import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { expect, request, test, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { COLLABORATION_CLIENT_CAPABILITIES, COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { DocumentReadFormatV1, DocumentReadPageV1, DocumentReadRequestV1 } from '../app/lib/documents/contracts';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import { assertCompletedWorkspaceMarkdownCreate } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';

// Only the original supervisor creates the production host, database, license
// and users. Every document action below crosses that host's actual TCP route.
const origin = process.env.BASE_URL ?? '';
const selector = '.tiptap-editor-shell .ProseMirror';
const initialText = 'A😀B🧪C';
const suffix = ' appended';
const maximumResponseBytes = 2 * 1024 * 1024;
const apiContexts: APIRequestContext[] = [];
const browserContexts: BrowserContext[] = [];
const pages: Page[] = [];
const pageErrors: string[] = [];
type Identity = { userId: string; sessionId: string };
type Login = { web: APIRequestContext; bearer: APIRequestContext; identity: Identity };
type NativeSession = { documentId: string; lifecycleGeneration: number; representation: string; schemaVersion: number;
  stateProof: string; stateVector: string; documentSequence: number };
type Candidate = Awaited<ReturnType<typeof readNativeRichCandidate>>;
type NativeBody = { bodyVersion: 1; representation: string; content: { kind: string; text?: string;
  document?: Candidate['document']; frontmatter?: string; bodyFinalLineEnding?: string } };
let owner: Login;
let peer: Login | undefined;
let workspaceId = '';
let plainId = '';
let richId = '';
let richPath = '';
let editor: Page;
let originalCandidate: Candidate;
let originalPage: DocumentReadPageV1;
let originalCursor = '';
let finalPage: DocumentReadPageV1;
let finalCursor = '';

const workspaceHeaders = () => ({ Origin: origin, 'x-canvas-workspace-id': workspaceId });

/** Read the whole bounded response before checking its status. Never include
 * authentication payloads or raw responses in an assertion/log message. */
async function json(response: APIResponse, label: string): Promise<Record<string, unknown>> {
  const bytes = await response.body();
  expect(bytes.byteLength, `${label}: complete response exceeds the fixture bound`).toBeLessThanOrEqual(maximumResponseBytes);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch { throw new Error(`${label}: the complete bounded response is not a UTF-8 JSON object.`); }
}

async function currentIdentity(api: APIRequestContext, email: string): Promise<Identity> {
  const response = await api.get('/api/auth/get-session', { maxRedirects: 0 });
  const value = await json(response, 'Current genuine session');
  expect(response.status(), 'Current genuine session HTTP status').toBe(200);
  const user = value.user as { id?: unknown; email?: unknown } | undefined;
  const session = value.session as { id?: unknown } | undefined;
  expect(typeof user?.id).toBe('string'); expect(typeof session?.id).toBe('string');
  expect(user?.email).toBe(email);
  if (typeof user?.id !== 'string' || typeof session?.id !== 'string') throw new Error('The current genuine identity is absent.');
  expect(user.id.length).toBeGreaterThan(0); expect(session.id.length).toBeGreaterThan(0);
  return { userId: user.id, sessionId: session.id };
}

async function login(email: string | undefined, password: string | undefined): Promise<Login> {
  if (!email || !password) throw new Error('The original supervisor must supply its real fixture credentials.');
  const web = await request.newContext({ baseURL: origin, timeout: 15_000,
    storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Origin: origin } });
  apiContexts.push(web);
  const response = await web.post('/api/auth/sign-in/email', { data: { email, password }, maxRedirects: 0 });
  await json(response, 'Genuine HTTP sign-in');
  expect(response.status(), 'Genuine HTTP sign-in status').toBe(200);
  let token = response.headers()['set-auth-token'] ?? '';
  if (!token || token.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('The genuine sign-in did not issue a bounded native bearer.');
  }
  expect((await web.storageState()).cookies.length).toBeGreaterThan(0);
  const bearer = await request.newContext({ baseURL: origin, timeout: 15_000,
    storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  token = ''; apiContexts.push(bearer);
  const identity = await currentIdentity(web, email);
  expect(await currentIdentity(bearer, email)).toEqual(identity);
  expect((await bearer.storageState()).cookies).toEqual([]);
  expect((await bearer.storageState()).origins).toEqual([]);
  return { web, bearer, identity };
}

function selection(documentId: string, extra: Partial<DocumentReadRequestV1> = {}): DocumentReadRequestV1 {
  return { apiVersion: 1, workspaceId, documentId, ...extra };
}

function assertPage(value: DocumentReadPageV1, documentId: string, format: DocumentReadFormatV1): void {
  expect(Object.keys(value).sort()).toEqual(['apiVersion', 'document', 'currency', 'projection', 'format', 'mediaType',
    'encoding', 'fragment', 'byteOffset', 'byteLength', 'totalBytes', 'nextCursor', 'complete'].sort());
  expect(value.apiVersion).toBe(1); expect(value.format).toBe(format); expect(value.encoding).toBe('utf-8');
  expect(value.document).toMatchObject({ kind: 'native_document', workspaceId, documentId, schemaVersion: COLLABORATION_SCHEMA_VERSION });
  expect(value.document.version).toMatch(/^canvas-document-v1:[a-f0-9]{64}$/u);
  expect(value.document.metadataVersion).toMatch(/^canvas-document-metadata-v1:[a-f0-9]{64}$/u);
  expect(value.document.lineageId.length).toBeGreaterThan(0);
  expect(value.document.lifecycleGeneration).toBeGreaterThan(0);
  expect(value.currency.observedVersion).toBe(value.document.version);
  expect(['live_yjs', 'persisted_yjs']).toContain(value.currency.source);
  expect(typeof value.currency.observedDurable).toBe('boolean');
  if (value.currency.observedDurable) {
    expect(value.currency.source).toBe('persisted_yjs'); expect(value.currency.durableVersion).toBe(value.document.version);
  } else {
    expect(value.currency.source).toBe('live_yjs'); expect(value.currency.durableVersion).not.toBe(value.document.version);
  }
  expect(['current', 'pending', 'unavailable']).toContain(value.projection.status);
  expect(value.mediaType).toBe(format === 'native' ? 'application/vnd.canvas.native-document+json'
    : format === 'text' ? 'text/plain' : 'text/markdown');
  for (const number of [value.byteOffset, value.byteLength, value.totalBytes]) {
    expect(Number.isSafeInteger(number)).toBe(true); expect(number).toBeGreaterThanOrEqual(0);
  }
  expect(value.byteLength).toBe(Buffer.byteLength(value.fragment, 'utf8'));
  expect(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.fragment, 'utf8'))).toBe(value.fragment);
  expect(value.byteOffset + value.byteLength).toBeLessThanOrEqual(value.totalBytes);
  expect(value.complete).toBe(value.byteOffset + value.byteLength === value.totalBytes);
  if (value.complete) expect(value.nextCursor).toBeNull();
  else { expect(value.byteLength).toBeGreaterThan(0); expect(typeof value.nextCursor).toBe('string'); }
}

async function read(api: APIRequestContext, documentId: string, extra: Partial<DocumentReadRequestV1> = {}): Promise<DocumentReadPageV1> {
  const response = await api.post('/api/documents/read', { headers: workspaceHeaders(), data: selection(documentId, extra), maxRedirects: 0 });
  const value = await json(response, 'Document read');
  expect(response.status(), 'Actual production document-read HTTP status').toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store'); expect(response.headers().pragma).toBe('no-cache');
  const page = value as unknown as DocumentReadPageV1;
  assertPage(page, documentId, extra.format ?? 'native');
  return page;
}

async function failure(response: APIResponse, statuses: readonly number[], codes: readonly string[]): Promise<void> {
  const value = await json(response, 'Expected document-read denial');
  expect(statuses).toContain(response.status());
  expect(Object.keys(value).sort()).toEqual(['apiVersion', 'success', 'code']);
  expect(value.apiVersion).toBe(1); expect(value.success).toBe(false); expect(codes).toContain(value.code);
  expect(Object.hasOwn(value, 'fragment')).toBe(false); expect(Object.hasOwn(value, 'document')).toBe(false);
  expect(response.headers()['cache-control']).toBe('no-store');
}

async function session(api: APIRequestContext, filePath: string, representation: 'plain_text' | 'auto'): Promise<NativeSession> {
  const response = await api.post('/api/files/collaboration/session', { headers: workspaceHeaders(), maxRedirects: 0,
    data: { path: filePath, representation, ...COLLABORATION_CLIENT_CAPABILITIES } });
  const value = await json(response, 'Genuine native session');
  expect(response.status(), 'Genuine native session HTTP status').toBe(200);
  expect(value.success).toBe(true); expect(value.provider).toBe('yjs'); expect(value.degraded).toBe(false);
  expect(value.representation).toBe(representation === 'plain_text' ? 'plain_text' : 'tiptap_blocks');
  expect(value.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION);
  expect(value.stateProof).toMatch(/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
  expect(typeof value.stateVector).toBe('string'); expect(typeof value.documentId).toBe('string');
  // Retain only public witnesses used by this test, never the session ticket.
  return { documentId: value.documentId as string, lifecycleGeneration: value.lifecycleGeneration as number,
    representation: value.representation as string, schemaVersion: value.schemaVersion as number,
    stateProof: value.stateProof as string, stateVector: value.stateVector as string, documentSequence: value.documentSequence as number };
}

function nativeBody(page: DocumentReadPageV1): NativeBody {
  expect(page.format).toBe('native'); expect(page.byteOffset).toBe(0); expect(page.complete).toBe(true);
  const body = JSON.parse(page.fragment) as NativeBody;
  expect(Object.keys(body).sort()).toEqual(['bodyVersion', 'representation', 'content']);
  expect(body.bodyVersion).toBe(1); expect(body.representation).toBe(page.document.representation);
  return body;
}

async function candidateIsDurable(candidate: Candidate): Promise<NativeSession> {
  let witness: NativeSession | undefined;
  for (let attempt = 0; attempt <= 30; attempt++) {
    witness = await session(owner.web, richPath, 'auto');
    if (witness.documentId === richId && witness.stateProof === candidate.stateProof && witness.stateVector === candidate.stateVector) return witness;
    if (attempt < 30) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  if (!witness) throw new Error('No actual persisted native session witness was observed.');
  expect({ documentId: witness.documentId, stateProof: witness.stateProof, stateVector: witness.stateVector })
    .toEqual({ documentId: richId, stateProof: candidate.stateProof, stateVector: candidate.stateVector });
  return witness;
}

async function observedPage(candidate: Candidate): Promise<DocumentReadPageV1> {
  let observed: DocumentReadPageV1 | undefined;
  // At most thirty-one document reads in this 30-second poll. Source describes
  // actual proof equality: an open editor may already be fully persisted.
  // No HTTP error is swallowed or enlarged production rate limit installed.
  for (let attempt = 0; attempt <= 30; attempt++) {
    observed = await read(owner.web, richId);
    if (isDeepStrictEqual(nativeBody(observed).content.document, candidate.document)) return observed;
    if (attempt < 30) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  if (!observed) throw new Error('No actual current native HTTP body was observed.');
  expect(nativeBody(observed).content.document).toEqual(candidate.document);
  return observed;
}

test.describe('owned production HTTP document read by stable native ID', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await requireOwnedYjsQaTarget();
    owner = await login(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);
    const response = await owner.web.post('/api/workspaces', { data: { type: 'organization', name: `Document read HTTP ${randomUUID()}` }, maxRedirects: 0 });
    const value = await json(response, 'Owned team workspace creation');
    expect(response.status()).toBe(201);
    const workspace = value.workspace as { id?: unknown } | undefined;
    if (typeof workspace?.id !== 'string' || !workspace.id) throw new Error('The actual owned team workspace has no ID.');
    workspaceId = workspace.id;
  });

  test.afterAll(async () => {
    const cleanup: unknown[] = [];
    // Even an interrupted earlier family must await all held transport owners.
    for (const page of pages.reverse()) try { if (!page.isClosed()) await page.close(); } catch (error) { cleanup.push(error); }
    for (const context of browserContexts.reverse()) try { await context.close(); } catch (error) { cleanup.push(error); }
    for (const api of apiContexts.reverse()) try { await api.dispose(); } catch (error) { cleanup.push(error); }
    if (pageErrors.length) cleanup.push(new Error(`The owned editor emitted ${pageErrors.length} page error(s).`));
    if (cleanup.length) throw new AggregateError(cleanup, 'Owned document-read HTTP transport cleanup failed.');
    // The original supervisor subsequently closes its host/issuer and removes
    // its own isolated DB/DATA. This hook does not claim their resource closure.
  });

  test('1: real unauthenticated, malformed and oversized HTTP requests disclose no document body', async () => {
    const anonymous = await request.newContext({ baseURL: origin, timeout: 15_000, storageState: { cookies: [], origins: [] } });
    apiContexts.push(anonymous);
    await failure(await anonymous.post('/api/documents/read', { headers: workspaceHeaders(),
      data: selection(randomUUID()), maxRedirects: 0 }), [401], ['AUTHENTICATION_REQUIRED']);
    await failure(await owner.web.post('/api/documents/read', { headers: { ...workspaceHeaders(), 'Content-Type': 'application/json' },
      data: '{broken', maxRedirects: 0 }), [400], ['INVALID_REQUEST']);
    await failure(await owner.web.post('/api/documents/read', { headers: workspaceHeaders(),
      data: { ...selection(randomUUID()), unexpected: true }, maxRedirects: 0 }), [400], ['INVALID_REQUEST']);
    await failure(await owner.web.post('/api/documents/read', { headers: { ...workspaceHeaders(), 'Content-Type': 'application/json' },
      data: ' '.repeat(32 * 1024 + 1), maxRedirects: 0 }), [413], ['DOCUMENT_TOO_LARGE']);
  });

  test('2: genuine TXT upload and native session read completely over Cookie and cookie-free issued Bearer', async () => {
    const plainPath = `document-read-http-${randomUUID()}.txt`;
    const text = 'Plain native HTTP\nÄΩ😀🧪\n';
    const upload = await owner.web.post('/api/files/upload', { headers: workspaceHeaders(), maxRedirects: 0,
      multipart: { path: '.', files: { name: plainPath, mimeType: 'text/plain', buffer: Buffer.from(text) } } });
    const uploaded = await json(upload, 'Genuine TXT upload'); expect(upload.status()).toBe(200); expect(uploaded.success).toBe(true);
    const initial = await session(owner.web, plainPath, 'plain_text'); plainId = initial.documentId;
    const cookieNative = await read(owner.web, plainId), bearerNative = await read(owner.bearer, plainId);
    expect(nativeBody(cookieNative)).toEqual({ bodyVersion: 1, representation: 'plain_text', content: { kind: 'plain_text', text } });
    expect(nativeBody(bearerNative)).toEqual(nativeBody(cookieNative)); expect(bearerNative.document).toEqual(cookieNative.document);
    for (const api of [owner.web, owner.bearer]) {
      const page = await read(api, plainId, { format: 'text', expectedVersion: cookieNative.document.version });
      expect(page.fragment).toBe(text); expect(page.complete).toBe(true); expect(page.totalBytes).toBe(Buffer.byteLength(text));
      expect(page.document).toEqual(cookieNative.document);
    }
    expect((await owner.bearer.storageState()).cookies).toEqual([]);
  });

  test('3: manual Markdown birth, actual editor text and exact five UTF-8 pages share the current native document', async ({ browser }, info) => {
    richPath = `document-read-http-${randomUUID()}.md`;
    const requestId = randomUUID(); await waitForFileCreateBudget();
    const created = await owner.web.post('/api/files/create', { headers: workspaceHeaders(), maxRedirects: 0,
      data: { path: richPath, type: 'file', requestId } });
    await json(created, 'Completed manual Markdown creation');
    await assertCompletedWorkspaceMarkdownCreate(created, { requestId, workspaceId, targetPath: richPath });
    const initial = await session(owner.web, richPath, 'auto'); richId = initial.documentId;
    const context = await browser.newContext({ baseURL: origin, storageState: await owner.web.storageState(), viewport: { width: 1440, height: 960 } });
    browserContexts.push(context); editor = await context.newPage(); pages.push(editor);
    editor.on('pageerror', error => { pageErrors.push(error.name); });
    await editor.goto(`/en/notebook?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(richPath)}`);
    await expect(editor.locator(selector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
    await expect(editor.getByRole('button', { name: 'Read', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await editor.locator(selector).click(); await editor.keyboard.insertText(initialText);
    await expect(editor.locator(selector)).toHaveText(initialText);
    originalCandidate = await readNativeRichCandidate(editor, selector);
    originalPage = await observedPage(originalCandidate);
    const witness = await candidateIsDurable(originalCandidate);
    expect(witness.lifecycleGeneration).toBe(initial.lifecycleGeneration);
    expect(originalPage.document.lifecycleGeneration).toBe(initial.lifecycleGeneration);
    expect(nativeBody(originalPage).content).toEqual({ kind: 'rich_text', document: originalCandidate.document,
      frontmatter: '', bodyFinalLineEnding: '' });
    const fragments: string[] = [], offsets: number[] = [], lengths: number[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 5; index++) {
      // Both transports came from the same genuine sign-in/session. A cursor
      // is comparison evidence and still crosses fresh authentication each time.
      const page = await read(index % 2 ? owner.bearer : owner.web, richId,
        { format: 'text', maxBytes: 4, expectedVersion: originalPage.document.version, ...(cursor ? { cursor } : {}) });
      expect(page.document).toEqual(originalPage.document);
      expect(page.totalBytes).toBe(11); fragments.push(page.fragment); offsets.push(page.byteOffset); lengths.push(page.byteLength);
      if (index === 0) { if (!page.nextCursor) throw new Error('The actual initial text page has no continuation.'); originalCursor = page.nextCursor; }
      if (index < 4) { expect(page.complete).toBe(false); if (!page.nextCursor) throw new Error('A complete continuation was omitted.'); cursor = page.nextCursor; }
      else { expect(page.complete).toBe(true); expect(page.nextCursor).toBeNull(); }
    }
    expect(fragments).toEqual(['A', '😀', 'B', '🧪', 'C']);
    expect(offsets).toEqual([0, 1, 5, 6, 10]); expect(lengths).toEqual([1, 4, 1, 4, 1]); expect(fragments.join('')).toBe(initialText);
    const markdown = await read(owner.bearer, richId, { format: 'markdown', expectedVersion: originalPage.document.version });
    expect(markdown.complete).toBe(true); expect(markdown.fragment).toBe(initialText); expect(markdown.document).toEqual(originalPage.document);
    await editor.screenshot({ path: info.outputPath('document-read-http-current-editor.png'), animations: 'disabled' });
  });

  test('4: actual permission update, fresh readonly peer login and positive read do not transfer an owner cursor', async () => {
    // The real permission mutation revokes existing target sessions. Re-login
    // afterwards; an old revoked session must not make this negative pass.
    const previousPeer = await login(process.env.TEST_SECONDARY_EMAIL, process.env.TEST_SECONDARY_PASSWORD);
    const response = await owner.web.patch(`/api/admin/organization/users/${encodeURIComponent(previousPeer.identity.userId)}/permissions`, {
      headers: { Origin: origin }, data: { canWriteTeamWorkspace: false }, maxRedirects: 0 });
    const updated = await json(response, 'Actual readonly peer permission update'); expect(response.status()).toBe(200); expect(updated.success).toBe(true);
    peer = await login(process.env.TEST_SECONDARY_EMAIL, process.env.TEST_SECONDARY_PASSWORD);
    expect(peer.identity.userId).toBe(previousPeer.identity.userId); expect(peer.identity.sessionId).not.toBe(previousPeer.identity.sessionId);
    const listedResponse = await peer.web.get('/api/workspaces', { maxRedirects: 0 });
    const listed = await json(listedResponse, 'Readonly peer workspace access'); expect(listedResponse.status()).toBe(200);
    const workspaces = listed.workspaces as Array<{ id: string; permissions: { canWrite: boolean } }>;
    expect(workspaces.find(workspace => workspace.id === workspaceId)?.permissions.canWrite).toBe(false);
    const positive = await read(peer.bearer, richId, { format: 'text' });
    expect(positive.complete).toBe(true); expect(positive.fragment).toBe(initialText); expect(positive.document).toEqual(originalPage.document);
    await failure(await peer.bearer.post('/api/documents/read', { headers: workspaceHeaders(), maxRedirects: 0,
      data: selection(richId, { format: 'text', maxBytes: 4, cursor: originalCursor }) }), [409], ['DOCUMENT_SCOPE_CHANGED']);
  });

  test('5: actual editor append conflicts with old continuation and survives room close as the identical durable native body', async ({}, info) => {
    await editor.locator(selector).click(); await editor.keyboard.press('ControlOrMeta+End'); await editor.keyboard.insertText(suffix);
    await expect(editor.locator(selector)).toHaveText(initialText + suffix);
    const candidate = await readNativeRichCandidate(editor, selector); expect(candidate.stateProof).not.toBe(originalCandidate.stateProof);
    const beforeClose = await observedPage(candidate); await candidateIsDurable(candidate);
    expect(beforeClose.document.documentId).toBe(richId); expect(beforeClose.document.lineageId).toBe(originalPage.document.lineageId);
    expect(beforeClose.document.lifecycleGeneration).toBe(originalPage.document.lifecycleGeneration);
    expect(beforeClose.document.version).not.toBe(originalPage.document.version); expect(beforeClose.document.metadataVersion).toBe(originalPage.document.metadataVersion);
    await failure(await owner.web.post('/api/documents/read', { headers: workspaceHeaders(), maxRedirects: 0,
      data: selection(richId, { format: 'text', maxBytes: 4, cursor: originalCursor }) }), [409], ['DOCUMENT_VERSION_CONFLICT']);
    await failure(await owner.bearer.post('/api/documents/read', { headers: workspaceHeaders(), maxRedirects: 0,
      data: selection(richId, { expectedVersion: originalPage.document.version }) }), [409], ['DOCUMENT_VERSION_CONFLICT']);
    await editor.screenshot({ path: info.outputPath('document-read-http-edited.png'), animations: 'disabled' });
    await editor.getByRole('button', { name: 'Close preview', exact: true }).click(); await expect(editor.locator(selector)).toHaveCount(0);
    let durable: DocumentReadPageV1 | undefined;
    // Observe the identical confirmed durable body after the actual editor
    // close. Source is proof equality, not evidence of room/owner release;
    // this does not flush/checkpoint a room or infer durability from the UI.
    const expectedDurable = { source: 'persisted_yjs', durable: true, version: beforeClose.document.version, body: nativeBody(beforeClose) };
    for (let attempt = 0; attempt <= 30; attempt++) {
      durable = await read(owner.bearer, richId, { expectedVersion: beforeClose.document.version });
      const observed = { source: durable.currency.source, durable: durable.currency.observedDurable,
        version: durable.currency.durableVersion, body: nativeBody(durable) };
      if (isDeepStrictEqual(observed, expectedDurable)) break;
      if (attempt < 30) await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    if (!durable) throw new Error('No actual persisted HTTP page was observed after editor close.');
    expect({ source: durable.currency.source, durable: durable.currency.observedDurable,
      version: durable.currency.durableVersion, body: nativeBody(durable) }).toEqual(expectedDurable);
    finalPage = durable; expect(finalPage.document).toEqual(beforeClose.document); expect(finalPage.fragment).toBe(beforeClose.fragment);
    const first = await read(owner.web, richId, { format: 'text', maxBytes: 4, expectedVersion: finalPage.document.version });
    expect(first.fragment).toBe('A'); if (!first.nextCursor) throw new Error('The final text page has no continuation.'); finalCursor = first.nextCursor;
    expect((await read(owner.bearer, richId, { format: 'text' })).fragment).toBe(initialText + suffix);
  });

  test('6: genuine HTTP sign-out revokes the same issued Bearer and cursor without returning content', async () => {
    const response = await owner.web.post('/api/auth/sign-out', { headers: { Origin: origin }, data: {}, maxRedirects: 0 });
    const signedOut = await json(response, 'Genuine HTTP sign-out'); expect(response.status()).toBe(200); expect(signedOut.success).toBe(true);
    for (const extra of [{}, { format: 'text' as const, maxBytes: 4, cursor: finalCursor }]) {
      await failure(await owner.bearer.post('/api/documents/read', { headers: workspaceHeaders(), maxRedirects: 0,
        data: selection(richId, extra) }), [401, 403], ['AUTHENTICATION_REQUIRED', 'ACCESS_DENIED']);
    }
    expect((await owner.bearer.storageState()).cookies).toEqual([]);
  });
});
