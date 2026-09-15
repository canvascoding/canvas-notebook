# File Version & Review Center V1 Operations

## Runtime contract

`FILE_VERSION_CENTER_MODE` is the only V1 core switch. It is read by the
Notebook server process and must never be exposed as a `NEXT_PUBLIC_` value.
Changing it requires recreating the Notebook process; it does not require a
database migration.

| Value | Capture | Center/history/compare | Restore/policy | Intended use |
| --- | ---: | ---: | ---: | --- |
| absent, unknown, `off` | no | no | no | immediate feature rollback |
| `shadow` | yes | no | no | content-free storage and latency measurement |
| `read_only` | yes | yes | no | authorized read-only canary |
| `full` | yes | yes | yes | mutation canary and general release |

Notifications are excluded until FVRC-P08. Existing collaboration-agent
accept/reject routes and normal file read/write routes do not depend on this
switch. A core rollback therefore does not block document access or the legacy
review API.

## Required activation order

Use one deployment ring at a time. Do not skip a stage.

1. Start from `off`; verify Notebook health, ordinary document read/write and
   existing collaboration-agent review actions.
2. Set `shadow`; recreate the Notebook process and collect a non-empty report.
   The report must pass every FVRC-002 storage boundary and the canary p95
   latency guard.
3. Set `read_only`; recreate the process, verify negative authorization tests,
   and validate history/compare with restore and policy mutation unavailable.
4. Set `full` only for the internal mutation ring. Verify stale-current,
   permission-loss, idempotent restore and review-policy CAS tests.
5. Expand the same `full` build to the intended user ring only after the editor,
   file-browser and chat entry-point checks pass. V1 has no separate public
   entry-point environment flag; exposure is controlled by the deployment ring.

The explicit sequence is therefore read-only center, mutation canary, then
entry-point exposure to a wider ring. If independent per-user cohorts are later
required, add a server-authorized rollout service instead of a client flag.

## Shadow report

The evaluator reads only aggregate PostgreSQL counters and already-redacted
FVRC observations. It neither selects nor prints document content, file paths,
workspace IDs, user IDs or object IDs. Use one fixed private fixture for the
complete local transition. The shadow smoke preserves it for the read-only
check; the off smoke deletes it and verifies a subsequent read returns 404:

```sh
export FVRC_ROLLOUT_FIXTURE_PATH=fvrc-702-rollout.md
FVRC_SHADOW_PRESERVE_FIXTURE=true \
  npm run test:file-version-center:shadow-smoke > /tmp/fvrc-shadow-sample.ndjson
docker logs --since 10m canvas-local-prod-notebook 2>&1 \
  | rg '"component":"file_version_center"' \
  >> /tmp/fvrc-shadow-sample.ndjson
npm run eval:file-version-center:shadow -- /tmp/fvrc-shadow-sample.ndjson

# Recreate the same Notebook build in read_only mode, then:
npm run test:file-version-center:mode-smoke

# Recreate it in off mode, then run the same command. This final run removes
# FVRC_ROLLOUT_FIXTURE_PATH after proving normal read/write remains available.
npm run test:file-version-center:mode-smoke
```

Keep the sample file private and delete it after recording the aggregate
report. Production log aggregation should feed the same two JSON event shapes
without writing an intermediate file.

The report fails closed unless all of these are true:

- the evaluator itself runs with `FILE_VERSION_CENTER_MODE=shadow`;
- at least one real Markdown capture run creates durable bindings;
- ordinary document access succeeds while FVRC UI capabilities remain hidden;
- the largest raw version is at most 1 MiB;
- the largest stored blob is at most 1 MiB + 64 KiB;
- the largest lineage is at most 128 MiB and 500 versions;
- the largest workspace is at most 4 GiB;
- capture and read p95 are at most 1000 ms by default.

The 1000-ms p95 is an operational canary guard, not a replacement for the hard
FVRC-002 storage, compare, rate or retention limits. A deployment can set a
stricter positive `FVRC_SHADOW_P95_LIMIT_MS`; raising it requires an explicit
performance review. Capture p95 deliberately measures the complete authenticated
import or write HTTP request, including authorization, file publication,
revision ledger and immutable content binding. It is therefore conservative
relative to the capture-only cost. A zero-sample report is never rollout
evidence.

## Data-preserving rollback

Never run `FILE_VERSION_CENTER_STORAGE_DOWN_SQL` for a feature incident.

1. For restore or policy incidents, change `full` to `read_only` and recreate
   the Notebook process. Confirm mutation capabilities are false and history is
   still readable.
2. For read-path, authorization or disclosure risk, change to `off` and
   recreate the process. Confirm FVRC capabilities are unavailable while normal
   document read/write and existing collaboration review actions still work.
3. Compare aggregate counts before and after the restart. Existing
   `file_version_blobs`, `file_revision_contents`, pending collaboration-agent
   operations, review policies and restore receipts must remain unchanged.
4. Preserve relevant inhaltsfreie observations and the aggregate shadow report
   for diagnosis. Do not export content or identifier-bearing rows into a
   support ticket.
5. Return through `shadow`, then `read_only`, then `full`; repeat every gate.

Stopping capture in `off` does not delete prior versions. Changing the flag also
does not accept, reject or rewrite a pending agent proposal and does not alter a
stored document review preference.

## Operator checks

For the managed local Team-Seat stack, use the
`canvas-local-team-seat-dev` skill. Confirm exactly one labelled stack exists,
all published ports are loopback-only, and run a host production build before
rebuilding the Notebook container.

Minimum checks for every transition:

```sh
npm run test:file-version-center:rollout
npm run test:file-version-center:hardening
npm run test:collaboration:agent-approval
npm run testenv:status
```

Also run changed-file ESLint, `npx tsc --noEmit`, `git diff --check`, and a
production `npm run build`. A transition is blocked by failed authorization,
quota, latency, data-preservation or health gates. External model availability
is reported separately; it must not be confused with Notebook or database
health.

## Support triage

| Symptom | Immediate mode | Check without content |
| --- | --- | --- |
| Restore or policy mutation fails | `read_only` | error-code/outcome counts, DB health, stale/conflict rate |
| Timeline or compare authorization concern | `off` | denied/error-code counts and negative scope suite |
| Storage approaches a hard boundary | `shadow` or `off` | aggregate utilization, retention eligibility, deduplication |
| Entry point is visually broken | keep safe server mode; stop ring expansion | P701 viewport/focus evidence |
| Ollama/provider returns 5xx | unchanged | provider readiness separately from FVRC health |

Support artifacts may contain mode, fixed operation/outcome/error enums,
durations, booleans and bounded aggregate counts. They must not contain document
content, file paths, workspace/user/object IDs, grants, tokens, cookies or
database URLs.
