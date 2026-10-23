import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import type { PristineOriginalWorkspaceFileRequest, MarkdownFileImportReceipt } from '../app/lib/collaboration/markdown-file-import-persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { filesystemFileVersion } from '../app/lib/filesystem/file-version';
import { parseWorkspaceStarterInitializationResult } from '../app/lib/workspaces/starter-document-initialization-contract';
import type * as Coordinator from '../app/lib/workspaces/starter-document-initialization';
import type { WorkspaceStarterInitializationIntent } from '../app/lib/workspaces/starter-document-initialization-store';
import type { WorkspaceRequestHistoricalOrigin } from '../app/lib/workspaces/request-principal';

/** Mechanical boundary tests with actual source-FD/hash and Yjs snapshot checks.
 * Principal, catalogue and SQL results are explicit adapters, never evidence of
 * genuine authentication, SQL ownership, or actual PostgreSQL COMMIT finality. */
async function fixture(operation: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>): Promise<void> {
  const h = await harness();
  try { await operation(h); } finally { h.doc.destroy(); await rm(h.root, { recursive: true, force: true }); }
}
async function harness() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-starter-coordinator-')));
  const bytes = Buffer.from('# Original starter\n'), filePath = path.join(root, 'Erste Schritte.md');
  await writeFile(filePath, bytes, { mode: 0o600 });
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Original starter');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const snapshot = Y.encodeSnapshot(Y.snapshot(doc));
  const intent: WorkspaceStarterInitializationIntent = Object.freeze({ workspaceId: 'starter-workspace', operationId: randomUUID(), requestId: randomUUID(),
    actorUserId: 'starter-owner', path: 'Erste Schritte.md', seedDisposition: 'created', sourceFileVersion: filesystemFileVersion(await stat(filePath)),
    sourceSha256: sourceHash, sourceBytes: bytes.length, organizationId: null, workspaceType: 'personal', projectId: null,
    rootRelativePath: 'users/starter-owner/workspace', createdAt: Date.now() });
  const scope: WorkspaceRequestHistoricalOrigin = { userId: intent.actorUserId, sessionId: 'current-session', impersonatedBy: null, workspaceId: intent.workspaceId,
    workspaceType: intent.workspaceType, organizationId: null, customerId: null, projectId: null, ownerUserId: intent.actorUserId,
    rootPath: root, rootRelativePath: intent.rootRelativePath, legacy: false, status: 'active', schema: 'starter_schema', schemaOid: 101,
    databaseOid: 102, searchPath: 'starter_schema, pg_catalog' };
  const state = { documentId: 'original-document', lineageId: 'original-lineage', workspaceId: intent.workspaceId,
    organizationId: null, path: intent.path, representation: 'plain_text', schemaVersion: 1, lifecycleGeneration: 1,
    documentSequence: 0, newlineStyle: 'lf', hasBom: false, yjsState: Y.encodeStateAsUpdate(doc) };
  const receipt: MarkdownFileImportReceipt = { version: 1, operationId: intent.operationId, requestFingerprint: 'a'.repeat(64),
    sourceHash, sourceBytes: bytes.length, checkpointRequired: true, target: { documentId: state.documentId, lineageId: state.lineageId,
      workspaceId: intent.workspaceId, organizationId: null, path: intent.path, representation: 'plain_text', schemaVersion: 1,
      lifecycleGeneration: 1, newlineStyle: 'lf', hasBom: false, initialSequence: 0,
      initialStateProof: `yjs-snapshot-sha256-v1:${createHash('sha256').update(snapshot).digest('hex')}`, persistedAt: Date.now() } };
  const persisted = { workspace_id: intent.workspaceId, operation_id: intent.operationId, organization_id: null, actor_user_id: intent.actorUserId,
    actor_session_id: 'historical-session', request_id: intent.requestId, version: 1, request_fingerprint: receipt.requestFingerprint,
    private_result: receipt, after_state_snapshot: snapshot };
  const controls = { enabled: true, intent: intent as WorkspaceStarterInitializationIntent | null,
    persisted: null as typeof persisted | null, catalogue: [] as { id: string; path: string; authority: string }[],
    transactionFailure: null as 'COMMIT' | 'ROLLBACK' | 'close' | null, principalFailure: null as Error | null,
    importFailure: null as Error | null, phaseScopeDrift: false, nativePhases: 0, calls: [] as string[], imported: [] as PristineOriginalWorkspaceFileRequest[],
    activePrincipal: false, activeTransaction: false, connectionClosed: true, principalClosed: true, importCookieMatches: true };
  const database: SqlConnection = { get: async () => ({ schema: scope.schema, schema_oid: scope.schemaOid, database_oid: scope.databaseOid, search_path: scope.searchPath }),
    all: async sql => sql.includes('unnest($1::text[])') ? ['canvas_workspace_starter_initializations', 'collaboration_markdown_file_import_receipts',
      'collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages'].map((name, index) => ({ name, oid: index + 1,
        unqualified_oid: index + 1, relkind: 'r', relrowsecurity: false, relforcerowsecurity: false })) : controls.persisted ? [controls.persisted] : [],
    run: async sql => { controls.calls.push(sql.startsWith('LOCK') ? 'LOCK' : sql);
      if (sql.startsWith('BEGIN')) controls.activeTransaction = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') controls.activeTransaction = false;
      if (controls.transactionFailure === sql) throw new Error(`Private ${sql} transport details`);
    }, close: async () => { controls.calls.push('close'); controls.connectionClosed = true;
      if (controls.transactionFailure === 'close') throw new Error('Private close details'); } };
  const filename = path.resolve('app/lib/workspaces/starter-document-initialization.ts'), require = createRequire(filename);
  let observe: ((value: typeof scope) => void) | undefined;
  const workspace = { ...scope, actor: { userId: scope.userId }, permissions: { canRead: true, canWrite: true } };
  const mocks: Record<string, unknown> = {
    '../db': { openDb: async () => { controls.calls.push('open'); controls.connectionClosed = false; return database; } },
    '../collaboration/native-text-session-activation': { authenticatedNativeTextSessionEnabled: () => controls.enabled },
    '../collaboration/markdown-file-import-persistence': { persistPristineOriginalWorkspaceFileForWrite: async (
      request: NextRequest, selection: PristineOriginalWorkspaceFileRequest, input: { openConnection: () => Promise<SqlConnection>; expectedRequestScope: object }) => {
      assert.equal(input.openConnection, Reflect.get(mocks['../db'] as object, 'openDb'));
      assert.equal(controls.activeTransaction, false); assert.equal(controls.activePrincipal, false);
      assert.equal(controls.connectionClosed, true); assert.equal(controls.principalClosed, true);
      assert.deepEqual(input.expectedRequestScope, Object.fromEntries(Object.entries(scope).filter(([key]) => key !== 'impersonatedBy')));
      controls.calls.push('original-import'); controls.imported.push(structuredClone(selection));
      controls.importCookieMatches = request.headers.get('cookie') === 'fixture=original';
      if (controls.importFailure) throw controls.importFailure;
      return { disposition: 'applied', receipt };
    } },
    './request-principal': {
      withWorkspaceRequestPrincipalOriginalOrigin: async (_request: NextRequest, input: { permission: string; workspaceId: string },
        sink: typeof observe, operation: (principal: object) => Promise<unknown>) => {
        controls.calls.push(`principal:${input.permission}`); assert.equal(input.workspaceId, intent.workspaceId); observe = sink;
        controls.principalClosed = false;
        try { return await operation({}); } finally { controls.principalClosed = true; }
      },
      withWorkspaceRequestPrincipalOnConnection: async (_db: SqlConnection, _principal: object, operation: (access: object) => Promise<unknown>) => {
        assert.equal(controls.activePrincipal, false); controls.activePrincipal = true; observe?.({ ...scope });
        try { if (controls.principalFailure) throw controls.principalFailure;
          return await operation({ workspace, userId: scope.userId, sessionId: scope.sessionId, assertCurrent: async () => undefined });
        } finally { controls.activePrincipal = false; }
      },
    },
    './starter-document-initialization-store': { readWorkspaceStarterInitializationIntent: async () => controls.intent },
    '../collaboration/workspace-document-catalogue': { readWorkspaceDocumentCatalogue: async () => controls.catalogue },
    '../collaboration/native-session-state-reader': { withAuthenticatedExistingNativeCollaborationSessionOnConnection: async (
      _db: SqlConnection, _principal: object, input: { expectedIdentity: Record<string, unknown> }, operation: (session: object, access: object) => Promise<void>) => {
      assert.equal(controls.activePrincipal, false); controls.nativePhases++;
      observe?.({ ...scope, ...(controls.phaseScopeDrift ? { customerId: 'foreign' } : {}) });
      for (const [key, value] of Object.entries(input.expectedIdentity)) if (Reflect.get(state, key) !== value) {
        throw Object.assign(new Error('Private native identity changed'), { code: 'NATIVE_SESSION_SCOPE_CHANGED' });
      }
      return operation({ snapshot: state }, { assertCurrent: async () => undefined });
    } },
    '../collaboration/persistence': { loadCollaborationStateOnConnection: async () => state },
  };
  const javascript = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const coordinator = {} as typeof Coordinator;
  new Function('require', 'exports', javascript)((name: string) => mocks[name] ?? require(name), coordinator);
  const request = new NextRequest('https://canvas.example.test/api/workspaces', { method: 'POST', headers: { cookie: 'fixture=original' } });
  const complete = () => coordinator.completeWorkspaceStarterDocumentInitialization(request, intent.workspaceId, { requireIntent: true });
  const read = () => coordinator.observeWorkspaceStarterDocumentInitialization(request, intent.workspaceId, { requireIntent: true });
  const installReceipt = () => { controls.persisted = persisted; controls.catalogue = [{ id: state.documentId, path: intent.path, authority: 'initialized' }]; };
  return { root, filePath, bytes, doc, scope, state, receipt, persisted, controls, intent, coordinator, request, complete, read, installReceipt };
}

test('completed admission runs the original import only after inspection COMMIT, close and principal retirement', async () => fixture(async h => {
  const output = await h.complete(); assert.equal(output.status, 'completed'); assert.equal(h.controls.imported.length, 1);
  assert.deepEqual(h.controls.imported[0], { workspaceId: h.intent.workspaceId, path: h.intent.path, operationId: h.intent.operationId,
    requestId: h.intent.requestId, expectedTarget: { kind: 'absent' }, expectedFileVersion: h.intent.sourceFileVersion });
  assert.equal(h.controls.calls.indexOf('COMMIT') < h.controls.calls.indexOf('close'), true);
  assert.equal(h.controls.calls.indexOf('close') < h.controls.calls.indexOf('original-import'), true);
  assert.deepEqual(parseWorkspaceStarterInitializationResult(output), output);
}));

test('READ with intact pending source does not import or write even when native initialization is enabled', async () => fixture(async h => {
  assert.equal((await h.read()).status, 'pending'); assert.equal(h.controls.imported.length, 0);
  assert.equal(h.controls.calls.some(sql => /^(?:INSERT|UPDATE|DELETE)/u.test(sql)), false);
  assert.deepEqual(await readFile(h.filePath), h.bytes);
  await writeFile(h.filePath, 'D2 replacement'); assert.equal((await h.read()).status, 'blocked'); assert.equal(h.controls.imported.length, 0);
}));

test('missing intent is never a completed attempt; gate-off not_required still performs actual boundary scope checking', async () => fixture(async h => {
  h.controls.intent = null; assert.equal((await h.complete()).status, 'pending');
  h.controls.enabled = false;
  assert.equal((await h.read()).status, 'pending');
  const output = await h.coordinator.observeWorkspaceStarterDocumentInitialization(h.request, h.intent.workspaceId);
  assert.equal(output.status, 'not_required'); assert.equal(h.controls.calls.includes('principal:canRead'), true);
  h.controls.principalFailure = Object.assign(new Error('Private ACL'), { code: 'PRINCIPAL_ACCESS_DENIED' });
  assert.equal((await h.coordinator.observeWorkspaceStarterDocumentInitialization(h.request, h.intent.workspaceId)).status, 'blocked');
  assert.equal(h.controls.imported.length, 0);
}));

test('actual source/version drift, original actor/scope drift and foreign initialized winner never reach the importer', async () => {
  await fixture(async h => { await writeFile(h.filePath, 'different bytes'); assert.equal((await h.complete()).status, 'blocked'); assert.equal(h.controls.imported.length, 0); });
  for (const patch of [{ actorUserId: 'other' }, { rootRelativePath: 'other/root' }, { organizationId: 'foreign' }, { projectId: 'foreign' }]) {
    await fixture(async h => { h.controls.intent = Object.freeze({ ...h.intent, ...patch }); assert.equal((await h.complete()).status, 'blocked'); assert.equal(h.controls.imported.length, 0); });
  }
  await fixture(async h => { h.controls.catalogue = [{ id: 'foreign-winner', path: h.intent.path, authority: 'initialized' }];
    assert.equal((await h.complete()).status, 'blocked'); assert.equal(h.controls.imported.length, 0); });
});

test('read-only inspection COMMIT/close uncertainty prevents admission and does not expose transport details', async () => {
  for (const fault of ['COMMIT', 'close'] as const) await fixture(async h => {
    h.controls.transactionFailure = fault; const output = await h.complete(); assert.equal(output.status, 'pending');
    assert.equal(h.controls.imported.length, 0); assert.equal(JSON.stringify(output).includes('Private'), false);
    assert.equal(h.controls.calls.includes('close'), true);
  });
  await fixture(async h => { h.controls.principalFailure = Object.assign(new Error('Private denied'), { code: 'PRINCIPAL_ACCESS_DENIED' });
    h.controls.transactionFailure = 'ROLLBACK'; assert.equal((await h.complete()).status, 'pending'); assert.equal(h.controls.calls.includes('close'), true); });
});

test('lost original import response remains pending and retry recognizes its own real snapshot without a second import', async () => fixture(async h => {
  h.controls.importFailure = Object.assign(new Error('Private ACK'), { code: 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED' });
  const first = await h.complete(); assert.equal(first.status, 'pending'); assert.equal(h.controls.imported.length, 1);
  h.installReceipt(); h.controls.importFailure = null;
  const observed = await h.read(), retried = await h.complete();
  assert.equal(observed.status, 'completed'); assert.equal(retried.status, 'completed');
  assert.equal(retried.operationId, h.intent.operationId); assert.equal(retried.requestId, h.intent.requestId); assert.equal(h.controls.imported.length, 1);
}));

test('own immutable receipt remains valid after real Yjs edits and a changed physical projection, only at the original native identity', async () => fixture(async h => {
  h.installReceipt(); h.doc.getText('content').insert(h.doc.getText('content').length, ' Later edit');
  h.state.yjsState = Y.encodeStateAsUpdate(h.doc); h.state.documentSequence++;
  await writeFile(h.filePath, 'Later physical projection');
  assert.equal((await h.read()).status, 'completed'); assert.equal(h.controls.imported.length, 0);
  h.state.lifecycleGeneration++; assert.equal((await h.read()).status, 'blocked');
  assert.equal(h.controls.imported.length, 0);
}));

test('foreign operation/source/request or tampered original snapshot cannot masquerade as completed history', async () => {
  for (const patch of [{ operation_id: randomUUID() }, { actor_user_id: 'foreign' }, { request_id: randomUUID() },
    { private_result: null }, { after_state_snapshot: new Uint8Array([1, 2, 3]) }]) await fixture(async h => {
    h.installReceipt(); Object.assign(h.persisted, patch); const output = await h.read();
    assert.equal(output.status, 'blocked'); assert.equal(h.controls.imported.length, 0);
  });
  await fixture(async h => { h.installReceipt(); h.receipt.sourceHash = 'f'.repeat(64);
    assert.equal((await h.read()).status, 'blocked'); assert.equal(h.controls.imported.length, 0); });
  await fixture(async h => { h.installReceipt(); const other = new Y.Doc(); other.getText('content').insert(0, 'Different native original');
    try { h.state.yjsState = Y.encodeStateAsUpdate(other); assert.equal((await h.read()).status, 'blocked'); } finally { other.destroy(); } });
});

test('fresh principal phase scope drift is rejected and raw request mutations do not change the captured original request', async () => {
  await fixture(async h => { h.installReceipt(); h.controls.phaseScopeDrift = true; assert.equal((await h.read()).status, 'blocked'); });
  await fixture(async h => { const pending = h.complete(); h.request.headers.set('cookie', 'fixture=mutated');
    assert.equal((await pending).status, 'completed'); assert.equal(h.controls.importCookieMatches, true); });
});

test('public result parser excludes private fields/accessors and validates paired stable UUIDs', () => {
  const output = { version: 1, workspaceId: 'workspace', status: 'completed', operationId: randomUUID(), requestId: randomUUID() };
  assert.deepEqual(parseWorkspaceStarterInitializationResult(output), output);
  assert.equal(parseWorkspaceStarterInitializationResult({ ...output, rootPath: '/private' }), null);
  assert.equal(parseWorkspaceStarterInitializationResult({ ...output, operationId: undefined }), null);
  let getters = 0; const accessor = { ...output }; Object.defineProperty(accessor, 'status', { enumerable: true, get: () => { getters++; return 'completed'; } });
  assert.equal(parseWorkspaceStarterInitializationResult(accessor), null); assert.equal(getters, 0);
  assert.equal(parseWorkspaceStarterInitializationResult({ ...output, code: 'raw SQL secret' }), null);
});
