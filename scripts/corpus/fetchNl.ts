/** Fetches pinned, permissively licensed natural-language documentation. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import sources from "./nl-sources.json";
import {
  appendManifest,
  chunkDocument,
  cloneAtRef,
  isContainedFile,
  noticePathFor,
  resetOrigin,
  resolvedSha,
  sizeBucketOf,
  syncNoticeFiles,
  writeSample,
} from "./shared.ts";

interface GitDocsSource {
  repo: string;
  ref: string;
  license: string;
  trainable: true;
  excludePrefixes?: string[];
}

interface LocaleSources {
  gitDocs: GitDocsSource[];
}

const counters = new Map<string, number>();

function main(): void {
  const requested = process.argv.slice(2);
  const locales = requested.length > 0 ? requested : Object.keys(sources.locales);
  for (const locale of locales) {
    const localeSources = (sources.locales as Record<string, LocaleSources>)[locale];
    if (!localeSources) throw new Error(`unknown locale: ${locale}`);
    resetOrigin(locale, "human");
    fetchGitDocs(locale, localeSources.gitDocs);
  }
}

function fetchGitDocs(locale: string, entries: GitDocsSource[]): void {
  for (const entry of entries) {
    const dir = cloneAtRef(entry.repo, entry.ref);
    if (!dir) continue;
    syncNoticeFiles(dir, entry.repo);
    const sha = resolvedSha(dir);
    let bytes = 0;
    const walk = (current: string): void => {
      for (const dirent of readdirSync(current, { withFileTypes: true })) {
        if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
        const path = join(current, dirent.name);
        if (dirent.isDirectory()) {
          walk(path);
          continue;
        }
        const sourcePath = relative(dir, path);
        if (
          entry.excludePrefixes?.some(
            (excluded) => sourcePath === excluded || sourcePath.startsWith(`${excluded}/`),
          )
        ) {
          continue;
        }
        // Symlinks to directories pass the extension check but would crash readFileSync, and a
        // link out of the checkout would read a host file. Broken links are skipped, not fatal.
        if (!isContainedFile(dir, path)) continue;
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!dirent.name.endsWith(".md") || stat.size < 500) continue;
        bytes += saveChunks(
          locale,
          readFileSync(path, "utf8"),
          `${entry.repo}@${sha}:${sourcePath}`,
          entry.license,
          noticePathFor(entry.repo),
        );
      }
    };
    walk(dir);
    console.log(`${locale}: ${entry.repo} docs → ${bytes} B`);
  }
}

function saveChunks(
  locale: string,
  text: string,
  source: string,
  license: string,
  notice: string,
): number {
  let saved = 0;
  for (const { chunk, chunkIndex } of chunkDocument(text)) {
    const name = `${String(counters.get(locale) ?? 0).padStart(5, "0")}.txt`;
    counters.set(locale, (counters.get(locale) ?? 0) + 1);
    writeSample(locale, "human", name, chunk);
    appendManifest(locale, {
      file: `human/${name}`,
      lang: locale,
      origin: "human",
      source: `${source}#chunk${chunkIndex}`,
      license,
      notice,
      sizeBucket: sizeBucketOf(Buffer.byteLength(chunk)),
      trainable: true,
    });
    saved += Buffer.byteLength(chunk);
  }
  return saved;
}

main();
