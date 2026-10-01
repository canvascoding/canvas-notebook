import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCollaborationRecovery, verifyCollaborationRecoveryCase,
  type CollaborationRecoveryEvidence, type RecoveryState } from '../app/lib/collaboration/recovery-plan';

function fixture(count = 1): CollaborationRecoveryEvidence {
  const states: RecoveryState[] = [];
  const evidence: CollaborationRecoveryEvidence = { states, registry: [], files: [],
    workspaces: [{ id: 'workspace', organizationId: 'org', type: 'team', status: 'active' }] };
  for (let index = 0; index < count; index++) {
    const base: RecoveryState = { documentId: `old-${index}`, workspaceId: 'workspace', organizationId: 'org',
      path: `${index}.md`, lifecycleGeneration: 1, documentSequence: 5, checkpointSequence: 5,
      stateVector: 'old-vector', yjsHash: 'old-binary', canonicalHash: 'old-canonical', serializedHash: 'old-file',
      computedSerializedHash: 'old-file', validationCode: null, degraded: false };
    states.push(base, { ...base, documentId: `current-${index}`, stateVector: 'current-vector', yjsHash: 'current-binary',
      canonicalHash: 'current-canonical', serializedHash: 'current-file', computedSerializedHash: 'current-file' });
    evidence.registry.push({ id: `current-${index}`, workspaceId: 'workspace', organizationId: 'org',
      workspaceType: 'team', path: base.path, provider: 'yjs', status: 'active', snapshotRevisionId: 'current-revision' });
    evidence.files.push({ workspaceId: 'workspace', path: base.path, hash: 'old-file', errorCode: null });
  }
  return evidence;
}

test('all 64 orphans are classified without rebinding either snapshot or changing input', () => {
  const evidence = fixture(64); const before = structuredClone(evidence);
  const result = planCollaborationRecovery(evidence);
  assert.equal(result.cases.length, 64);
  assert(result.cases.every((item) => item.proposedAction === 'restore_current_snapshot_after_approval'));
  assert.deepEqual(evidence, before);
  assert.deepEqual(planCollaborationRecovery(structuredClone(evidence)), result);
  assert.deepEqual(planCollaborationRecovery({ ...evidence, states: evidence.states.slice().reverse() }), result);
});

test('no current snapshot, invalid scope/schema, degraded/current changes and unknown file require review', () => {
  for (const change of [
    (e: CollaborationRecoveryEvidence) => { e.states.pop(); },
    (e: CollaborationRecoveryEvidence) => { e.registry[0].status = 'archived'; },
    (e: CollaborationRecoveryEvidence) => { e.registry[0].organizationId = 'other'; },
    (e: CollaborationRecoveryEvidence) => { e.registry[0].provider = 'excalidraw'; },
    (e: CollaborationRecoveryEvidence) => { e.workspaces[0].status = 'disabled'; },
    (e: CollaborationRecoveryEvidence) => { e.states[1].validationCode = 'schema_invalid'; },
    (e: CollaborationRecoveryEvidence) => { e.states[1].degraded = true; },
    (e: CollaborationRecoveryEvidence) => { e.states[1].documentSequence++; },
    (e: CollaborationRecoveryEvidence) => { e.states[1].computedSerializedHash = 'different'; },
    (e: CollaborationRecoveryEvidence) => { e.files[0].hash = 'external-edit'; },
    (e: CollaborationRecoveryEvidence) => { e.files[0].hash = null; e.files[0].errorCode = 'ENOENT'; },
    (e: CollaborationRecoveryEvidence) => { e.registry.push({ ...e.registry[0], id: 'conflicting' }); },
  ]) {
    const evidence = fixture(); change(evidence);
    assert.equal(planCollaborationRecovery(evidence).cases.find((item) => item.documentId === 'old-0')?.proposedAction, 'manual_review');
  }
});

test('restoration recheck rejects changed binary, generation, file, identity and revision', () => {
  const original = fixture(); const planned = planCollaborationRecovery(original).cases[0];
  assert.equal(verifyCollaborationRecoveryCase(planned, planCollaborationRecovery(original)), 'unchanged');
  for (const change of [
    (e: CollaborationRecoveryEvidence) => { e.states[1].yjsHash = 'new-binary'; },
    (e: CollaborationRecoveryEvidence) => { e.states[1].lifecycleGeneration++; },
    (e: CollaborationRecoveryEvidence) => { e.states[0].documentSequence++; },
    (e: CollaborationRecoveryEvidence) => { e.registry[0].id = 'new-identity'; },
    (e: CollaborationRecoveryEvidence) => { e.registry[0].snapshotRevisionId = 'new-revision'; },
    (e: CollaborationRecoveryEvidence) => { e.files[0].hash = 'new-file'; },
  ]) {
    const changed = structuredClone(original); change(changed);
    assert.equal(verifyCollaborationRecoveryCase(planned, planCollaborationRecovery(changed)), 'changed');
  }
  const restored = structuredClone(original); restored.files[0].hash = 'current-file';
  const repeated = planCollaborationRecovery(restored);
  assert.equal(repeated.cases[0].proposedAction, 'retain_current_file');
  assert.equal(verifyCollaborationRecoveryCase(planned, repeated), 'already_restored');
});

test('the invalid historical state remains identified for separate clone repair', () => {
  const evidence = fixture(); evidence.states[0].validationCode = 'schema_invalid'; evidence.states[0].degraded = true;
  const result = planCollaborationRecovery(evidence).cases[0];
  assert.equal(result.schema, 'schema_invalid');
  assert.equal(result.preconditions.orphan.yjsHash, 'old-binary');
  assert.equal(result.proposedAction, 'restore_current_snapshot_after_approval');
});
