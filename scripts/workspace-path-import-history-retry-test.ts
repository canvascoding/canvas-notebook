/** Isolated retry-contract unit: declared DB/Auth/Record/Batch seams, no PG claim.
 * GitNexus before creation: exact new File/main UIDs UNKNOWN (unindexed).
 * Manual entrypoint: this file's IIFE under the explicit node:test command.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { mock, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { WorkspaceRequestHistoricalOrigin } from '../app/lib/workspaces/request-principal';

async function main() {
  // Preserve the actual Auth error constructor/class identity at the declared
  // Auth seam without bootstrapping Better Auth or the PI import graph.
  const ts = (await import('typescript')).default;
  const authSource = ts.createSourceFile('request-principal.ts', await fs.readFile(new URL(
    '../app/lib/workspaces/request-principal.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = authSource.statements.find(statement => ts.isClassDeclaration(statement)
    && statement.name?.text === 'WorkspaceRequestPrincipalError');
  assert(declaration);
  const classExports: { WorkspaceRequestPrincipalError?: typeof import('../app/lib/workspaces/request-principal').WorkspaceRequestPrincipalError } = {};
  new Function('exports', ts.transpileModule(declaration.getText(authSource), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(classExports);
  const PrincipalError = classExports.WorkspaceRequestPrincipalError; assert(PrincipalError);
  const unexpected = (): never => { throw new Error('Unexpected unexercised unit boundary.'); };
  const workspace = Object.freeze({ workspaceId: 'owned-unit-workspace', workspaceType: 'personal',
    organizationId: null, customerId: null, projectId: null, ownerUserId: 'unit-user', rootPath: '/isolated/unit-history',
    rootRelativePath: 'users/unit-user/workspaces/unit', legacy: false, status: 'active',
    permissions: Object.freeze({ canRead: true, canWrite: true, canDelete: true }) });
  const origin: WorkspaceRequestHistoricalOrigin = Object.freeze({ userId: 'unit-user', sessionId: 'original-session',
    impersonatedBy: null, workspaceId: workspace.workspaceId, workspaceType: 'personal', organizationId: null,
    customerId: null, projectId: null, ownerUserId: 'unit-user', rootPath: workspace.rootPath,
    rootRelativePath: workspace.rootRelativePath, legacy: false, status: 'active', schema: 'owned_unit',
    schemaOid: 123, searchPath: 'owned_unit', databaseOid: 456 });
  type Mode = 'success' | 'busy' | 'auth' | 'raw-sql' | 'lookalike' | 'begin' | 'commit' | 'rollback' | 'close'
    | 'schema' | 'factory-busy' | 'origin' | 'capture';
  type State = { mode: Mode; busyCount: number; factories: number; databases: number; currents: number;
    recordReads: number; batchReads: number; events: string[]; principals: object[]; headers: string[][][];
    requests: NextRequest[]; mutate?: () => void; error: Error; recordKeys: string[] };
  let state: State;
  const reset = (mode: Mode, busyCount = 0): State => state = { mode, busyCount, factories: 0, databases: 0, currents: 0,
    recordReads: 0, batchReads: 0, events: [], principals: [], headers: [], requests: [],
    error: Object.assign(new Error(`Declared ${mode} failure.`), { code: mode === 'lookalike' ? 'PRINCIPAL_BUSY' : '55P03' }), recordKeys: [] };
  const realm = { schema_name: 'owned_unit', schema_oid: 123, database_oid: 456, search_path: 'owned_unit',
    backend_pid: 901, backend_start: 'unit-backend-start', xid: '42', isolation: 'read committed', read_only: 'off', replication: 'origin' };
  const dbMock = {
    openDb: async () => {
      const index = ++state.databases; let realmReads = 0; state.events.push(`db:${index}`);
      return {
        run: async (sql: string) => {
          state.events.push(`${index}:${sql}`);
          if (sql.startsWith('BEGIN') && state.mode === 'begin') throw new PrincipalError('PRINCIPAL_BUSY');
          if (sql === 'COMMIT' && state.mode === 'commit') throw state.error;
          if (sql === 'ROLLBACK' && state.mode === 'rollback') throw state.error;
          return { changes: 0 };
        },
        get: async (sql: string) => {
          assert(sql.includes('pg_catalog.current_schema()')); state.events.push(`${index}:realm`);
          if (state.mode === 'raw-sql') throw state.error;
          return state.mode === 'schema' && ++realmReads === 2 ? { ...realm, schema_oid: 124 } : { ...realm };
        },
        all: unexpected,
        close: async () => {
          state.events.push(`${index}:close`); if (state.mode === 'close') throw state.error;
        },
      };
    },
  };
  mock.module('../app/lib/db/index.ts', { namedExports: dbMock });
  mock.module('../app/lib/workspaces/request-principal.ts', { namedExports: {
    WorkspaceRequestPrincipalError: PrincipalError,
    withWorkspaceRequestPrincipalOriginalOrigin: async (request: NextRequest, options: unknown,
      observe: (value: WorkspaceRequestHistoricalOrigin) => void, work: (principal: object) => Promise<unknown>) => {
      const attempt = ++state.factories; state.events.push(`factory:${attempt}`);
      assert.deepEqual(options, { permission: 'canWrite', workspaceId: workspace.workspaceId });
      if (attempt > 1) assert.equal(state.events.at(-2), `factory:${attempt - 1}:end`);
      const principal = Object.freeze({ attempt }); state.principals.push(principal);
      state.requests.push(request); state.headers.push([...request.headers.entries()]);
      try {
        if (state.mode === 'factory-busy') throw new PrincipalError('PRINCIPAL_BUSY');
        observe(state.mode === 'origin' && attempt === 2 ? { ...origin, sessionId: 'different-session' } : origin);
        if (attempt === 1) state.mutate?.();
        return await work(principal);
      } finally { state.events.push(`factory:${attempt}:end`); }
    },
    withWorkspaceRequestPrincipalOnConnection: async (_db: unknown, principal: object,
      work: (access: object) => Promise<unknown>) => {
      assert.equal(principal, state.principals.at(-1));
      if ((state.mode === 'busy' || state.mode === 'origin' || state.mode === 'capture') && state.factories <= state.busyCount
        || state.mode === 'rollback' || state.mode === 'close') throw new PrincipalError('PRINCIPAL_BUSY');
      if (state.mode === 'auth') throw new PrincipalError('PRINCIPAL_AUTH_REVOKED');
      if (state.mode === 'lookalike') throw state.error;
      return work({ workspace, userId: origin.userId, sessionId: origin.sessionId,
        assertCurrent: async () => { state.currents++; } });
    },
  } });
  mock.module('../app/lib/mcp/server/document-read-principal.ts', { namedExports: {
    withDirectMcpWorkspaceMovePrincipalOnConnection: unexpected, withDirectMcpWorkspaceDeletePrincipalOnConnection: unexpected,
  } });
  mock.module('../app/lib/files/workspace-operation-mcp-authorization.ts', { namedExports: { workspaceOperationMcpBatchId: unexpected } });
  mock.module('../app/lib/files/workspace-path-import-preparation-record.ts', { namedExports: {
    readWorkspacePathImportPreparationRecordOnConnection: async (_db: unknown, input: { schema: string; workspaceId: string; batchId: string }) => {
      state.recordReads++; assert.equal(input.schema, origin.schema); assert.equal(input.workspaceId, workspace.workspaceId);
      state.recordKeys.push(input.batchId); return null;
    },
  } });
  mock.module('../app/lib/files/workspace-operation-batch-store.ts', { namedExports: {
    readWorkspacePathImportOperationBatchOnConnection: async () => { state.batchReads++; return unexpected(); },
  } });
  const { readRequestWorkspacePathImportOperationHistory: read, WorkspacePathImportOperationHistoryError: HistoryError } =
    await import('../app/lib/files/workspace-path-import-operation-history');
  const request = () => new NextRequest('http://canvas.test/api/files/rename?workspaceId=owned-unit-workspace', {
    method: 'POST', headers: { cookie: 'synthetic-unit-session', 'x-canvas-workspace-id': workspace.workspaceId, 'x-unit-question': 'original' } });
  const question = () => ({ workspaceId: String(workspace.workspaceId), operationId: 'same-original-idempotency-key', expected: {
    planId: 'a'.repeat(64), request: { kind: 'rename' as const, selections: [{ sourcePath: 'before.md', destinationPath: 'after.md' }] },
  } });
  const assertClosedBeforeRetry = (h: State, busy: number) => {
    for (let index = 1; index <= busy; index++) {
      const rollback = h.events.indexOf(`${index}:ROLLBACK`), close = h.events.indexOf(`${index}:close`);
      const end = h.events.indexOf(`factory:${index}:end`), next = h.events.indexOf(`factory:${index + 1}`);
      assert(rollback >= 0 && rollback < close && close < end && (next < 0 || end < next), h.events.join('\n'));
    }
  };
  for (const busy of [1, 2]) await test(`${busy} typed busy failure(s) unwind before fresh factories and real null-record success`, async () => {
    const h = reset('busy', busy), original = request(), input = question();
    assert.equal(await read(original, input), null);
    assert.equal(h.factories, busy + 1); assert.equal(h.databases, busy + 1);
    assert.equal(new Set(h.principals).size, busy + 1); assertClosedBeforeRetry(h, busy);
    assert(h.requests.every(r => r !== original)); assert(h.headers.every(headers => JSON.stringify(headers) === JSON.stringify([...original.headers.entries()])));
    assert.equal(h.recordReads, 1); assert.equal(h.batchReads, 0); assert.equal(h.currents, 2);
    assert.deepEqual(h.recordKeys, [createHash('sha256').update(JSON.stringify([
      'workspace-path-operation-id-v1', workspace.workspaceId, origin.userId, input.operationId])).digest('hex')]);
    assert(h.events.includes(`${busy + 1}:COMMIT`)); assert.equal(h.events.at(-1), `factory:${busy + 1}:end`);
  });
  await test('copied request headers and the immutable expected question survive original caller mutation', async () => {
    const h = reset('capture', 1), original = request(), input = question(), expectedHeaders = [...original.headers.entries()];
    h.mutate = () => { original.headers.set('x-unit-question', 'late'); input.workspaceId = 'wrong-late-workspace';
      input.operationId = '\u0000late-invalid-key'; input.expected.planId = 'invalid-late-plan';
      input.expected.request.selections[0].sourcePath = '../invalid-late-path'; };
    assert.equal(await read(original, input), null); assert.equal(h.factories, 2); assertClosedBeforeRetry(h, 1);
    assert(h.headers.every(headers => JSON.stringify(headers) === JSON.stringify(expectedHeaders)));
    assert.deepEqual(h.recordKeys, [createHash('sha256').update(JSON.stringify([
      'workspace-path-operation-id-v1', workspace.workspaceId, origin.userId, 'same-original-idempotency-key'])).digest('hex')]);
  });
  await test('three typed busy failures yield typed 503 and never null or a fourth factory', async () => {
    const h = reset('busy', 3); await assert.rejects(read(request(), question()), error => {
      assert(error instanceof HistoryError); assert.equal(error.code, 'PATH_IMPORT_HISTORY_UNAVAILABLE'); assert.equal(error.status, 503); return true;
    }); assert.equal(h.factories, 3); assert.equal(h.databases, 3); assert.equal(h.recordReads, 0); assertClosedBeforeRetry(h, 3);
  });
  await test('changed original historical origin is rejected before the second connection', async () => {
    const h = reset('origin', 1); await assert.rejects(read(request(), question()), error => {
      assert(error instanceof HistoryError); assert.equal(error.code, 'PATH_IMPORT_HISTORY_CHANGED'); return true;
    }); assert.equal(h.factories, 2); assert.equal(h.databases, 1); assertClosedBeforeRetry(h, 1);
  });
  for (const mode of ['auth', 'schema', 'raw-sql', 'lookalike', 'begin', 'commit', 'rollback', 'close', 'factory-busy'] as const) {
    await test(`${mode} failure never qualifies for the confirmed retry`, async () => {
      const h = reset(mode); await assert.rejects(read(request(), question()), error => {
        if (mode === 'commit' || mode === 'rollback' || mode === 'close') {
          assert(error instanceof HistoryError); assert.equal(error.code, 'PATH_IMPORT_HISTORY_UNAVAILABLE'); assert.equal(error.status, 503);
        } else if (mode === 'schema') { assert(error instanceof HistoryError); assert.equal(error.code, 'PATH_IMPORT_HISTORY_CHANGED'); }
        else if (mode === 'auth' || mode === 'begin' || mode === 'factory-busy') {
          assert(error instanceof PrincipalError); assert.equal(error.code, mode === 'auth' ? 'PRINCIPAL_AUTH_REVOKED' : 'PRINCIPAL_BUSY');
        } else assert.equal(error, h.error);
        return true;
      });
      assert.equal(h.factories, 1); assert.equal(h.databases, mode === 'factory-busy' ? 0 : 1);
      assert(!h.events.includes('factory:2'));
      if (mode === 'commit' || mode === 'begin') assert(!h.events.includes('1:ROLLBACK'));
      if (mode !== 'factory-busy') assert(h.events.includes('1:close'));
    });
  }
  for (const mode of ['request', 'workspace', 'key', 'expected'] as const) await test(`invalid ${mode} rejects before factory or DB`, async () => {
    const h = reset('success'), input = question();
    if (mode === 'workspace') input.workspaceId = ' padded ';
    if (mode === 'key') input.operationId = '\u0000invalid';
    if (mode === 'expected') input.expected.request.selections[0].sourcePath = '../invalid';
    await assert.rejects(Reflect.apply(read, undefined, [mode === 'request' ? {} : request(), input]), error => {
      assert(error instanceof HistoryError); assert.equal(error.code, 'PATH_IMPORT_HISTORY_INVALID'); return true;
    }); assert.equal(h.factories, 0); assert.equal(h.databases, 0); assert.deepEqual(h.events, []);
  });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
