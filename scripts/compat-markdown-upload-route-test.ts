import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import type { CompatMarkdownUploadResult } from '../app/lib/files/compat-markdown-upload';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type Row = Record<string, unknown>;
const workspace: WorkspaceContext = { workspaceId: 'compat-route-workspace', workspaceType: 'personal', rootPath: '/owned/compat', legacy: false,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
const uploadId = '11111111-1111-4111-8111-111111111111', fileId = '22222222-2222-4222-8222-222222222222';

/** Executes the real compatibility POST and unchanged upload error response
 * helper. Auth, native import and storage are explicit IO fixtures; this is no
 * PostgreSQL, native authority, actual session or Scene-service proof. */
function harness(files: File[], options: { convertParams?: unknown; targetDir?: string } = {}) {
  const filename = path.resolve('app/api/files/upload/route.ts'), load = createRequire(filename);
  const form = new FormData(); for (const file of files) form.append('files', file);
  form.append('path', options.targetDir || 'folder');
  if (options.convertParams) form.append('convertParams', JSON.stringify(options.convertParams));
  const controls = { enabled: true, authStatus: 0, nativeStatus: 'completed', unlocated: false,
    conversionFailure: '', rawFailure: '', effectsFailure: false,
    sceneConflict: false, sceneAuthorityRevoked: false, sceneAuthorityFactories: 0, sceneAuthorityChecks: 0,
    nativeInputs: [] as Row[], rawWrites: [] as string[], normalizes: [] as string[],
    rawAttempts: [] as string[], beforeWrites: [] as string[],
    shares: [] as string[][], published: [] as string[], audits: [] as Row[] };
  class PolicyError extends Error {}
  class ServiceError extends Error {}
  const dependencies: Record<string, unknown> = {
    'next/server': { NextRequest, NextResponse },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async (request: NextRequest) => {
      assert(request instanceof NextRequest); assert.equal(request.headers.get('cookie'), 'actual-current-cookie');
      return controls.authStatus ? { response: Response.json({ success: false }, { status: controls.authStatus }) }
        : { workspace, session: { user: { id: 'actual-user' }, session: { id: 'actual-session' } } };
    }, workspaceFileOptions: () => ({ workspace }) },
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/api/form-data': { parseMultipartFormData: async () => ({ ok: true, formData: form }) },
    '@/app/lib/collaboration/native-text-session-activation': { authenticatedNativeTextSessionEnabled: () => controls.enabled },
    '@/app/lib/files/compat-markdown-upload': { COMPAT_MARKDOWN_UPLOAD_MAX_BYTES: 5 * 1024 * 1024,
      importCompatMarkdownUpload: async (input: Row & { request: NextRequest; file: File; relativePath: string; targetDir: string }): Promise<CompatMarkdownUploadResult> => {
        controls.nativeInputs.push(input); assert(input.request instanceof NextRequest);
        assert.equal(input.request.headers.get('cookie'), 'actual-current-cookie'); assert.equal(input.actorUserId, 'actual-user');
        const targetPath = path.posix.join(input.targetDir, input.relativePath), locator = { uploadId, fileId, targetPath };
        if (controls.nativeStatus === 'failed') return { status: 'failed', httpStatus: controls.unlocated ? 503 : 409,
          code: controls.unlocated ? 'UPLOAD_SESSION_CREATE_UNCONFIRMED' : 'MARKDOWN_IMPORT_TARGET_CHANGED',
          error: 'Original data was retained.', phase: controls.unlocated ? 'session_create' : 'complete',
          locator: controls.unlocated ? null : locator, unlocated: controls.unlocated };
        const completion = { status: controls.nativeStatus as 'completed' | 'projection_pending' | 'recovery_required' | 'unavailable', ...locator };
        return controls.nativeStatus === 'completed'
          ? Object.assign({ status: 'completed' as const, locator, completion, committed: { targetPath, fileVersion: 'native-version' } },
            { privateNativeEvidence: { session: 'private-upload-session', receipt: 'private-receipt', stateProof: 'private-state-proof' } })
          : { status: 'pending', httpStatus: 202, locator, completion };
      } },
    '@/app/lib/files/collaboration-policy': { FileCollaborationPolicyError: PolicyError },
    '@/app/lib/excalidraw-collaboration/http': { excalidrawRequestAuthority: (request: NextRequest, initial: {
      workspace: WorkspaceContext; session: { user: { id: string }; session: { id: string } };
    }, permission: 'canRead' | 'canWrite') => {
      assert(request instanceof NextRequest); assert.equal(request.method, 'POST');
      assert.equal(request.url, 'http://localhost/api/files/upload');
      assert.equal(request.headers.get('cookie'), 'actual-current-cookie');
      assert.equal(initial.workspace, workspace); assert.equal(permission, 'canWrite');
      assert.equal(initial.session.user.id, 'actual-user'); assert.equal(initial.session.session.id, 'actual-session');
      controls.sceneAuthorityFactories++;
      return async () => {
        controls.sceneAuthorityChecks++; request.signal.throwIfAborted();
        assert.equal(initial.workspace, workspace); assert.equal(initial.workspace.permissions.canWrite, true);
        assert.equal(request.headers.get('cookie'), 'actual-current-cookie');
        if (controls.sceneAuthorityRevoked) {
          assert.equal(controls.nativeInputs.length, 1, 'The controlled late rejection follows the preceding native import.');
          throw Object.assign(new Error('The scene upload authority changed.'), {
            status: 403, code: 'EXCALIDRAW_AUTHORITY_CHANGED', privateAuthority: 'private-scene-authority',
          });
        }
        return workspace;
      };
    } },
    '@/app/lib/images/convert': { getImageConversionErrorMessage: (name: string) => `Could not convert ${name}.` },
    '@/app/lib/images/upload-conversion': {
      parseUploadConvertParams: (raw: string | undefined) => ({ ok: true, params: raw ? JSON.parse(raw) : null }),
      normalizeUploadImageBuffer: async (input: { filename: string; buffer: Buffer; mimeType: string; convertParams?: unknown }) => {
        controls.normalizes.push(input.filename); if (controls.conversionFailure === input.filename) throw new Error('Expected conversion failure.');
        return { ...input, filename: input.convertParams ? input.filename.replace(/\.[^.]+$/u, '.jpg') : input.filename };
      } },
    '@/app/lib/files/workspace-upload-flow': { runWorkspaceUploadWrite: async (input: {
      targetPath: string; beforeWrite?: () => Promise<void>; write: (before: () => Promise<void>) => Promise<void>;
    }) => {
      controls.rawAttempts.push(input.targetPath);
      if (input.beforeWrite) { controls.beforeWrites.push(input.targetPath); await input.beforeWrite(); }
      if (controls.sceneConflict && input.targetPath.endsWith('.excalidraw')) throw Object.assign(new Error('The scene path already exists.'), {
        status: 409, code: 'PATH_EXISTS', privateSceneReceipt: 'private-scene-receipt',
      });
      if (controls.rawFailure === input.targetPath) throw new Error('Expected raw write failure.');
      await input.write(async () => undefined);
    } },
    '@/app/lib/filesystem/workspace-files': { writeFile: async (targetPath: string, _content: unknown, _options: unknown, before: () => Promise<void>) => {
      await before(); controls.rawWrites.push(targetPath);
    } },
    '@/app/lib/public-sharing/public-file-shares': { syncPublicSharesAfterWrite: async (paths: string[]) => {
      controls.shares.push(paths); if (controls.effectsFailure) throw new Error('Expected raw publication failure.');
    } },
    '@/app/lib/filesystem/upload-events': { publishWorkspaceUpload: async (_workspace: unknown, targetPath: string) => {
      controls.published.push(targetPath); return { targetPath, fileVersion: 'raw-version' };
    } },
    '@/app/lib/audit/audit-service': { recordAuditEvent: async (input: Row) => { controls.audits.push(input); } },
  };
  const responseFilename = path.resolve('app/lib/files/workspace-upload-responses.ts');
  const responseJavascript = ts.transpileModule(readFileSync(responseFilename, 'utf8'), {
    fileName: responseFilename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const responseDependencies: Record<string, unknown> = {
    'server-only': {}, 'next/server': { NextResponse },
    '@/app/lib/files/collaboration-policy': { FileCollaborationPolicyError: PolicyError },
    '@/app/lib/files/workspace-upload-service': { WorkspaceUploadServiceError: ServiceError },
  };
  const responseModule = { exports: {} as {
    workspaceUploadErrorResponse: (error: unknown, scope: string) => NextResponse;
  } };
  new Function('require', 'module', 'exports', responseJavascript)((name: string) => {
    assert(Object.hasOwn(responseDependencies, name), `Unexpected upload response dependency: ${name}`);
    return responseDependencies[name];
  }, responseModule, responseModule.exports);
  dependencies['@/app/lib/files/workspace-upload-responses'] = responseModule.exports;
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const evaluated = { exports: {} as { POST: (request: NextRequest) => Promise<Response> } };
  new Function('require', 'module', 'exports', javascript)((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : load(name), evaluated, evaluated.exports);
  const invoke = async () => {
    const response = await evaluated.exports.POST(new NextRequest('http://localhost/api/files/upload', { method: 'POST', headers: { cookie: 'actual-current-cookie' } }));
    return { response, body: await response.json() };
  };
  return { controls, invoke };
}
const file = (name: string, text = 'Exact uploaded bytes') => new File([text], name);

test('native Markdown uses actual request/helper and never the legacy buffer writer, conversion or outer effects', async () => {
  const h = harness([file('note.MARKDOWN')]), { response, body } = await h.invoke();
  assert.equal(response.status, 200); assert.equal(body.success, true); assert.deepEqual(body.files, ['note.MARKDOWN']);
  assert.equal(h.controls.nativeInputs.length, 1); assert.equal(h.controls.nativeInputs[0].targetDir, 'folder');
  assert.deepEqual(h.controls.normalizes, []); assert.deepEqual(h.controls.rawWrites, []);
  assert.deepEqual(h.controls.shares, []); assert.deepEqual(h.controls.published, []); assert.deepEqual(h.controls.audits, []);
  assert.deepEqual(body.committed, [{ targetPath: 'folder/note.MARKDOWN', fileVersion: 'native-version' }]);
});

test('gate false preserves legacy successful shape and conversion/writer/effect path', async () => {
  const h = harness([file('note.md')]); h.controls.enabled = false;
  const { response, body } = await h.invoke(); assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['success', 'count', 'files', 'committed'].sort()); assert.equal(body.count, 1);
  assert.deepEqual(h.controls.rawWrites, ['folder/note.md']); assert.equal(h.controls.nativeInputs.length, 0);
  assert.deepEqual(h.controls.shares, [['folder/note.md']]); assert.deepEqual(h.controls.published, ['folder/note.md']); assert.equal(h.controls.audits.length, 1);
});

test('txt/mdx and converted image remain raw with central Markdown classification', async () => {
  const h = harness([file('note.txt'), file('note.mdx'), file('image.png')], { convertParams: [null, null, { format: 'jpg', quality: 80 }] });
  const { body } = await h.invoke(); assert.equal(body.success, true); assert.equal(h.controls.nativeInputs.length, 0);
  assert.deepEqual(body.files, ['note.txt', 'note.mdx', 'image.jpg']);
  assert.deepEqual(h.controls.rawWrites, ['folder/note.txt', 'folder/note.mdx', 'folder/image.jpg']);
});

test('mixed success preserves input order while raw subset gets exactly one batch publication', async () => {
  const h = harness([file('first.pdf'), file('note.md'), file('last.png')]), { body } = await h.invoke();
  assert.equal(body.success, true); assert.equal(body.count, 3); assert.deepEqual(body.files, ['first.pdf', 'note.md', 'last.png']);
  assert.deepEqual(body.committed.map((value: Row) => value.targetPath), ['folder/first.pdf', 'folder/note.md', 'folder/last.png']);
  assert.deepEqual(h.controls.shares, [['folder/first.pdf', 'folder/last.png']]);
  assert.deepEqual(h.controls.published, ['folder/first.pdf', 'folder/last.png']); assert.equal(h.controls.audits.length, 1);
  assert.deepEqual((h.controls.audits[0].metadata as Row).uploadedPaths, ['folder/first.pdf', 'folder/last.png']);
});

for (const pending of ['projection_pending', 'recovery_required', 'unavailable']) test(`${pending}: HTTP202 is explicitly incomplete for old compatibility clients, retains locator and real partial results`, async () => {
  const h = harness([file('first.pdf'), file('note.md'), file('never-read.png')]); h.controls.nativeStatus = pending;
  const { response, body } = await h.invoke(); assert.equal(response.status, 202); assert.equal(body.success, false);
  assert.equal(body.count, 1); assert.deepEqual(body.files, ['first.pdf']); assert.equal(body.completion.status, pending);
  assert.equal(body.completion.uploadId, uploadId); assert.equal(body.completion.fileId, fileId);
  assert.deepEqual(h.controls.rawWrites, ['folder/first.pdf']); assert.deepEqual(h.controls.published, ['folder/first.pdf']);
  assert.equal(h.controls.shares.length, 1); assert.equal(h.controls.audits.length, 1);
  assert.equal(body.uploads[0].locator.targetPath, 'folder/note.md');
});

test('native conflict cannot fall back, overwrite or lose an acknowledged session locator', async () => {
  const h = harness([file('first.pdf'), file('note.md'), file('never-read.png')]); h.controls.nativeStatus = 'failed';
  const { response, body } = await h.invoke(); assert.equal(response.status, 409); assert.equal(body.success, false);
  assert.equal(body.upload.uploadId, uploadId); assert.equal(body.unlocated, false); assert.equal(body.code, 'MARKDOWN_IMPORT_TARGET_CHANGED');
  assert.deepEqual(h.controls.rawWrites, ['folder/first.pdf']); assert.deepEqual(h.controls.published, ['folder/first.pdf']);
});

test('unconfirmed create ACK is explicitly unlocated and never supplies an invented session ID', async () => {
  const h = harness([file('note.md')]); h.controls.nativeStatus = 'failed'; h.controls.unlocated = true;
  const { response, body } = await h.invoke(); assert.equal(response.status, 503); assert.equal(body.upload, null);
  assert.equal(body.unlocated, true); assert.equal(body.code, 'UPLOAD_SESSION_CREATE_UNCONFIRMED');
  assert.deepEqual(h.controls.rawWrites, []); assert.deepEqual(h.controls.published, []); assert.equal(body.count, 0);
});

test('native 5MiB limit and conversion conflict reject whole selection before any File read or writer', async () => {
  const large = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.md'); let reads = 0;
  Object.defineProperty(large, 'arrayBuffer', { value: async () => { reads++; throw new Error('Must not read.'); } });
  const h = harness([file('first.pdf'), large]); const { response, body } = await h.invoke();
  assert.equal(response.status, 413); assert.equal(body.code, 'MARKDOWN_UPLOAD_TOO_LARGE'); assert.equal(reads, 0);
  assert.deepEqual(h.controls.rawWrites, []); assert.deepEqual(h.controls.nativeInputs, []);
  const converted = harness([file('note.md')], { convertParams: [{ format: 'png', quality: 80 }] });
  assert.equal((await converted.invoke()).response.status, 400); assert.equal(converted.controls.nativeInputs.length, 0);
});

for (const failure of ['conversion', 'write']) test(`later raw ${failure} failure retains earlier native locator and publishes only genuine preceding raw writes`, async () => {
  const h = harness([file('note.md'), file('first.pdf'), file('broken.png')]);
  if (failure === 'conversion') h.controls.conversionFailure = 'broken.png'; else h.controls.rawFailure = 'folder/broken.png';
  const { response, body } = await h.invoke(); assert.equal(body.success, false); assert.equal(response.status, failure === 'conversion' ? 400 : 500);
  assert.equal(body.uploads[0].locator.uploadId, uploadId); assert.equal(body.count, 2);
  assert.deepEqual(body.files, ['note.md', 'first.pdf']); assert.deepEqual(h.controls.rawWrites, ['folder/first.pdf']);
  assert.deepEqual(h.controls.shares, [['folder/first.pdf']]); assert.deepEqual(h.controls.published, ['folder/first.pdf']);
  assert.equal(h.controls.audits.length, 1); assert.equal(body.committed.some((value: Row) => value.targetPath === 'folder/broken.png'), false);
});

test('raw publication failure is not retried and keeps completed native facts plus actual locator', async () => {
  const h = harness([file('note.md'), file('first.pdf')]); h.controls.effectsFailure = true;
  const { response, body } = await h.invoke(); assert.equal(response.status, 500); assert.equal(body.success, false);
  assert.equal(body.count, 1); assert.deepEqual(body.files, ['note.md']); assert.equal(body.uploads[0].locator.uploadId, uploadId);
  assert.equal(h.controls.shares.length, 1); assert.deepEqual(h.controls.published, []); assert.equal(h.controls.audits.length, 0);
});

test('current auth rejection precedes helper, File reads and every side effect', async () => {
  const h = harness([file('note.md')]); h.controls.authStatus = 401;
  assert.equal((await h.invoke()).response.status, 401); assert.deepEqual(h.controls.nativeInputs, []);
  assert.deepEqual(h.controls.rawWrites, []); assert.deepEqual(h.controls.published, []);
});

for (const code of ['PATH_EXISTS', 'EXCALIDRAW_AUTHORITY_CHANGED'] as const) test(
  `route-only IO: Markdown then Scene ${code} preserves exact public native completion and stops later files`, async () => {
    let laterReads = 0;
    const later = file('never.txt');
    Object.defineProperty(later, 'arrayBuffer', { value: async () => { laterReads++; throw new Error('Later file must not be read.'); } });
    const h = harness([file('note.md'), file('scene.excalidraw'), later]);
    h.controls.sceneConflict = code === 'PATH_EXISTS';
    h.controls.sceneAuthorityRevoked = code === 'EXCALIDRAW_AUTHORITY_CHANGED';
    const { response, body } = await h.invoke();
    assert(response instanceof NextResponse);
    assert.equal(response.status, code === 'PATH_EXISTS' ? 409 : 403);
    const locator = { uploadId, fileId, targetPath: 'folder/note.md' };
    assert.deepEqual(body, {
      success: false, code,
      error: code === 'PATH_EXISTS' ? 'The scene path already exists.' : 'The scene upload authority changed.',
      count: 1, files: ['note.md'], committed: [{ targetPath: locator.targetPath, fileVersion: 'native-version' }],
      uploads: [{ status: 'completed', locator, completion: { status: 'completed', ...locator } }],
    });
    assert.equal(Object.hasOwn(body, 'unlocated'), false);
    assert.equal(Object.hasOwn(body.uploads[0], 'unlocated'), false);
    assert.doesNotMatch(JSON.stringify(body), /private-|privateNativeEvidence|privateAuthority|privateSceneReceipt|stateProof/);
    assert.equal(h.controls.nativeInputs.length, 1);
    assert.equal(h.controls.nativeInputs[0].relativePath, 'note.md');
    assert.equal(h.controls.sceneAuthorityFactories, 1); assert.equal(h.controls.sceneAuthorityChecks, 1);
    assert.deepEqual(h.controls.beforeWrites, ['folder/scene.excalidraw']);
    assert.deepEqual(h.controls.rawAttempts, ['folder/scene.excalidraw']);
    assert.deepEqual(h.controls.normalizes, ['scene.excalidraw']); assert.equal(laterReads, 0);
    assert.deepEqual(h.controls.rawWrites, []); assert.deepEqual(h.controls.shares, []);
    assert.deepEqual(h.controls.published, []); assert.deepEqual(h.controls.audits, []);
  },
);
