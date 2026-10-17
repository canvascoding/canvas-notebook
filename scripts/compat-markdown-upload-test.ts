import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import type { importCompatMarkdownUpload } from '../app/lib/files/compat-markdown-upload';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const uploadId = '11111111-1111-4111-8111-111111111111', fileId = '22222222-2222-4222-8222-222222222222';
const workspace: WorkspaceContext = { workspaceId: 'compat-workspace', workspaceType: 'personal', rootPath: '/owned/compat', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
type Row = Record<string, unknown>;

/** Real adapter body and real File/NextRequest/streams. Only its existing IO
 * boundaries are substituted; these tests grant no native/SQL authority. */
function harness() {
  const filename = path.resolve('app/lib/files/compat-markdown-upload.ts'), load = createRequire(filename);
  const controls = { enabled: true, fail: '' as string, pending: '' as string, alreadyCompleted: false,
    wrongCompletion: false, wrongSession: false, duplicateEffects: false,
    events: [] as string[], calls: [] as Array<{ kind: string; input: Row }>, chunkBytes: new Uint8Array(), replacements: 0 };
  class ServiceError extends Error { constructor(readonly code: string, readonly status: number, message: string) { super(message); } }
  let session: Row, file: Row;
  const dependencies: Record<string, unknown> = {
    'server-only': {},
    '../collaboration/native-text-session-activation': { authenticatedNativeTextSessionEnabled: () => controls.enabled },
    './workspace-upload-service': {
      WorkspaceUploadServiceError: ServiceError,
      createWorkspaceUploadSession: async (input: Row & { files: Array<{ path: string; size: number; mimeType: string }>; workspace: WorkspaceContext }) => {
        controls.events.push('create'); controls.calls.push({ kind: 'create', input });
        if (controls.fail === 'create') throw new Error('private filesystem session ACK failure');
        if (controls.fail === 'create-known') throw new ServiceError('UPLOAD_FILE_PATH_INVALID', 400, 'Invalid upload path.');
        const first = input.files[0];
        file = { id: fileId, relativePath: first.path, targetPath: input.targetDir === '.' ? first.path : `${input.targetDir}/${first.path}`,
          size: first.size, mimeType: first.mimeType, status: 'pending', futureNativeProof: 'PRIVATE_NATIVE_PROOF' };
        session = { id: uploadId, userId: input.userId, workspaceId: controls.wrongSession ? 'other-workspace' : input.workspace.workspaceId,
          files: [file], futureSecret: 'PRIVATE_SESSION_SECRET' };
        return session;
      },
      writeWorkspaceUploadChunk: async (input: Row & { body: ReadableStream<Uint8Array> }) => {
        controls.events.push('chunk'); controls.calls.push({ kind: 'chunk', input });
        if (controls.fail === 'chunk') throw new Error('private chunk fsync ACK failure');
        const reader = input.body.getReader(), chunks: Uint8Array[] = [];
        try { while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); } }
        finally { reader.releaseLock(); }
        controls.chunkBytes = Buffer.concat(chunks); return { session, file, alreadyReceived: false };
      },
      completeWorkspaceUploadFile: async (input: Row & {
        commit: (value: Row) => Promise<void>; afterMarkdownCompletion: (value: Row) => Promise<void>;
      }) => {
        controls.events.push('complete'); controls.calls.push({ kind: 'complete', input });
        if (controls.fail === 'complete') throw new Error('private native COMMIT ACK failure');
        if (!controls.pending && !controls.alreadyCompleted) {
          await input.commit({ session, file, sourcePath: '/owned/private/actual-upload.part', persistOfficeAttempt: async () => undefined });
          await input.afterMarkdownCompletion({ session, file });
          if (controls.duplicateEffects) await input.afterMarkdownCompletion({ session, file });
        }
        return { session, file, alreadyCompleted: controls.alreadyCompleted,
          ...(controls.fail === 'missing-completion' ? {} : { completion: { status: controls.pending || 'completed', uploadId,
            fileId, targetPath: controls.wrongCompletion ? 'other.md' : file.targetPath,
            ...(controls.pending ? { code: 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED' } : {}), futureNative: 'PRIVATE_COMPLETION' } }) };
      },
    },
    './workspace-upload-flow': { runWorkspaceUploadWrite: async (input: Row) => {
      controls.events.push('writer'); controls.calls.push({ kind: 'writer', input });
      // The genuine Complete dispatch intercepts this writer before its raw
      // callback; unit tests inspect that contract without manufacturing ALS.
    } },
    '../filesystem/workspace-files': { replaceWorkspaceFileFromPath: async () => { controls.replacements++; } },
    '../public-sharing/public-file-shares': { syncPublicSharesAfterWrite: async (paths: string[]) => {
      controls.events.push('shares'); controls.calls.push({ kind: 'shares', input: { paths } });
      if (controls.fail === 'effects') throw new Error('private public-share write failure');
    } },
    '../filesystem/upload-events': { publishWorkspaceUpload: async (_workspace: unknown, targetPath: string) => {
      controls.events.push('publish'); return { targetPath, fileVersion: 'actual-public-version' };
    } },
    '../audit/audit-service': { recordAuditEvent: async (input: Row) => {
      controls.events.push('audit'); controls.calls.push({ kind: 'audit', input });
      if (controls.fail === 'audit') throw new Error('private audit ACK failure');
    } },
  };
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const evaluated = { exports: {} as { importCompatMarkdownUpload: typeof importCompatMarkdownUpload } };
  new Function('require', 'module', 'exports', javascript)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : load(name), evaluated, evaluated.exports);
  const request = new NextRequest('http://localhost/api/files/upload', { method: 'POST',
    headers: { cookie: 'current-session-cookie', 'x-canvas-workspace-id': workspace.workspaceId } });
  const invoke = (file = new File(['# Exact\r\n😀'], 'note.md', { type: 'text/markdown' }), relativePath = file.name,
    currentWorkspace = structuredClone(workspace)) => evaluated.exports.importCompatMarkdownUpload({ request, workspace: currentWorkspace,
      fileOptions: { workspace: currentWorkspace }, actorUserId: 'current-user', targetDir: 'folder', file, relativePath });
  return { controls, invoke, request };
}

test('actual adapter uses single-file create/chunk/complete, real bytes, request and upload idempotency', async () => {
  const h = harness(), text = '# Exact\r\n😀', result = await h.invoke(new File([text], 'note.MARKDOWN', { type: 'text/markdown' }));
  assert.equal(result.status, 'completed'); if (result.status !== 'completed') assert.fail();
  assert.deepEqual(result.locator, { uploadId, fileId, targetPath: 'folder/note.MARKDOWN' });
  assert.deepEqual(h.controls.chunkBytes, Buffer.from(text));
  assert.deepEqual(h.controls.events, ['create', 'chunk', 'complete', 'writer', 'shares', 'publish', 'audit']);
  const chunk = h.controls.calls.find(value => value.kind === 'chunk')!.input;
  assert.equal(chunk.offset, 0); assert.equal(chunk.expectedBytes, Buffer.byteLength(text)); assert.equal(chunk.includeFullSession, false);
  const complete = h.controls.calls.find(value => value.kind === 'complete')!.input;
  assert(complete.request instanceof NextRequest); assert.equal(complete.request.headers.get('cookie'), 'current-session-cookie');
  const writer = h.controls.calls.find(value => value.kind === 'writer')!.input;
  assert.equal(writer.sourcePath, '/owned/private/actual-upload.part'); assert.equal(writer.actorUserId, 'current-user');
  assert.equal(writer.idempotencyKey, `upload:${uploadId}:${fileId}`); assert.equal(typeof writer.write, 'function');
  assert.equal(h.controls.replacements, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|userId|futureNative/);
});

test('real empty Markdown skips Chunk and delegates empty Source creation entirely to Complete', async () => {
  const h = harness(), result = await h.invoke(new File([], 'empty.md'));
  assert.equal(result.status, 'completed'); assert.equal(h.controls.events.includes('chunk'), false);
  assert.equal(h.controls.events.filter(value => value === 'complete').length, 1);
  assert.equal(h.controls.calls.find(value => value.kind === 'create')!.input.files instanceof Array, true);
});

test('5 MiB is accepted and larger input is refused before arrayBuffer or session creation', async () => {
  const h = harness(), maximum = 5 * 1024 * 1024;
  assert.equal((await h.invoke(new File([new Uint8Array(maximum)], 'maximum.md'))).status, 'completed');
  const tooLarge = new File([new Uint8Array(maximum + 1)], 'large.md'); let reads = 0;
  Object.defineProperty(tooLarge, 'arrayBuffer', { value: async () => { reads++; throw new Error('Must not allocate.'); } });
  const other = harness(), result = await other.invoke(tooLarge); assert.equal(result.status, 'failed');
  if (result.status !== 'failed') assert.fail(); assert.equal(result.httpStatus, 413); assert.equal(result.code, 'MARKDOWN_UPLOAD_TOO_LARGE');
  assert.equal(reads, 0); assert.deepEqual(other.controls.events, []);
});

test('headers and workspace scope are detached before the first file-read await', async () => {
  const h = harness(), currentWorkspace = structuredClone(workspace), file = new File(['A'], 'note.md');
  const pending = h.invoke(file, file.name, currentWorkspace);
  h.request.headers.set('cookie', 'replacement-session'); currentWorkspace.workspaceId = 'replacement-workspace';
  currentWorkspace.permissions.canWrite = false;
  assert.equal((await pending).status, 'completed');
  const complete = h.controls.calls.find(value => value.kind === 'complete')!.input;
  assert.equal((complete.request as NextRequest).headers.get('cookie'), 'current-session-cookie');
  assert.equal((complete.workspace as WorkspaceContext).workspaceId, workspace.workspaceId);
});

test('genuine File bytes ignore an overridden reader and a File-shaped DTO is rejected', async () => {
  const h = harness(), file = new File(['Exact actual bytes'], 'note.md'); let injectedReads = 0;
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { injectedReads++; return new ArrayBuffer(0); } });
  assert.equal((await h.invoke(file)).status, 'completed'); assert.equal(injectedReads, 0);
  assert.deepEqual(h.controls.chunkBytes, Buffer.from('Exact actual bytes'));
  const other = harness(), fake = { name: 'note.md', size: 1, type: 'text/markdown', arrayBuffer: async () => new Uint8Array([65]).buffer };
  const result = await other.invoke(fake as File); assert.equal(result.status, 'failed');
  if (result.status !== 'failed') assert.fail(); assert.equal(result.code, 'UPLOAD_FILE_REQUIRED'); assert.deepEqual(other.controls.events, []);
});

for (const status of ['projection_pending', 'recovery_required', 'unavailable']) test(`${status}: real locator retained with no success or post-effects`, async () => {
  const h = harness(); h.controls.pending = status; const result = await h.invoke();
  assert.equal(result.status, 'pending'); if (result.status !== 'pending') assert.fail();
  assert.equal(result.httpStatus, 202); assert.equal(result.locator.uploadId, uploadId); assert.equal(result.completion.status, status);
  assert.equal(h.controls.events.includes('writer'), false); assert.equal(h.controls.events.includes('publish'), false);
});

for (const phase of ['create', 'chunk', 'complete', 'effects', 'audit']) test(`${phase}: unknown ACK never falls back or cancels, and preserves actual locator when available`, async () => {
  const h = harness(); h.controls.fail = phase; const result = await h.invoke();
  assert.equal(result.status, 'failed'); if (result.status !== 'failed') assert.fail();
  assert.equal(result.httpStatus, 503); assert.equal(result.unlocated, phase === 'create');
  assert.equal(result.locator?.uploadId ?? null, phase === 'create' ? null : uploadId);
  if (phase === 'create') assert.equal(result.code, 'UPLOAD_SESSION_CREATE_UNCONFIRMED');
  assert.equal(h.controls.replacements, 0); assert.doesNotMatch(JSON.stringify(result), /private |PRIVATE_/);
  assert.equal(h.controls.events.filter(value => value === 'create').length, 1);
});

test('known create rejection retains its actual 400 code and makes no completion claim', async () => {
  const h = harness(); h.controls.fail = 'create-known'; const result = await h.invoke();
  assert.equal(result.status, 'failed'); if (result.status !== 'failed') assert.fail();
  assert.equal(result.httpStatus, 400); assert.equal(result.code, 'UPLOAD_FILE_PATH_INVALID'); assert.equal(result.locator, null);
});

for (const invalidKind of ['gate', 'extension', 'session', 'completion', 'missing-completion', 'duplicate-effects']) test(`${invalidKind}: no alternate raw completion path is accepted`, async () => {
  const h = harness();
  if (invalidKind === 'gate') h.controls.enabled = false;
  if (invalidKind === 'session') h.controls.wrongSession = true;
  if (invalidKind === 'completion') h.controls.wrongCompletion = true;
  if (invalidKind === 'missing-completion') h.controls.fail = invalidKind;
  if (invalidKind === 'duplicate-effects') h.controls.duplicateEffects = true;
  const result = await h.invoke(undefined, invalidKind === 'extension' ? 'note.mdx' : 'note.md');
  assert.equal(result.status, 'failed'); assert.equal(h.controls.replacements, 0);
  assert(h.controls.events.filter(value => value === 'publish').length <= 1);
  assert(h.controls.events.filter(value => value === 'audit').length <= 1);
});

test('already-completed actual transport observation emits no second effect', async () => {
  const h = harness(); h.controls.alreadyCompleted = true; const result = await h.invoke();
  assert.equal(result.status, 'completed'); assert.equal(h.controls.events.includes('publish'), false);
  assert.equal(h.controls.events.includes('audit'), false);
});
