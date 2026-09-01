import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { mapPersistedChatMessage } from '../app/components/canvas-agent-chat/chatMessageMapping';
import {
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeCompactionStatus,
  type RuntimeStatus,
} from '../app/lib/chat/runtime-status';
import { getContextStatusDisplay } from '../app/components/canvas-agent-chat/contextStatusDisplay';

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
}), 'compactionStatusTooLarge');
assert.equal(getRuntimeCompactionStatusTranslationKey({
  ...baseStatus,
  state: 'deferred',
  reasonCode: 'summary_provider_error',
}), 'compactionStatusDeferred');
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
  source: 'actual', usedTokens: 140_000, contextWindow: 262_000,
}, 'idle status must never present a stale next-request estimate as actual usage');
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

console.log('pi-compaction-ui-contract-test: ok');
