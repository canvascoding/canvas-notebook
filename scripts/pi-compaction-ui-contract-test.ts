import assert from 'node:assert/strict';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { mapPersistedChatMessage } from '../app/components/canvas-agent-chat/chatMessageMapping';
import {
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeCompactionStatus,
} from '../app/lib/chat/runtime-status';

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

console.log('pi-compaction-ui-contract-test: ok');
