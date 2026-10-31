# Bounded retained human Move proof groups

Date: 2026-10-31. Product source: `ce06019b8b1973895e519c960fd319b2730bd5cb`.

An original human Move previously repeated the Header → Target → State proof
reader and the full current-policy check for each document, including proofs
already materialized under the continuously retained native owner.

`proveWorkspaceOperationOriginalMoveJobQuiescenceGroup` now uses the existing
fresh set reader for at most eight documents in a direct human job. The set
reader retains the original per-document validator. An entirely proven set uses
one full current-policy check within the group. An unproven target retains the
individual proof path. Agent and MCP jobs retain their individual path.

The existing prepared intent, actual SQL owner, workspace and room guards,
human auth/ACL SHARE fences, durable claim, group boundaries and final COMMIT
checks remain in place. There is no positive permission cache, larger phase or
new Review Center/Undo behavior. A failed read is not automatically replayed.

## Actual resource comparison

Both fixtures use regular uploads, including the real starter document, and
public cookie-authenticated preview, apply, preparation/status, native owner and
file-checkpoint paths. They restore their original target path and verify every
unrelated source, its physical bytes and row `xmin`.

| Warm rename through physical checkpoint | Before SQL / leases | After SQL / leases | Summed query duration before → after | Overall duration before → after |
| --- | ---: | ---: | ---: | ---: |
| 10 documents | 4046 / 372 | 3835 / 373 | 5.112 → 4.823 s | 29.740 → 29.978 s |
| 200 documents | 19692 / 1220 | 14600 / 1080 | 48.681 → 34.529 s | 89.837 → 90.065 s |

These are individual local diagnosis windows. At 200 documents they show about
26% fewer SQL calls, 11% fewer leases and 29% lower summed query duration. They
do not establish an overall latency improvement. The next measurement separates
public job completion from physical projection convergence. Summed query time
can overlap; it must not be interpreted as elapsed request time.

The accepted measurements use the same runtime owner bytes as the product
commit. Later test-only changes strengthened the fault read-count assertion and
fixed the MCP test's operational-history observer; they did not change that
runtime path. Full SQL and lease counters agree in all four windows; query,
lease and physical-connection observation failures are zero.

The earlier catalog/hash batching experiment was rejected: its smaller SQL
count did not demonstrate a lease or elapsed-time improvement. Its runtime and
runner changes were restored to the base version before this change.

## Validation

- The 22 existing actual PostgreSQL owner cases and the existing successful
  COMMIT / lost acknowledgement recovery case pass.
- Three new actual PostgreSQL group failures pass: target invalidation, changed
  storage trigger and reply loss after the real set-read reply. Each verifies
  exactly one attempted set read before explicit recovery, unchanged originals
  and the same retained durable operation. Recovery also exercises a genuinely
  unproven target's individual fallback and an actually blocked peer account
  policy write under the human auth fence.
- The 30 actual job-principal cases, actual MCP-principal suite and 11 public MCP
  dispatcher groups pass. The corrected MCP test allows only the closed
  operational request-history SQL profiles and preserves all other private
  schema rows, including auth rows, via hashes and `xmin`. This is dispatcher
  acceptance, not new browser OAuth issuance or installed SDK acceptance.
- The 47 controlled scheduling families pass. These controlled scheduler seams
  do not constitute actual current-authentication acceptance.
- TypeScript 6.0.3 checks 5939 source files with zero diagnostics; scoped ESLint
  and `git diff --check` pass. GitNexus reports LOW risk for the changed owner
  function, one direct runner caller and its bounded Move ancestors.
- `npm run build` and the pinned Linux image build pass. The single managed
  Notebook container is recreated with its existing database and volumes and
  becomes healthy. Image: `sha256:104957130544b712987749f365bb81f44d5532db7440f52da467d17ac4decedc`.
- All 15 Linux storage cases and nine actual browser cases pass with zero skips
  and zero retries: first-session recovery, two lost manual-Create replies,
  mobile save recovery, two live editors/current access revocation, HEIF,
  rich frontmatter links after UI rename, never-opened target rename and source
  move. Review Center stays disabled; the existing Undo-OFF denial stays intact.
- Protected original rows/`xmin`, physical bytes and storage anchors match
  before/after. All eleven other running containers retain their identities.

The acceptance drivers bind the exact clean product commit and image; test
sources are archived into a private driver, without overlaying the running
application. Private logs retain failures as well as corrected passes, source
hashes, resource closure and the actual measured counters.

The regular `test:all` suite has not been rerun for this component. It remains
required before production deployment. API-key management, full API/SDK
acceptance, the remaining performance packages, final CI/reviews and the next
release remain open in the [central plan](../document-write-database-performance-plan.md).
