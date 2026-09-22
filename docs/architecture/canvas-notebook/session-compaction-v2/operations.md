# Session Compaction V2 Operations

> **Parity refresh (2026-09-22):** Current Hermes main at
> `e2f8a0731bf26e95b31e35d73e71e183a1045b81` replaces the older multi-digest
> lean design with one bounded summary call plus deterministic anchors, user
> excerpts and recovery pointers. The implementation and rollout plan is
> [hermes-parity-refresh-plan.md](./hermes-parity-refresh-plan.md). Statements
> below that keep Lean as a measurement-only variant describe the previous
> shipping decision and remain as historical rollout evidence until SC-P10
> through SC-P14 are complete.

## Shipping decision

Canvas currently ships the Hermes V2 summary path with the conservative Hermes
`legacy` tail policy. The deterministic unit selector, exact anchors, rolling
LLM summary contract, recovery sections, fail-closed validation, retries and
anti-thrash protection are active. The smaller `lean` tail remains a measured
variant rather than the default.

This separates two decisions that are easy to conflate:

- `CANVAS_PI_COMPACTION_ROLLOUT` selects the summary rollout (`legacy`,
  `shadow`, or `v2`). Its default is `v2`.
- The tail policy remains `legacy`, matching the pinned Hermes default. The
  `lean` policy is evaluated in shadow measurements and can be supplied by an
  explicit runtime policy after the production gates below pass.

Micro-compaction is not part of Canvas V2. There is no environment switch or
post-turn rewrite loop for it. This preserves the provider prompt-cache prefix
between episodic compaction boundaries.

## Runtime settings and overrides

Admins configure the tail mode and optional summary route in **AI providers &
models → Context compaction**. A summary route is always the exact catalog
identity `providerInstallationId/modelId`, never only a provider id. The model
picker only offers enabled models from verified provider installations.

The saved setting is organization-scoped (`ai_organization_compaction_settings`)
and revisioned: one organization can never change another organization's route.
The legacy instance-wide `pi-runtime-config.json` remains a bootstrap fallback
only when that organization has not saved a compaction setting. It is not
written by the admin panel. Saving **Use main model** is explicit and suppresses
that legacy summary-route fallback for the organization.

Deployment overrides take precedence and are intentionally visible but locked
in the Settings UI:

- `CANVAS_PI_COMPACTION_TAIL_MODE=legacy|lean`
- `CANVAS_PI_COMPACTION_SUMMARY_MODEL=<providerInstallationId/modelId>`

An invalid or stale configured summary identity never blocks a session: Canvas
uses the request's pinned main model. Changes are read at the next safe
request/run boundary; an already streaming chat or automation is not mutated.
The settings preview is a default-model budget preview. The in-chat context
status is authoritative for the actual request because it also includes prompt,
tool, media and output-reserve costs. It displays only a catalog-and-runtime
validated auxiliary identity (or `main-model fallback`), plus its source and
the trigger/tail-target copied from the same request budget snapshot; stale or
environment-only raw identities are never serialized to the client.

## Rollout modes

| Mode | User-visible summary path | Deterministic pruning | Shadow scorecard | Intended use |
| --- | --- | --- | --- | --- |
| `legacy` | V1 LLM summary | Off | Off | Immediate rollback |
| `shadow` | V1 LLM summary | Off | Legacy/lean selection only | Content-free production measurement |
| `v2` | Validated Hermes V2 rolling summary | On | Off | Shipping mode |

All three modes retain atomic history-unit selection. Rolling that safety
boundary back could split assistant tool calls from their results, so the V1
rollback is intentionally limited to summary generation and deterministic
pruning.

Changing the environment value requires recreating the runtime process. An
unknown value fails to the tested `v2` default rather than selecting a partial
state.

## Shadow telemetry

Set `CANVAS_PI_COMPACTION_ROLLOUT=shadow` on a canary instance. When a
compaction candidate is prepared, Canvas executes the legacy summary path and
logs one `[PI Compaction Shadow]` JSON event. The event contains only counts,
token estimates, basis-point savings, invariant results and selection time. It
does not contain a session ID, message text, tool arguments, file paths or
summary text.

The persisted-session evaluator uses the same projection without writing to
the database:

```sh
npm run eval:pi:compaction-v2
```

Optional evaluation bounds:

- `CANVAS_PI_COMPACTION_EVAL_SESSION_LIMIT` (default `25`)
- `CANVAS_PI_COMPACTION_EVAL_CONTEXT_WINDOW` (default `262144`)
- `CANVAS_PI_COMPACTION_EVAL_OUTPUT_TOKENS` (default `8192`)

The report is deliberately aggregate and content-free. A report with zero
eligible sessions is not rollout evidence.

## Enablement gates

Before enabling `v2` on a canary, require all of the following:

- zero history-partition losses;
- zero newly orphaned tool groups;
- zero latest-user or latest-assistant anchor failures;
- projected savings above five percent for every compaction-eligible session;
- no final-request overflow loop in runtime tests;
- no material p95 selection-latency regression.

Before making the `lean` tail a default, additionally compare legacy and lean
on sanitized real-session shapes and run factual recall evaluation with the
same provider/model mix used in production. Lean must not regress recall,
cache-read economics or compaction-boundary latency. Until that evidence
exists, legacy remains the default even when lean projects more token savings.

## Current verification evidence

The committed deterministic scorecard uses a 241-message, tool-heavy,
production-shaped fixture. It currently projects:

| Variant | Raw history retained | Projected savings | Partition loss | New orphan groups | Anchor failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy tail | 28,058 tokens | 78.30% | 0 | 0 | 0 |
| Lean tail | 15,128 tokens | 88.30% | 0 | 0 | 0 |

The local Docker development database available during SC-P09 contained zero
eligible persisted sessions, so it was not treated as real-session rollout
evidence. That absence is why the more aggressive lean tail is not selected as
the default.

## Rollback

1. Set `CANVAS_PI_COMPACTION_ROLLOUT=legacy`.
2. Recreate the application process; do not rebuild the database.
3. Confirm new compaction attempts use the legacy summary path and that the
   context bar still reports the shared trigger-relative budget.
4. Preserve compaction attempt telemetry and the affected session for
   diagnosis. Existing V2 summaries remain valid reference-only summaries;
   the rollback does not delete or rewrite history.
5. Re-enable `shadow` before returning to `v2` if the incident involved
   summary recall, selection savings or provider behavior.

## P14 canary runbook

Use one canary application process only. Start with the validated V2 summary
path and the Hermes-compatible legacy tail:

```sh
CANVAS_PI_COMPACTION_ROLLOUT=v2
CANVAS_PI_COMPACTION_TAIL_MODE=legacy
```

For at least 25 eligible compaction attempts, retain the normal attempt rows
and inspect only the content-free `[PI Compaction]` JSON events. Correlate an
attempt through its opaque `attemptId`; never add a session ID, prompt, tool
argument, provider error message or contract fingerprint to log collection.
The required fields are stage, provider/model route, token counters,
`durationMs`, terminal state/reason and retry time. The canary passes only if:

- no attempt commits after `aborted`, `stale_snapshot`, idle or total timeout;
- no `cooldown_active` or `breaker_active` loop repeats provider work;
- every successful attempt reports a strictly smaller sendable projection;
- scorecard partition and orphan-tool-group counts remain zero; and
- observed p95 `attempt_finished.durationMs` is materially below the retired
  multi-digest baseline. The deterministic fixture baseline is 75 percent
  lower (375 ms vs 1,500 ms) and guards architectural regressions; it is not a
  substitute for provider-specific production latency monitoring.

After that legacy-tail canary is stable, enable Lean only on a separate canary
process:

```sh
CANVAS_PI_COMPACTION_TAIL_MODE=lean
```

Do not mix this comparison with a summary-model change. Compare the same
provider/model mix, context-window bands (small, 256k and large) and tool-rich
traffic. Require the legacy invariants above plus no recall, cache-read-cost or
p95-boundary-latency regression before making Lean the organization default.

### Immediate rollback

If Lean has an invariant, recall, provider or latency incident, recreate only
the affected application process with `CANVAS_PI_COMPACTION_TAIL_MODE=legacy`.
For a summary-path incident also set `CANVAS_PI_COMPACTION_ROLLOUT=legacy`.
Do not delete session rows, attempt records, V2 summaries or raw history.
Keep the correlated `attemptId` telemetry and the authorized session record for
diagnosis, then return through `shadow` before re-enabling the affected path.
