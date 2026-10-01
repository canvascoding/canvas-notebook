import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { NextRequest } from 'next/server';

type SavedAttachment = {
  name: string;
  size: number;
  mimeType: string;
  scope: { ownerUserId: string; workspaceId: string };
};
const state = {
  authenticated: true,
  denied: false,
  saved: [] as SavedAttachment[],
  scopes: [] as { userId: string; workspaceId: string; sessionId: string }[],
};
const testGlobal = globalThis as typeof globalThis & { __mobileAttachmentTestState?: typeof state };

type Attachment = { id: string; name: string; contentKind: string; mimeType: string; size: number; previewUrl: string | null; mediaUrl: string | null };
type UploadResult = { success: boolean; attachment: Attachment; attachments: Attachment[]; code?: string; error?: string; errors?: string[] };
type Route = { POST: (request: NextRequest, context: { params: Promise<{ sessionId: string }> }) => Promise<Response> };

const mocks: Record<string, string> = {
  '@/app/lib/auth': `const state = globalThis.__mobileAttachmentTestState;
    export const auth = { api: { getSession: async () => state.authenticated ? { user: { id: 'user-a' } } : null } };`,
  '@/app/lib/mobile/chat': `const state = globalThis.__mobileAttachmentTestState;
    export class MobileChatError extends Error { constructor(code, message, status) { super(message); this.code=code; this.status=status; } }
    export async function requireMobileChatSession(scope) { state.scopes.push(scope); if (state.denied) throw new MobileChatError('WORKSPACE_ACCESS_DENIED', 'Access denied.', 403); }`,
  '@/app/lib/api/form-data': `export async function parseMultipartFormData(request) { return { ok: true, formData: await request.formData() }; }`,
  '@/app/lib/filesystem/upload-handler': `const state = globalThis.__mobileAttachmentTestState;
    export async function saveUploadBuffer(buffer, name, mimeType, scope) {
      state.saved.push({ name, size: buffer.length, mimeType, scope });
      return { id: 'upload-' + state.saved.length, originalName: name, mimeType, size: buffer.length, category: mimeType.startsWith('image/') ? 'image' : 'document' };
    }`,
  '@/app/lib/images/convert': `export function getImageConversionErrorMessage(name, error) { return name + ': ' + error.message; }`,
  '@/app/lib/images/upload-conversion': `export async function normalizeUploadImageBuffer(input) { return { buffer: input.buffer, filename: input.filename, mimeType: input.mimeType }; }`,
  '@/app/lib/utils/rate-limit': `export function rateLimit(_request, options) { if (options.limit !== 20) throw new Error('Unexpected rate limit'); return { ok: true }; }`,
};

function files(count: number): File[] {
  return Array.from({ length: count }, (_, index) => new File([`photo ${index + 1}`], `attachment-${index + 1}.${index < 6 ? 'png' : 'pdf'}`, {
    type: index < 6 ? 'image/png' : 'application/pdf',
  }));
}

async function upload(route: Route, selected: File[]) {
  const formData = new FormData();
  for (const file of selected) formData.append('file', file);
  const request = new NextRequest('https://canvas.test/api/mobile/v1/sessions/session-a/attachments', {
    method: 'POST', headers: { 'x-canvas-workspace-id': 'workspace-a' }, body: formData,
  });
  const response = await route.POST(request, { params: Promise.resolve({ sessionId: 'session-a' }) });
  return { response, payload: await response.json() as UploadResult };
}

async function main() {
  const directory = await mkdtemp(path.join(process.cwd(), '.mobile-attachments-route-'));
  testGlobal.__mobileAttachmentTestState = state;
  try {
    const filename = path.join(directory, 'route.cjs');
    await build({
      entryPoints: ['app/api/mobile/v1/sessions/[sessionId]/attachments/route.ts'], outfile: filename,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      plugins: [{ name: 'attachment-service-boundaries', setup(builder) {
        builder.onResolve({ filter: /^@\/app\/lib\// }, argument => argument.path in mocks
          ? { path: argument.path, namespace: 'mock' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, argument => ({ contents: mocks[argument.path], loader: 'js' }));
      } }],
    });
    const route = createRequire(import.meta.url)(filename) as Route;
    const selected = files(8);
    const accepted = await upload(route, selected);
    assert.equal(accepted.response.status, 201);
    assert.equal(accepted.response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(accepted.payload.success, true);
    assert.equal(accepted.payload.attachments.length, 8);
    assert.deepEqual(accepted.payload.attachment, accepted.payload.attachments[0], 'Legacy clients retain the singular response field');
    assert.deepEqual(accepted.payload.attachments.map(item => item.name), selected.map(file => file.name));
    assert.ok(accepted.payload.attachments.slice(0, 6).every(item => item.contentKind === 'image' && item.mediaUrl && item.previewUrl));
    assert.ok(accepted.payload.attachments.slice(6).every(item => item.contentKind === 'document' && item.mediaUrl === null && item.previewUrl === null));
    assert.ok(state.saved.every(item => item.scope.ownerUserId === 'user-a' && item.scope.workspaceId === 'workspace-a'));
    assert.deepEqual(state.scopes[0], { userId: 'user-a', workspaceId: 'workspace-a', sessionId: 'session-a' });

    const savedCount = state.saved.length;
    const rejected = await upload(route, files(9));
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.payload.code, 'ATTACHMENT_LIMIT_EXCEEDED');
    assert.match(rejected.payload.error || '', /up to 8 attachments/u);
    assert.equal(state.saved.length, savedCount, 'An over-limit batch saves no partial uploads');

    const legacy = await upload(route, files(1));
    assert.equal(legacy.response.status, 201);
    assert.equal(legacy.payload.attachments.length, 1);
    assert.deepEqual(legacy.payload.attachment, legacy.payload.attachments[0]);

    const tooLarge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'too-large.png', { type: 'image/png' });
    const beforeLarge = state.saved.length;
    const oversized = await upload(route, [tooLarge]);
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.payload.code, 'ATTACHMENT_SIZE_INVALID');
    assert.equal(state.saved.length, beforeLarge, 'The 10 MB per-file limit remains enforced');
    const partial = await upload(route, [...files(7), tooLarge]);
    assert.equal(partial.response.status, 201);
    assert.equal(partial.payload.attachments.length, 7);
    assert.equal(partial.payload.errors?.length, 1, 'Existing partial-batch failure reporting is retained');

    state.denied = true;
    const beforeDenied = state.saved.length;
    const denied = await upload(route, files(8));
    assert.equal(denied.response.status, 403);
    assert.equal(state.saved.length, beforeDenied);
    state.authenticated = false;
    const unauthorized = await upload(route, files(8));
    assert.equal(unauthorized.response.status, 401);
    assert.equal(state.saved.length, beforeDenied);
    console.log('mobile-chat-attachments-route-test: eight accepted, nine rejected, scope and legacy response preserved');
  } finally {
    delete testGlobal.__mobileAttachmentTestState;
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
