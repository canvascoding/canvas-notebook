# Bounded MCP source previews

## Failure and change

The production `2026.11.5.2` preview associated with correlation ID
`db9cd3c4-3b1a-48b5-8af7-7d3d9e043dda` spent 7,751 ms scanning sources
inside a principal transaction with a 5,000 ms budget. Native inspection alone
consumed 5,447 ms. A slow filesystem read therefore expired SQL authorization
although the SQL statements themselves completed within their limits.

Historical previews now authorize every catalogue read in a fresh, bounded
transaction. Filesystem reads and parsing do not retain an SQL transaction.
Every phase rechecks the genuine principal, current workspace scope, and shared
admission fence. Two complete observations must agree before issuing a plan.
SQL/principal budgets and apply-time authority checks are unchanged.

Only the historical preview collector batches physical registry inspection into
four complete catalogue snapshots. Default execution collectors retain their
per-file checks. The private per-connection preview marker is removed in a
`finally` block. Byte, inode, namespace, native-state and final-source
revalidation remain mandatory; source gaps cannot yield executable plans.

Passive scan diagnostics distinguish read waits, parsing work, total SQL and
maximum authority-phase duration without logging paths, content or credentials.

The MCP edit declaration also flattens nested object alternatives so `edits` and
`operations` expose typed items through adapters. Generated descriptions list
required fields per kind. The original strict HTTP/PI schema and runtime decoder
still reject incomplete or mixed variants.

## Verification

The regression first failed with `PATH_TIMEOUT` when an actual physical file
read took 5,200 ms. It passed after the change. PostgreSQL `pg_stat_activity`
confirmed no source transaction remained open during that file read. Changing
rights, grants, tokens or native sources during the read fails closed.

Completed targeted suites: 26 real HTTP/PostgreSQL groups; nine authenticated
web-route groups; ten Copy-owner groups; 66 source-collector tests; three
telemetry tests; four edit-schema tests; nine real edit-dispatch groups.
Targeted ESLint, full production `npm run build`, and Docker production build
passed. The built image's four changed application files were independently
hashed against the worktree. Private `artifacts` are excluded from all image
layers.

All 17 browser/OAuth acceptance groups passed on the source-verified image,
including persisted settings, editor links and reload, UTF-8 pagination,
revision conflicts, upload continuation across a real container restart,
checksums, idempotency, twelve sequential replacements and incomplete-source
rejection. The direct OAuth/MCP large-workspace run also passed all six executable delete
previews against 300 synthetic native documents plus 50 physical Markdown
sources (and the automatically created starter document). Preview durations
were 23,657–25,647 ms with zero retries; original target hashes were unchanged.
A separate 300-document / 6,000-reference workspace returned `PATH_TOO_LARGE`
for all six previews, without executable plans. One retryable `PATH_BUSY` was
retried successfully.

These large synthetic fixtures copied the original API-created Yjs bytes into
fresh API-created workspaces, with new document/lineage identities and correct
workspace/organization scope. Physical projections matched the original source
SHA-256 values. The smaller browser suite exercised actual MCP creation and
mutation. Existing fixtures with stale filesystem anchors were left unchanged.
The installed Codex `app-server` MCP client also passed all twelve large
previews (six ready plans and six `PATH_TOO_LARGE` results), schema discovery,
OAuth DCR/PKCE, native/legacy reads and pagination, revision conflicts, uploads,
replacement/idempotency/status checks and source-coverage rejection. Both nested
edit fields arrived as typed arrays. All 50 physical sources were read through
that client and matched their original SHA-256 values; an independent final
filesystem verification also passed. One retryable `PATH_BUSY` occurred in the
Codex size-limit case and succeeded on retry. No model turn or persisted chat
was created.

Across 51 large-workspace preview scan measurements, the maximum observed
authority transaction phase was 213 ms; the five-second limit was unchanged.
The tested application image was
`sha256:75e2adfba67e4cee5860f3db284e904f8f3515ced9c3aabf74a3c59d73a76ce2`.
The original managed Notebook image and mounts were restored after acceptance. Private credentials and full raw artifacts are excluded
from this repository.

## Hosted adapter limitation

For the original production timeout, the server log and raw JSON text both
contained `error_code: PATH_TIMEOUT`; the hosted connector's structured result
rewrote that field to `INVALID_ARGUMENT`, while retaining `code: PATH_TIMEOUT`.
That is a separate adapter transformation. This change preserves the canonical
server error and `isError` semantics; local Codex acceptance cannot prove that a
hosted adapter has refreshed. Recheck hosted schemas and canonical errors after
an approved deployment and connector refresh.

No Knowledge-Sync, production mutation, release or production deletion is part
of this acceptance. A preview is historical data; apply must reauthorize and
reobserve all sources independently.
