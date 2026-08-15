import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

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
      `INSERT INTO pi_sessions (
        session_id, user_id, agent_id, provider, model, title, created_at, updated_at,
        last_message_at, last_viewed_at, channel_id, workspace_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['historic-unread-session', 'mobile-attention-user', 'canvas-agent', 'openai', 'test', 'Historic review', nowSeconds - 3 * 24 * 60 * 60, nowSeconds, nowSeconds - 3 * 24 * 60 * 60, null, 'web', 'personal'],
    );
    await database.run(
      `INSERT INTO studio_generations (
        id, user_id, mode, aspect_ratio, provider, model, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['generation-ready', 'mobile-attention-user', 'image', '1:1', 'test', 'test', 'completed', nowSeconds - 5, nowSeconds - 4],
    );
    await database.run(
      `INSERT INTO studio_generation_outputs (
        id, generation_id, variation_index, type, file_path, file_name, mime_type,
        file_size, width, height, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'generation-preview-output',
        'generation-ready',
        0,
        'image',
        'studio/outputs/generation-ready/preview.png',
        'preview.png',
        'image/png',
        1_234,
        1_024,
        1_024,
        nowSeconds - 4,
      ],
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
    const {
      countMobileUnreadMessages,
      groupMobileAggregateInboxItemsForPresentation,
      listMobileAggregateInbox,
      listMobileInbox,
      markMobileAggregateInboxRead,
      markMobileInboxRead,
    } = await import('../app/lib/mobile/inbox');
    const {
      getUserInboxExcludedWorkspaceIds,
      setUserInboxExcludedWorkspaceIds,
    } = await import('../app/lib/user-preferences');
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
    assert.equal(await countMobileUnreadMessages({ userId: 'mobile-attention-user', workspaces: [workspace] }), 1);
    assert.equal(inbox.items.some((item) => item.id === 'chat:attention-session'), true);
    assert.equal(inbox.items.some((item) => item.id === 'chat:historic-unread-session'), false);
    assert.equal(inbox.items.some((item) => item.id === `todo:${firstTodo.id}`), true);
    assert.equal(inbox.items.some((item) => item.id === 'studio:generation-ready'), true);
    assert.equal(inbox.items.some((item) => item.id === 'automation:run-failed'), true);
    assert.equal(
      inbox.items.find((item) => item.id === 'studio:generation-ready')?.previewUrl,
      '/api/mobile/v1/studio/outputs/generation-preview-output/preview',
    );
    const aggregateInbox = await listMobileAggregateInbox({
      userId: 'mobile-attention-user',
      workspaces: [workspace],
      limit: 2,
    });
    assert.equal(aggregateInbox.scope.workspaceCount, 1);
    assert.deepEqual(aggregateInbox.scope.workspaceIds, [workspace.workspaceId]);
    assert.equal(aggregateInbox.counts.unread, inbox.counts.unread);
    assert.equal(aggregateInbox.items.every((item) => item.workspaceId === workspace.workspaceId), true);
    assert.ok(aggregateInbox.nextCursor);
    const aggregateNextPage = await listMobileAggregateInbox({
      userId: 'mobile-attention-user',
      workspaces: [workspace],
      cursor: aggregateInbox.nextCursor,
      limit: 2,
    });
    assert.equal(aggregateNextPage.items.length, 2);
    const groupedTodoEntries = groupMobileAggregateInboxItemsForPresentation([
      ...['workspace-alex', 'workspace-coding', 'workspace-notebook'].map((workspaceId, index) => ({
        id: `todo:grouped-${index}`,
        occurredAt: new Date(now - index * 1_000).toISOString(),
        previewUrl: null,
        priority: 'normal' as const,
        title: 'Social Media: Performance data',
        detail: 'To-do',
        target: { kind: 'todo' as const, todoId: `grouped-${index}` },
        todoPresentationCandidate: {
          createdAt: new Date(now - index * 1_000).toISOString(),
          fingerprint: 'same-cross-workspace-task',
        },
        type: 'todo.attention' as const,
        unread: true,
        workspaceId,
      })),
      {
        id: 'todo:independent',
        occurredAt: new Date(now - 500).toISOString(),
        previewUrl: null,
        priority: 'normal' as const,
        title: 'Social Media: Performance data',
        detail: 'To-do',
        target: { kind: 'todo' as const, todoId: 'independent' },
        todoPresentationCandidate: {
          createdAt: new Date(now - 500).toISOString(),
          fingerprint: 'independent-task-with-the-same-title',
        },
        type: 'todo.attention' as const,
        unread: true,
        workspaceId: 'workspace-independent',
      },
    ]);
    assert.equal(groupedTodoEntries.length, 2);
    const groupedTodo = groupedTodoEntries.find((item) => item.todoGroup);
    assert.equal(groupedTodo?.id.startsWith('todo-group:'), true);
    assert.equal(groupedTodo?.todoGroup?.workspaceCount, 3);
    assert.equal(groupedTodo?.todoGroup?.items.length, 3);
    assert.equal(groupedTodoEntries.some((item) => item.id === 'todo:independent'), true);
    await assert.rejects(
      () => listMobileAggregateInbox({
        userId: 'mobile-attention-user',
        workspaces: [],
        cursor: aggregateInbox.nextCursor,
      }),
      (error: unknown) => Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'INVALID_CURSOR'
      ),
    );
    assert.deepEqual(await getUserInboxExcludedWorkspaceIds('mobile-attention-user'), []);
    assert.deepEqual(
      await setUserInboxExcludedWorkspaceIds('mobile-attention-user', ['workspace-muted']),
      ['workspace-muted'],
    );
    assert.deepEqual(
      await getUserInboxExcludedWorkspaceIds('mobile-attention-user'),
      ['workspace-muted'],
    );
    await assert.rejects(
      () => setUserInboxExcludedWorkspaceIds('mobile-attention-user', ['workspace-muted', 'workspace-muted']),
      /Unsupported Inbox workspace selection/u,
    );
    await setUserInboxExcludedWorkspaceIds('mobile-attention-user', []);

    const { auth } = await import('../app/lib/auth');
    let badgeSession: {
      user: { id: string; email: string; role: string };
    } | null = null;
    assert.equal(Reflect.set(auth.api, 'getSession', async () => badgeSession), true);
    const badgeRoute = await import('../app/api/mobile/v1/inbox/badge/route');
    const unauthorizedBadge = await badgeRoute.GET(
      new NextRequest('http://localhost/api/mobile/v1/inbox/badge'),
    );
    assert.equal(unauthorizedBadge.status, 401);
    badgeSession = {
      user: {
        id: 'mobile-attention-user',
        email: 'attention@example.test',
        role: 'owner',
      },
    };
    const badgeResponse = await badgeRoute.GET(
      new NextRequest('http://localhost/api/mobile/v1/inbox/badge'),
    );
    assert.equal(badgeResponse.status, 200);
    assert.equal(badgeResponse.headers.get('cache-control'), 'no-store, max-age=0');
    assert.deepEqual(await badgeResponse.json(), { success: true, count: 1 });

    await markMobileInboxRead({
      userId: 'mobile-attention-user',
      workspace,
      action: 'mark_item_read',
      itemId: 'studio:generation-ready',
    });
    const afterStudioRead = await listMobileInbox({ userId: 'mobile-attention-user', workspace, filter: 'unread' });
    assert.equal(afterStudioRead.items.some((item) => item.id === 'studio:generation-ready'), false);

    await markMobileInboxRead({
      userId: 'mobile-attention-user',
      workspace,
      action: 'dismiss_item',
      itemId: 'automation:run-failed',
    });
    const afterAutomationDismiss = await listMobileInbox({ userId: 'mobile-attention-user', workspace });
    assert.equal(afterAutomationDismiss.items.some((item) => item.id === 'automation:run-failed'), false);
    assert.equal(afterAutomationDismiss.counts.automation, 0);
    await assert.rejects(
      () => markMobileInboxRead({
        userId: 'mobile-attention-user',
        workspace,
        action: 'dismiss_item',
        itemId: `todo:${firstTodo.id}`,
      }),
      (error: unknown) => Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ITEM_NOT_DISMISSIBLE'
      ),
    );

    await markMobileInboxRead({ userId: 'mobile-attention-user', workspace, action: 'mark_all_read' });
    const afterAllRead = await listMobileInbox({ userId: 'mobile-attention-user', workspace, filter: 'unread' });
    assert.equal(afterAllRead.counts.unread, 0, JSON.stringify(afterAllRead));
    assert.equal(afterAllRead.items.length, 0);
    assert.equal(await countMobileUnreadMessages({ userId: 'mobile-attention-user', workspaces: [workspace] }), 0);
    const aggregateReadResult = await markMobileAggregateInboxRead({
      userId: 'mobile-attention-user',
      workspaces: [workspace],
    });
    assert.deepEqual(aggregateReadResult.workspaceIds, [workspace.workspaceId]);

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

    const aggregateRoute = await import('../app/api/mobile/v1/inbox/aggregate/route');
    const aggregateResponse = await aggregateRoute.GET(
      new NextRequest('http://localhost/api/mobile/v1/inbox/aggregate?filter=all&limit=20'),
    );
    assert.equal(aggregateResponse.status, 200);
    const aggregatePayload = await aggregateResponse.json();
    assert.equal(aggregatePayload.success, true);
    assert.equal(aggregatePayload.scope.workspaceCount, 1);
    assert.equal(aggregatePayload.items.length > 0, true);
    assert.equal(typeof aggregatePayload.items[0]?.workspaceId, 'string');

    const preferencesRoute = await import('../app/api/mobile/v1/inbox/preferences/route');
    const preferencesResponse = await preferencesRoute.GET(
      new NextRequest('http://localhost/api/mobile/v1/inbox/preferences'),
    );
    assert.equal(preferencesResponse.status, 200);
    const preferencesPayload = await preferencesResponse.json();
    assert.equal(preferencesPayload.success, true);
    assert.equal(preferencesPayload.data.sources.length, 1);
    assert.deepEqual(preferencesPayload.data.excludedWorkspaceIds, []);
    const emptyScopeResponse = await preferencesRoute.PATCH(
      new NextRequest('http://localhost/api/mobile/v1/inbox/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
          excludedWorkspaceIds: [preferencesPayload.data.sources[0].id],
        }),
      }),
    );
    assert.equal(emptyScopeResponse.status, 400);

    const { mobileTodosErrorResponse } = await import('../app/lib/mobile/todos-route');
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const response = mobileTodosErrorResponse(
        new Error('Failed query: select * from "todo_items" where "user_id" = $1\nparams: private-user-id'),
        '[API] Mobile To-dos GET failed:',
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        success: false,
        error: 'To-do request failed.',
      });
    } finally {
      console.error = originalConsoleError;
    }

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
