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
    // This seam checks route inputs only; it does not exercise production authentication.
    '@/app/lib/excalidraw-collaboration/http': { excalidrawRequestAuthority: (candidate: NextRequest,
      initial: { workspace: WorkspaceContext; session: { user: { id: string } } }, permission: string) => {
      assert.ok(candidate instanceof NextRequest);
      assert.equal(initial.workspace, workspace);
      assert.equal(initial.session.user.id, 'u');
      assert.equal(permission, 'canWrite');
      return async () => workspace;
    } },
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

  // Actual complete handlers, with native-service outcomes supplied at the IO boundary.
  // These cases establish route plumbing, not native persistence or authentication.
  type CompleteInput = Parameters<typeof service.completeWorkspaceUploadFile>[0];
  type Completion = NonNullable<Awaited<ReturnType<typeof service.completeWorkspaceUploadFile>>['completion']>;
  for (const platform of ['web', 'mobile'] as const) {
    for (const status of ['completed', 'projection_pending'] as const) {
      const nativeFile: WorkspaceUploadFileRecord & Record<string, unknown> = {
        id: `native-${platform}-${status}`, sourceIndex: 0, relativePath: 'native.md', targetPath: 'folder/native.md',
        size: 12, mimeType: 'text/markdown', uploadedBytes: 12, status: status === 'completed' ? 'completed' : 'uploaded',
        privateAttempt: { actorUserId: 'private-actor', proof: 'private-state-proof' },
        futureNativeAttempt: { receipt: 'private-receipt', stateProof: 'private-proof' },
        proof: 'private-file-proof',
      };
      const nativeSession: WorkspaceUploadSession & Record<string, unknown> = {
        id: `native-upload-${platform}-${status}`, userId: 'private-owner', workspaceId: workspace.workspaceId,
        targetDir: 'folder', totalBytes: nativeFile.size, status: status === 'completed' ? 'completed' : 'receiving',
        files: [nativeFile], createdAt: session.createdAt, updatedAt: session.updatedAt, expiresAt: session.expiresAt,
        privateAttempt: { proof: 'private-session-proof' }, proof: 'private-upload-proof',
      };
      for (const record of [nativeFile, nativeSession]) {
        Object.defineProperty(record, 'privateGetter', { enumerable: true,
          get() { assert.fail('Complete responses must select public fields without reading private metadata.'); } });
      }
      const completion: Completion = { status, uploadId: nativeSession.id, fileId: nativeFile.id,
        targetPath: nativeFile.targetPath,
        ...(status === 'projection_pending' ? { code: 'MARKDOWN_UPLOAD_PROJECTION_PENDING' as const } : {}),
      };
      const incoming = new NextRequest(`http://localhost/api/${platform}/files/uploads/${nativeSession.id}/complete?workspaceId=${workspace.workspaceId}`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: 'canvas-session=fixture-cookie',
          authorization: 'Bearer fixture-token', 'x-canvas-workspace-id': workspace.workspaceId, 'x-upload-fixture': platform },
        body: JSON.stringify({ fileId: nativeFile.id }),
      });
      const fixtureWorkspaceResult = { workspace, session: { user: { id: 'u' }, session: { id: 'fixture-auth-session' } } };
      const fixtureFileOptions = { workspace };
      let authorizedRequest: NextRequest | undefined;
      let authorizationCalls = 0;
      let completeCalls = 0;
      let forwardedCallbackCalls = 0;
      let excalidrawAuthorityCalls = 0;
      const events: string[] = [];
      const nativeDependencies: Exports = {
        ...dependencies,
        '@/app/lib/workspaces/request': {
          requireRequestWorkspace: async (candidate: NextRequest, options: { permissions: string }) => {
            authorizationCalls++;
            assert.ok(candidate instanceof NextRequest);
            assert.notEqual(candidate, incoming);
            assert.equal(candidate.url, incoming.url);
            assert.equal(candidate.method, incoming.method);
            assert.deepEqual([...candidate.headers], [...incoming.headers]);
            assert.equal(candidate.headers.get('cookie'), 'canvas-session=fixture-cookie');
            assert.equal(candidate.headers.get('authorization'), 'Bearer fixture-token');
            assert.equal(candidate.headers.get('x-canvas-workspace-id'), workspace.workspaceId);
            assert.equal(candidate.body, null, 'The retained credential request must not share the consumed JSON body.');
            assert.equal(incoming.bodyUsed, false);
            assert.deepEqual(options, { permissions: 'canWrite' });
            authorizedRequest = candidate;
            return fixtureWorkspaceResult;
          },
          workspaceFileOptions: (candidate: WorkspaceContext) => {
            assert.equal(candidate, workspace);
            return fixtureFileOptions;
          },
        },
        '@/app/lib/files/workspace-upload-service': { ...service,
          completeWorkspaceUploadFile: async (input: CompleteInput) => {
            completeCalls++;
            events.push('service:start');
            assert.equal(input.sessionId, nativeSession.id);
            assert.equal(input.fileId, nativeFile.id);
            assert.equal(input.userId, 'u');
            assert.equal(input.workspace, workspace);
            assert.ok(input.request instanceof NextRequest);
            assert.equal(input.request, authorizedRequest, 'The same credential request must reach the native completion service.');
            assert.equal(input.request.body, null);
            assert.equal(input.includeFullSession, platform === 'web' ? false : undefined);
            assert.equal(typeof input.commit, 'function');
            assert.equal(typeof input.afterMarkdownCompletion, 'function');
            if (status === 'completed') {
              forwardedCallbackCalls++;
              await input.afterMarkdownCompletion!({ session: nativeSession, file: nativeFile });
            }
            events.push('service:return');
            return { session: nativeSession, file: nativeFile, alreadyCompleted: false, completion };
          },
        },
        '@/app/lib/public-sharing/public-file-shares': { syncPublicSharesAfterWrite: async (paths: string[], candidate: WorkspaceContext) => {
          assert.deepEqual(paths, [nativeFile.targetPath]);
          assert.equal(candidate, workspace);
          events.push('sync');
        } },
        '@/app/lib/filesystem/upload-events': { publishWorkspaceUpload: async (candidate: WorkspaceContext, targetPath: string) => {
          assert.equal(platform, 'web');
          assert.equal(candidate, workspace);
          assert.equal(targetPath, nativeFile.targetPath);
          events.push('publish');
          return { targetPath };
        } },
        '@/app/lib/api/route-helpers': { invalidateWorkspaceFileViews: (input: unknown) => {
          assert.equal(platform, 'mobile');
          assert.deepEqual(input, { fileOptions: fixtureFileOptions, fullTree: true,
            mutations: [{ path: nativeFile.targetPath, type: 'add' }] });
          events.push('invalidate');
        } },
        '@/app/lib/audit/audit-service': { recordAuditEvent: async (event: { workspaceId: string; userId: string; action: string;
          entityId: string; metadata: { uploadSessionId: string; targetPath: string; mobile?: boolean } }) => {
          assert.equal(event.workspaceId, workspace.workspaceId);
          assert.equal(event.userId, 'u');
          assert.equal(event.action, 'file.upload');
          assert.equal(event.entityId, nativeFile.targetPath);
          assert.equal(event.metadata.uploadSessionId, nativeSession.id);
          assert.equal(event.metadata.targetPath, nativeFile.targetPath);
          assert.equal(event.metadata.mobile, platform === 'mobile' ? true : undefined);
          events.push('audit');
        } },
        '@/app/lib/files/workspace-upload-flow': { runWorkspaceUploadWrite: async () => {
          assert.fail('A native service outcome must not invoke the legacy outer write flow.');
        } },
        '@/app/lib/excalidraw-collaboration/http': { excalidrawRequestAuthority: (candidate: NextRequest,
          initial: typeof fixtureWorkspaceResult, permission: string) => {
          excalidrawAuthorityCalls++;
          assert.equal(candidate, incoming);
          assert.equal(initial, fixtureWorkspaceResult);
          assert.equal(permission, 'canWrite');
          return async () => workspace;
        } },
      };
      const nativeRoute = loadRoute(platform === 'web' ? 'app/api/files/uploads/[id]/complete/route.ts'
        : 'app/api/mobile/v1/files/uploads/[id]/complete/route.ts', nativeDependencies);
      const response = await nativeRoute.POST(incoming, { params: Promise.resolve({ id: nativeSession.id }) });
      const value = await response.json();
      assert.equal(authorizationCalls, 1);
      assert.equal(completeCalls, 1, 'Each handler must delegate completion exactly once.');
      assert.equal(forwardedCallbackCalls, status === 'completed' ? 1 : 0);
      assert.equal(excalidrawAuthorityCalls, 0);
      assert.deepEqual(value.completion, completion);
      assert.doesNotMatch(JSON.stringify(value), /private-|privateAttempt|futureNativeAttempt|stateProof|"proof"|"userId"/);
      assert.ok(nativeFile.privateAttempt, 'Public response mapping must retain the private service attempt.');
      assert.ok(nativeSession.privateAttempt);
      if (status === 'completed') {
        assert.equal(response.status, 200);
        assert.equal(value.success, true);
        assert.equal(value.alreadyCompleted, false);
        assertFile(value.file, nativeFile);
        assert.deepEqual(events, ['service:start', 'sync', platform === 'web' ? 'publish' : 'invalidate', 'audit', 'service:return'],
          'The forwarded callback must run inside completion; the route must not repeat its effects after service return.');
        if (platform === 'web') assert.deepEqual(value.committed, { targetPath: nativeFile.targetPath });
        else {
          assert.deepEqual(Object.keys(value.upload).sort(),
            ['id', 'workspaceId', 'targetDir', 'totalBytes', 'status', 'files', 'createdAt', 'updatedAt', 'expiresAt'].sort());
          assert.equal(value.upload.id, nativeSession.id);
          assertFile(value.upload.files[0], nativeFile);
        }
      } else {
        assert.equal(response.status, platform === 'web' ? 202 : 409);
        assert.equal(value.success, platform === 'web');
        assert.equal('committed' in value, false);
        assert.deepEqual(events, ['service:start', 'service:return'], 'Pending native work must not publish outer completion effects.');
        if (platform === 'web') {
          assert.equal(value.uploadId, nativeSession.id);
          assert.equal(value.alreadyCompleted, false);
          assertFile(value.file, nativeFile);
        } else {
          assert.equal(value.code, 'MARKDOWN_UPLOAD_PROJECTION_PENDING');
          assert.equal('file' in value, false);
          assert.equal('upload' in value, false);
          assert.equal('uploadId' in value, false);
        }
      }
    }
  }

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
  console.log('workspace-upload-public-response-test: ok (existing TXT handlers, 4 native completion outcomes and reordered sourceIndex client mapping; IO fixtures)');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
