import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

async function main() {
  const filename = path.resolve('app/api/files/collaboration/location/route.ts');
  const load = createRequire(filename);
  const calls: [string, string][] = [];
  const location = { workspaceId: 'allowed-workspace', documentId: 'stable-document', path: 'renamed/note.md',
    lifecycleGeneration: 2, representation: 'tiptap_blocks' };
  let result: typeof location | null = location;
  let access: Response | null = null;
  let limited: Response | null = null;
  let available = true;
  let failure: Error | null = null;
  class LockError extends Error { status = 503; }
  const requireMock = (name: string) => {
    if (name === '@/app/lib/workspaces/request') return { requireRequestWorkspace: async (_request: NextRequest, options: unknown) => {
      assert.deepEqual(options, { permissions: 'canRead' });
      return access ? { response: access } : { workspace: { workspaceId: 'allowed-workspace' } };
    } };
    if (name === '@/app/lib/api/route-helpers') return { applyRateLimit: () => limited };
    if (name === '@/app/lib/collaboration/runtime-policy') return { liveCollaborationRuntimeAvailable: () => available };
    if (name === '@/app/lib/files/workspace-mutation-lock') return { WorkspaceMutationLockError: LockError };
    if (name === '@/app/lib/collaboration/document-location') return { resolveCollaborationDocumentLocation: async (workspaceId: string, documentId: string) => {
      calls.push([workspaceId, documentId]);
      if (failure) throw failure;
      return result;
    } };
    return load(name);
  };
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {} as { GET: (request: NextRequest) => Promise<NextResponse> };
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: exported }, exported);
  const get = (documentId = 'stable-document') => exported.GET(new NextRequest(
    `https://canvas.test/api/files/collaboration/location?documentId=${encodeURIComponent(documentId)}&workspaceId=untrusted-workspace`));
  access = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  assert.equal((await get()).status, 403);
  assert.equal(calls.length, 0);
  access = null;
  assert.equal((await get('')).status, 400);
  assert.equal((await get('x'.repeat(257))).status, 400);
  available = false;
  assert.equal((await get()).status, 409);
  available = true;
  limited = NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  assert.equal((await get()).status, 429);
  assert.equal(calls.length, 0);
  limited = null;
  const response = await get(' stable-document ');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { success: true, ...location });
  assert.deepEqual(calls, [['allowed-workspace', 'stable-document']], 'lookup uses the authorized workspace only');
  result = null;
  const missing = await get();
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal((await missing.json()).code, 'document_unavailable');
  failure = new LockError('The workspace is busy. Retry.');
  assert.equal((await get()).status, 503);
  failure = new Error('Private database details');
  const failed = await get();
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /Private database/u);
  console.log('Document location endpoint: authorization, workspace scope, validation, no-store, unavailable identities and retryable failures passed.');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
