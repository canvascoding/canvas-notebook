import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as util from 'node:util';
import ts from 'typescript';
import { executeLifecycleTransaction } from '../app/lib/collaboration/lifecycle-transaction';

async function workspacePreviewBusyTransactionTest() {
  // Transaction/error-boundary unit fixture; genuine PostgreSQL contention is
  // covered separately. Use the product error class, not a matching code alone.
  const source = ts.createSourceFile('request-principal.ts', await fs.readFile(path.resolve('app/lib/workspaces/request-principal.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WorkspaceRequestPrincipalError');
  assert(declaration);
  const principalExports = {} as { WorkspaceRequestPrincipalError: new (code: string) => Error & { code: string } };
  new Function('exports', ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(principalExports);
  const PrincipalError = principalExports.WorkspaceRequestPrincipalError;
  const compiled = ts.transpileModule(await fs.readFile(path.resolve('app/lib/files/workspace-path-import-operation-preview.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  for (const mode of ['busy', 'rollback', 'close', 'lookalike', 'raw-sql', 'revoked'] as const) {
    const trace: string[] = [];
    const original = mode === 'lookalike' || mode === 'raw-sql'
      ? Object.assign(new Error('private diagnostic'), { code: mode === 'lookalike' ? 'PRINCIPAL_BUSY' : '55P03' })
      : new PrincipalError(mode === 'revoked' ? 'PRINCIPAL_AUTH_REVOKED' : 'PRINCIPAL_BUSY');
    const cleanup = new Error('cleanup unconfirmed');
    const database = { get: async () => { throw new Error('unexpected query'); }, all: async () => { throw new Error('unexpected query'); },
      run: async (sql: string) => { trace.push(sql); if (mode === 'rollback' && sql === 'ROLLBACK') throw cleanup; },
      close: async () => { trace.push('close'); if (mode === 'close') throw cleanup; } };
    const mocks: Record<string, unknown> = {
      'server-only': {}, 'node:util': util, '../db': { openDb: async () => database },
      '../collaboration/lifecycle-transaction': { executeLifecycleTransaction },
      '../collaboration/native-text-session-activation': { authenticatedNativeTextSessionEnabled: () => true },
      '../collaboration/room-admission-contract': { isCanonicalAdmissionPath: () => true },
      '../workspaces/request-principal': { WorkspaceRequestPrincipalError: PrincipalError,
        withWorkspaceRequestPrincipalOnConnection: async () => { throw original; } },
    };
    for (const name of ['../markdown/workspace-source-authority-stage', '../markdown/workspace-file-operation-preview',
      '../mcp/server/document-read-principal', './workspace-operation-job-scope', './workspace-path-cohort-delete-preparation',
      './workspace-path-physical-delete-preparation-v5', './workspace-path-import-preparation-plan', './workspace-path-html-no-import-preparation',
      './workspace-path-html-native-delete-preparation', './workspace-path-html-import-preparation']) mocks[name] = {};
    const exported = {} as typeof import('../app/lib/files/workspace-path-import-operation-preview');
    new Function('require', 'module', 'exports', compiled)((name: string) => { assert(Object.hasOwn(mocks, name), name); return mocks[name]; }, { exports: exported }, exported);
    let received: unknown;
    try { await exported.readWorkspacePathImportPreparationPlan({ principal: { kind: 'request', principal: {} as never }, kind: 'rename',
      selections: [{ sourcePath: 'a.txt', destinationPath: 'b.txt' }] }); } catch (error) { received = error; }
    assert(received instanceof Error);
    assert.equal(trace.at(-1), 'close'); assert(trace.includes('ROLLBACK')); assert(!trace.includes('COMMIT'));
    if (mode === 'busy') {
      assert(received instanceof exported.WorkspacePathImportPreviewError, 'Clean principal contention must become PATH_IMPORT_PREVIEW_BUSY');
      assert.equal(received.code, 'PATH_IMPORT_PREVIEW_BUSY'); assert.equal(received.status, 409); assert.equal(received.cause, original);
    } else {
      assert(!(received instanceof exported.WorkspacePathImportPreviewError) || received.code !== 'PATH_IMPORT_PREVIEW_BUSY', `${mode} cannot authorize a fresh attempt`);
      if (mode === 'close') {
        assert(received instanceof exported.WorkspacePathImportPreviewError, 'Unconfirmed disposal stays unavailable');
        assert.equal(received.code, 'PATH_IMPORT_PREVIEW_UNAVAILABLE'); assert.equal(received.cause, cleanup);
      }
      else if (mode === 'rollback') assert(received instanceof AggregateError);
      else assert.equal(received, original);
    }
  }
  console.log('Workspace preview busy transaction: clean rollback mapping and fail-closed cleanup passed');
}
void workspacePreviewBusyTransactionTest().catch(error => { console.error(error); process.exitCode = 1; });
