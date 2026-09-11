import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  hasExportedCollaborationRecovery,
  prepareRecoverableCollaborationTransition,
  recordExportedCollaborationRecovery,
} from '../app/lib/collaboration/local-recovery';

async function main() {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'First\nMiddle\nLast');
  let saved = 0;
  const input = {
    doc, isPersistedCurrent: () => false,
    preserveLocalSnapshot: async () => { saved += 1; },
  };
  await prepareRecoverableCollaborationTransition(input);
  assert.equal(saved, 1, 'a degraded checkpoint does not prevent a durable local exit');
  await prepareRecoverableCollaborationTransition({ ...input, isPersistedCurrent: () => true });
  assert.equal(saved, 1, 'an exact binary confirmation needs no Markdown checkpoint or extra local backup');
  await prepareRecoverableCollaborationTransition(input);
  assert.equal(saved, 2, 'a changed document requires a current local snapshot');
  const failedStorage = { ...input, preserveLocalSnapshot: async () => { throw new Error('Quota exceeded'); } };
  await assert.rejects(prepareRecoverableCollaborationTransition(failedStorage), /Quota exceeded/);
  recordExportedCollaborationRecovery(doc, Y.encodeStateAsUpdate(doc));
  await prepareRecoverableCollaborationTransition(failedStorage);
  const vector = Y.encodeStateVector(doc);
  doc.getText('content').delete(6, 7);
  assert.deepEqual(Y.encodeStateVector(doc), vector, 'deletions do not advance a Yjs state vector');
  assert.equal(hasExportedCollaborationRecovery(doc), false, 'an older download must not authorize losing a newer deletion');
  await assert.rejects(prepareRecoverableCollaborationTransition(failedStorage), /Quota exceeded/);
  doc.destroy();
  console.log('Collaboration exits preserve degraded/offline edits and reject stale recovery exports.');
}
void main();
