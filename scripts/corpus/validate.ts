/** Fails when committed corpus bytes lack approved provenance or redistribution notices. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import nlSources from "./nl-sources.json";
import ossSources from "./oss-sources.json";
import {
  CORPUS_DIR,
  hasIncompatibleSpdx,
  isNoticeFile,
  MAX_SAMPLE_BYTES,
  nearDuplicatePairs,
  noticePathFor,
  parsePinnedSource,
  sizeBucketOf,
  sourceProvenance,
  type ManifestEntry,
} from "./shared.ts";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWED_LICENSES = new Set([
  "Apache-2.0",
  "BSD-3-Clause",
  "MIT",
  "MIT-like (curl)",
  "MIT/Apache-2.0",
]);
interface SourcePolicy {
  excludePrefixes?: string[];
  license: string;
  ref: string;
  requiredNoticeFiles?: string[];
  trainable: boolean;
}

const SOURCE_POLICIES = sourcePolicies();

function main(): void {
  const errors: string[] = [];
  const entriesByHash = new Map<string, { label: string; split?: string }[]>();
  const entriesByProvenance = new Map<string, { label: string; split?: string }[]>();
  const samplesByLanguage = new Map<
    string,
    { content: string; label: string; split?: string }[]
  >();
  let samples = 0;
  for (const language of readdirSync(CORPUS_DIR, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  )) {
    const dir = join(CORPUS_DIR, language.name);
    const manifestPath = join(dir, "manifest.jsonl");
    if (!existsSync(manifestPath)) {
      errors.push(`${language.name}: missing manifest.jsonl`);
      continue;
    }
    const referenced = new Set<string>();
    let languageTrainCount = 0;
    let languageSampleCount = 0;
    for (const [index, line] of readFileSync(manifestPath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      const label = `${language.name}/manifest.jsonl:${index + 1}`;
      const entry = JSON.parse(line) as ManifestEntry;
      referenced.add(entry.file);
      samples++;
      languageSampleCount++;
      if (entry.split === "train") languageTrainCount++;
      const matchingHashes = entriesByHash.get(entry.sha256) ?? [];
      matchingHashes.push({ label, split: entry.split });
      entriesByHash.set(entry.sha256, matchingHashes);
      const provenance = sourceProvenance(entry.source);
      if (provenance !== undefined) {
        const matchingSources = entriesByProvenance.get(provenance) ?? [];
        matchingSources.push({ label, split: entry.split });
        entriesByProvenance.set(provenance, matchingSources);
      }
      validateEntry(dir, label, entry, errors);
      const samplePath = join(dir, entry.file);
      if (existsSync(samplePath)) {
        const languageSamples = samplesByLanguage.get(language.name) ?? [];
        languageSamples.push({
          content: readFileSync(samplePath, "utf8"),
          label,
          split: entry.split,
        });
        samplesByLanguage.set(language.name, languageSamples);
      }
    }
    // Global duplicate coalescing only promotes toward bench; a language whose entire corpus
    // ends up held out would silently train an empty dictionary downstream.
    if (languageSampleCount > 0 && languageTrainCount === 0)
      errors.push(`${language.name}: no training samples remain after the split`);
    for (const origin of ["human", "llm"]) {
      const originDir = join(dir, origin);
      if (!existsSync(originDir)) continue;
      for (const file of readdirSync(originDir)) {
        if (!referenced.has(`${origin}/${file}`))
          errors.push(`${language.name}/${origin}/${file}: not in manifest`);
      }
    }
  }
  for (const entries of entriesByHash.values()) {
    if (new Set(entries.map((entry) => entry.split)).size > 1) {
      errors.push(
        `exact content crosses train/bench: ${entries.map((entry) => entry.label).join(", ")}`,
      );
    }
  }
  for (const entries of entriesByProvenance.values()) {
    if (new Set(entries.map((entry) => entry.split)).size > 1) {
      errors.push(
        `upstream file crosses train/bench: ${entries.map((entry) => entry.label).join(", ")}`,
      );
    }
  }
  for (const samples of samplesByLanguage.values()) {
    for (const [index, previous] of nearDuplicatePairs(samples.map((sample) => sample.content))) {
      if (samples[index]!.split !== samples[previous]!.split)
        errors.push(
          `near-duplicate content crosses train/bench: ${samples[index]!.label}, ${samples[previous]!.label}`,
        );
    }
  }
  if (errors.length > 0) throw new Error(`corpus compliance failed:\n- ${errors.join("\n- ")}`);
  console.log(
    `corpus compliance: ${samples} samples have approved licenses, notices, pins, and hashes`,
  );
}

function validateEntry(dir: string, label: string, entry: ManifestEntry, errors: string[]): void {
  const samplePath = join(dir, entry.file);
  if (!ALLOWED_LICENSES.has(entry.license))
    errors.push(`${label}: disallowed license ${entry.license}`);
  if (!parsePinnedSource(entry.source))
    errors.push(`${label}: source is not pinned to a 40-character commit`);
  // Intentionally stricter than split.ts's non-trainable → bench fallback: the distributed
  // corpus accepts only training-approved permissive sources, so a trainable:false policy
  // must fail validation instead of shipping as a benchmark-only sample.
  if (entry.trainable !== true)
    errors.push(`${label}: sample is not explicitly approved for training`);
  if (entry.split !== "train" && entry.split !== "bench") errors.push(`${label}: invalid split`);
  if (!existsSync(samplePath)) {
    errors.push(`${label}: missing ${entry.file}`);
    return;
  }
  const content = readFileSync(samplePath);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== entry.sha256) errors.push(`${label}: content hash mismatch`);
  if (content.byteLength > MAX_SAMPLE_BYTES)
    errors.push(`${label}: sample exceeds the ${MAX_SAMPLE_BYTES}-byte cap`);
  const actualSizeBucket = sizeBucketOf(content.byteLength);
  if (actualSizeBucket !== entry.sizeBucket)
    errors.push(`${label}: size bucket ${entry.sizeBucket} does not match ${actualSizeBucket}`);
  validateSourcePolicy(label, entry, samplePath, errors);
  const noticeDir = resolve(ROOT, entry.notice);
  if (!noticeDir.startsWith(join(ROOT, "THIRD_PARTY_NOTICES/")) || !existsSync(noticeDir)) {
    errors.push(`${label}: missing or unsafe notice path ${entry.notice}`);
    return;
  }
  const noticeFiles = readdirSync(noticeDir);
  if (!noticeFiles.some((file) => /^(COPYING|LICEN[CS]E)/i.test(file))) {
    errors.push(`${label}: ${entry.notice} has no upstream license text`);
  }
  const policy = sourcePolicyFor(entry.source);
  for (const required of policy?.requiredNoticeFiles ?? []) {
    if (!noticeFiles.includes(required)) errors.push(`${label}: ${entry.notice} omits ${required}`);
  }
}

function sourcePolicyFor(source: string): SourcePolicy | undefined {
  const parsed = parsePinnedSource(source);
  return parsed ? SOURCE_POLICIES.get(parsed.repo) : undefined;
}

function validateSourcePolicy(
  label: string,
  entry: ManifestEntry,
  samplePath: string,
  errors: string[],
): void {
  const parsed = parsePinnedSource(entry.source);
  if (!parsed) return;
  // Attribution must come from the sample's own upstream: an existing notice directory for a
  // different repository would still ship the wrong license text.
  if (entry.notice !== noticePathFor(parsed.repo))
    errors.push(`${label}: notice ${entry.notice} does not match source repo ${parsed.repo}`);
  const policy = SOURCE_POLICIES.get(parsed.repo);
  if (!policy) {
    errors.push(`${label}: source is absent from the pinned source allowlist`);
    return;
  }
  if (!/^[0-9a-f]{40}$/.test(policy.ref) || parsed.commit !== policy.ref)
    errors.push(`${label}: source commit does not match configured immutable ref ${policy.ref}`);
  if (entry.license !== policy.license)
    errors.push(`${label}: license does not match source policy ${policy.license}`);
  if (entry.trainable !== policy.trainable)
    errors.push(`${label}: trainable flag does not match source policy`);
  const sourcePath = parsed.path.replace(/#chunk\d+$/, "");
  if (sourcePath.split("/").some(isNoticeFile))
    errors.push(`${label}: source path contains a license or notice component`);
  if (
    policy.excludePrefixes?.some(
      (excluded) => sourcePath === excluded || sourcePath.startsWith(`${excluded}/`),
    )
  ) {
    errors.push(`${label}: source path is excluded by its license policy`);
  }
  if (hasIncompatibleSpdx(readFileSync(samplePath, "utf8"), entry.license))
    errors.push(`${label}: file-level SPDX license is incompatible with manifest license`);
}

function sourcePolicies(): Map<string, SourcePolicy> {
  const policies = new Map<string, SourcePolicy>();
  const add = (repo: string, policy: SourcePolicy): void => {
    policies.set(repo, policy);
    policies.set(repo.split("/").slice(-2).join("__"), policy);
  };
  for (const entries of Object.values(ossSources.languages)) {
    for (const entry of entries) {
      if (!entry.repo.startsWith("http")) continue;
      add(entry.repo, entry);
    }
  }
  for (const locale of Object.values(nlSources.locales)) {
    for (const entry of locale.gitDocs) add(entry.repo, entry);
  }
  return policies;
}

main();
