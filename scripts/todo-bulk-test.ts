import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { parseTodoBulkInput, bulkActionAllowsStatus, TodoBulkError } from '../app/lib/todos/bulk-policy';

// Uses the existing PostgreSQL service, but creates and drops only its own disposable database.
// Run with --env-file pointing to the managed host-dev env. Never runs fixtures in the app database.
async function main() {
  assert.ok(process.env.DATABASE_URL, 'Provide the managed PostgreSQL environment to run this test.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const name = `canvas_todo_bulk_test_${randomUUID().replaceAll('-', '')}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-bulk-'));
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  process.env.DATABASE_URL = url.toString();
  process.env.DATA = dataDir;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.CANVAS_POSTGRES_MODE = 'external';
  process.env.CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS = 'true';
  let appPool: Pool | null = null;
  try {
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const { db, getPostgresRuntimeQueryable } = await import('../app/lib/db');
    appPool = getPostgresRuntimeQueryable();
    assert.ok(appPool);
    await runPostgresMigrations(appPool);
    const regression = spawnSync(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', 'scripts/todo-store-test.ts'], { env: process.env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(regression.status, 0, regression.stdout + regression.stderr);
    const { user, todoItems, todoCategories } = await import('../app/lib/db/schema');
    const { listTodos, listTodoSelection, updateTodo, mutateTodosBulk, getTodo } = await import('../app/lib/todos/store');
    const now = new Date('2026-09-01T12:00:00Z');
    await db.insert(user).values(['bulk-owner', 'bulk-other'].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(todoCategories).values({ id: 'bulk-category', userId: 'bulk-owner', name: 'Destination', createdAt: now, updatedAt: now });
    await db.insert(todoItems).values(Array.from({ length: 205 }, (_, index) => ({
      id: `bulk-${String(index).padStart(4, '0')}`, userId: 'bulk-owner', title: `Todo ${index}`,
      createdAt: now, updatedAt: now, priority: index % 2 ? 'high' : 'normal',
    })));
    const list = await listTodos('bulk-owner', { status: 'open' });
    assert.equal(list.length, 100);
    const selection = await listTodoSelection('bulk-owner', { status: 'open' });
    assert.equal(selection.length, 205);
    assert.equal(new Set(selection.map((row) => row.id)).size, 205);
    assert.deepEqual(selection.slice(0, 100).map((row) => row.id), list.map((row) => row.id));
    assert.equal((await listTodoSelection('bulk-owner', { priority: 'high', readState: 'unread' })).length, 102);
    const items = selection.map((row) => ({ id: row.id, expectedUpdatedAt: row.updatedAt }));
    const authorize = async () => {};
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-other', items, action: { type: 'complete' }, authorize }));
    let checks = 0;
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-owner', items, action: { type: 'complete' }, authorize: async () => {
      if (++checks === 205) throw new Error('Permission revoked');
    } }));
    assert.equal((await getTodo('bulk-owner', items[0].id))?.status, 'open', 'Permission failure leaves every row unchanged');
    await updateTodo('bulk-owner', items.at(-1)!.id, { title: 'Changed by agent' });
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-owner', items, action: { type: 'complete' }, authorize }), (error: unknown) => error instanceof TodoBulkError && error.code === 'TODO_BULK_CONFLICT');
    assert.equal((await getTodo('bulk-owner', items[0].id))?.status, 'open');
    const freshItems = async () => (await listTodoSelection('bulk-owner', { status: 'all' })).map((row) => ({ id: row.id, expectedUpdatedAt: row.updatedAt }));
    await appPool.query(`CREATE FUNCTION reject_bulk_test_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = 'bulk-0204' THEN RAISE EXCEPTION 'Injected final-row failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_bulk_test_update BEFORE UPDATE ON todo_items FOR EACH ROW EXECUTE FUNCTION reject_bulk_test_update()`);
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'category', categoryId: 'bulk-category' }, authorize }));
    assert.equal((await getTodo('bulk-owner', 'bulk-0000'))?.categoryId, null, 'A late SQL failure rolls back already-written rows');
    await appPool.query('DROP TRIGGER reject_bulk_test_update ON todo_items; DROP FUNCTION reject_bulk_test_update()');
    const move = await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'category', categoryId: 'bulk-category' }, authorize });
    assert.equal(move.changed, 205);
    assert.equal((await listTodoSelection('bulk-owner', { categoryId: 'bulk-category' })).length, 205);
    assert.equal((await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'category', categoryId: 'bulk-category' }, authorize })).changed, 0);
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'assign', assigneeUserId: 'bulk-other' }, authorize }));
    await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'priority', priority: 'low' }, authorize });
    await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'assign', assigneeUserId: 'bulk-owner' }, authorize });
    await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'complete' }, authorize });
    assert.equal((await listTodoSelection('bulk-owner', { status: 'open' })).length, 0);
    assert.equal((await getTodo('bulk-owner', items[0].id))?.readState, 'read');
    await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'reopen' }, authorize });
    assert.equal((await getTodo('bulk-owner', items[0].id))?.readState, 'read');
    await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'archive' }, authorize });
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'complete' }, authorize }), (error: unknown) => error instanceof TodoBulkError && error.code === 'TODO_BULK_STATUS');
    await mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'restore' }, authorize });
    assert.equal((await getTodo('bulk-owner', items[0].id))?.completedAt, null);
    assert.equal((await getTodo('bulk-owner', items[0].id))?.archivedAt, null);
    await db.update(todoCategories).set({ isArchived: true }).where(eq(todoCategories.id, 'bulk-category'));
    await assert.rejects(mutateTodosBulk({ userId: 'bulk-owner', items: await freshItems(), action: { type: 'category', categoryId: 'bulk-category' }, authorize }));
    await db.insert(todoItems).values(Array.from({ length: 800 }, (_, i) => ({ id: `overflow-${i}`, userId: 'bulk-owner', title: 'Extra', createdAt: now, updatedAt: now })));
    await assert.rejects(listTodoSelection('bulk-owner', { status: 'all' }), (error: unknown) => error instanceof TodoBulkError && error.code === 'TODO_SELECTION_LIMIT');
    const rawItem = { id: 'one', expectedUpdatedAt: now.toISOString() };
    assert.equal(parseTodoBulkInput({ items: [rawItem, rawItem], action: { type: 'complete' } }).items.length, 1);
    for (const bad of [null, {}, { items: [], action: { type: 'complete' } }, { items: [rawItem], action: { type: 'toggle' } }, { items: [rawItem], action: { type: 'assign' } }]) assert.throws(() => parseTodoBulkInput(bad));
    assert.equal(bulkActionAllowsStatus('complete', 'archived'), false);
    assert.equal(bulkActionAllowsStatus('restore', 'archived'), true);
    console.log('Todo bulk PostgreSQL checks passed, including existing store regression suite.');
  } finally {
    await appPool?.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
