import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-inbox-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  try {
    const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
    const database = await openDb();
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1_000);
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['mobile-attention-user', 'Attention User', 'attention@example.test', 1, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO pi_sessions (
        session_id, user_id, agent_id, provider, model, title, created_at, updated_at,
        last_message_at, last_viewed_at, channel_id, workspace_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['attention-session', 'mobile-attention-user', 'canvas-agent', 'openai', 'test', 'Client review', nowSeconds - 10, nowSeconds, nowSeconds, nowSeconds - 20, 'web', 'personal'],
    );
    await database.run(
      `INSERT INTO studio_generations (
        id, user_id, mode, aspect_ratio, provider, model, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['generation-ready', 'mobile-attention-user', 'image', '1:1', 'test', 'test', 'completed', nowSeconds - 5, nowSeconds - 4],
    );
    await database.run(
      `INSERT INTO automation_jobs (
        id, name, status, owner_user_id, prompt, preferred_skill, workspace_context_paths_json,
        schedule_kind, schedule_config_json, time_zone, created_by_user_id, agent_id,
        delivery_mode, delivery_session_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['job-failed', 'Morning report', 'active', 'mobile-attention-user', 'Report', '', '[]', 'manual', '{}', 'UTC', 'mobile-attention-user', 'canvas-agent', 'web', 'new_session', nowSeconds - 5, nowSeconds],
    );
    await database.run(
      `INSERT INTO automation_runs (
        id, job_id, status, actor_user_id, trigger_type, finished_at, attempt_number, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run-failed', 'job-failed', 'failed', 'mobile-attention-user', 'manual', nowSeconds - 3, 1, 'Provider unavailable', nowSeconds - 6],
    );
    await database.close();

    const { createLegacyPersonalWorkspaceContext } = await import('../app/lib/workspaces/context');
    const { createTodo } = await import('../app/lib/todos/store');
    const { getMobileTodo, listMobileTodos } = await import('../app/lib/mobile/todos');
    const { listMobileInbox, markMobileInboxRead } = await import('../app/lib/mobile/inbox');
    const workspace = createLegacyPersonalWorkspaceContext({
      userId: 'mobile-attention-user',
      email: 'attention@example.test',
      role: 'owner',
    });

    const firstTodo = await createTodo('mobile-attention-user', {
      title: 'Approve launch copy',
      priority: 'high',
      seenAt: null,
      fileLinks: [{ workspacePath: 'Clients/Acme/brief.md', label: 'Brief' }],
    });
    await createTodo('mobile-attention-user', { title: 'Prepare screenshots', seenAt: new Date() });

    const inbox = await listMobileInbox({ userId: 'mobile-attention-user', workspace, limit: 20 });
    assert.equal(inbox.counts.unread, 4);
    assert.equal(inbox.items.some((item) => item.id === 'chat:attention-session'), true);
    assert.equal(inbox.items.some((item) => item.id === `todo:${firstTodo.id}`), true);
    assert.equal(inbox.items.some((item) => item.id === 'studio:generation-ready'), true);
    assert.equal(inbox.items.some((item) => item.id === 'automation:run-failed'), true);

    await markMobileInboxRead({
      userId: 'mobile-attention-user',
      workspace,
      action: 'mark_item_read',
      itemId: 'studio:generation-ready',
    });
    const afterStudioRead = await listMobileInbox({ userId: 'mobile-attention-user', workspace, filter: 'unread' });
    assert.equal(afterStudioRead.items.some((item) => item.id === 'studio:generation-ready'), false);

    await markMobileInboxRead({ userId: 'mobile-attention-user', workspace, action: 'mark_all_read' });
    const afterAllRead = await listMobileInbox({ userId: 'mobile-attention-user', workspace, filter: 'unread' });
    assert.equal(afterAllRead.counts.unread, 0, JSON.stringify(afterAllRead));
    assert.equal(afterAllRead.items.length, 0);

    const todoPage = await listMobileTodos({ userId: 'mobile-attention-user', workspace, status: 'all', limit: 1 });
    assert.equal(todoPage.todos.length, 1);
    assert.ok(todoPage.nextCursor);
    const nextTodoPage = await listMobileTodos({
      userId: 'mobile-attention-user',
      workspace,
      status: 'all',
      limit: 1,
      cursor: todoPage.nextCursor,
    });
    assert.equal(nextTodoPage.todos.length, 1);
    assert.notEqual(nextTodoPage.todos[0]?.id, todoPage.todos[0]?.id);

    const loadedTodo = await getMobileTodo({ userId: 'mobile-attention-user', workspace, todoId: firstTodo.id });
    assert.equal(loadedTodo.title, 'Approve launch copy');
    assert.deepEqual(loadedTodo.fileLinks.map((link) => ({
      workspaceId: link.workspaceId,
      workspaceType: link.workspaceType,
      workspacePath: link.workspacePath,
    })), [{
      workspaceId: null,
      workspaceType: 'personal',
      workspacePath: 'Clients/Acme/brief.md',
    }]);
    await assert.rejects(() => listMobileTodos({
      userId: 'mobile-attention-user',
      workspace,
      status: 'open',
      cursor: todoPage.nextCursor,
    }), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_CURSOR'));

    await closeDatabaseConnections();
    console.log('mobile-inbox-todos-test: ok');
  } finally {
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalProvider;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
