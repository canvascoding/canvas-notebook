import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';

dotenv.config({ path: process.env.CANVAS_ENV_FILE || '.env.local', quiet: true });
assert.equal(process.env.TODO_LIFECYCLE_UI_TEST, '1', 'Opt in to isolated local fixtures.');
const baseURL = process.env.BASE_URL || 'http://localhost:3001';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname));
assert.ok(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const screenshots = await mkdtemp(path.join(tmpdir(), 'canvas-todo-lifecycle-ui-'));
const title = `Lifecycle QA ${randomUUID().slice(0, 8)}`;
const writes = [];
const errors = [];
let todoId;
const popup = page.getByTestId('todo-detail-popup');
const readStateCount = async () => Number((await pool.query('SELECT count(*) FROM todo_read_states WHERE todo_id=$1', [todoId])).rows[0].count);
const readTodo = async () => {
  const response = await context.request.get(`/api/todos/${todoId}?todoMode=lifecycle`);
  assert.equal(response.status(), 200);
  return (await response.json()).data;
};
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (request.method() !== 'GET' && (url.pathname.startsWith('/api/todos') || url.pathname === '/api/notifications/summary')) {
    writes.push({ url, method: request.method(), body: request.postDataJSON() });
  }
});

try {
  const login = await context.request.post('/api/auth/sign-in/email', {
    headers: { Origin: baseURL }, data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }, timeout: 120_000,
  });
  assert.equal(login.status(), 200);
  const created = await context.request.post('/api/todos?todoMode=lifecycle', { data: { title, priority: 'normal', scopeKind: 'user' } });
  assert.equal(created.status(), 201);
  todoId = (await created.json()).data.id;
  await page.goto('/de/todos', { timeout: 120_000 });
  const row = page.getByTestId('todo-list-item').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(page.getByTestId('todo-mark-all-seen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Gelesen|Ungelesen/ })).toHaveCount(0);
  await row.getByRole('button', { name: new RegExp(title) }).first().click();
  await expect(page.getByTestId('todo-detail')).toContainText(title);
  assert.equal(writes.length, 0, 'Selecting the task performs no write.');
  assert.equal(await readStateCount(), 0);
  const task = await readTodo();
  assert.equal(task.status, 'open');
  assert.equal(task.dueAt, null);
  for (const key of ['seenAt', 'readAt', 'readState']) assert.equal(key in task, false);
  await page.screenshot({ path: path.join(screenshots, 'desktop-todos.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Filter/ }).click();
  const filters = page.getByRole('dialog');
  await expect(filters).not.toContainText(/Lesestatus|Gelesen und ungelesen/);
  await expect(filters.getByRole('button', { name: 'Offen', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'compact-filters.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.goto(`/de?todo=${todoId}`, { timeout: 120_000 });
  await expect(popup).toContainText(title);
  assert.equal(writes.length, 0, 'Opening from a direct link performs no write.');
  await expect(popup.getByRole('button', { name: /Als gelesen|Ungelesen/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(screenshots, 'compact-popup.png'), animations: 'disabled' });
  assert.equal(await popup.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  }), true);

  for (const [action, status] of [['complete', 'done'], ['reopen', 'open'], ['archive', 'archived'], ['restore', 'open']]) {
    const response = page.waitForResponse(item => new URL(item.url()).pathname === `/api/todos/${todoId}` && item.request().method() === 'PATCH');
    await popup.getByTestId(`todo-popup-${action}`).click();
    assert.equal((await response).status(), 200);
    assert.equal((await readTodo()).status, status);
    await expect(popup.getByTestId(action === 'complete' ? 'todo-popup-reopen' : action === 'archive' ? 'todo-popup-restore' : 'todo-popup-complete')).toBeEnabled();
  }
  assert.equal(await readStateCount(), 0, 'Lifecycle changes do not write read state.');
  for (const write of writes) {
    assert.equal(write.url.searchParams.get('todoMode'), 'lifecycle');
    assert.equal('markSeen' in write.body, false);
    assert.equal('read' in write.body, false);
  }
  await page.keyboard.press('Escape');
  await page.goto('/de/todos', { timeout: 120_000 });
  await expect(page.getByTestId('todo-list-item').filter({ hasText: title })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(`Todo lifecycle Web QA passed. Screenshots: ${screenshots}`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true }).catch(() => undefined);
  console.error(`Lifecycle QA screenshot: ${screenshots}/failure.png`);
  throw error;
} finally {
  await browser.close();
  if (todoId) await pool.query('DELETE FROM todo_items WHERE id=$1', [todoId]);
  await pool.end();
}
