/** Fails when committed corpus bytes lack approved provenance or redistribution notices. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORPUS_DIR, type ManifestEntry } from "./shared.ts";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWED_LICENSES = new Set([
  "Apache-2.0",
  "BSD-3-Clause",
  "MIT",
  "MIT-like (curl)",
  "MIT/Apache-2.0",
]);
const PINNED_SOURCE = /@[0-9a-f]{40}:/;

function main(): void {
  const errors: string[] = [];
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
    for (const [index, line] of readFileSync(manifestPath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      const label = `${language.name}/manifest.jsonl:${index + 1}`;
      const entry = JSON.parse(line) as ManifestEntry;
      referenced.add(entry.file);
      samples++;
      validateEntry(dir, label, entry, errors);
    }
    for (const origin of ["human", "llm"]) {
      const originDir = join(dir, origin);
      if (!existsSync(originDir)) continue;
      for (const file of readdirSync(originDir)) {
        if (!referenced.has(`${origin}/${file}`))
          errors.push(`${language.name}/${origin}/${file}: not in manifest`);
      }
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
  if (!PINNED_SOURCE.test(entry.source))
    errors.push(`${label}: source is not pinned to a 40-character commit`);
  if (entry.trainable !== true)
    errors.push(`${label}: sample is not explicitly approved for training`);
  if (entry.split !== "train" && entry.split !== "bench") errors.push(`${label}: invalid split`);
  if (!existsSync(samplePath)) {
    errors.push(`${label}: missing ${entry.file}`);
    return;
  }
  const actualHash = createHash("sha256").update(readFileSync(samplePath)).digest("hex");
  if (actualHash !== entry.sha256) errors.push(`${label}: content hash mismatch`);
  const noticeDir = resolve(ROOT, entry.notice);
  if (!noticeDir.startsWith(join(ROOT, "THIRD_PARTY_NOTICES/")) || !existsSync(noticeDir)) {
    errors.push(`${label}: missing or unsafe notice path ${entry.notice}`);
    return;
  }
  const noticeFiles = readdirSync(noticeDir);
  if (!noticeFiles.some((file) => /^(COPYING|LICENSE)/i.test(file))) {
    errors.push(`${label}: ${entry.notice} has no upstream license text`);
  }
}

main();
