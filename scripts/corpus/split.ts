/**
 * Deterministic, seeded train/benchmark split (~85/15 by document) with near-duplicate
 * detection across splits (shingled n-gram hashing) and benchmark representation for every
 * source and size bucket that has at least two independent clusters.
 * License policy: non-trainable (copyleft/share-alike) samples are forced into the benchmark
 * split, which also guarantees they can never leak into shipped dictionaries.
 *
 * The resulting benchmark split is versioned (`bench-v2`): re-running with the same corpus
 * and seed reproduces it exactly.
 *
 * Usage: bun scripts/corpus/split.ts [<language> ...]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORPUS_DIR,
  nearDuplicatePairs,
  parsePinnedSource,
  seededRandom,
  sourceProvenance,
  type ManifestEntry,
} from './shared.ts';

const SPLIT_SEED = 0xBE_9C_11;
const BENCH_RATIO = 0.15;
function splitLanguage(language: string): void {
  const dir = join(CORPUS_DIR, language);
  const manifestPath = join(dir, 'manifest.jsonl');
  if (!existsSync(manifestPath)) return;
  const entries: ManifestEntry[] = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ManifestEntry);

  const random = seededRandom(SPLIT_SEED);
  // Near-duplicate clusters: union-find over pairwise-overlapping documents, so a whole
  // cluster always lands in one split (a bench doc must never have a near-copy in training).
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const contents = entries.map((entry) => readFileSync(join(dir, entry.file), 'utf8'));
  for (const [index, previous] of nearDuplicatePairs(contents)) parent[find(previous)] = find(index);
  const firstByProvenance = new Map<string, number>();
  for (let index = 0; index < entries.length; index++) {
    const provenance = sourceProvenance(entries[index]!.source);
    if (provenance === undefined) continue;
    const first = firstByProvenance.get(provenance);
    if (first === undefined) firstByProvenance.set(provenance, index);
    else parent[find(index)] = find(first);
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    const indices = clusters.get(root) ?? [];
    indices.push(i);
    clusters.set(root, indices);
  }
  const clusterSplit = new Map<number, 'train' | 'bench'>();
  const priority = new Map<number, number>();
  for (const [root, indices] of clusters) {
    const value = random();
    priority.set(root, value);
    clusterSplit.set(root, value < BENCH_RATIO ? 'bench' : 'train');
    // License policy: non-trainable sources are benchmark-only (and drag their cluster along).
    if (indices.some((index) => !entries[index]!.trainable)) clusterSplit.set(root, 'bench');
  }

  ensureBenchmarkCoverage(
    clusters,
    clusterSplit,
    priority,
    (entry) => parsePinnedSource(entry.source)?.repo ?? entry.source,
    entries
  );
  ensureBenchmarkCoverage(clusters, clusterSplit, priority, (entry) => entry.sizeBucket, entries);
  ensureBothSplits(clusters, clusterSplit, priority, entries);

  for (let i = 0; i < entries.length; i++) entries[i]!.split = clusterSplit.get(find(i))!;
  writeFileSync(manifestPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

/** Gives every sufficiently diverse source or size stratum benchmark representation. */
function ensureBenchmarkCoverage(
  clusters: Map<number, number[]>,
  clusterSplit: Map<number, 'train' | 'bench'>,
  priority: Map<number, number>,
  keyOf: (entry: ManifestEntry) => string,
  entries: ManifestEntry[]
): void {
  const rootsByKey = new Map<string, Set<number>>();
  for (const [root, indices] of clusters) {
    for (const index of indices) {
      const key = keyOf(entries[index]!);
      const roots = rootsByKey.get(key) ?? new Set<number>();
      roots.add(root);
      rootsByKey.set(key, roots);
    }
  }
  for (const roots of rootsByKey.values()) {
    if (roots.size < 2 || [...roots].some((root) => clusterSplit.get(root) === 'bench')) continue;
    const candidate = [...roots]
      .filter((root) => clusters.get(root)!.every((index) => entries[index]!.trainable))
      .toSorted(smallestClusterFirst(clusters, priority))[0];
    if (candidate !== undefined) clusterSplit.set(candidate, 'bench');
  }
}

/**
 * Forced bench promotions hold out the smallest sufficient cluster: promoting by random
 * priority alone can move a locale's dominant multi-chunk document into the benchmark and
 * starve its training split (zh-TW dropped to 3 train / 11 bench that way).
 */
function smallestClusterFirst(
  clusters: Map<number, number[]>,
  priority: Map<number, number>
): (a: number, b: number) => number {
  return (a, b) => clusters.get(a)!.length - clusters.get(b)!.length || priority.get(a)! - priority.get(b)!;
}

/** A usable language corpus needs at least one held-out and one trainable cluster. */
function ensureBothSplits(
  clusters: Map<number, number[]>,
  clusterSplit: Map<number, 'train' | 'bench'>,
  priority: Map<number, number>,
  entries: ManifestEntry[]
): void {
  const roots = [...clusters.keys()];
  if (roots.length < 2) return;
  if (!roots.some((root) => clusterSplit.get(root) === 'bench'))
    clusterSplit.set(roots.toSorted(smallestClusterFirst(clusters, priority))[0]!, 'bench');
  if (!roots.some((root) => clusterSplit.get(root) === 'train')) {
    const candidate = roots
      .filter((root) => clusters.get(root)!.every((index) => entries[index]!.trainable))
      .toSorted((a, b) => smallestClusterFirst(clusters, priority)(b, a))[0];
    if (candidate !== undefined) clusterSplit.set(candidate, 'train');
  }
}

/** Related representations must never train a dictionary and also appear in its benchmark. */
function coalesceGlobalDuplicates(): Set<string> {
  const manifests = new Map<string, { entries: ManifestEntry[]; manifestPath: string }>();
  const values: { entry: ManifestEntry; language: string }[] = [];
  for (const language of corpusLanguages()) {
    const manifestPath = join(CORPUS_DIR, language, 'manifest.jsonl');
    if (!existsSync(manifestPath)) continue;
    const entries = readManifest(manifestPath);
    manifests.set(language, { entries, manifestPath });
    for (const entry of entries) values.push({ entry, language });
  }

  const parent = values.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const unionBy = (keyOf: (entry: ManifestEntry) => string | undefined): void => {
    const firstByKey = new Map<string, number>();
    for (let index = 0; index < values.length; index++) {
      const key = keyOf(values[index]!.entry);
      if (key === undefined) continue;
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, index);
      else parent[find(index)] = find(first);
    }
  };
  unionBy((entry) => entry.sha256);
  unionBy((entry) => sourceProvenance(entry.source));
  const indicesByLanguage = new Map<string, number[]>();
  for (let index = 0; index < values.length; index++) {
    const indices = indicesByLanguage.get(values[index]!.language) ?? [];
    indices.push(index);
    indicesByLanguage.set(values[index]!.language, indices);
  }
  for (const [language, indices] of indicesByLanguage) {
    const contents = indices.map((index) =>
      readFileSync(join(CORPUS_DIR, language, values[index]!.entry.file), 'utf8')
    );
    for (const [index, previous] of nearDuplicatePairs(contents))
      parent[find(indices[index]!)] = find(indices[previous]!);
  }

  const indicesByRoot = new Map<number, number[]>();
  for (let index = 0; index < values.length; index++) {
    const root = find(index);
    const indices = indicesByRoot.get(root) ?? [];
    indices.push(index);
    indicesByRoot.set(root, indices);
  }
  const changed = new Set<string>();
  for (const indices of indicesByRoot.values()) {
    if (!indices.some((index) => values[index]!.entry.split === 'bench')) continue;
    for (const index of indices) {
      const value = values[index]!;
      if (value.entry.split !== 'bench') {
        value.entry.split = 'bench';
        changed.add(value.language);
      }
    }
  }
  // Bench promotion is one-way, so it can consume a language's last train cluster. Restore
  // training data only from a component confined to that language (promoting a cross-language
  // component would reintroduce the train/bench contamination this pass exists to prevent).
  for (const [language, indices] of indicesByLanguage) {
    if (indices.some((index) => values[index]!.entry.split === 'train')) continue;
    const candidate = [...new Set(indices.map((index) => find(index)))]
      .map((root) => indicesByRoot.get(root)!)
      .filter((members) =>
        members.every((index) => values[index]!.language === language && values[index]!.entry.trainable)
      )
      .toSorted((a, b) => b.length - a.length || a[0]! - b[0]!)[0];
    if (!candidate) {
      throw new Error(
        `${language}: global duplicate coalescing left no training split and no language-local trainable cluster can restore one`
      );
    }
    for (const index of candidate) values[index]!.entry.split = 'train';
    changed.add(language);
  }
  for (const language of changed) {
    const { entries, manifestPath } = manifests.get(language)!;
    writeFileSync(manifestPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
  return changed;
}

function printCounts(languages: Iterable<string>): void {
  for (const language of [...languages].toSorted()) {
    const entries = readManifest(join(CORPUS_DIR, language, 'manifest.jsonl'));
    const trainCount = entries.filter((entry) => entry.split === 'train').length;
    console.log(
      `${language}: ${trainCount} train / ${entries.length - trainCount} bench (bench-v2, seed ${SPLIT_SEED})`
    );
  }
}

function readManifest(manifestPath: string): ManifestEntry[] {
  return readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ManifestEntry);
}

function corpusLanguages(): string[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

const requested = process.argv.slice(2);
const languages = requested.length > 0 ? requested : corpusLanguages();
for (const language of languages) splitLanguage(language);
const globalDuplicateChanges = coalesceGlobalDuplicates();
printCounts(new Set([...languages, ...globalDuplicateChanges]));
