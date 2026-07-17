/**
 * Fetches the human-written code corpus: shallow-clones pinned OSS repos, applies the
 * sampling rules from the design issue, and writes documents + manifest entries under
 * `corpus/<lang>/human/`. Corpus samples and their provenance manifests are committed in
 * this dedicated repository; clone caches remain ignored and reproducible.
 *
 * Usage: bun scripts/corpus/fetchOss.ts [--quick] [<language> ...]
 *   --quick  clone only the repo marked `quick` per language and cap the sample volume.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import nlSources from "./nl-sources.json";
import sources from "./oss-sources.json";
import {
  appendManifest,
  CACHE_DIR,
  chunkDocument,
  cloneAtRef,
  hasIncompatibleSpdx,
  isContainedFile,
  isNoticeFile,
  MAX_SAMPLE_BYTES,
  noticePathFor,
  resetOrigin,
  resolvedSha,
  sizeBucketOf,
  syncNoticeFiles,
  writeSample,
} from "./shared.ts";

const EXTENSIONS: Record<string, string[]> = {
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh"],
  csharp: [".cs"],
  css: [".css", ".scss"],
  dart: [".dart"],
  haskell: [".hs"],
  html: [".html", ".htm"],
  java: [".java"],
  jsp: [".jsp"],
  javascript: [".js", ".mjs", ".cjs", ".jsx"],
  php: [".php"],
  python: [".py"],
  ruby: [".rb"],
  rust: [".rs"],
  text: [".md", ".txt"],
  typescript: [".ts", ".tsx"],
  zig: [".zig"],
};
/**
 * Dropped from the text corpus only. The code corpora deliberately keep tests — real projects are
 * full of them — but a test tree's prose is machine output (compiler baselines, parser dumps,
 * dependency pins), not documentation.
 */
/** `.txt` files that are configuration or tool input, not documentation. Text corpus only. */
const NON_PROSE_TXT =
  /^(cmakelists|conanfile|robots|requirements(-[\w.]+)?|constraints|\.?[\w.-]*supp(ressions)?|package-list|\.?gitattributes)\.txt$/i;
const PROSE_EXCLUDED_DIRS = new Set([
  "test",
  "tests",
  "testing",
  "fixtures",
  "fixture",
  "baselines",
  "requirements",
  "testdata",
  "spec",
  "specs",
]);
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "vendor",
  "vendored",
  "dist",
  "build",
  "out",
  "third_party",
  "third-party",
  "thirdparty",
  "deps",
  "external",
  "extern",
  ".git",
  "generated",
  "__generated__",
]);
const MAX_AVG_LINE_LENGTH = 200;
const LANG_BUDGET_BYTES = 8 * 1024 * 1024;
const QUICK_LANG_BUDGET_BYTES = 4 * 1024 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface SourceEntry {
  repo: string;
  ref: string;
  license: string;
  trainable: boolean;
  quick?: boolean;
  requiredNoticeFiles?: string[];
  excludePrefixes?: string[];
}

main();

function main(): void {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const requested = args.filter((a) => !a.startsWith("--"));
  const languages = requested.length > 0 ? requested : Object.keys(sources.languages);
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const language of languages) {
    if (language === "text") continue; // Harvested after all clones below.
    fetchLanguage(language, quick);
  }
  if (languages.includes("text") || requested.length === 0) harvestText(quick);
}

function fetchLanguage(language: string, quick: boolean): void {
  const entries = (sources.languages as Record<string, SourceEntry[]>)[language];
  const extensions = EXTENSIONS[language];
  if (!entries || !extensions) {
    console.error(`skip ${language}: no sources or extensions defined`);
    return;
  }
  resetOrigin(language, "human"); // Re-runs must not duplicate manifest rows over stale samples.
  const selected = quick ? entries.filter((e) => e.quick) : entries;
  const budget = quick ? QUICK_LANG_BUDGET_BYTES : LANG_BUDGET_BYTES;
  const repoCap = budget / selected.length;
  let total = 0;
  let index = 0;
  for (const entry of selected) {
    if (total >= budget) break;
    const checkout = cloneAtRef(entry.repo, entry.ref);
    if (!checkout) continue;
    syncNoticeFiles(checkout, entry.repo);
    const sha = resolvedSha(checkout);
    let repoBytes = 0;
    for (const file of sampleFiles(checkout, extensions, entry.license, entry.excludePrefixes)) {
      if (total >= budget || repoBytes >= repoCap) break;
      const content = readFileSync(file.path, "utf8");
      const name = `${String(index++).padStart(5, "0")}.txt`;
      writeSample(language, "human", name, content);
      appendManifest(language, {
        file: `human/${name}`,
        lang: language,
        origin: "human",
        source: `${entry.repo}@${sha}:${file.relative}`,
        license: entry.license,
        notice: noticePathFor(entry.repo),
        sizeBucket: sizeBucketOf(file.bytes),
        trainable: entry.trainable,
      });
      total += file.bytes;
      repoBytes += file.bytes;
    }
    console.log(`${language}: ${entry.repo} → ${repoBytes} B (total ${total} B)`);
  }
}

/**
 * License/trainability by clone-cache directory name, across every source list that clones
 * into `.corpus/.cache` (all oss-sources languages + fetchNl's gitDocs repos). Harvested text
 * must inherit the source repo's flags, or copyleft prose could leak into shipped dictionaries.
 */
function repoFlagsByCacheDir(): Map<
  string,
  { excludePrefixes?: string[]; license: string; quick: boolean; trainable: boolean }
> {
  const flags = new Map<
    string,
    { excludePrefixes?: string[]; license: string; quick: boolean; trainable: boolean }
  >();
  const register = (
    repo: string,
    license: string,
    trainable: boolean,
    quick: boolean,
    excludePrefixes?: string[],
  ): void => {
    flags.set(repo.split("/").slice(-2).join("__"), {
      excludePrefixes,
      license,
      quick,
      trainable,
    });
  };
  for (const entries of Object.values(sources.languages as Record<string, SourceEntry[]>)) {
    for (const entry of entries)
      if (entry.repo.startsWith("http"))
        register(
          entry.repo,
          entry.license,
          entry.trainable,
          entry.quick === true,
          entry.excludePrefixes,
        );
  }
  const locales = nlSources.locales as Record<
    string,
    {
      gitDocs?: {
        excludePrefixes?: string[];
        license: string;
        repo: string;
        trainable: boolean;
      }[];
    }
  >;
  for (const locale of Object.values(locales)) {
    for (const entry of locale.gitDocs ?? [])
      register(entry.repo, entry.license, entry.trainable, true, entry.excludePrefixes);
  }
  return flags;
}

/** The `text` corpus harvests README/CHANGELOG/docs prose from every cloned repo. */
function harvestText(quick: boolean): void {
  prepareTextSources(quick);
  if (!existsSync(CACHE_DIR)) return;
  resetOrigin("text", "human");
  const flags = repoFlagsByCacheDir();
  const budget = quick ? QUICK_LANG_BUDGET_BYTES : LANG_BUDGET_BYTES;
  let total = 0;
  let index = 0;
  const repos: {
    dir: string;
    files: SampledFile[];
    flags: { excludePrefixes?: string[]; license: string; quick: boolean; trainable: boolean };
    next: number;
    repoDir: string;
    sha: string;
  }[] = [];
  for (const repoDir of readdirSync(CACHE_DIR).toSorted()) {
    const dir = join(CACHE_DIR, repoDir);
    if (!statSync(dir).isDirectory()) continue;
    const repoFlags = flags.get(repoDir);
    if (!repoFlags) {
      console.error(`text: skipping unmapped cache dir ${repoDir} (no license metadata)`);
      continue;
    }
    if (quick && !repoFlags.quick) continue;
    repos.push({
      dir,
      files: sampleFiles(
        dir,
        EXTENSIONS.text!,
        repoFlags.license,
        repoFlags.excludePrefixes,
        true,
        true,
      ),
      flags: repoFlags,
      next: 0,
      repoDir,
      sha: resolvedSha(dir),
    });
  }
  while (total < budget) {
    let progressed = false;
    for (const repo of repos) {
      const file = repo.files[repo.next++];
      if (!file) continue;
      progressed = true;
      const content = file.content ?? readFileSync(file.path, "utf8");
      const name = `${String(index++).padStart(5, "0")}.txt`;
      writeSample("text", "human", name, content);
      appendManifest("text", {
        file: `human/${name}`,
        lang: "text",
        origin: "human",
        source: `${repo.repoDir}@${repo.sha}:${file.relative}`,
        license: repo.flags.license,
        notice: `THIRD_PARTY_NOTICES/${repo.repoDir}`,
        sizeBucket: sizeBucketOf(file.bytes),
        trainable: repo.flags.trainable,
      });
      total += file.bytes;
      if (total >= budget) break;
    }
    if (!progressed) break;
  }
  // The README promises documentation from every pinned repository in the shared text corpus.
  for (const repo of repos) {
    if (repo.files.length === 0 || repo.next === 0) {
      console.error(`error: text harvested no documentation from ${repo.repoDir}`);
      process.exitCode = 1;
    }
  }
  console.log(`text: harvested ${total} B of docs/prose`);
}

/** Text-only fetching must populate its own cache instead of depending on prior language runs. */
function prepareTextSources(quick: boolean): void {
  const ossEntries = Object.values(sources.languages as Record<string, SourceEntry[]>).flat();
  const localeEntries = Object.values(
    nlSources.locales as Record<string, { gitDocs?: SourceEntry[] }>,
  ).flatMap((locale) => (locale.gitDocs ?? []).map((entry) => ({ ...entry, quick: true })));
  for (const entry of [...ossEntries, ...localeEntries]) {
    if (!entry.repo.startsWith("http") || (quick && entry.quick !== true)) continue;
    const dir = cloneAtRef(entry.repo, entry.ref);
    if (dir) syncNoticeFiles(dir, entry.repo);
  }
}

function hashOf(text: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.codePointAt(i)!, 0x01_00_01_93);
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- >>> 0 coerces to uint32, Math.trunc does not
  return hash >>> 0;
}

interface SampledFile {
  path: string;
  relative: string;
  bytes: number;
  /** Chunked slice of an oversized document; whole-file samples re-read from `path`. */
  content?: string;
}

/**
 * Sampling rules: language extensions only; skip vendored/generated/minified; keep tests; whole
 * files. `proseOnly` additionally drops test/fixture/baseline trees and accepts `.txt` only at the
 * repository root or under `docs/`: the text corpus is meant to be documentation, and a repo's
 * `tests/baselines/**.txt` (compiler diagnostics, parser dumps) or `requirements/*.txt` (pip pins)
 * are machine output that would otherwise dominate it — TypeScript contributed 48 baseline files
 * and zero prose.
 */
function sampleFiles(
  root: string,
  extensions: string[],
  license: string,
  excludedPrefixes: string[] = [],
  chunkOversized = false,
  proseOnly = false,
): SampledFile[] {
  const files: SampledFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        excludedPrefixes.some(
          (excluded) => relative === excluded || relative.startsWith(`${excluded}/`),
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        const excluded =
          EXCLUDED_DIRS.has(entry.name.toLowerCase()) ||
          (proseOnly && PROSE_EXCLUDED_DIRS.has(entry.name.toLowerCase()));
        if (!excluded && !isNoticeFile(entry.name)) walk(path, relative);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (entry.name.includes(".min.")) continue;
      if (isNoticeFile(entry.name)) continue;
      // A `.txt` is prose only where documentation lives; elsewhere it is data (fixtures, pins).
      if (proseOnly && entry.name.endsWith(".txt")) {
        if (prefix !== "" && !relative.startsWith("docs/")) continue;
        // Even at the root or under docs/, some .txt files are build or tool configuration
        // (CMakeLists.txt, requirements.txt, robots.txt) rather than documentation. Prose files
        // that happen to live beside them (BUILDING.txt, RUNNING.txt) are kept.
        if (NON_PROSE_TXT.test(entry.name)) continue;
      }
      // Dirents never report symlinks as directories, so a link to a directory would reach
      // readFileSync and crash with EISDIR; a link out of the checkout would read a host file.
      if (!isContainedFile(root, path)) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.size === 0 || (stat.size > MAX_SAMPLE_BYTES && !chunkOversized)) continue;
      const buffer = readFileSync(path);
      let content: string;
      try {
        content = fatalUtf8Decoder.decode(buffer);
      } catch {
        continue; // The corpus API consumes Unicode text, so non-UTF-8 fixtures are not samples.
      }
      if (content.includes("\u0000")) continue;
      if (hasIncompatibleSpdx(content, license)) continue;
      const lines = content.split("\n");
      if (content.length / Math.max(lines.length, 1) > MAX_AVG_LINE_LENGTH) continue; // Minified/generated.
      if (buffer.byteLength > MAX_SAMPLE_BYTES) {
        // Oversized documentation still represents its repo: sample it as bounded chunks.
        for (const { chunk, chunkIndex } of chunkDocument(content)) {
          files.push({
            path,
            relative: `${relative}#chunk${chunkIndex}`,
            bytes: Buffer.byteLength(chunk),
            content: chunk,
          });
        }
        continue;
      }
      files.push({ path, relative, bytes: buffer.byteLength });
    }
  };
  walk(root, "");
  // Stable pseudo-random order within each size bucket spreads samples across the tree.
  // Round-robin interleaving then prevents a repo's dominant file size from crowding the
  // other benchmark sizes out before the byte cap is reached.
  const buckets = new Map<string, SampledFile[]>();
  for (const file of files) {
    const bucket = sizeBucketOf(file.bytes);
    const values = buckets.get(bucket) ?? [];
    values.push(file);
    buckets.set(bucket, values);
  }
  for (const values of buckets.values())
    values.sort(
      (a, b) => hashOf(a.relative) - hashOf(b.relative) || (a.relative < b.relative ? -1 : 1),
    );
  const balanced: SampledFile[] = [];
  const bucketOrder = ["0.25k", "0.5k", "2k", "8k", "24k"];
  for (let index = 0; bucketOrder.some((bucket) => index < (buckets.get(bucket)?.length ?? 0)); index++) {
    for (const bucket of bucketOrder) {
      const file = buckets.get(bucket)?.[index];
      if (file) balanced.push(file);
    }
  }
  return balanced;
}
