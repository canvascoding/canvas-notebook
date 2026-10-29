# Mobile original-operation replay under a concurrent reader

The peer-status candidate `710dd8317` passed host/Linux production builds,
same-volume startup and all nine CI checks. Its four-case Linux UI batch passed
the two-user live editor/revocation/read-only case and both Agent access cases,
but mobile recovery returned HTTP 500 when retrying an already durable edit.
Protected original rows, bytes and identities remained unchanged.

The actual server error was `ADMISSION_CONFLICT` at the strict native writer
entry. Mobile replay entered that writer even when its callback would only
recognize the already-applied original receipt. Activity entry also acquired
writer admission before it knew whether any mutation was needed. A legitimate
shared reader could therefore reject the completed operation. These two call
sites are unchanged between the preceding accepted source and `710dd8317`;
the new real-lock PostgreSQL case reproduces the failure on `710dd8317`.

Activity entry now makes the shared read observation appropriate for an idle
pin. It still resolves the actual user session with **write permission**, bound
workspace/document identity, owner, lifecycle and reservations. The public
`assertOpen` facade and actual native apply retain strict writer admission.
The actual native writer implementation is byte-for-byte unchanged.

Mobile replay verifies its existing receipt fingerprint/user/document/scope
binding and the deletion-aware original snapshot in actual persisted Yjs state.
When inclusion is already confirmed, it never enters the writer. Durability is
read again and the bound current reader/completion still checks access and
identity before returning. Later peer deletion cannot cause the original delta
to be inserted again. Unapplied operations retain the original strict apply.
An already compacted receipt no longer receives a redundant UPDATE.

Actual admission denials now return HTTP 503 with `COLLABORATION_BUSY`, keeping
the response private and uncached, instead of an unclassified HTTP 500. This
maps a denial only; it grants no success, receipt or mutation authority.

The real PostgreSQL regression retains an independently held shared advisory
lock across the complete retry. It verifies original operation identity and
receipt xmin, native state/vector/sequence and physical file bytes after a
later peer replaces all text. A conflicting key, an unapplied mutation under
the shared reader, an exclusive writer and expired authentication remain
denied. The actual unapplied-mutation denial is also checked through the mobile
HTTP error mapper. The original 15 activity/reader/actual-write boundary cases
and the existing prepare/crash/retry/compaction unit scenario pass.

## Current-source acceptance

Product source `24b234d61b4ef04afdea88c471610443b56a7722` passes host and full
Linux production builds, same-volume startup and all nine CI checks. The fresh
four-case UI batch passes in 80.175 seconds, with zero skipped/flaky/failed cases
and zero Playwright case retries: mobile durable-save recovery after failed
export and later peer changes; two-user live edits followed by actual permission
revocation and a fresh read-only login; both Agent provisioning/access cases.
One existing bounded sign-in transport retry follows an actual HTTP 429; no
rate limits, retry allowances, timeouts or test selections are increased.

All 15 current Linux storage cases pass. The two-user case uses a separately
pinned acceptance-test source in the private driver, with no application-source
overlay. Actual runtime source hashes match the commit. Desktop/mobile captures
are retained; the mobile capture includes a transient remote presence badge.
All other eleven containers remain unchanged. Original rows/xmin, native/file
bytes and identities and physical anchors match across all ten protected
snapshot sections after the entire batch.

Final `test:all`, performance budgets, remaining plan packages, PR/main/release
and production backup plus actual restore remain open. Review Center and Undo
development remain excluded.
