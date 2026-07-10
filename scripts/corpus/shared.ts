import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CORPUS_DIR = join(import.meta.dir, "../../corpus");
export const CACHE_DIR = join(import.meta.dir, "../../.cache");

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
