import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import pg from 'pg';

// Explicit opt-in: this script inserts only uniquely identified fixtures into the managed local DB.
// It removes those exact fixtures in finally, leaving existing to-dos untouched.
assert.equal(process.env.TODO_BULK_UI_TEST, '1', 'Set TODO_BULK_UI_TEST=1 to allow isolated local UI fixtures.');
const baseURL = process.env.BASE_URL || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const prefix = `bulk-ui-${randomUUID()}`;
const categoryIds = [`${prefix}-a`, `${prefix}-b`];
const names = [`Bulk UI ${prefix.slice(-6)} A`, `Bulk UI ${prefix.slice(-6)} B`];
const ids = Array.from({ length: 108 }, (_, i) => `${prefix}-${i}`);
const screenshotDir = await mkdtemp(path.join(tmpdir(), 'canvas-todo-bulk-ui-'));
const toolbar = page.getByTestId('todo-bulk-toolbar');
const master = toolbar.getByRole('checkbox', { name: 'Alle auswählen', exact: true });
const rows = page.getByTestId('todo-list-item');
const assertCount = (count) => expect(toolbar.getByRole('status')).toHaveText(`${count} ausgewählt`);
const chooseAction = async (action, value) => {
  await toolbar.getByRole('combobox', { name: 'Aktion wählen' }).selectOption(action);
  if (value) await toolbar.getByRole('combobox', { name: 'Ziel wählen' }).selectOption(value);
};
const apply = async () => {
  const response = page.waitForResponse((item) => item.url().endsWith('/api/todos/bulk') && item.request().method() === 'POST');
  await toolbar.getByRole('button', { name: 'Anwenden' }).click();
  assert.equal((await response).status(), 200);
  await assertCount(0);
};
try {
  const login = await context.request.post('/api/auth/sign-in/email', { headers: { Origin: baseURL }, data: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD }, timeout: 120_000 });
  assert.equal(login.status(), 200, 'Bootstrap login must succeed');
  const userId = (await login.json()).user.id;
  for (let i = 0; i < 2; i++) await pool.query('INSERT INTO todo_categories (id,user_id,name,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)', [categoryIds[i], userId, names[i], Date.now()]);
  await pool.query(`INSERT INTO todo_items (id,user_id,created_by_user_id,title,category_id,priority,created_at,updated_at)
    SELECT value,$2,$2,'Bulk fixture ' || ordinal,$3,CASE WHEN ordinal <= 105 THEN 'high' ELSE 'normal' END,$4,$4
    FROM unnest($1::text[]) WITH ORDINALITY AS input(value,ordinal)`, [ids, userId, categoryIds[0], Date.now()]);
  await page.goto('/de/todos', { timeout: 120_000 });
  await page.getByRole('button', { name: names[0], exact: true }).click();
  await page.getByRole('button', { name: 'Hoch', exact: true }).click();
  await expect(rows).toHaveCount(100);
  await expect(master).toBeEnabled();
  await rows.first().getByRole('checkbox').check();
  await assertCount(1);
  await expect(master).toHaveAttribute('aria-checked', 'mixed');
  assert.equal(Number((await pool.query('SELECT count(*) FROM todo_read_states WHERE todo_id = ANY($1::text[])', [ids])).rows[0].count), 0, 'Selection must not mark unread todos as read');
  await master.click();
  await assertCount(105);
  await expect(master).toBeChecked();
  await page.screenshot({ path: path.join(screenshotDir, 'desktop-selection.png') });

  // A stale version rejects the entire operation; the selection remains available for review.
  await pool.query('UPDATE todo_items SET updated_at=updated_at + 1000 WHERE id=$1', [ids[0]]);
  await chooseAction('complete');
  const conflict = page.waitForResponse((response) => response.url().endsWith('/api/todos/bulk'));
  await toolbar.getByRole('button', { name: 'Anwenden' }).click();
  assert.equal((await conflict).status(), 409);
  await expect(toolbar.getByRole('alert')).toContainText('Es wurde nichts übernommen');
  assert.equal(Number((await pool.query("SELECT count(*) FROM todo_items WHERE id=ANY($1::text[]) AND status='open'", [ids])).rows[0].count), 108);
  await toolbar.getByRole('button', { name: 'Auswahl aufheben' }).click();
  await master.click();
  await assertCount(105);
  const lateId = `${prefix}-late`;
  ids.push(lateId);
  await pool.query('INSERT INTO todo_items (id,user_id,title,category_id,priority,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)', [lateId, userId, 'Late arrival', categoryIds[0], 'high', Date.now()]);
  await chooseAction('category', categoryIds[1]);
  await apply();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Late arrival');
  assert.equal(Number((await pool.query('SELECT count(*) FROM todo_items WHERE id=ANY($1::text[]) AND category_id=$2', [ids, categoryIds[1]])).rows[0].count), 105);
  assert.equal(Number((await pool.query('SELECT count(*) FROM todo_items WHERE id=ANY($1::text[]) AND category_id=$2', [ids, categoryIds[0]])).rows[0].count), 4);

  await page.getByRole('button', { name: names[1], exact: true }).click();
  await expect(rows).toHaveCount(100);
  await master.click();
  await assertCount(105);
  await page.getByRole('button', { name: 'Normal', exact: true }).click();
  await assertCount(0);
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Hoch', exact: true }).click();
  await expect(rows).toHaveCount(100);

  // Scoped keyboard selection and clear work without hijacking text fields.
  await master.focus();
  await page.keyboard.press('Control+a');
  await assertCount(105);
  await page.keyboard.press('Escape');
  await assertCount(0);
  await master.click();
  await assertCount(105);
  await chooseAction('archive');
  await toolbar.getByRole('button', { name: 'Anwenden' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('105 To-dos löschen?');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await assertCount(105);
  await toolbar.getByRole('button', { name: 'Anwenden' }).click();
  const deletion = page.waitForResponse((response) => response.url().endsWith('/api/todos/bulk'));
  await dialog.getByRole('button', { name: 'Löschen', exact: true }).click();
  assert.equal((await deletion).status(), 200);
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Zuletzt gelöscht', exact: true }).click();
  await expect(rows).toHaveCount(100);
  await master.click();
  await assertCount(105);
  await chooseAction('restore');
  await apply();
  await expect(rows).toHaveCount(0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM todo_items WHERE id=ANY($1::text[]) AND status='open' AND archived_at IS NULL", [ids])).rows[0].count), 109);

  await page.getByRole('button', { name: 'Offen', exact: true }).click();
  await expect(rows).toHaveCount(100);
  await master.click();
  await assertCount(105);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseAction('priority', 'low');
  await expect(toolbar.getByRole('combobox', { name: 'Aktion wählen' })).toHaveValue('priority');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-selection.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal mobile overflow');
  assert.equal(await toolbar.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth), true, 'Mobile bulk controls must not be clipped');
  assert.equal(await toolbar.getByRole('button', { name: 'Anwenden' }).evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth), true, 'Apply button stays on-screen');
  await apply();
  await expect(rows).toHaveCount(0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM todo_items WHERE id=ANY($1::text[]) AND priority='low'", [ids])).rows[0].count), 105);
  // Response-controlled UI checks complement the real permission and transaction tests.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const listMatcher = (url) => url.pathname === '/api/todos';
  const readonlyHandler = async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data[0].canWrite = false;
    await route.fulfill({ response, json: payload });
  };
  await page.route(listMatcher, readonlyHandler);
  await page.getByRole('button', { name: 'Niedrig', exact: true }).click();
  await expect(rows).toHaveCount(100);
  await expect(rows.first().getByRole('checkbox')).toBeDisabled();
  await master.click();
  await assertCount(104);
  await expect(toolbar).toContainText('1 nur lesbare To-dos wurden nicht ausgewählt');
  await rows.nth(1).getByRole('checkbox').uncheck();
  await assertCount(103);
  await expect(master).toHaveAttribute('aria-checked', 'mixed');
  await toolbar.getByRole('button', { name: 'Auswahl aufheben' }).click();
  await page.unroute(listMatcher, readonlyHandler);

  let release;
  let started;
  let finished;
  const held = new Promise((resolve) => { release = resolve; });
  const captured = new Promise((resolve) => { started = resolve; });
  const settled = new Promise((resolve) => { finished = resolve; });
  const delayedHandler = async (route) => {
    if (!new URL(route.request().url()).searchParams.has('selection')) return route.continue();
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response }).catch(() => {});
    finished();
  };
  await page.route(listMatcher, delayedHandler);
  await master.click();
  await captured;
  await page.getByRole('button', { name: 'Normal', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await assertCount(0);
  release();
  await settled;
  await page.unroute(listMatcher, delayedHandler);
  await page.getByRole('button', { name: 'Niedrig', exact: true }).click();
  await expect(rows).toHaveCount(100);
  await assertCount(0);
  console.log(`Todo bulk UI checks passed (105 selected; 3 filtered out and 1 late arrival untouched). Screenshots: ${screenshotDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshotDir, 'failure.png') }).catch(() => {});
  console.error(`UI failure screenshot: ${screenshotDir}/failure.png`);
  throw error;
} finally {
  await context.request.post('/api/auth/sign-out', { headers: { Origin: baseURL }, timeout: 5_000 }).catch(() => {});
  await browser.close();
  await pool.query('DELETE FROM todo_read_states WHERE todo_id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM todo_items WHERE id = ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM todo_categories WHERE id = ANY($1::text[])', [categoryIds]);
  await pool.end();
}
