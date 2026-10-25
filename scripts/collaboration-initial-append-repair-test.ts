import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { prepareLegacyInitialAppendRepair, identityForInitialAppendCheckpoint,
  type LegacyInitialAppendIdentity } from '../app/lib/collaboration/initial-append-repair';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';

function fixture() {
  const before = 'Original text.\n', after = before + 'Additional verified text.\n';
  const doc = new Y.Doc({ gc: false }); doc.getText('content').insert(0, 'Removed prefix. ' + before);
  doc.getText('content').delete(0, 'Removed prefix. '.length);
  const state: PersistedCollaborationState = { documentId: 'original-document', workspaceId: 'workspace', organizationId: 'organization',
    path: 'folder/note.txt', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 0, checkpointSequence: 0,
    persistedAt: 2, checkpointedAt: 2, canonicalHash: recoveryHash(before), serializedHash: recoveryHash(before),
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  doc.destroy();
  const scope = { workspaceId: 'workspace', organizationId: 'organization', customerId: null, projectId: null,
    workspaceType: 'team' as const, path: state.path };
  const originalRevision = { ...scope, id: 'original-revision', lineageId: 'original-lineage', path: 'previous.txt', revisionNumber: 1,
    contentHash: recoveryHash('Earlier file revision'), sizeBytes: 21, createdByUserId: 'owner', createdByActorType: 'user' as const,
    sourceSessionId: null, baseRevisionId: null, createdAt: 1, historyOnly: false as const };
  const identity: LegacyInitialAppendIdentity = {
    document: { ...scope, id: state.documentId, lineageId: 'original-lineage', provider: 'yjs', stateVersion: 0,
      snapshotRevisionId: originalRevision.id, status: 'active', createdAt: 1, updatedAt: 1 },
    lineage: { ...scope, id: 'original-lineage', status: 'active', createdAt: 1, archivedAt: null, trashEntryId: null },
    revision: originalRevision, history: [], historicalRevisionPaths: ['previous.txt'],
    laterRevisions: [{ ...originalRevision, id: 'newer-revision', revisionNumber: 2, contentHash: recoveryHash(after),
      sizeBytes: Buffer.byteLength(after), baseRevisionId: originalRevision.id, createdAt: 3 }],
  };
  return { state, identity, file: Uint8Array.from(Buffer.from(after)), before, after };
}

test('verified newer file may only append to the original plain-text birth, preserving exact original structures', () => {
  const f = fixture(), original = structuredClone(f);
  const first = prepareLegacyInitialAppendRepair(f.state, f.file, f.identity);
  const again = prepareLegacyInitialAppendRepair(f.state, f.file, f.identity);
  assert.deepEqual(first, again); assert.deepEqual(f, original);
  assert.equal(first.appendedUtf16Units, f.after.length - f.before.length);
  assert.equal(first.serializedHash, recoveryHash(f.file));
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, f.state.yjsState); const beforeVector = Y.decodeStateVector(Y.encodeStateVector(doc));
    Y.applyUpdate(doc, first.repairedYjsState);
    assert.equal(doc.getText('content').toString(), f.after);
    const afterVector = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [client, clock] of beforeVector) assert.equal(afterVector.get(client), clock, 'every original client clock stays exact');
    assert.deepEqual(Y.encodeStateVector(doc), first.stateVector);
    Y.applyUpdate(doc, first.repairedYjsState); assert.equal(doc.getText('content').toString(), f.after);
  } finally { doc.destroy(); }
  const checkpoint = identityForInitialAppendCheckpoint(f.identity, { documentId: f.state.documentId, documentSequence: 1, persistedAt: 10 });
  assert.equal(checkpoint.document.id, f.identity.document.id);
  assert.equal(checkpoint.document.snapshotRevisionId, 'newer-revision');
  assert.equal(checkpoint.document.stateVersion, 1); assert.equal(checkpoint.document.createdAt, 1); assert.equal(checkpoint.document.updatedAt, 10);
  assert.equal(checkpoint.revision.id, 'newer-revision'); assert.equal(checkpoint.revision.path, 'previous.txt');
  assert.deepEqual(checkpoint.history, [f.identity.revision]);
  assert.deepEqual(f.identity, original.identity, 'original historical records are never rewritten');
});

const rejected: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['already advanced sequence', f => { f.state.documentSequence = 1; f.state.checkpointSequence = 1; }],
  ['later generation', f => { f.state.lifecycleGeneration = 2; }],
  ['rich state', f => { f.state.representation = 'tiptap_xml'; }],
  ['quarantined state', f => { f.state.degraded = true; }],
  ['archived state', f => { f.state.status = 'archived'; }],
  ['unknown original identity', f => { f.identity.document.id = 'other'; }],
  ['foreign workspace', f => { f.identity.document.workspaceId = 'foreign'; }],
  ['foreign lineage', f => { f.identity.lineage!.id = 'foreign'; }],
  ['archived lineage', f => { f.identity.lineage!.status = 'archived'; }],
  ['unknown snapshot pointer', f => { f.identity.document.snapshotRevisionId = 'unknown'; }],
  ['missing newer revision', f => { f.identity.laterRevisions = []; }],
  ['older file revision', f => { f.identity.laterRevisions[0].createdAt = 2; }],
  ['wrong current file hash', f => { f.identity.laterRevisions[0].contentHash = recoveryHash('other'); }],
  ['wrong current file size', f => { f.identity.laterRevisions[0].sizeBytes = 1; }],
  ['ambiguous revision identity', f => { f.identity.laterRevisions[0].id = f.identity.revision.id; }],
  ['unverified revision base', f => { f.identity.laterRevisions[0].baseRevisionId = 'unknown'; }],
  ['revision ordinal gap', f => { f.identity.laterRevisions[0].revisionNumber = 3; }],
  ['history-only file', f => { (f.identity.laterRevisions[0] as { historyOnly: boolean }).historyOnly = true; }],
  ['unproven historical path', f => { f.identity.historicalRevisionPaths = []; }],
  ['foreign revision scope', f => { f.identity.laterRevisions[0].organizationId = 'foreign'; }],
  ['unknown native hash', f => { f.state.canonicalHash = recoveryHash('other'); }],
  ['different encoding', f => { f.state.hasBom = true; }],
  ['different original text', f => { f.file = Uint8Array.from(Buffer.from('Changed original.\nAdditional text.\n'));
    f.identity.laterRevisions[0].contentHash = recoveryHash(f.file); f.identity.laterRevisions[0].sizeBytes = f.file.byteLength; }],
  ['no additional text', f => { f.file = Uint8Array.from(Buffer.from(f.before)); f.identity.laterRevisions[0].contentHash = recoveryHash(f.file);
    f.identity.laterRevisions[0].sizeBytes = f.file.byteLength; }],
];
for (const [name, change] of rejected) test(`initial append recovery rejects ${name} without changing evidence`, () => {
  const f = fixture(); change(f); const before = structuredClone(f);
  assert.throws(() => prepareLegacyInitialAppendRepair(f.state, f.file, f.identity)); assert.deepEqual(f, before);
});
