# Security review records

This directory contains internal remediation records and the raw artifacts referenced by them. Treat all contents as confidential: the reports describe unpatched attack paths and the archives contain scanner evidence.

- The active remediation tracker is [2026-07-29-security-review.md](2026-07-29-security-review.md).
- `artifacts/` mirrors the raw outputs retained for this review. An archive name ending in `partial` or `interrupted` is **not** a completed scan and must not be treated as proof that its scope is clean.
- Do not publish this directory or its artifacts in a public repository, issue tracker, or release attachment.

Each archive is listed with a SHA-256 checksum in the review report. Verify a copied archive before using it:

```sh
shasum -a 256 docs/security/artifacts/<archive-name>.tar.gz
```
