import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { chromium, expect } from '@playwright/test';
import pg from 'pg';

// Uses the single managed host server; never starts another server or container.
// The only persisted mutations affect these exact, per-run fixture IDs.
dotenv.config({ path: process.env.CANVAS_ENV_FILE || '.env.local', quiet: true });
assert.equal(process.env.TODO_DETAIL_UI_TEST, '1', 'Set TODO_DETAIL_UI_TEST=1 to allow isolated local fixtures.');
const baseURL = process.env.BASE_URL || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local test server required.');
assert.ok(process.env.DATABASE_URL, 'Managed database required for exact fixture cleanup.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const screenshotDir = await mkdtemp(path.join(tmpdir(), 'canvas-todo-detail-ui-'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.setDefaultNavigationTimeout(120_000);
const fixtureIds = [];
let fixtureSession = null;
const prefix = `Popup QA ${randomUUID().slice(0, 8)}`;
const popup = page.getByTestId('todo-detail-popup');
const action = (name) => popup.getByTestId(`todo-popup-${name}`);
const requestErrors = [];
page.on('pageerror', (error) => requestErrors.push(error.message));

async function login(request) {
  const response = await request.post('/api/auth/sign-in/email', {
    headers: { Origin: baseURL },
    data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD },
    timeout: 120_000,
  });
  assert.equal(response.status(), 200, 'Bootstrap login must succeed.');
  return (await response.json()).user.id;
}

async function createFixture(title, attributes = {}) {
  const response = await context.request.post('/api/todos', {
    data: { title, description: '**Popup description**\n\nUseful context for the task.', priority: 'high', ...attributes },
  });
  assert.equal(response.status(), 201);
  const todo = (await response.json()).data;
  fixtureIds.push(todo.id);
  return todo;
}

async function readFixture(id) {
  const response = await context.request.get(`/api/todos/${id}`);
  assert.equal(response.status(), 200);
  return (await response.json()).data;
}

async function expectMutation(name, id, method = 'PATCH') {
  const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === `/api/todos/${id}`
    && candidate.request().method() === method);
  await action(name).click();
  assert.equal((await response).status(), 200, `${name} must persist successfully.`);
}

async function installInternalLink(id, title) {
  await page.evaluate(({ id, title }) => {
    document.querySelector('[data-popup-qa-link]')?.remove();
    const link = document.createElement('a');
    link.href = `/todos?todo=${encodeURIComponent(id)}`;
    link.textContent = title;
    link.dataset.popupQaLink = 'true';
    link.style.cssText = 'position:fixed;left:12px;bottom:45px;z-index:25;padding:12px;background:white;color:black';
    document.body.append(link);
  }, { id, title });
  return page.locator('[data-popup-qa-link]');
}

try {
  const ownerId = await login(context.request);
  const first = await createFixture(`${prefix} A`, {
    dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    remindAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    assigneeUserId: ownerId,
  });
  const second = await createFixture(`${prefix} B`);
  console.log('Popup QA: isolated fixtures created; checking email-link login.');

  // A fresh email-link tab must retain its target through the actual login form.
  for (const target of [`/?todo=${first.id}`, `/de/todos?todo=${first.id}`]) {
    const fresh = await browser.newContext({ baseURL });
    try {
      const emailPage = await fresh.newPage();
      emailPage.setDefaultTimeout(30_000);
      await emailPage.goto(target, { timeout: 120_000 });
      await expect(emailPage.locator('#email')).toBeVisible();
      assert.equal(new URL(emailPage.url()).searchParams.get('from'), target);
      await emailPage.locator('#email').fill(process.env.BOOTSTRAP_ADMIN_EMAIL);
      await emailPage.locator('#password').fill(process.env.BOOTSTRAP_ADMIN_PASSWORD);
      await emailPage.locator('form button[type="submit"]').click();
      await expect(emailPage.getByTestId('todo-detail-popup')).toContainText(first.title, { timeout: 120_000 });
      assert.equal(new URL(emailPage.url()).pathname.includes('/todos'), target.includes('/todos'), 'Both email link formats retain their target.');
    } finally {
      await fresh.close();
    }
  }
  console.log('Popup QA: email-link login passed; checking Home and bell.');

  const firstMatcher = (url) => url.pathname === `/api/todos/${first.id}`;
  const initialsHandler = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.data?.assignee) body.data.assignee.image = null;
    await route.fulfill({ response, json: body });
  };
  await page.route(firstMatcher, initialsHandler);
  await page.goto('/');
  const baseline = page.url();
  // Real Home and notification bell entry points share the same global host.
  await page.locator('#home-attention-items a').filter({ hasText: first.title }).click();
  await expect(popup).toContainText(first.title);
  await expect(popup.getByTestId('todo-detail-due')).toContainText(/in 3 Tagen/i);
  await expect(popup.getByTestId('todo-detail-reminder')).toContainText(/in 2 Stunden/i);
  await expect(popup.getByTestId('todo-assignee-avatar').locator('[data-avatar-kind="initials"]')).toBeVisible();
  await expect(popup.getByTestId('todo-assignee-avatar').locator('img')).toHaveCount(0);
  await expect(popup.getByTestId('todo-detail-files')).toHaveCount(0);
  assert.equal(page.url(), baseline, 'Home attention opens the popup in place.');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await page.getByTestId('notification-bell').click();
  await page.locator(`[data-notification-id="todo:${first.id}"]`).click();
  await expect(popup).toContainText(first.title);
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  assert.equal(page.url(), baseline, 'Notification bell opens the popup in place.');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  const link = await installInternalLink(first.id, 'Open fixture A');
  await link.click();
  await expect(popup).toContainText(first.title);
  assert.equal(new URL(page.url()).pathname, new URL(baseline).pathname, 'Todo link preserves the current page.');
  await expect(popup).toContainText('Popup description');
  await page.screenshot({ path: path.join(screenshotDir, 'desktop.png'), animations: 'disabled' });
  console.log('Popup QA: in-place entry points passed; checking persisted edits and lifecycle actions.');

  await expectMutation('complete', first.id);
  assert.equal((await readFixture(first.id)).status, 'done');
  await expectMutation('reopen', first.id);
  assert.equal((await readFixture(first.id)).status, 'open');
  await expectMutation('archive', first.id);
  assert.equal((await readFixture(first.id)).status, 'archived');
  await expectMutation('restore', first.id);
  assert.equal((await readFixture(first.id)).status, 'open');

  await action('edit').click();
  const titleInput = popup.getByTestId('todo-editor-title');
  await titleInput.fill(`${prefix} updated`);
  await expect(action('save')).toBeEnabled();
  await page.screenshot({ path: path.join(screenshotDir, 'desktop-editor.png'), animations: 'disabled' });
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/todos/${first.id}`
    && response.request().method() === 'PATCH');
  await action('save').click();
  assert.equal((await saved).status(), 200);
  await expect(popup).toContainText(`${prefix} updated`);
  assert.equal((await readFixture(first.id)).title, `${prefix} updated`);
  const savedDates = await readFixture(first.id);
  assert.equal(savedDates.dueAt, first.dueAt, 'Editing the title preserves the precise deadline.');
  assert.equal(savedDates.remindAt, first.remindAt, 'Editing the title preserves the precise reminder.');

  // Concurrent edits cannot silently overwrite a newer server version.
  await action('edit').click();
  await titleInput.fill(`${prefix} stale draft`);
  const concurrent = await context.request.patch(`/api/todos/${first.id}`, { data: { title: `${prefix} external update` } });
  assert.equal(concurrent.status(), 200);
  const conflict = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/todos/${first.id}`
    && response.request().method() === 'PATCH');
  await action('save').click();
  assert.equal((await conflict).status(), 409, 'A stale editor must not overwrite the current version.');
  await expect(titleInput).toHaveValue(`${prefix} stale draft`);
  assert.equal((await readFixture(first.id)).title, `${prefix} external update`);
  await action('cancel-edit').click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Verwerfen|Discard/i }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(titleInput).toBeHidden();
  await expect(popup).toContainText(`${prefix} external update`);

  // Closing dirty input requires a decision; keep editing preserves the draft.
  await action('edit').click();
  await titleInput.fill(`${prefix} unsaved`);
  await page.keyboard.press('Escape');
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: /Weiter bearbeiten|Keep editing|Abbrechen|Cancel/i }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(titleInput).toHaveValue(`${prefix} unsaved`);
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: /Verwerfen|Discard/i }).click();
  await expect(popup).toBeHidden();
  await expect(link).toBeFocused();
  assert.equal((await readFixture(first.id)).title, `${prefix} external update`, 'Discard never writes the unsaved draft.');
  console.log('Popup QA: mutations, stale-editor conflict and dirty-close protection passed.');

  // Retry handles errors at the current location instead of silently navigating.
  let fail = true;
  const loadMatcher = (url) => url.pathname === `/api/todos/${second.id}`;
  const failedHandler = async (route) => {
    if (route.request().method() !== 'GET' || !fail) return route.continue();
    await route.fulfill({ status: 503, json: { success: false, error: 'QA temporary load failure' } });
  };
  await page.route(loadMatcher, failedHandler);
  await (await installInternalLink(second.id, 'Open fixture B')).click();
  await expect(popup).toContainText('QA temporary load failure');
  fail = false;
  await action('retry').click();
  await expect(popup).toContainText(second.title);
  await page.unroute(loadMatcher, failedHandler);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(popup.getByTestId('todo-detail-due')).toHaveCount(0);
  await expect(popup.getByTestId('todo-detail-reminder')).toHaveCount(0);
  await expect(popup.getByTestId('todo-detail-files')).toHaveCount(0);
  await expect(popup).not.toContainText(/Kein Datum|Keine Erinnerung|Keine Dateien verlinkt/i);
  await expect(action('full-page')).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, 'mobile.png'), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow.');
  assert.equal(await popup.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
  }), true, 'Popup fits the mobile viewport.');
  await action('edit').click();
  await expect(popup.getByTestId('todo-editor-title')).toBeVisible();
  await expect(action('save')).toBeEnabled();
  await expect(popup.getByTestId('todo-file-result').first()).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-editor.png'), animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile editor has no horizontal overflow.');
  assert.equal(await popup.locator('div.overflow-y-auto').first().evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true,
    'Loaded file results cannot widen the mobile editor body.');
  await action('cancel-edit').click();
  await expect(popup.getByTestId('todo-editor-title')).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await action('full-page').click();
  await expect(popup).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/todos\\?[^#]*todo=${second.id}`), { timeout: 120_000 });
  await expect(page.getByTestId('todo-detail')).toContainText(second.title, { timeout: 30_000 });

  // Permission affordances are driven by the freshly fetched detail response.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const readonlyHandler = async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.data) body.data.canWrite = false;
    await route.fulfill({ response, json: body });
  };
  await page.route(loadMatcher, readonlyHandler);
  await page.goto(`/?todo=${second.id}`);
  await expect(popup).toContainText(second.title);
  await expect(action('edit')).toBeHidden();
  await expect(action('complete')).toBeHidden();
  await expect(action('archive')).toBeHidden();
  await page.unroute(loadMatcher, readonlyHandler);
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  assert.ok(!new URL(page.url()).searchParams.has('todo'), 'Closing a URL-opened popup clears its open intent.');

  // Finishing a slow load after close must never resurrect the popup.
  let releaseSlow;
  let startedSlow;
  const held = new Promise((resolve) => { releaseSlow = resolve; });
  const captured = new Promise((resolve) => { startedSlow = resolve; });
  const slowHandler = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    startedSlow();
    await held;
    await route.fulfill({ response }).catch(() => {});
  };
  await page.route(loadMatcher, slowHandler);
  await (await installInternalLink(second.id, 'Open slow fixture B')).click();
  await captured;
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  releaseSlow();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(popup).toBeHidden();

  // A controlled local image verifies image rendering without changing a real profile.
  const imageSource = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="20" fill="#dbeafe"/><circle cx="20" cy="15" r="7" fill="#2563eb"/><path d="M7 38v-5c0-7 6-11 13-11s13 4 13 11v5" fill="#2563eb"/></svg>').toString('base64')}`;
  const imageHandler = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (body.data?.assignee) body.data.assignee.image = imageSource;
    await route.fulfill({ response, json: body });
  };
  await page.route(firstMatcher, imageHandler);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?todo=${first.id}`);
  await expect(popup.getByTestId('todo-detail-due')).toContainText(/in 3 Tagen/i);
  await expect(popup.getByTestId('todo-detail-reminder')).toContainText(/in 2 Stunden/i);
  const imageAvatar = popup.getByTestId('todo-assignee-avatar').locator('img');
  await expect(imageAvatar).toHaveAttribute('src', imageSource);
  await expect.poll(() => imageAvatar.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-with-dates-avatar.png'), animations: 'disabled' });
  assert.equal(await popup.locator('div.overflow-y-auto').first().evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true,
    'Deadline, reminder and avatar cards fit the mobile popup.');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await page.unroute(firstMatcher, imageHandler);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A saved tool result exercises the actual chat widget, its authorization,
  console.log('Popup QA: failure retry, mobile, full page and late-load close passed; checking real saved chat widget.');
  // and its update subscription without making an AI request.
  const workspaces = await context.request.get('/api/workspaces');
  assert.equal(workspaces.status(), 200);
  const personal = (await workspaces.json()).workspaces.find((workspace) => workspace.type === 'personal');
  assert.ok(personal?.id, 'Personal workspace required for the widget fixture.');
  const createdChat = await context.request.post('/api/sessions', {
    data: { title: `${prefix} widget chat`, agentId: 'bradley', workspaceId: personal.id }, timeout: 120_000,
  });
  assert.equal(createdChat.status(), 200, 'Create the fixture through normal runtime selection.');
  fixtureSession = (await createdChat.json()).session;
  const callId = `popup-qa-${randomUUID()}`;
  const app = { kind: 'builtin', version: 1, resourceUri: 'ui://canvas/human-todo/v1',
    entityId: second.id, toolCallId: callId, operation: 'inspect_human_todo' };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistantBase = { role: 'assistant', api: 'openai-completions', provider: fixtureSession.provider,
    model: fixtureSession.model, usage };
  const now = Date.now();
  const messages = [
    { role: 'user', content: 'Show me this task.', timestamp: now },
    { ...assistantBase, content: [{ type: 'toolCall', id: callId, name: 'inspect_human_todo', arguments: { todoId: second.id } }],
      stopReason: 'toolUse', timestamp: now + 1 },
    { role: 'toolResult', toolName: 'inspect_human_todo', toolCallId: callId, isError: false,
      content: [{ type: 'text', text: 'Task inspected.' }], details: { todo: { id: second.id }, toolApp: app }, timestamp: now + 2 },
    { ...assistantBase, content: [{ type: 'text', text: `[Open the task from chat](/todos?todo=${second.id})` }],
      stopReason: 'stop', timestamp: now + 3 },
  ];
  for (let i = 0; i < messages.length; i++) {
    await pool.query('INSERT INTO pi_messages (pi_session_db_id,role,content,timestamp,sequence) VALUES ($1,$2,$3,$4,$5)',
      [fixtureSession.id, messages[i].role, JSON.stringify(messages[i]), messages[i].timestamp, i + 1]);
  }
  await page.goto(`/notebook?${new URLSearchParams({ session: fixtureSession.sessionId, workspaceId: personal.id, chat: 'open' })}`);
  const widget = page.getByTestId('canvas-tool-app-widget');
  await expect(widget.locator('a[href*="todo="]')).toBeVisible({ timeout: 120_000 });
  const chatBaseline = page.url();
  const chatDraft = page.getByTestId('chat-input');
  await chatDraft.fill('This unsent chat draft must remain intact.');
  await widget.locator('a[href*="todo="]').click();
  await expect(popup).toContainText(second.title);
  assert.equal(page.url(), chatBaseline, 'Chat widget opens the popup in place.');
  await action('edit').click();
  await popup.getByTestId('todo-editor-title').fill(`${prefix} widget updated`);
  await expectMutation('save', second.id);
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(chatDraft).toHaveValue('This unsent chat draft must remain intact.');
  await expect(widget.frameLocator('iframe').frameLocator('iframe').locator('h1')).toHaveText(`${prefix} widget updated`, { timeout: 120_000 });
  await page.screenshot({ path: path.join(screenshotDir, 'chat-widget-updated.png'), animations: 'disabled' });
  await page.getByRole('link', { name: 'Open the task from chat', exact: true }).click();
  await expect(popup).toContainText(`${prefix} widget updated`);
  assert.equal(page.url(), chatBaseline, 'Markdown Todo links in chat also open in place.');
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  assert.deepEqual(requestErrors, [], 'No uncaught browser errors.');
  console.log(`Todo popup UI checks passed. Screenshots: ${screenshotDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshotDir, 'failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(`Todo popup failure screenshot: ${screenshotDir}/failure.png`);
  throw error;
} finally {
  let chatCleanupFailed = false;
  if (fixtureSession) {
    const deletedChat = await context.request.delete(`/api/sessions?${new URLSearchParams({ sessionId: fixtureSession.sessionId, agentId: 'bradley' })}`)
      .catch(() => null);
    chatCleanupFailed = !deletedChat?.ok();
  }
  await browser.close();
  await pool.query('DELETE FROM todo_read_states WHERE todo_id = ANY($1::text[])', [fixtureIds]);
  await pool.query('DELETE FROM todo_items WHERE id = ANY($1::text[])', [fixtureIds]);
  await pool.end();
  assert.equal(chatCleanupFailed, false, 'The exact fixture chat must be removed.');
}
