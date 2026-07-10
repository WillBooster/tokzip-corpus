# Third-party corpus material

The `corpus/` directory contains excerpts of third-party source code and documentation.
The repository's Apache-2.0 license applies only to original tooling and metadata; it does
not relicense corpus samples.

Each `manifest.jsonl` row identifies the exact upstream repository commit and path, the
sample's governing license, its content digest, and a `THIRD_PARTY_NOTICES/` directory.
That directory contains the unmodified license, copyright, attribution, disclaimer, and
NOTICE files supplied by the upstream project. Recipients must comply with those terms.

The corpus build allowlist accepts only these reviewed license expressions:

- `Apache-2.0`
- `BSD-3-Clause`
- `MIT`
- `MIT-like (curl)`
- `MIT/Apache-2.0`

No endorsement by any upstream project is implied. Corpus files preserve upstream content
verbatim when sampling whole source files. Natural-language documentation is converted
into size-bucket chunks; the corresponding manifest row identifies the source document
and bundled license notice for every chunk.
