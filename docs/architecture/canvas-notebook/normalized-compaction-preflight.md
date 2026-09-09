# Normalized live compaction preflight

## Incident and cause

On 2026-09-09, a live session on 2026.9.8.1 compacted after six tool calls.
The complete raw history estimate was 194,775 tokens, above the 171,963-token
trigger. Summary generation took 126 seconds. Logs did not record the complete
normalized input, so they cannot prove that this individual compaction was needed.

`transformContext` previously selected an automatic history tail before preparing
the provider payload. Large raw tool results could exceed the rough threshold,
causing uncovered messages to be omitted. Even if the normalized tail fit, the
coverage guard then correctly refused to send it and forced compaction. The
premature selection, not the coverage guard, was the defect.

## Change

1. Project messages with the existing loaded-context/provider text and inline-image
   limits. Do not modify originals or introduce tighter truncation limits.
2. Compose the **full effective history**, including any existing summary and all
   uncovered messages. No automatic tail selection occurs in preflight.
3. Inject runtime context and prepare the canonical provider payload. Compare its
   serialized token estimate with the automatic threshold and hard limits.
4. If it fits below the trigger, reuse that exact prepared payload for dispatch.
   Otherwise run the existing bounded compaction/recovery path on the originals.

The prior status-measurement fix was display-only. This change connects the live
decision to the same normalized request budget. Live status also projects tool
text before its full-history byte guard, matching persisted-context loading and
preventing false overflow notices for raw results over 8 MB.
It does not alter manual compaction,
summary generation, persistence, shared selection policy, or automation scheduling.
Unprojectable histories exceeding the full-history byte guard still fail closed;
an empty overflow projection is never treated as a sendable request.

## Diagnostics

`[PI Compaction] normalized_preflight` is emitted when projection changed messages
or compaction is needed. It records raw/effective/normalized token counts,
normalized bytes, changed/omitted message counts, threshold, decision, and reason.
It never logs prompts, search queries, tool contents, or credentials. Covered old
messages can account for differences between raw and effective totals.

If the full-history byte guard prevented preparation, `completeHistoryMeasured`
is false and normalized sizes are null rather than misleadingly reporting an empty
request. Decision reasons distinguish soft threshold, hard request overflow,
history projection overflow, and summary coverage.

## Regression checks

`npx tsx scripts/pi-normalized-compaction-preflight-test.ts` exercises the real
runtime transform and canonical payload preparation without database or provider
calls: six large results, raw history over 8 MB, preserved call/result pairs and
originals, payload-cache reuse, status/decision consistency, real soft/hard
pressure, byte overflow, and existing summary coverage.
