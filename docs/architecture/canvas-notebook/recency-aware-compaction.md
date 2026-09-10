# Recency-aware compaction

## Invariants

- Before selecting a protected tail, live/manual/automation candidates use the
  same bounded tool-result representation as final payload normalization.
  Projection never mutates persisted messages or changes tool-call IDs.
- The summary model receives a separate reference-only recent-conversation
  block in every digest and final summary call. It draws from the latest three
  user turns and up to seven visible message excerpts, prioritizing the latest
  real user request. Tool results, thinking, and synthetic user records are not
  promoted to user instructions.
- Orientation is capped at 3,000 estimated tokens or 5% of the model window,
  whichever is smaller. Its framing is preserved and its budget is reserved
  separately from historical content. It never advances summary watermarks.
- Recent corrections, current goals, valid constraints, deadlines and open work
  take precedence over superseded history. Manual focus is a relevance hint,
  not an exact-substring validation requirement.
- Small sources (at most 12,000 characters and fitting the model-specific source
  allowance) use one direct summary. Larger sources use digests without sending
  the whole source again to the final call. Source, prior summary, anchors and
  historical user excerpts receive separate budgets; each digest gets a share.
- All source-record framing escapes reference text before budgeting, including
  model-generated digests, prior summaries, anchors and user excerpts. Embedded
  closing tags cannot escape the reference envelope; escaping expansion counts
  toward input limits. This is framing hardening, not a guarantee against all
  semantic prompt injection.
- One total deadline covers all digest calls, repairs and final generation.
  Summary acceptance still requires valid structure, preserved history coverage,
  a smaller effective context, and the normal generation/revision checks.
- Automation recovery rejects unsafe/empty candidates. Context overflow uses
  the minimum required size rather than reporting an empty projection as 0%.

## Diagnostics and UI

`candidate_projection` logs raw/projected estimates, message count, required and
available history tokens and overflow flags. `summary_orientation` logs source,
excerpt count, estimated size and whether manual focus was applied.
`summary_budget_selected` includes `strategy` and `digestCount`. No conversation
content is added to these events. Attempt before/after metrics now compare the
complete effective context rather than a preselected tail with the final context.

`retained_context_too_large` distinguishes the required conversation segment
from fixed-request overhead (`fixed_context_too_large`) and transfer size
(`payload_bytes_exceeded`). Chat and menu use the same translated reason.

## Regression checks

- `npm run test:pi:compaction-candidate-normalization`: 29-message search incident,
  automatic/manual candidates, intact raw messages/tool pairs, real user overflow,
  rejected empty automation recovery and nonzero overflow measurement.
- `npm run test:pi:compaction-orientation`: topic correction, short confirmation,
  focus paraphrase, excluded tool/thinking instructions, secret redaction, bounded
  framing, focus in all stages, tool-only source with a current user task,
  unchanged watermark, direct fast path and cross-chunk deadline.
- Existing summary/digest, policy, selection, pruning, recovery, context UI and
  rollout suites; live/automation integration tests against dedicated empty
  PostgreSQL databases on the managed local service.
- `npm run test:pi:summary-framing`: hostile closing tags in every source section,
  pre-encoded entities, tight budgets and direct/digest-backed model prompts.
- `npm run test:pi:context-ui-browser`: real ChatHeader/ChatRuntimeNotice components,
  eight desktop/mobile checks covering streaming/idle/abort, stale estimates,
  overflow, manual compact control and retained-context error wording. These are
  deterministic component-browser tests, not a production/provider end-to-end run.

Provider responses in regression tests are deterministic doubles. Semantic
summary quality still needs confirmation with real conversations after deployment.
