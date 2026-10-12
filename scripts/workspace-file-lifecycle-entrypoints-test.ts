import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

/** Entrypoint wiring tests use physical fixture bytes; dedicated PostgreSQL tests cover the lock itself. */
async function routeHarness(kind: 'extract' | 'restore') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-lifecycle-entrypoint-'));
  const file = path.resolve(kind === 'extract' ? 'app/api/files/extract/route.ts'
    : 'app/api/files/operation-backups/[backupId]/route.ts');
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const controls = { busy: true, guardDepth: 0, mutationDepth: 0, physicalWrites: 0, metadataWrites: 0,
    sharesWrites: 0, scopes: [] as string[] };
  const workspace = { workspaceId: 'fixture-ws', rootPath: root, organizationId: null, workspaceType: 'personal' };
  const backup = { originalPath: 'restored.bin', entries: [{ type: 'file', path: '.' }], sizeBytes: 8,
    contentSha256: 'a'.repeat(64) };
  const destination = kind === 'extract' ? 'imports/extracted.bin' : 'restored.bin';
  class WorkspaceFileLifecycleBusyError extends Error {
    readonly status = 409;
    readonly code = 'COLLABORATION_FILE_LIFECYCLE_BUSY';
  }
  class ZipExtractionError extends Error { readonly status = 422; }
  const jsonError = (error: string, status: number, details: object = {}) => Response.json({ success: false, error, ...details }, { status });
  const guard = async (scope: { paths: string[] }, work: () => Promise<unknown>) => {
    assert.equal(controls.mutationDepth, 0, 'admission is acquired before local mutation locks');
    controls.scopes = scope.paths;
    if (controls.busy) throw new WorkspaceFileLifecycleBusyError('busy');
    controls.guardDepth += 1;
    try { return await work(); } finally { controls.guardDepth -= 1; }
  };
  const physicalWrite = async () => {
    assert.equal(controls.guardDepth, 1);
    controls.physicalWrites += 1;
    await fs.mkdir(path.dirname(path.join(root, destination)), { recursive: true });
    await fs.writeFile(path.join(root, destination), 'restored');
  };
  const route = { exports: {} as { POST: (request: Request, context: { params: Promise<{ backupId: string }> }) => Promise<Response> } };
  const load = createRequire(file);
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/workspaces/request') return {
      requireRequestWorkspace: async () => ({ workspace, session: { user: { id: 'fixture-user' } } }),
      workspaceFileOptions: () => ({ workspace }),
    };
    if (name === '@/app/lib/api/route-helpers') return {
      applyRateLimit: () => null, invalidateWorkspaceFileViews: () => {}, jsonError,
      jsonSuccess: (payload: object) => Response.json({ success: true, ...payload }),
      jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
      readJsonBody: (request: Request) => request.json(),
    };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => {} };
    if (name === '@/app/lib/files/workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuard: guard, WorkspaceFileLifecycleBusyError,
    };
    if (name === '@/app/lib/files/workspace-mutation-lock') return {
      withWorkspaceMutationLock: async (_workspaceId: string, work: () => Promise<unknown>) => {
        assert.equal(controls.guardDepth, 1);
        controls.mutationDepth += 1;
        try { return await work(); } finally { controls.mutationDepth -= 1; }
      },
    };
    if (name === '@/app/lib/files/collaboration-policy') return {
      initializeCopiedFileCollaborationPaths: async () => {
        assert.equal(controls.guardDepth, 1, 'metadata completes before admission release');
        assert.equal(await fs.readFile(path.join(root, destination), 'utf8'), 'restored');
        controls.metadataWrites += 1;
      },
    };
    if (name === '@/app/lib/public-sharing/public-file-shares') return {
      syncPublicSharesAfterWrite: async () => { assert.equal(controls.guardDepth, 1); controls.sharesWrites += 1; },
    };
    if (name === '@/app/lib/filesystem/zip-extraction') return {
      ZipExtractionError, extractWorkspaceZip: async () => {
        await physicalWrite();
        return { targetDir: 'imports', files: [destination], directories: ['imports'], collaborationInitializedPaths: [] };
      },
    };
    if (name === '@/app/lib/files/workspace-operation-backup') return {
      getWorkspaceOperationBackup: async () => backup,
      restoreWorkspaceOperationBackup: async () => { await physicalWrite(); return { backup, restoredPath: destination }; },
    };
    return load(name);
  }, route, route.exports);
  const invoke = () => route.exports.POST(new Request('http://localhost/api/files/fixture', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(kind === 'extract' ? { path: 'archive.zip', targetDir: 'imports' } : {}),
  }), { params: Promise.resolve({ backupId: 'fixture-backup' }) });
  return { root, controls, destination, invoke };
}

for (const kind of ['extract', 'restore'] as const) {
  test(`${kind} rejects busy lifecycle before physical work and finishes metadata under the guard`, async () => {
    const h = await routeHarness(kind);
    try {
      const sentinel = path.join(h.root, 'sentinel.bin');
      await fs.writeFile(sentinel, 'original');
      const busy = await h.invoke();
      assert.equal(busy.status, 409);
      assert.equal((await busy.json()).code, 'COLLABORATION_FILE_LIFECYCLE_BUSY');
      assert.equal(h.controls.physicalWrites, 0);
      assert.equal(h.controls.metadataWrites, 0);
      await assert.rejects(fs.stat(path.join(h.root, h.destination)), { code: 'ENOENT' });
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'original');
      h.controls.busy = false;
      const released = await h.invoke();
      assert.equal(released.status, 200);
      assert.equal(h.controls.physicalWrites, 1);
      assert.equal(h.controls.metadataWrites, 1);
      assert.equal(h.controls.sharesWrites, kind === 'extract' ? 1 : 0);
      assert.deepEqual(h.controls.scopes, kind === 'extract' ? ['archive.zip', 'imports'] : ['restored.bin']);
      assert.equal(h.controls.guardDepth, 0);
      assert.equal(h.controls.mutationDepth, 0);
    } finally { await fs.rm(h.root, { recursive: true, force: true }); }
  });
}
