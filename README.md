# tokzip-corpus

[![Test](https://github.com/WillBooster/tokzip-corpus/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tokzip-corpus/actions/workflows/test.yml)
[![wbfy](https://img.shields.io/badge/wbfy-19.2.1-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

Public, versioned corpus data and generation tooling for training and evaluating
[tokzip](https://github.com/WillBooster/tokzip).

## Contents

- `corpus/`: human-written source code and natural-language samples, with one
  `manifest.jsonl` per language or locale.
- `scripts/corpus/`: pinned permissive-source definitions, fetchers, compliance
  validation, near-duplicate clustering, and the deterministic, source- and size-stratified
  `bench-v2` split.
- `THIRD_PARTY_NOTICES/`: exact license, copyright, attribution, and NOTICE material
  shipped by every upstream repository represented in the corpus.

Every manifest row records the sample path, SHA-256, language, origin, exact upstream
commit and path, license, notice directory, size bucket, training approval, and immutable
train/benchmark assignment. Only MIT, BSD-3-Clause, Apache-2.0, curl's permissive license,
and explicitly dual-licensed MIT/Apache-2.0 sources are accepted.

The Apache-2.0 repository license applies to original tooling and metadata. Corpus samples
remain subject to the per-sample upstream license and attribution recorded in their
manifest rows; the repository license does not replace those terms.

Share-alike, copyleft, source-available, jurisdiction-dependent public-domain, and
unreviewed generated content are intentionally excluded from the distributed corpus.

## Rebuild

```bash
bun install --frozen-lockfile
bun run rebuild
bun run validate
```

The full rebuild fetches natural-language sources first, then all OSS sources so the shared `text`
corpus consistently includes documentation from every pinned repository, and finally
recreates the seeded split. Every source is pinned to an exact Git commit. Validation fails
if a sample lacks an approved license, upstream license bundle, immutable source pin,
manifest membership, or matching content digest.

Code samples preserve upstream file content, including a leading UTF-8 BOM when present.
This keeps the benchmark honest about source text that real file readers can return.

Use `bun run rebuild:quick` for a smaller local smoke corpus built from each language's
designated quick source. The committed corpus is always produced by the full rebuild.

## Consumers

`tokzip` accepts `TOKZIP_CORPUS_DIR=/absolute/path/to/tokzip-corpus/corpus`. Its CI checks
out this repository and records a SHA-256 fingerprint of every benchmark run's exact input.
