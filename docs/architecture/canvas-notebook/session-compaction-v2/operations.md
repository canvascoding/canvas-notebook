# Session Compaction V2 Operations

## Shipping decision

Canvas ships the Hermes V2 summary path with the conservative Hermes
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
