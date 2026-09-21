import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyPendingLegacyOperation,
  type PendingLegacyOperation,
} from '../app/lib/file-version-center/proposal-legacy-classification';

const hash = 'a'.repeat(64);
const proof = (ref: string) => ({ ref, sha256: hash });
const operation = (overrides: Partial<PendingLegacyOperation> = {}): PendingLegacyOperation => ({
  operationId: 'op-1',
  originalTargetIds: ['a', 'b'],
  appliedTargetIds: [],
  targets: [
    { id: 'a', representation: 'anchored', sourceProof: proof('source-a'), effectProof: proof('effect-a') },
    { id: 'b', representation: 'anchored', sourceProof: proof('source-b'), effectProof: proof('effect-b') },
  ],
  ...overrides,
});

test('accepts a complete independently anchored legacy operation', () => {
  const result = classifyPendingLegacyOperation(operation());
  assert.equal(result.status, 'eligible_independent');
  assert.deepEqual(result.remainingTargetIds, ['a', 'b']);
});

test('classifies a proven partial remainder without applying anything', () => {
  const result = classifyPendingLegacyOperation(operation({ appliedTargetIds: ['a'], appliedEffectProof: proof('receipt-a') }));
  assert.equal(result.status, 'eligible_partial_remainder');
  assert.deepEqual(result.remainingTargetIds, ['b']);
});

test('classifies all applied targets as satisfied elsewhere', () => {
  const result = classifyPendingLegacyOperation(operation({
    appliedTargetIds: ['a', 'b'],
    appliedEffectProof: proof('receipt-all'),
  }));
  assert.equal(result.status, 'satisfied_elsewhere');
  assert.equal(result.reasonCode, 'PROPOSAL_NO_EFFECT');
  assert.deepEqual(result.remainingTargetIds, []);
});

test('requires upgrade for rich markdown whole-document edits', () => {
  const result = classifyPendingLegacyOperation(operation({
    targets: [{ id: 'a', representation: 'rich_markdown', sourceProof: proof('s'), effectProof: proof('e') },
      { id: 'b', representation: 'anchored', sourceProof: proof('s2'), effectProof: proof('e2') }],
  }));
  assert.equal(result.status, 'upgrade_required');
  assert.equal(result.reasonCode, 'PROPOSAL_UPGRADE_REQUIRED');
});

test('requires upgrade when immutable source/effect provenance is missing', () => {
  const result = classifyPendingLegacyOperation(operation({
    targets: [{ id: 'a', representation: 'anchored' },
      { id: 'b', representation: 'anchored', sourceProof: proof('s'), effectProof: proof('e') }],
  }));
  assert.equal(result.status, 'upgrade_required');
  assert.deepEqual(result.remainingTargetIds, ['a', 'b']);
});

test('does not trust bogus applied target ids', () => {
  const result = classifyPendingLegacyOperation(operation({
    appliedTargetIds: ['bogus'],
    appliedEffectProof: proof('receipt-bogus'),
  }));
  assert.equal(result.status, 'upgrade_required');
  assert.equal(result.reasonCode, 'PROPOSAL_UPGRADE_REQUIRED');
});

test('does not trust a partial or complete applied set without a durable effect proof', () => {
  assert.equal(classifyPendingLegacyOperation(operation({ appliedTargetIds: ['a'] })).status, 'upgrade_required');
  assert.equal(classifyPendingLegacyOperation(operation({ appliedTargetIds: ['a', 'b'] })).status, 'upgrade_required');
});
