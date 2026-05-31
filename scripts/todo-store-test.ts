import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-store-'));
process.env.DATA = dataDir;

async function main() {
  const workspaceDir = path.join(dataDir, 'workspace');
  mkdirSync(path.join(workspaceDir, 'docs'), { recursive: true });
  writeFileSync(path.join(workspaceDir, 'docs', 'brief.md'), '# Brief');

  const { db } = await import('../app/lib/db');
  const { user } = await import('../app/lib/db/schema');
  const {
    DEFAULT_TODO_CATEGORY_NAME,
    TodoStoreError,
    archiveTodo,
    createTodo,
    ensureTodoCategories,
    listTodos,
    markTodoSeen,
    normalizeWorkspaceTodoPath,
    restoreTodo,
  } = await import('../app/lib/todos/store');

  const now = new Date('2026-05-31T12:00:00.000Z');
  await db.insert(user).values([
    {
      id: 'todo-user',
      name: 'Todo User',
      email: 'todo-user@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'other-user',
      name: 'Other User',
      email: 'other-todo-user@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const categories = await ensureTodoCategories('todo-user');
  assert.equal(categories.length, 7);
  assert.equal(categories[0].name, DEFAULT_TODO_CATEGORY_NAME);

  const created = await createTodo('todo-user', {
    title: '  Review the brief  ',
    description: 'Human review required',
    categoryName: 'Pruefen',
    priority: 'high',
    sourceType: 'agent',
    sourceAgentId: 'canvas-agent',
    sourceSessionId: 'sess-test',
    fileLinks: [
      { workspacePath: './docs/brief.md', label: 'Brief' },
      'docs/brief.md',
    ],
  });

  assert.equal(created.title, 'Review the brief');
  assert.equal(created.priority, 'high');
  assert.equal(created.sourceType, 'agent');
  assert.equal(created.category?.name, 'Pruefen');
  assert.equal(created.fileLinks.length, 1);
  assert.equal(created.fileLinks[0].workspacePath, 'docs/brief.md');

  const todos = await listTodos('todo-user');
  assert.equal(todos.length, 1);
  assert.equal(todos[0].id, created.id);

  const otherUserTodos = await listTodos('other-user', { status: 'all' });
  assert.equal(otherUserTodos.length, 0);

  const seen = await markTodoSeen('todo-user', created.id, new Date('2026-05-31T12:05:00.000Z'));
  assert.equal(seen?.seenAt?.toISOString(), '2026-05-31T12:05:00.000Z');

  const archived = await archiveTodo('todo-user', created.id);
  assert.equal(archived?.status, 'archived');
  assert.ok(archived?.archivedAt instanceof Date);
  assert.equal((await listTodos('todo-user')).length, 0);
  assert.equal((await listTodos('todo-user', { status: 'archived' })).length, 1);

  const restored = await restoreTodo('todo-user', created.id);
  assert.equal(restored?.status, 'open');
  assert.equal(restored?.archivedAt, null);

  assert.equal(normalizeWorkspaceTodoPath('docs/../docs/brief.md'), 'docs/brief.md');
  assert.throws(
    () => normalizeWorkspaceTodoPath('../outside.md'),
    (error) => error instanceof TodoStoreError && error.code === 'INVALID_WORKSPACE_PATH',
  );
  assert.throws(
    () => normalizeWorkspaceTodoPath('/data/workspace/docs/brief.md'),
    (error) => error instanceof TodoStoreError && error.code === 'INVALID_WORKSPACE_PATH',
  );
}

main()
  .then(() => {
    console.log('[Todo Store Test] passed');
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error('[Todo Store Test] failed:', error);
    process.exitCode = 1;
  });
