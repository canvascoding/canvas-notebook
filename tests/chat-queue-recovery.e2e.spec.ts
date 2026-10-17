import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response } from '@playwright/test';
import type { ChatQueueRecoveryStatus } from '../app/lib/chat/queue-recovery';
import { readMessageChatBody } from '../app/lib/chat/body-state';
import type { ChatQueueRecoveryBrowserEntry, ChatQueueRecoveryBrowserFixture } from '../scripts/helpers/chat-queue-recovery-browser-fixture';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import en from '../messages/en.json';

type Fixture = { version: 1; nonce: string; root: string; repo: string; actorId: string; dataRoot: string;
  baseURL: string; buildId: string; modelProofUrl: string; queueRecovery: ChatQueueRecoveryBrowserFixture };
type SavedMessage = { role: string; clientMessageId?: string; serverMessageId?: string; content?: unknown; body?: unknown };
let fixture: Fixture, owner: BrowserContext, page: Page, completedCases = 0;
const runtimeErrors: string[] = [], forbidden: string[] = [], sends: string[] = [], screenshots: string[] = [];
test.describe.configure({ mode: 'serial', retries: 0, timeout: 120_000 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

async function json<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), 'The actual route must return the expected HTTP status.').toBe(status);
  return response.json() as Promise<T>;
}
const panel = () => page.getByTestId('chat-queue-recovery');
const editor = () => page.locator('[data-testid="chat-inline-editor"] [role="textbox"][contenteditable="true"]:visible');
const item = (entry: ChatQueueRecoveryBrowserEntry) => panel().locator(`[data-testid="chat-queue-recovery-item"][data-queue-id="${entry.serverMessageId}"]`);
const headers = () => ({ 'X-Canvas-Workspace-Id': fixture.queueRecovery.workspaceId });
async function sdkCount(): Promise<number> {
  const proof = await json<{ completions: unknown[] }>(await owner.request.get(fixture.modelProofUrl)); return proof.completions.length;
}
async function queue(entry: ChatQueueRecoveryBrowserEntry): Promise<ChatQueueRecoveryStatus> {
  const result = await json<{ success: boolean; queue: ChatQueueRecoveryStatus }>(await owner.request.get(
    `/api/chat/queue?${new URLSearchParams({ sessionId: entry.sessionId })}`, { headers: headers() }));
  expect(result.success).toBe(true); expect(result.queue.sessionId).toBe(entry.sessionId); return result.queue;
}
async function transcript(entry: ChatQueueRecoveryBrowserEntry) {
  const result = await json<{ messages: SavedMessage[] }>(await owner.request.get(`/api/sessions/messages?${new URLSearchParams({
    sessionId: entry.sessionId, agentId: fixture.queueRecovery.agentId, workspaceId: fixture.queueRecovery.workspaceId, limit: '100',
  })}`)); return result.messages;
}
async function open(entry: ChatQueueRecoveryBrowserEntry) {
  const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat/queue'
    && response.request().method() === 'GET' && new URL(response.url()).searchParams.get('sessionId') === entry.sessionId, { timeout: 30_000 });
  await page.goto(`/en/notebook?${new URLSearchParams({ chat: 'open', session: entry.sessionId,
    workspaceId: fixture.queueRecovery.workspaceId })}`, { waitUntil: 'domcontentloaded' });
  expect((await received).status()).toBe(200);
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', entry.sessionId);
  await expect(panel()).toBeVisible(); await expect(panel().getByRole('button', { name: en.chat.queueRecoveryRefresh, exact: true })).toBeEnabled();
}
async function details() {
  const disclosure = panel().locator('details');
  if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
  await expect(disclosure).toHaveAttribute('open', '');
}
function commandResponse(entry: ChatQueueRecoveryBrowserEntry, action: 'resume' | 'cancel') {
  return page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/chat/queue' || response.request().method() !== 'POST') return false;
    const payload = response.request().postDataJSON() as Record<string, unknown>;
    return payload.sessionId === entry.sessionId && payload.queueItemId === entry.serverMessageId && payload.action === action;
  }, { timeout: 30_000 });
}
async function clickCommand(entry: ChatQueueRecoveryBrowserEntry, action: 'resume' | 'cancel', status = 200) {
  const button = item(entry).getByRole('button', { name: action === 'resume' ? en.chat.queueRecoveryResume : en.chat.queueRecoveryCancel, exact: true });
  await expect(button).toBeEnabled();
  const [response] = await Promise.all([commandResponse(entry, action), button.click()]);
  const request = response.request().postDataJSON() as Record<string, unknown>;
  expect(Object.keys(request).sort()).toEqual(['action', 'executionRevision', 'queueItemId', 'sessionId']);
  expect(request.executionRevision).toBe(entry.executionRevision);
  expect(response.status()).toBe(status); return response;
}
async function waitExecutedOnce(entry: ChatQueueRecoveryBrowserEntry, count: number, originalSendCount: number) {
  await expect.poll(() => sdkCount(), { timeout: 30_000 }).toBe(count + 1);
  await expect(page.getByTestId('chat-message-assistant').filter({ hasText: 'Inline context received.' })).toHaveCount(1);
  await expect(page.getByLabel(en.chat.assistantStreamingAria, { exact: true }).and(page.locator(':visible'))).toHaveCount(0);
  await expect.poll(async () => (await transcript(entry)).filter(message => message.role === 'user').length, { timeout: 30_000 }).toBe(1);
  const message = (await transcript(entry)).find(value => value.role === 'user'); expect(message).toBeTruthy();
  expect(message?.clientMessageId).toBe(entry.clientMessageId); expect(message?.serverMessageId).toBe(entry.serverMessageId);
  expect(readMessageChatBody(message!)).toEqual({ version: 1, parts: [{ type: 'text', text: entry.text }], bundles: [] });
  await expect.poll(async () => (await queue(entry)).items.length).toBe(0);
  expect(sends.length, 'Continuing SQL admissions must never emit a new send_message frame.').toBe(originalSendCount);
}
async function rejectOldCommand(entry: ChatQueueRecoveryBrowserEntry, action: 'resume' | 'cancel') {
  const response = await owner.request.post('/api/chat/queue', { headers: headers(), data: {
    sessionId: entry.sessionId, action, queueItemId: entry.serverMessageId, executionRevision: entry.executionRevision,
  } });
  expect(await json<{ code: string }>(response, 409)).toMatchObject({ code: 'MESSAGE_EXECUTION_CONFLICT' });
}
async function snapshot(name: string) {
  const filename = `chat-queue-recovery-${name}.png`; screenshots.push(filename);
  await page.screenshot({ path: path.join(fixture.root, filename), fullPage: true });
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1'); expect(process.env.CANVAS_CHAT_INLINE_E2E).toBe('1');
  const file = process.env.PLUGIN_EXTENSION_E2E_FIXTURE; if (!file || !path.isAbsolute(file)) throw new Error('Owned production runner required.');
  const stat = await fs.lstat(file);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600).toBe(true);
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(fixture.version).toBe(1); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(path.dirname(file)).toBe(fixture.root);
  expect(fixture.repo).toBe(await fs.realpath(process.cwd())); expect(fixture.dataRoot).toBe(path.join(fixture.root, 'data'));
  expect(fixture.baseURL).toBe('http://127.0.0.1:3001'); expect(fixture.buildId).toBe((await fs.readFile('.next/BUILD_ID', 'utf8')).trim());
  expect(fixture.queueRecovery.agentId).toBeTruthy(); expect(fixture.queueRecovery.workspaceId).toBeTruthy();
  const proof = new URL(fixture.modelProofUrl); expect(proof.hostname).toBe('127.0.0.1'); expect(proof.pathname).toBe(`/__owned/${fixture.nonce}/proof`);
  owner = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL },
    viewport: { width: 1280, height: 900 } });
  await runManagedTestPreflight(owner, { baseURL: fixture.baseURL });
  expect((await json<{ user: { id: string } }>(await requestManagedTestSession(owner.request))).user.id).toBe(fixture.actorId);
  await owner.addInitScript(({ workspace, origin }) => { if (location.origin === origin) localStorage.setItem('canvas.activeWorkspaceId', workspace); },
    { workspace: fixture.queueRecovery.workspaceId, origin: fixture.baseURL });
  owner.on('request', request => { const url = new URL(request.url());
    if (/\/tools\/execute\//u.test(url.pathname) || /^\/api\/integrations\/gateway\/call/u.test(url.pathname)) forbidden.push(`${request.method()} ${url.pathname}`); });
  owner.on('page', current => current.on('pageerror', error => runtimeErrors.push(error.name)));
  page = await owner.newPage();
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const payload = JSON.parse(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')) as { type?: string };
      if (payload.type === 'send_message') sends.push('send_message'); } catch { /* Binary/heartbeat frames are not a send. */ }
  }));
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await snapshot(`failure-${info.line}`);
  expect(runtimeErrors).toEqual([]); expect(forbidden).toEqual([]);
});
test.afterAll(async () => {
  if (fixture) await fs.writeFile(path.join(fixture.root, 'chat-queue-recovery-ui-proof.json'), JSON.stringify({
    version: 1, nonce: fixture.nonce, actorId: fixture.actorId, agentId: fixture.queueRecovery.agentId,
    completedCases, screenshots, runtimeErrors: runtimeErrors.length, forbiddenUiCalls: forbidden.length,
    newSendFrames: sends.length, controlledSdkOnly: true, actualExternalModelAcceptance: false,
  }), { mode: 0o600, flag: 'wx' });
  await owner?.close();
});

test('a cold persisted ready message waits for an explicit continuation and executes its original admission exactly once', async () => {
  const entry = fixture.queueRecovery.sessions.ready, before = await sdkCount(), sendCount = sends.length;
  await open(entry); await details(); await expect(item(entry)).toContainText(entry.text);
  expect((await queue(entry)).items).toEqual(expect.arrayContaining([expect.objectContaining({
    id: entry.serverMessageId, clientMessageId: entry.clientMessageId, executionRevision: entry.executionRevision, queue: entry.queue,
  })]));
  expect(await transcript(entry)).toEqual([]); expect(await sdkCount()).toBe(before);
  await snapshot('cold-ready'); await clickCommand(entry, 'resume'); await waitExecutedOnce(entry, before, sendCount);
  await rejectOldCommand(entry, 'resume');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-message-user')).toHaveCount(1); await expect(page.getByTestId('chat-message-user')).toContainText(entry.text);
  expect(await sdkCount()).toBe(before + 1); completedCases++;
});

test('paused and unpositioned originals require explicit continuation or cancellation without changing message identity', async () => {
  const paused = fixture.queueRecovery.sessions.suspended, pausedBefore = await sdkCount(), sendCount = sends.length;
  await open(paused); await details(); await expect(item(paused)).toHaveAttribute('data-queue-disposition', 'suspended');
  await expect(item(paused)).toContainText(en.chat.queueRecoverySuspended); expect(await sdkCount()).toBe(pausedBefore);
  await clickCommand(paused, 'resume'); await waitExecutedOnce(paused, pausedBefore, sendCount);
  const unpositioned = fixture.queueRecovery.sessions.unpositioned, cancel = unpositioned.cancelTarget!;
  const before = await sdkCount(); await open(unpositioned); await details();
  await expect(item(unpositioned)).toHaveAttribute('data-queue-disposition', 'unpositioned');
  await expect(item(cancel)).toHaveAttribute('data-queue-disposition', 'unpositioned');
  expect(await sdkCount()).toBe(before);
  await clickCommand(cancel, 'cancel'); await expect(item(cancel)).toHaveCount(0); await rejectOldCommand(cancel, 'cancel');
  expect(await sdkCount()).toBe(before); expect((await queue(unpositioned)).items).toHaveLength(1);
  await clickCommand(unpositioned, 'resume'); await waitExecutedOnce(unpositioned, before, sendCount); completedCases++;
});

test('legacy, unknown and abandoned in-flight executions remain blocked across reload and keyboard submit', async () => {
  const before = await sdkCount(), sendCount = sends.length;
  for (const kind of ['legacy', 'unknown', 'inflight'] as const) {
    const entry = fixture.queueRecovery.sessions[kind]; await open(entry); await details();
    await expect(panel().locator(`[data-testid="chat-queue-blocker"][data-reason="${entry.blockerReason}"]`)).toContainText(entry.blockerClientMessageId!);
    expect((await queue(entry)).blocked).toContainEqual({ clientMessageId: entry.blockerClientMessageId, reason: entry.blockerReason });
    await editor().fill(`Never replay ${kind}`); await expect(page.locator('[data-testid="chat-send"][data-action="send"]:visible')).toBeDisabled();
    await editor().press('Enter'); expect(await transcript(entry)).toEqual([]);
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(panel()).toContainText(en.chat.queueRecoveryNoRepeat);
    expect((await queue(entry)).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: entry.serverMessageId, executionRevision: entry.executionRevision })]));
    expect(await sdkCount()).toBe(before); expect(sends.length).toBe(sendCount);
    await panel().getByRole('button', { name: en.chat.newChatTitle, exact: true }).click();
    await expect(page.getByTestId('chat-session-id')).toHaveCount(0); await expect(editor()).toBeEmpty();
  }
  expect(await sdkCount()).toBe(before); completedCases++;
});

test('390px recovery keeps uncertain work blocked and rejects a resumed follower without another execution', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    const entry = fixture.queueRecovery.sessions.inflight, before = await sdkCount(), sendCount = sends.length;
    await open(entry); await details(); await expect(item(entry)).toContainText(entry.text);
    await expect(item(entry).getByRole('button', { name: en.chat.queueRecoveryResume, exact: true })).toHaveCount(0);
    const response = await owner.request.post('/api/chat/queue', { headers: headers(), data: {
      sessionId: entry.sessionId, action: 'resume', queueItemId: entry.serverMessageId, executionRevision: entry.executionRevision,
    } });
    expect(await json<{ code: string }>(response, 409)).toMatchObject({ code: 'MESSAGE_EXECUTION_UNCERTAIN' });
    await expect(panel()).toContainText(en.chat.queueRecoveryInProgress);
    expect((await queue(entry)).blocked).toContainEqual({ clientMessageId: entry.blockerClientMessageId, reason: 'execution_in_progress' });
    expect(await transcript(entry)).toEqual([]); expect(await sdkCount()).toBe(before); expect(sends.length).toBe(sendCount);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await snapshot('narrow-blocked'); completedCases++;
  } finally { await page.setViewportSize({ width: 1280, height: 900 }); }
});
