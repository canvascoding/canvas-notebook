import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { CollaborationFileOperationProjectionPendingError } from '../app/lib/collaboration/checkpoint-errors';
import type * as Guard from '../app/lib/collaboration/projection-publication-guard';

/** Pure coordinator contracts with the actual compiled guard. SQL replies and
 * kernel lifetime are mocked here. This proves no PG advisory exclusion, disk
 * transition, checkpoint I/O, real OriginalOwner or genuine I04 acceptance. */
async function fixture() {
  const state = { documentId: 'document', workspaceId: 'workspace', organizationId: null, path: 'document.md',
    representation: 'tiptap_blocks' as const, lifecycleGeneration: 1, schemaVersion: 1 };
  const controls = { locked: true, held: true, move: false, delete: false, scope: true, switched: false, closed: 0,
    discard: false, kernel: false, calls: [] as string[] };
  const realm = { schema: 'fixture', searchPath: 'fixture, pg_catalog', schemaOid: 11, database: 12, backend: 13, start: '14' };
  const database = {
    run: async (sql: string) => { assert.match(sql, /^SET /u); },
    get: async (sql: string, values: unknown[]) => {
      assert.equal(controls.kernel, true, 'all guard SQL stays inside the retained workspace kernel callback');
      if (sql.includes('current_schema() AS schema')) { controls.calls.push('identity'); return { ...realm, backend: controls.switched ? 99 : realm.backend }; }
      if (sql.startsWith('SELECT pg_catalog.pg_try_advisory_lock_shared')) { controls.calls.push('acquire'); assert.deepEqual(values, ['42']); return { locked: controls.locked }; }
      if (sql.includes("mode='ShareLock'")) { controls.calls.push('lock'); assert.deepEqual(values, [12, 0, 42]); return { held: controls.held }; }
      if (sql.includes('SELECT y.document_id')) { controls.calls.push('scope'); return controls.scope ? { document_id: state.documentId } : undefined; }
      if (sql.includes('AS move_pending')) {
        controls.calls.push('pending'); assert.deepEqual(values, [state.workspaceId]);
        assert.match(sql, /"fixture"\.workspace_file_operation_move_intents/u);
        assert.match(sql, /"fixture"\.workspace_file_operation_delete_intents/u);
        assert.equal((sql.match(/r\.batch_id=i\.batch_id AND r\.intent_digest=i\.intent_digest/gu) ?? []).length, 2);
        assert.doesNotMatch(sql, /lease|expires|batch.*status|\bUPDATE\b|\bINSERT\b/iu);
        return { move_pending: controls.move, delete_pending: controls.delete };
      }
      throw new Error('Unexpected guard SQL in pure fixture.');
    },
    close: async (reason?: Error) => { controls.closed++; controls.discard = reason instanceof Error; },
  };
  const mocks: Record<string, unknown> = {
    'server-only': {}, '@/app/lib/db': { openDb: async () => database },
    '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: async (workspaceId: string, callback: () => Promise<unknown>) => {
      assert.equal(workspaceId, state.workspaceId); assert.equal(controls.kernel, false); controls.kernel = true;
      try { return await callback(); } finally { controls.kernel = false; }
    } },
    '@/app/lib/workspaces/path-identity': { isCanonicalWorkspacePath: (value: unknown) => value === state.path },
    './room-admission-contract': { collaborationAdmissionLockKey: (workspaceId: string) => { assert.equal(workspaceId, state.workspaceId); return '42'; } },
    './projection-identity': { currentProjectionIdentityJoins: '' },
    './checkpoint-errors': { CollaborationFileOperationProjectionPendingError },
  };
  const compiled = ts.transpileModule(await readFile(path.resolve('app/lib/collaboration/projection-publication-guard.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exported = {};
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert(Object.hasOwn(mocks, name), `Unexpected runtime import ${name}`); return mocks[name];
  }, { exports: exported }, exported);
  return { api: exported as typeof Guard, controls, state };
}

test('retains kernel/shared session and rechecks actual backend/lock/scope before returning', async () => {
  const { api, controls, state } = await fixture();
  const result = await api.withCollaborationProjectionPublicationGuard(state, async assertCurrent => {
    assert.equal(controls.kernel, true); assert.equal(controls.closed, 0);
    assert(controls.calls.includes('scope') && controls.calls.includes('pending')); await assertCurrent(); return 'complete';
  });
  assert.equal(result, 'complete'); assert.equal(controls.closed, 1); assert.equal(controls.discard, true); assert.equal(controls.kernel, false);
  assert.equal(controls.calls.filter(value => value === 'acquire').length, 1);
  assert.equal(controls.calls.filter(value => value === 'pending').length, 3);
});

for (const kind of ['move', 'delete'] as const) test(`${kind} pending original blocks before publication and discards the guard`, async () => {
  const { api, controls, state } = await fixture(); controls[kind] = true; let attempted = false;
  await assert.rejects(api.withCollaborationProjectionPublicationGuard(state, async () => { attempted = true; }), CollaborationFileOperationProjectionPendingError);
  assert.equal(attempted, false); assert.equal(controls.closed, 1); assert.equal(controls.discard, true);
});

test('nonblocking shared acquisition defers without entering publication', async () => {
  const { api, controls, state } = await fixture(); controls.locked = false; let attempted = false;
  await assert.rejects(api.withCollaborationProjectionPublicationGuard(state, async () => { attempted = true; }), CollaborationFileOperationProjectionPendingError);
  assert.equal(attempted, false); assert.equal(controls.calls.includes('pending'), false); assert.equal(controls.closed, 1);
});

for (const kind of ['held', 'switched', 'scope'] as const) test(`${kind} drift cannot finish a publication guard`, async () => {
  const { api, controls, state } = await fixture();
  await assert.rejects(api.withCollaborationProjectionPublicationGuard(state, async assertCurrent => {
    if (kind === 'switched') controls.switched = true; else controls[kind] = false;
    await assertCurrent();
  }), { code: kind === 'scope' ? 'COLLABORATION_PROJECTION_SCOPE_CHANGED' : 'COLLABORATION_PROJECTION_GUARD_UNAVAILABLE' });
  assert.equal(controls.closed, 1); assert.equal(controls.discard, true);
});

test('a retained callback cannot use a closed guard or a new backend', async () => {
  const { api, controls, state } = await fixture(); let late: (() => Promise<void>) | undefined;
  await api.withCollaborationProjectionPublicationGuard(state, async assertCurrent => { late = assertCurrent; });
  const before = controls.calls.length;
  await assert.rejects(late!(), { code: 'COLLABORATION_PROJECTION_GUARD_DETACHED' }); assert.equal(controls.calls.length, before);
});

test('the rejection-only I04 predicate fails closed on missing or malformed observations', async () => {
  const { api } = await fixture();
  for (const reply of [undefined, {}, { move_pending: false, delete_pending: 0 }]) {
    await assert.rejects(api.assertNoPendingOriginalFileOperationProjection({ get: async () => reply }, 'workspace'),
      { code: 'COLLABORATION_PROJECTION_GUARD_UNAVAILABLE' });
  }
});
