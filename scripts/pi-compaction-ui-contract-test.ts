import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { mapPersistedChatMessage } from '../app/components/canvas-agent-chat/chatMessageMapping';
import {
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeCompactionStatus,
  type RuntimeStatus,
} from '../app/lib/chat/runtime-status';
import { getContextStatusDisplay } from '../app/components/canvas-agent-chat/contextStatusDisplay';
import { createPiRuntimeContextStatusProjection } from '../app/lib/pi/runtime-context-status';
import { parseClientMessage } from '../app/lib/websocket/protocol';
import type { PiContextBudgetSnapshot } from '../app/lib/pi/context-budget';
import type { PiHistoryComposition } from '../app/lib/pi/history-budget';

const runtimeServiceSource = fs.readFileSync('app/lib/pi/runtime-service.ts', 'utf8');
const chatControlSource = fs.readFileSync('app/components/canvas-agent-chat/useChatControlActions.ts', 'utf8');
const chatHeaderSource = fs.readFileSync('app/components/canvas-agent-chat/ChatHeader.tsx', 'utf8');
assert.match(
  runtimeServiceSource,
  /case 'compact':\s+return runtimeInstance\.startCompaction\(focusTopic\);/u,
  'WebSocket control must acknowledge compaction start instead of awaiting the complete provider operation',
);
assert.match(chatControlSource, /error\.code === 'REQUEST_TIMEOUT'/u);
assert.match(
  chatControlSource,
  /wsRequest<\{ success: boolean; status\?: RuntimeStatus \}>\('get_status'/u,
  'a lost compaction acknowledgement must reconcile authoritative runtime status before showing an error',
);
assert.match(
  chatHeaderSource,
  /compactionStatus\?\.state === 'succeeded'/u,
  'candidate/no-op token metrics must not be presented as an applied compaction',
);

const baseStatus: Omit<RuntimeCompactionStatus, 'state' | 'reasonCode'> = {
  attemptId: 'compact-contract-test',
  trigger: 'manual',
  retryAfter: null,
  omittedMessageCount: 4,
};

assert.equal(getRuntimeCompactionStatusTranslationKey(undefined), null);
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'running',
  reasonCode: null,
}), 'compactionStatusRunning');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'failed',
  reasonCode: 'payload_bytes_exceeded',
}), 'compactionStatusPayloadTooLarge');
assert.equal(getRuntimeCompactionStatusTranslationKey({ ...baseStatus, state: 'failed', reasonCode: 'retained_context_too_large' }), 'compactionStatusRetainedTooLarge');
assert.equal(getRuntimeCompactionStatusTranslationKey({ ...baseStatus, state: 'failed', reasonCode: 'fixed_context_too_large' }), 'compactionStatusFixedTooLarge');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'deferred',
  reasonCode: 'summary_provider_error',
}), 'compactionStatusSummaryProviderError');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'deferred',
  reasonCode: 'cooldown_active',
}), 'compactionStatusCooldown');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'failed',
  reasonCode: 'summary_idle_timeout',
}), 'compactionStatusSummaryIdleTimeout');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'failed',
  reasonCode: 'summary_total_timeout',
}), 'compactionStatusSummaryTotalTimeout');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'stale',
  reasonCode: 'stale_snapshot',
}), 'compactionStatusStale');

const compactBreak = {
  role: 'compact-break',
  attemptId: 'compact-persisted-attempt',
  kind: 'automatic',
  timestamp: '2026-08-27T16:00:00.000Z',
  omittedMessageCount: 12,
} as unknown as AgentMessage;
const mapped = mapPersistedChatMessage(compactBreak, 'Run stopped');
assert.equal(mapped.compactMeta?.attemptId, 'compact-persisted-attempt');
assert.equal(mapped.compactMeta?.omittedMessageCount, 12);

const publicStatus = {
  ...baseStatus,
  state: 'failed',
  reasonCode: 'summary_provider_error',
} satisfies RuntimeCompactionStatus;
assert.equal('summaryText' in publicStatus, false);
assert.equal('prompt' in publicStatus, false);
assert.equal('messages' in publicStatus, false);

const baseRuntimeStatus = {
  sessionId: 'context-status-contract',
  phase: 'idle',
  activeTool: null,
  pendingToolCalls: 0,
  followUpQueue: [],
  steeringQueue: [],
  canAbort: false,
  contextWindow: 262_000,
  estimatedHistoryTokens: 100_000,
  availableHistoryTokens: 200_000,
  contextUsagePercent: 50,
  includedSummary: false,
  omittedMessageCount: 0,
  summaryUpdatedAt: null,
  lastCompactionAt: null,
  lastCompactionKind: null,
  lastCompactionOmittedCount: 0,
} satisfies RuntimeStatus;

assert.deepEqual(getContextStatusDisplay({
  ...baseRuntimeStatus,
  lastProviderInputTokens: 140_000,
  nextRequestEstimatedTokens: 185_000,
}), {
  source: 'next_request', usedTokens: 185_000, contextWindow: 262_000,
}, 'idle status must retain the same next-request basis as streaming; provider actual is historical');
assert.deepEqual(getContextStatusDisplay({
  ...baseRuntimeStatus,
  phase: 'streaming',
  lastProviderInputTokens: 140_000,
  nextRequestEstimatedTokens: 185_000,
}), {
  source: 'next_request', usedTokens: 185_000, contextWindow: 262_000,
}, 'active status must present the current serialized-request estimate separately');
assert.deepEqual(getContextStatusDisplay({
  ...baseRuntimeStatus,
  nextRequestEstimatedTokens: 285_000,
  nextRequestBudgetExceeded: true,
}), {
  source: 'next_request', usedTokens: 285_000, contextWindow: 262_000,
}, 'an idle overflow must retain the failing next-request estimate for recovery');

const composition = {
  llmMessages: [],
  keptMessages: [],
  omittedMessages: [],
  includedSummary: true,
  outputReserveTokens: 20_000,
  availableHistoryTokens: 220_000,
  triggerHistoryTokens: 110_000,
  targetHistoryTokens: 22_000,
  estimatedHistoryTokens: 88_000,
  availableHistoryBytes: 1_000_000,
  estimatedHistoryBytes: 10_000,
  contextBudgetExceeded: false,
  payloadBudgetExceeded: false,
  minimumRequiredTokens: 1,
  minimumRequiredBytes: 1,
  softThresholdExceeded: false,
} satisfies PiHistoryComposition;
const roughProjection = createPiRuntimeContextStatusProjection({
  composition,
  contextWindow: 262_000,
});
assert.deepEqual(roughProjection, {
  contextPressure: {
    pressureTokens: 88_000,
    source: 'rough_estimate',
    effectiveInputBudgetTokens: 220_000,
    triggerTokens: 110_000,
    targetTokens: 22_000,
    percentOfTrigger: 80,
  },
  nextRequestEstimatedTokens: 130_000,
  nextRequestBudgetExceeded: false,
  nextRequestEstimateSource: 'rough_estimate',
});
assert.deepEqual(getContextStatusDisplay({
  ...baseRuntimeStatus,
  ...roughProjection,
  lastProviderInputTokens: 140_000,
}), {
  source: 'pressure',
  pressureTokens: 88_000,
  pressureSource: 'rough_estimate',
  effectiveInputBudgetTokens: 220_000,
  triggerTokens: 110_000,
  targetTokens: 22_000,
  percentOfTrigger: 80,
  contextWindow: 262_000,
}, 'the bar must use the same trigger denominator as compaction, not the full model window');

const exactProjection = createPiRuntimeContextStatusProjection({
  composition,
  contextWindow: 262_000,
  finalSnapshot: {
    contextWindowTokens: 262_000,
    effectiveInstructionTokens: 8_000,
    toolSchemaTokens: 4_000,
    runtimeProviderOverheadTokens: 64,
    multimodalTokens: 512,
    safetyReserveTokens: 6_000,
    outputReserveTokens: 20_000,
    estimatedTotalTokens: 138_576,
    hardHistoryTokens: 223_424,
    triggerHistoryTokens: 111_712,
    targetTailTokens: 22_342,
    contextBudgetExceeded: false,
    payloadBudgetExceeded: false,
  } as PiContextBudgetSnapshot,
});
assert.equal(exactProjection.contextPressure.pressureTokens, 100_000);
assert.equal(exactProjection.contextPressure.source, 'serialized_request');
assert.equal(exactProjection.contextPressure.triggerTokens, 111_712);
assert.equal(exactProjection.nextRequestEstimatedTokens, 138_576);

assert.equal(parseClientMessage({
  type: 'control',
  sessionId: 'focus-session',
  action: 'compact',
  focusTopic: 'database migration safety',
}).ok, true);
assert.equal(parseClientMessage({
  type: 'control',
  sessionId: 'focus-session',
  action: 'compact',
  focusTopic: 'x'.repeat(501),
}).ok, false);

const en = JSON.parse(fs.readFileSync('messages/en.json', 'utf8')) as { chat: Record<string, string> };
const de = JSON.parse(fs.readFileSync('messages/de.json', 'utf8')) as { chat: Record<string, string> };
for (const key of [
  'contextPressureLabel',
  'contextPressureTooltip',
  'contextTargetMarker',
  'contextTargetMarkerWithValue',
  'compactWithFocus',
  'compactionMetrics',
  'compactionStatusCooldown',
  'compactionStatusSummaryProviderError',
  'compactionStatusSummaryIdleTimeout',
  'compactionStatusSummaryTotalTimeout',
]) {
  assert.ok(en.chat[key], `missing English chat translation: ${key}`);
  assert.ok(de.chat[key], `missing German chat translation: ${key}`);
}

console.log('pi-compaction-ui-contract-test: ok');
