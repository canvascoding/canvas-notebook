import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { captureOwnedCopyB2FaultInput, ownedCopyB2FaultDefinition } from './lib/owned-yjs-native-copy-b2-fault';

function input() {
  const actorUserId = 'own-user', sourceWorkspaceId = 'own-source', destinationWorkspaceId = 'own-destination', planId = 'a'.repeat(64);
  const sourcePath = 'owned-yjs-restart-12345678-1234-1234-1234-123456789abc.md';
  return { version: 1, action: 'arm', faultId: 'b'.repeat(32), target: { nonce: 'c'.repeat(32), repo: '/private/owned/repo',
    head: 'd'.repeat(40), sourceFingerprint: 'e'.repeat(64), buildFingerprint: 'f'.repeat(64), buildId: 'own-build', receiptIdentity: '1'.repeat(64) },
  actorUserId, sourceWorkspaceId, destinationWorkspaceId, sourcePath, destinationPath: sourcePath,
  sourceDocumentId: 'own-document', sourceGeneration: 1, planId,
  operationId: createHash('sha256').update(JSON.stringify(['workspace-file-operation-v1', actorUserId, sourceWorkspaceId, destinationWorkspaceId, planId])).digest('hex') };
}
test('fault input is detached, immutable and rejects getters without executing them', () => {
  const raw = input(), captured = captureOwnedCopyB2FaultInput(raw); raw.target.head = '0'.repeat(40); raw.destinationPath = 'foreign.md';
  assert.equal(captured.target.head, 'd'.repeat(40)); assert.equal(captured.destinationPath, captured.sourcePath);
  assert(Object.isFrozen(captured) && Object.isFrozen(captured.target));
  let called = false; const accessor = input(); Object.defineProperty(accessor, 'operationId', { enumerable: true, get() { called = true; return 'a'.repeat(64); } });
  assert.throws(() => captureOwnedCopyB2FaultInput(accessor)); assert.equal(called, false);
});
test('fault refuses foreign operation IDs, same workspace, traversal and non-owned paths', () => {
  for (const change of [{ operationId: '0'.repeat(64) }, { destinationWorkspaceId: 'own-source' },
    { sourcePath: '../owned-yjs-restart-12345678-1234-1234-1234-123456789abc.md' }, { destinationPath: 'other.md' },
    { sourceGeneration: 0 }, { sourceDocumentId: "foreign' OR true" }]) assert.throws(() => captureOwnedCopyB2FaultInput({ ...input(), ...change }));
});
test('fault refuses extra, missing, symbolic and inherited descriptor data', () => {
  assert.throws(() => captureOwnedCopyB2FaultInput({ ...input(), unbound: true }));
  const missing = input() as Record<string, unknown>; delete missing.sourceDocumentId;
  assert.throws(() => captureOwnedCopyB2FaultInput(missing));
  assert.throws(() => captureOwnedCopyB2FaultInput({ ...input(), [Symbol('foreign')]: true }));
  assert.throws(() => captureOwnedCopyB2FaultInput(Object.assign(Object.create({ extra: true }), input())));
});
test('fault names and definition bind all captured pins, and remain equal for cleanup', () => {
  const raw = input(), captured = captureOwnedCopyB2FaultInput(raw), armed = ownedCopyB2FaultDefinition(captured);
  assert.deepEqual(ownedCopyB2FaultDefinition(captureOwnedCopyB2FaultInput({ ...raw, action: 'cleanup' })), armed);
  assert(Object.values(armed.names).every(name => name.length <= 63 && /^[a-z0-9_]+$/u.test(name)));
  for (const field of ['sourceDocumentId', 'planId'] as const) {
    const changed = input(); changed[field] = field === 'planId' ? '2'.repeat(64) : 'another-own-doc';
    if (field === 'planId') changed.operationId = createHash('sha256').update(JSON.stringify(['workspace-file-operation-v1',
      changed.actorUserId, changed.sourceWorkspaceId, changed.destinationWorkspaceId, changed.planId])).digest('hex');
    assert.notEqual(ownedCopyB2FaultDefinition(captureOwnedCopyB2FaultInput(changed)).marker, armed.marker);
  }
});
test('real trigger faults only the exact native-committed Copy INSERT once across rollback', async () => {
  const db = await PGlite.create(); const captured = captureOwnedCopyB2FaultInput(input()), definition = ownedCopyB2FaultDefinition(captured);
  try {
    await db.exec(`CREATE TABLE public.workspace_file_metadata(workspace_id text,path text,title text);
      CREATE TABLE public.collaboration_native_copy_receipts(operation_id text,workspace_id text,publication_status text)`);
    for (const sql of definition.create) await db.exec(sql);
    const insert = (workspace: string, file: string) => db.query('INSERT INTO public.workspace_file_metadata VALUES($1,$2,$3)', [workspace, file, 'Title']);
    await insert(captured.destinationWorkspaceId, captured.destinationPath); // No ledger cannot be the B2 fault target.
    await db.query('INSERT INTO public.collaboration_native_copy_receipts VALUES($1,$2,$3)', [captured.operationId, captured.destinationWorkspaceId, 'native_committed']);
    await insert('foreign-workspace', captured.destinationPath); await insert(captured.destinationWorkspaceId, 'foreign-path.md');
    await db.exec('BEGIN');
    await assert.rejects(insert(captured.destinationWorkspaceId, captured.destinationPath), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === 'P0001' && error.message === 'OWNED_QA_COPY_B2_INSERT_ONCE');
    await db.exec('ROLLBACK');
    assert.deepEqual((await db.query(`SELECT last_value::text,is_called FROM public."${definition.names.sequence}"`)).rows, [{ last_value: '1', is_called: true }]);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM public.workspace_file_metadata')).rows[0].count, 3);
    await insert(captured.destinationWorkspaceId, captured.destinationPath);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM public.workspace_file_metadata')).rows[0].count, 4);
    await db.exec(`DROP TRIGGER "${definition.names.trigger}" ON public.workspace_file_metadata RESTRICT;
      DROP FUNCTION public."${definition.names.function}"() RESTRICT; DROP SEQUENCE public."${definition.names.sequence}" RESTRICT`);
    assert.deepEqual((await db.query('SELECT to_regclass($1) AS object', [`public.${definition.names.sequence}`])).rows, [{ object: null }]);
  } finally { await db.close(); }
});
