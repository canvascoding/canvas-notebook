import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';
import ts from 'typescript';

import type { WorkspaceUploadFileRecord, WorkspaceUploadSession } from '../app/lib/files/workspace-upload-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const requireDependency = createRequire(import.meta.url);
type Exports = Record<string, unknown>;
type Handler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Execute each complete route module with fixtures only at its IO boundary. */
function loadRoute(filename: string, dependencies: Exports): Record<string, Handler> {
  const absolute = path.resolve(filename);
  const javascript = ts.transpileModule(readFileSync(absolute, 'utf8'), {
    fileName: absolute,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluated = { exports: {} as Record<string, Handler> };
  new Function('require', 'module', 'exports', javascript)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireDependency(name),
    evaluated, evaluated.exports,
  );
  return evaluated.exports;
}

async function main() {
  const service = await import('../app/lib/files/workspace-upload-service');
  const { uploadWorkspaceFilesInChunks } = await import('../app/lib/files/workspace-upload-client');
  const workspace: WorkspaceContext = { workspaceId: 'upload-dto', workspaceType: 'personal', rootPath: '/unused', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
  const fileKeys = ['id', 'sourceIndex', 'relativePath', 'targetPath', 'size', 'mimeType', 'uploadedBytes', 'status'].sort();
  const files: WorkspaceUploadFileRecord[] = ['first', 'second'].map((name, sourceIndex) => ({
    id: `file-${sourceIndex}`, sourceIndex, relativePath: `${name}.txt`, targetPath: `folder/${name}.txt`,
    size: name.length, mimeType: 'text/plain', uploadedBytes: 0, status: 'pending',
    officeAttempt: { version: 1, workspaceId: workspace.workspaceId, actorUserId: 'private-actor', path: `folder/${name}.txt`,
      lineageId: 'private-lineage', actorSessionId: 'private-session', idempotencyKey: 'private-request',
      expectedSha256: null, baseRevisionId: null, contentHash: 'private-hash', createOnly: true },
    futureNativeAttempt: { receipt: 'private-receipt', stateProof: 'private-proof' },
  }));
  const session: WorkspaceUploadSession = { id: 'upload-session', userId: 'private-owner', workspaceId: workspace.workspaceId,
    targetDir: 'folder', totalBytes: 11, status: 'receiving', files: [...files].reverse(),
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z' };
  Object.defineProperty(files[0], 'privateGetter', { enumerable: true, get() { assert.fail('Public mapping must not read private fields.'); } });
  function assertFile(value: Record<string, unknown>, original: WorkspaceUploadFileRecord) {
    assert.deepEqual(Object.keys(value).sort(), fileKeys);
    for (const key of fileKeys) assert.equal(value[key], original[key as keyof WorkspaceUploadFileRecord]);
    assert.doesNotMatch(JSON.stringify(value), /private-|officeAttempt|futureNativeAttempt|stateProof/);
  }
  assertFile(service.publicWorkspaceUploadFile(files[0]), files[0]);
  const mappedSession = service.publicWorkspaceUploadSession(session);
  assert.equal('userId' in mappedSession, false);
  assertFile(mappedSession.files[1], files[0]);
  assert.notEqual(mappedSession.files, session.files);
  assert.notEqual(mappedSession.files[1], files[0]);
  assert.ok(files[0].officeAttempt, 'Mapping must retain private server metadata.');

  let alreadyCompleted = false;
  let published = 0;
  const dependencies: Exports = {
    '@/app/lib/files/workspace-upload-service': { ...service,
      createWorkspaceUploadSession: async () => session,
      getWorkspaceUploadSession: async () => session,
      writeWorkspaceUploadChunk: async () => ({ session, file: files[0], alreadyReceived: true }),
      completeWorkspaceUploadFile: async (input: { fileId: string }) => ({ session,
        file: files.find(file => file.id === input.fileId)!, alreadyCompleted }),
    },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async () => ({ workspace, session: { user: { id: 'u' } } }), workspaceFileOptions: () => ({ workspace }) },
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/files/workspace-upload-responses': { workspaceUploadErrorResponse: (error: unknown) => { throw error; } },
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => undefined },
    '@/app/lib/filesystem/upload-events': { publishWorkspaceUpload: async (_workspace: unknown, targetPath: string) => { published++; return { targetPath }; } },
    '@/app/lib/filesystem/workspace-files': { replaceWorkspaceFileFromPath: async () => undefined, writeWorkspaceFileFromPathIfAbsent: async () => undefined },
    '@/app/lib/files/workspace-upload-flow': { runWorkspaceUploadWrite: async () => undefined },
    '@/app/lib/public-sharing/public-file-shares': { syncPublicSharesAfterWrite: async () => undefined },
    '@/app/lib/api/route-helpers': { invalidateWorkspaceFileViews: () => undefined },
  };
  const start = loadRoute('app/api/files/uploads/route.ts', dependencies);
  const chunk = loadRoute('app/api/files/uploads/[id]/route.ts', dependencies);
  const complete = loadRoute('app/api/files/uploads/[id]/complete/route.ts', dependencies);
  const mobileComplete = loadRoute('app/api/mobile/v1/files/uploads/[id]/complete/route.ts', dependencies);
  const mobileStart = loadRoute('app/api/mobile/v1/files/uploads/route.ts', { ...dependencies, '@/app/api/files/uploads/route': start });
  const mobileChunk = loadRoute('app/api/mobile/v1/files/uploads/[id]/route.ts', { ...dependencies, '@/app/api/files/uploads/[id]/route': chunk });
  const context = { params: Promise.resolve({ id: session.id }) };
  const request = (method: string, body?: object) => new NextRequest('http://localhost/api/files/uploads?fileId=file-0&offset=0&expectedBytes=0', {
    method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  for (const route of [start, mobileStart]) {
    const response = await route.POST(request('POST', { files: [] }), context);
    assert.equal(response.status, 201);
    const value = await response.json();
    assertFile(value.upload.files[1], files[0]);
    assert.equal('userId' in value.upload, false);
  }
  for (const route of [chunk, mobileChunk]) {
    const read = await (await route.GET(request('GET'), context)).json();
    assertFile(read.upload.files[1], files[0]);
    const write = await (await route.PUT(request('PUT'), context)).json();
    assertFile(write.file, files[0]);
    assert.equal(write.alreadyReceived, true);
  }
  for (const retry of [false, true]) {
    alreadyCompleted = retry;
    for (const route of [complete, mobileComplete]) {
      const response = await route.POST(request('POST', { fileId: files[0].id }), context);
      assert.equal(response.status, 200);
      const value = await response.json();
      assertFile(value.file, files[0]);
      assert.equal(value.alreadyCompleted, retry);
      if (value.upload) assertFile(value.upload.files[1], files[0]);
    }
  }
  assert.equal(published, 1, 'Existing fresh/retry publication behavior is preserved.');

  class UploadRequest {
    static sent: Array<{ url: string; body: Blob }> = [];
    status = 200; statusText = ''; responseText = '{"success":true}'; withCredentials = false;
    upload = { onprogress: null }; onload: (() => void) | null = null;
    onerror = null; onabort = null; private url = '';
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send(body: Blob) { UploadRequest.sent.push({ url: this.url, body }); queueMicrotask(() => this.onload?.()); }
  }
  const originalFetch = globalThis.fetch, originalXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = UploadRequest as unknown as typeof XMLHttpRequest;
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/files/uploads') return start.POST(request('POST', { files: [] }), context);
    if (String(input).endsWith('/complete')) return complete.POST(request('POST', JSON.parse(String(init?.body))), context);
    if (init?.method === 'DELETE') return Response.json({ success: true });
    throw new Error(`Unexpected upload URL: ${input}`);
  };
  try {
    const result = await uploadWorkspaceFilesInChunks({ workspaceId: workspace.workspaceId, targetDir: 'folder',
      files: ['first', 'second'].map(name => ({ path: `${name}.txt`, file: new File([name], `${name}.txt`, { type: 'text/plain' }) })) });
    assert.equal(result.completed.length, 2);
    for (const item of UploadRequest.sent) {
      const source = await item.body.text();
      assert.equal(new URL(item.url, 'http://localhost').searchParams.get('fileId'), source === 'first' ? 'file-0' : 'file-1',
        'SourceIndex must bind the original file to its server ID even when response files are reordered.');
    }
    assert.equal(UploadRequest.sent.length, 2);
  } finally { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXhr; }
  console.log('workspace-upload-public-response-test: ok (10 handler responses and reordered sourceIndex client mapping; IO fixtures)');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
