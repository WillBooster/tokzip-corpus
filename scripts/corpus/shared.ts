import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CORPUS_DIR = join(import.meta.dir, "../../corpus");
export const CACHE_DIR = join(import.meta.dir, "../../.cache");
const SHINGLE_LENGTH = 32;
const SHINGLES_PER_DOC = 64;
const NEAR_DUP_THRESHOLD = 0.5;

const git = (args: string[]): boolean =>
  spawnSync("git", args, { stdio: ["ignore", "ignore", "pipe"], timeout: 600_000 }).status === 0;

const gitOutput = (args: string[]): string | undefined => {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 600_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/**
 * Shallow-clones `repo` at exactly the pinned `ref` (branch, tag, or commit SHA) into the
 * shared clone cache. An unresolvable ref is a hard error — silently sampling a moving
 * default branch would break the reproducibility contract of the source manifests — and a
 * failed clone never leaves a partial directory behind to poison later runs.
 */
export function cloneAtRef(repo: string, ref: string): string | undefined {
  const dir = join(CACHE_DIR, repo.split("/").slice(-2).join("__"));
  if (existsSync(dir)) {
    // A cached checkout may predate a pin change (or be a partial clone): verify HEAD
    // actually matches the requested ref before reusing it.
    const head = gitOutput(["-C", dir, "rev-parse", "HEAD"]);
    const pinned = gitOutput(["-C", dir, "rev-parse", `${ref}^{commit}`]);
    if (head && (head === ref || head === pinned)) return dir;
    if (
      git(["-C", dir, "fetch", "--depth", "1", "origin", ref]) &&
      git(["-C", dir, "checkout", "--detach", "FETCH_HEAD"])
    ) {
      return dir;
    }
    rmSync(dir, { recursive: true, force: true }); // Unusable cache entry: fall through to a fresh clone.
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`cloning ${repo}@${ref} ...`);
  if (git(["clone", "--depth", "1", "--branch", ref, "--single-branch", repo, dir])) return dir;
  // The pinned ref is not a branch/tag name (e.g. a commit SHA): fetch it explicitly.
  rmSync(dir, { recursive: true, force: true });
  if (
    git(["clone", "--depth", "1", repo, dir]) &&
    git(["-C", dir, "fetch", "--depth", "1", "origin", ref]) &&
    git(["-C", dir, "checkout", "--detach", "FETCH_HEAD"])
  ) {
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  console.error(`error: cannot resolve ${repo}@${ref}; skipping repo (fix the pinned ref)`);
  process.exitCode = 1;
  return undefined;
}

/** Resolved commit of a cached clone, recorded in manifests for reproducibility. */
export function resolvedSha(dir: string): string {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.stdout?.trim() || "unknown";
}

/** One manifest line per sample; split.ts fills in the `split` field. */
export interface ManifestEntry {
  file: string;
  lang: string;
  origin: "human" | "llm";
  source: string;
  license: string;
  notice: string;
  sha256: string;
  sizeBucket: string;
  /** Samples require explicit training approval even when redistribution is permitted. */
  trainable: boolean;
  split?: "train" | "bench";
}

/** Canonical pinned upstream file identity shared by URL-based and clone-cache sources. */
export function sourceProvenance(source: string): string | undefined {
  const parsed = parsePinnedSource(source);
  if (!parsed) return undefined;
  const sourceRepo = parsed.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const repo = sourceRepo.includes("/") ? sourceRepo : sourceRepo.replace("__", "/");
  const sourcePath = parsed.path.replace(/#chunk\d+$/, "");
  return `${repo}@${parsed.commit}:${sourcePath}`;
}

/** Parses a manifest source without assuming that a valid Git path is single-line. */
export function parsePinnedSource(
  source: string,
): { commit: string; path: string; repo: string } | undefined {
  const match = /^(.*)@([0-9a-f]{40}):([\s\S]*)$/.exec(source);
  return match ? { repo: match[1]!, commit: match[2]!, path: match[3]! } : undefined;
}

/** Returns near-duplicate edges using the corpus split's sampled-shingle definition. */
export function nearDuplicatePairs(contents: string[]): [number, number][] {
  const shingleSets = contents.map(shinglesOf);
  const docsByShingle = new Map<number, number[]>();
  const pairs: [number, number][] = [];
  for (let index = 0; index < shingleSets.length; index++) {
    const sharedCounts = new Map<number, number>();
    for (const hash of shingleSets[index]!) {
      for (const previous of docsByShingle.get(hash) ?? [])
        sharedCounts.set(previous, (sharedCounts.get(previous) ?? 0) + 1);
    }
    for (const [previous, shared] of sharedCounts) {
      const possible = Math.min(shingleSets[index]!.size, shingleSets[previous]!.size);
      if (shared / Math.max(1, possible) >= NEAR_DUP_THRESHOLD) pairs.push([index, previous]);
    }
    for (const hash of shingleSets[index]!) {
      const docs = docsByShingle.get(hash) ?? [];
      docs.push(index);
      docsByShingle.set(hash, docs);
    }
  }
  return pairs;
}

function shinglesOf(content: string): Set<number> {
  const shingles = new Set<number>();
  if (content.length < SHINGLE_LENGTH) return shingles;
  // Ceil spreads the shingle budget across the whole document; floor would leave the tail of
  // documents shorter than SHINGLE_LENGTH + 2 * SHINGLES_PER_DOC entirely unsampled.
  const step = Math.max(1, Math.ceil((content.length - SHINGLE_LENGTH) / SHINGLES_PER_DOC));
  for (
    let index = 0;
    index + SHINGLE_LENGTH <= content.length && shingles.size < SHINGLES_PER_DOC;
    index += step
  ) {
    let hash = 0x81_1c_9d_c5;
    for (let offset = 0; offset < SHINGLE_LENGTH; offset++)
      hash = Math.imul(hash ^ content.codePointAt(index + offset)!, 0x01_00_01_93);
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- >>> 0 coerces to uint32, Math.trunc does not
    shingles.add(hash >>> 0);
  }
  return shingles;
}

const CHUNK_TARGETS = [512, 2048, 8192, 24_576];
/** Hard per-sample ceiling shared by whole-file sampling and documentation chunking. */
export const MAX_SAMPLE_BYTES = 32 * 1024;

/**
 * Splits a document into size-bucket-cycling chunks at paragraph boundaries. `chunkIndex` is
 * 1-based and counts skipped short chunks, so manifest `#chunkN` suffixes stay stable.
 */
export function chunkDocument(text: string): { chunk: string; chunkIndex: number }[] {
  const chunks: { chunk: string; chunkIndex: number }[] = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < text.length) {
    const target = CHUNK_TARGETS[chunkIndex % CHUNK_TARGETS.length]!;
    let end = Math.min(offset + target, text.length);
    const paragraphBreak = text.indexOf("\n\n", end);
    if (paragraphBreak !== -1 && paragraphBreak - end < target) end = paragraphBreak + 2;
    // Paragraph extension and multi-byte characters must not break the per-sample byte cap;
    // the remainder simply becomes the next chunk.
    while (end > offset && Buffer.byteLength(text.slice(offset, end)) > MAX_SAMPLE_BYTES) {
      end = offset + Math.floor(((end - offset) * 3) / 4);
    }
    // Never split a surrogate pair: a dangling high surrogate would corrupt both chunks. The
    // end > offset + 1 guard keeps the offset advancing when a lone high surrogate is the
    // only remaining character, instead of looping forever.
    const trailing = text.charCodeAt(end - 1);
    if (trailing >= 0xd8_00 && trailing <= 0xdb_ff && end > offset + 1) end--;
    const chunk = text.slice(offset, end).trim();
    offset = end;
    chunkIndex++;
    if (chunk.length >= 200) chunks.push({ chunk, chunkIndex });
  }
  return chunks;
}

export function sizeBucketOf(bytes: number): string {
  if (bytes <= 1024) return "0.5k";
  if (bytes <= 4096) return "2k";
  if (bytes <= 16 * 1024) return "8k";
  return "24k";
}

export function writeSample(
  language: string,
  origin: "human" | "llm",
  name: string,
  content: string,
): void {
  const dir = join(CORPUS_DIR, language, origin);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

export function appendManifest(language: string, entry: Omit<ManifestEntry, "sha256">): void {
  mkdirSync(join(CORPUS_DIR, language), { recursive: true });
  const content = readFileSync(join(CORPUS_DIR, language, entry.file));
  const sha256 = createHash("sha256").update(content).digest("hex");
  appendFileSync(
    join(CORPUS_DIR, language, "manifest.jsonl"),
    JSON.stringify({ ...entry, sha256 }) + "\n",
  );
}

export function noticePathFor(repo: string): string {
  return `THIRD_PARTY_NOTICES/${repo.split("/").slice(-2).join("__")}`;
}

/** Copies root-level license and attribution material verbatim into the redistribution bundle. */
export function syncNoticeFiles(checkout: string, repo: string): void {
  const noticeDir = join(import.meta.dir, "../..", noticePathFor(repo));
  rmSync(noticeDir, { recursive: true, force: true });
  mkdirSync(noticeDir, { recursive: true });
  const files = readdirSync(checkout, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && isNoticeFile(entry.name),
  );
  if (files.length === 0) throw new Error(`${repo}: no root-level license or notice files`);
  for (const file of files) {
    const name = /licen[cs]e/i.test(file.name) && !/^licen[cs]e/i.test(file.name)
      ? `LICENSE-${file.name}`
      : file.name;
    copyFileSync(join(checkout, file.name), join(noticeDir, name));
  }
}

export function isNoticeFile(name: string): boolean {
  return /^(authors|copying|copyright|licen[cs]es?|notices?)(\.|$|[-_])|^third[-_ ]?party[-_ ]?notices?(?:text)?(\.|$|[-_ ])|[-_](licen[cs]es?|notices?)(\.|$|[-_])/i.test(name);
}

/** Rejects file-level license declarations that are not covered by the source allowlist entry. */
export function hasIncompatibleSpdx(content: string, license: string): boolean {
  const compatible = new Set(
    {
      "Apache-2.0": ["Apache-2.0"],
      "BSD-3-Clause": ["BSD-3-Clause"],
      MIT: ["MIT"],
      "MIT-like (curl)": ["curl"],
      "MIT/Apache-2.0": ["Apache-2.0", "MIT"],
    }[license]?.map((identifier) => identifier.toLowerCase()) ?? [],
  );
  for (const match of content.matchAll(/SPDX-License-Identifier:\s*([^\r\n]+)/gi)) {
    // Strip comment terminators instead of truncating at "*": stopping the capture there
    // would silently read "MIT*" (or "MIT OR GPL-3.0*") as plain "MIT".
    const expression = match[1]!
      .replace(/\s*\*\/\s*$/, "")
      .replace(/\s*-->\s*$/, "")
      .trim();
    if (!isCompatibleSpdxExpression(expression, compatible)) return true;
  }
  return false;
}

function isCompatibleSpdxExpression(expression: string, compatible: Set<string>): boolean {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/gi) ?? [];
  let position = 0;

  const parsePrimary = (): boolean | undefined => {
    const token = tokens[position++];
    if (!token) return undefined;
    if (token === "(") {
      const value = parseOr();
      if (tokens[position++] !== ")") return undefined;
      return value;
    }
    if (/^(?:AND|OR|WITH|\))$/i.test(token)) return undefined;
    return compatible.has(token.toLowerCase());
  };
  // No allowlisted license carries an exception, so any WITH expression is unreviewed: leaving
  // WITH unparsed makes the whole expression invalid, which fails closed to "incompatible".
  const parseAnd = (): boolean | undefined => {
    let value = parsePrimary();
    if (value === undefined) return undefined;
    while (/^AND$/i.test(tokens[position] ?? "")) {
      position++;
      const right = parsePrimary();
      if (right === undefined) return undefined;
      value = value && right;
    }
    return value;
  };
  const parseOr = (): boolean | undefined => {
    let value = parseAnd();
    if (value === undefined) return undefined;
    while (/^OR$/i.test(tokens[position] ?? "")) {
      position++;
      const right = parseAnd();
      if (right === undefined) return undefined;
      value = value || right;
    }
    return value;
  };

  const result = parseOr();
  return result === true && position === tokens.length;
}

/**
 * Clears one origin's samples and manifest rows before a re-fetch. Without this, re-running a
 * fetcher would overwrite sample files but keep appending manifest rows, duplicating entries.
 */
export function resetOrigin(language: string, origin: "human" | "llm"): void {
  rmSync(join(CORPUS_DIR, language, origin), { recursive: true, force: true });
  const manifestPath = join(CORPUS_DIR, language, "manifest.jsonl");
  if (!existsSync(manifestPath)) return;
  const kept = readFileSync(manifestPath, "utf8")
    .split("\n")
    .filter(
      (line) => line.trim() && !(JSON.parse(line) as ManifestEntry).file.startsWith(`${origin}/`),
    );
  writeFileSync(manifestPath, kept.length > 0 ? kept.join("\n") + "\n" : "");
}

/** Deterministic seeded RNG (mulberry32) shared by split and generation sampling. */
// oxlint-disable unicorn/prefer-math-trunc -- >>> 0 coerces to uint32, Math.trunc does not
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
