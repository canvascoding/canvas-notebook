# Context status measurement

The chat notice and header use `getContextStatusPresentation`. Their percentage
always has the same numerator, denominator, freshness and severity. When pressure
is available, the denominator is the automatic compaction trigger, not the model
window. The small marker is the post-compaction target on that same scale.

The runtime measures the complete effective history (including an existing
summary) with `preparePiFinalPayload`, without invoking a model, changing the
history, or attempting compaction. This is still a heuristic token estimate, not
a provider tokenizer count. In particular, status-only measurement must not use
an automatically selected smaller tail and pretend compaction has happened.
The actual send/preflight safety checks remain independent and unchanged.

## Lifecycle and freshness

- Completed user/assistant/tool-result messages, context configuration changes,
  compaction and error persistence invalidate a context revision.
- Status reads share one asynchronous normalization per revision. Streaming
  deltas and streaming/idle/aborting phase transitions do not change the basis.
- While normalization runs, the previous snapshot remains explicitly labelled.
  Late results cannot overwrite a newer revision or a disposed runtime.
- Failed normalization is shown as unavailable; repeated live status reads do
  not retry until the context changes.
- Without a live runtime, saved history uses the same normalization and full
  history selection. A scoped content fingerprint caches up to 32 measurements
  for 30 seconds, including unavailable results. It includes the model,
  instructions, tools, history and normalization options.
- Saved-context status includes current memory, file-tree and tool instructions.
  Temporary editor/turn context is not persisted by this change; this limitation
  is labelled in the menu and the live measurement replaces it on send.

Provider-reported input tokens belong to the **last sent request**. They are shown
separately, never substituted for the next-request context. Measurement logs
contain scope/revisions, numerical components and deltas only, not prompts,
messages, tool arguments, attachments, reasoning or secrets.

## UI semantics

Below 80% of the trigger: no pressure warning. At 80–99%: yellow warning.
At 100% and above: yellow automatic-summary-required notice, with the true
percentage in text and a visually clamped bar. Red is reserved for current
token/attachment budget overflow or failed compaction. Stale pressure does not
produce a current warning. Legacy responses use one shared fallback in both views.

## Verification

- `npm run test:pi:compaction-ui`: status contract, cache races, disposal,
  normalization parity, scoped reload cache, instruction changes, oversize
  projection and severity/fallback cases.
- `npm run test:pi:live-compaction`: actual runtime phase stability, durable
  message invalidation, compaction persistence and failure handling.
- `npm run test:pi:context-ui-browser`: real header/menu/notice components with
  controlled status events, desktop and 390px mobile viewports. Unrelated
  workspace/navigation services are stubbed; no server, provider or container.
  Covers phase changes, refresh/failure/recovery, actual overflow, trigger
  crossing, target marker, menu controls and legacy fallback; captures screenshots.
- `npm run build` and targeted ESLint/TypeScript checks.

After deployment, check one long real chat through streaming, response end,
compaction and reload. A content change may legitimately change the count; a
phase transition alone must not. Compare metadata-only `[ContextStatus]` logs
when investigating a discrepancy.
