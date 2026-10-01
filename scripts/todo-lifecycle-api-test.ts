import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';

// Reuses the managed PostgreSQL server; fixtures live in a disposable database.
// node --env-file=<managed notebook-host-dev.env> --import tsx --conditions react-server scripts/todo-lifecycle-api-test.ts
async function main() {
  assert.ok(process.env.DATABASE_URL, 'Provide the managed PostgreSQL environment.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const databaseName = `canvas_todo_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-lifecycle-'));
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  let databaseCreated = false;
  let appPool: Pool | null = null;
  const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  let currentUserId: string | null = 'lifecycle-owner';
  let followUpFails = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    Object.assign(process.env, {
      DATABASE_URL: url.toString(), DATA: dataDir, CANVAS_DATA_ROOT: dataDir,
      CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external',
      CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS: 'true', CANVAS_DISABLE_TODO_PUSH_NOTIFICATIONS: 'true',
    });
    loader._load = (request, parent, isMain) => {
      if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => currentUserId ? ({
        user: { id: currentUserId, name: currentUserId, email: `${currentUserId}@example.test`, role: null },
        session: { id: 'lifecycle-session', userId: currentUserId },
      }) : null } } };
      if (request === '@/app/lib/pi/runtime-service') return { sendFollowUpMessage: async () => {
        if (followUpFails) throw new Error('Fixture follow-up failure');
        return { status: 'queued' };
      } };
      return originalLoad(request, parent, isMain);
    };
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const { db, getPostgresRuntimeQueryable } = await import('../app/lib/db');
    appPool = getPostgresRuntimeQueryable();
    assert.ok(appPool);
    await runPostgresMigrations(appPool);
    const { user, canvasOrganizationSettings, canvasWorkspaces, canvasWorkspaceMembers, organizationUserPermissions, todoItems, todoReadStates, piSessions } = await import('../app/lib/db/schema');
    const ownerId = 'lifecycle-owner';
    const readerId = 'lifecycle-reader';
    const outsiderId = 'lifecycle-outsider';
    const organizationId = 'lifecycle-org';
    const workspaceId = 'lifecycle-team';
    const now = new Date();
    await db.insert(user).values([ownerId, readerId, outsiderId].map(id => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(canvasOrganizationSettings).values({ organizationId, ownerUserId: ownerId, deploymentMode: 'team', teamFeaturesEnabled: true, createdAt: now, updatedAt: now });
    await db.insert(organizationUserPermissions).values([
      { organizationId, userId: ownerId, role: 'owner', canWriteTeamWorkspace: true, createdAt: now, updatedAt: now },
      { organizationId, userId: readerId, role: 'member', canWriteTeamWorkspace: false, createdAt: now, updatedAt: now },
    ]);
    await db.insert(canvasWorkspaces).values({ id: workspaceId, organizationId, type: 'team', rootRelativePath: `organizations/${organizationId}/team`, displayName: 'Lifecycle team', status: 'active', createdAt: now, updatedAt: now });
    await db.insert(canvasWorkspaceMembers).values([
      { organizationId, workspaceId, userId: ownerId, role: 'owner', status: 'active', canRead: true, canWrite: true, canManage: true, createdAt: now, updatedAt: now },
      { organizationId, workspaceId, userId: readerId, role: 'member', status: 'active', canRead: true, canWrite: false, canManage: false, createdAt: now, updatedAt: now },
    ]);
    const teamId = randomUUID();
    const sessionId = randomUUID();
    await db.insert(piSessions).values({ sessionId, userId: ownerId, agentId: 'lifecycle-agent', provider: 'openai', model: 'fixture-model', workspaceId, title: 'Follow-up', createdAt: now, updatedAt: now });
    await db.insert(todoItems).values({ id: teamId, userId: ownerId, createdByUserId: ownerId, assigneeUserId: readerId, organizationId, workspaceId, workspaceType: 'team', scopeKind: 'workspace', title: 'Assigned task', sourceType: 'agent', sourceAgentId: 'lifecycle-agent', sourceSessionId: sessionId, createdAt: now, updatedAt: now });
    const web = await import('../app/api/todos/[id]/route');
    const webList = await import('../app/api/todos/route');
    const mobile = await import('../app/api/mobile/v1/todos/[todoId]/route');
    const mobileList = await import('../app/api/mobile/v1/todos/route');
    const mobileInbox = await import('../app/api/mobile/v1/inbox/route');
    const followUp = await import('../app/api/mobile/v1/todos/[todoId]/follow-up/route');
    const bulk = await import('../app/api/todos/bulk/route');
    const { requireSessionWorkspace } = await import('../app/lib/workspaces/request');
    const { listMobileInbox, listMobileAggregateInbox, markMobileAggregateInboxRead } = await import('../app/lib/mobile/inbox');
    const { listMobileTodos } = await import('../app/lib/mobile/todos');
    const { listLifecycleTodoAttention, getTodo } = await import('../app/lib/todos/store');
    const { readNotificationAttention } = await import('../app/lib/notifications/attention');
    const { selectTodoAttention } = await import('../app/lib/notifications/attention-policy');
    const request = (pathname: string, method = 'GET', payload?: unknown, lifecycle = true) => new NextRequest(`http://localhost${pathname}${pathname.includes('?') ? '&' : '?'}${lifecycle ? 'todoMode=lifecycle' : ''}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Canvas-Workspace-Id': workspaceId }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const context = { params: Promise.resolve({ id: teamId }) };
    const mobileContext = { params: Promise.resolve({ todoId: teamId }) };
    const readRows = () => db.select().from(todoReadStates);
    const noReadMetadata = (todo: Record<string, unknown>) => {
      for (const key of ['seenAt', 'readAt', 'readState']) assert.equal(key in todo, false, `${key} must not leak into lifecycle DTOs`);
    };
    const fixtureSession = () => ({ user: { id: currentUserId!, email: `${currentUserId}@example.test`, role: null } }) as Parameters<typeof requireSessionWorkspace>[0];
    currentUserId = readerId;
    const scope = await requireSessionWorkspace(fixtureSession(), { workspaceId, permissions: 'canRead' });
    assert.ok(scope.workspace, JSON.stringify(scope.response && await scope.response.json()));
    const workspace = scope.workspace;
    const opened = await web.GET(request(`/api/todos/${teamId}`), context);
    assert.equal(opened?.status, 200);
    const openedTodo = (await opened!.json()).data;
    noReadMetadata(openedTodo);
    assert.equal(openedTodo.canWrite, false);
    const legacy = (await (await web.GET(request(`/api/todos/${teamId}`, 'GET', undefined, false), context))!.json()).data;
    assert.equal(legacy.readState, 'unread');
    assert.equal(legacy.seenAt, null);
    assert.equal((await readRows()).length, 0, 'Opening both modes never writes Todo read state');
    for (const payload of [{ markSeen: true }, { read: false }, { seenAt: null }, { readState: 'unread' }, { readAt: now.toISOString() }]) {
      for (const [handler, routeContext, pathname] of [[web.PATCH, context, `/api/todos/${teamId}`], [mobile.PATCH, mobileContext, `/api/mobile/v1/todos/${teamId}`]] as const) {
        const response = await handler(request(pathname, 'PATCH', payload), routeContext as never);
        assert.equal(response?.status, 400);
        assert.equal((await response!.json()).code, 'TODO_READ_STATE_NOT_SUPPORTED');
      }
    }
    assert.equal((await web.PATCH(request(`/api/todos/${teamId}`, 'PATCH', { status: 'done' }), context))?.status, 403);
    assert.equal((await mobile.PATCH(request(`/api/mobile/v1/todos/${teamId}`, 'PATCH', { status: 'done' }), mobileContext))?.status, 403);
    assert.equal((await readRows()).length, 0);
    const mobileOpened = await mobile.GET(request(`/api/mobile/v1/todos/${teamId}`), mobileContext);
    assert.equal(mobileOpened?.status, 200);
    noReadMetadata((await mobileOpened!.json()).todo);
    const inboxBefore = await listMobileInbox({ userId: readerId, workspace, todoMode: 'lifecycle', filter: 'todos' });
    assert.equal(inboxBefore.items[0]?.unread, false);
    assert.equal(inboxBefore.counts.todos, 1);
    await markMobileAggregateInboxRead({ userId: readerId, workspaces: [workspace], todoMode: 'lifecycle' });
    assert.equal((await readRows()).length, 0, 'Generic read-all never touches lifecycle Todos');
    for (const action of ['mark_item_read', 'set_item_read_state', 'dismiss_item']) {
      const response = await mobileInbox.PATCH(request('/api/mobile/v1/inbox', 'PATCH', { action, itemId: `todo:${teamId}`, read: true }));
      assert.equal(response.status, 400);
    }
    const legacyMark = await web.PATCH(request(`/api/todos/${teamId}`, 'PATCH', { markSeen: true }, false), context);
    assert.equal(legacyMark?.status, 200);
    assert.equal((await legacyMark!.json()).data.readState, 'read');
    assert.equal((await getTodo(readerId, teamId))!.updatedAt.toISOString(), openedTodo.updatedAt);
    assert.equal(selectTodoAttention({ todos: [(await getTodo(readerId, teamId))!], viewerUserId: readerId, now }).length, 0, 'Legacy viewed task without a date remains legacy-compatible');
    assert.equal(selectTodoAttention({ todos: [(await getTodo(readerId, teamId))!], viewerUserId: readerId, now, todoMode: 'lifecycle' })[0]?.attentionReason, 'open');
    assert.equal((await listMobileInbox({ userId: readerId, workspace, todoMode: 'lifecycle', filter: 'todos' })).items.length, 1, 'Viewed task remains open');
    const priorReads = await readRows();
    currentUserId = ownerId;
    const patch = async (status: string) => {
      const response = await mobile.PATCH(request(`/api/mobile/v1/todos/${teamId}`, 'PATCH', { status }), mobileContext);
      assert.equal(response?.status, 200);
      noReadMetadata((await response!.json()).todo);
    };
    await patch('done');
    assert.equal((await listMobileInbox({ userId: readerId, workspace, todoMode: 'lifecycle', filter: 'todos' })).items.length, 0);
    await patch('open');
    await patch('archived');
    assert.equal((await listMobileInbox({ userId: readerId, workspace, todoMode: 'lifecycle', filter: 'todos' })).items.length, 0);
    await patch('open');
    assert.deepEqual(await readRows(), priorReads);
    for (const action of ['mark_read', 'mark_unread']) {
      const response = await bulk.POST(request('/api/todos/bulk', 'POST', { items: [{ id: teamId, expectedUpdatedAt: (await getTodo(ownerId, teamId))!.updatedAt.toISOString() }], action: { type: action } }));
      assert.equal(response?.status, 400);
    }
    await patch('done');
    const reopened = await bulk.POST(request('/api/todos/bulk', 'POST', { items: [{ id: teamId, expectedUpdatedAt: (await getTodo(ownerId, teamId))!.updatedAt.toISOString() }], action: { type: 'reopen' } }));
    assert.equal(reopened?.status, 200);
    assert.deepEqual(await readRows(), priorReads, 'Bulk reopen never adds compatibility read state in lifecycle mode');
    const createPayload = { title: 'Create lifecycle Todo', scopeKind: 'user' };
    const created = await webList.POST(request('/api/todos', 'POST', createPayload));
    assert.equal(created?.status, 201);
    const createdTodo = (await created!.json()).data;
    noReadMetadata(createdTodo);
    assert.deepEqual(await readRows(), priorReads, 'Lifecycle creation does not mark the task read');
    const mobileCreated = await mobileList.POST(request('/api/mobile/v1/todos', 'POST', { title: 'Mobile lifecycle task' }));
    assert.equal(mobileCreated?.status, 201);
    noReadMetadata((await mobileCreated!.json()).todo);
    for (const filter of ['read', 'unread']) {
      assert.equal((await webList.GET(request(`/api/todos?readState=${filter}`)))?.status, 400);
      assert.equal((await mobileList.GET(request(`/api/mobile/v1/todos?readState=${filter}`)))?.status, 400);
    }
    const webListed = await webList.GET(request(`/api/todos?scope=workspace&workspaceId=${workspaceId}`));
    assert.equal(webListed?.status, 200);
    (await webListed!.json()).data.forEach(noReadMetadata);
    const mobileListed = await mobileList.GET(request('/api/mobile/v1/todos'));
    assert.equal(mobileListed?.status, 200);
    (await mobileListed!.json()).todos.forEach(noReadMetadata);
    for (const failing of [false, true]) {
      followUpFails = failing;
      const response = await followUp.POST(request(`/api/mobile/v1/todos/${teamId}/follow-up`, 'POST', { comment: 'Completed' }), mobileContext);
      assert.equal(response?.status, failing ? 500 : 200);
      noReadMetadata((await response!.json()).data.todo);
      assert.deepEqual(await readRows(), priorReads, 'Follow-up does not add a read state');
      await patch('open');
    }
    // Total counts must cover >200 tasks while the bell preview stays at six.
    const batch = Array.from({ length: 211 }, (_, index) => ({
      id: randomUUID(), userId: ownerId, createdByUserId: ownerId, assigneeUserId: readerId, organizationId, workspaceId, workspaceType: 'team', scopeKind: 'workspace', title: `Count task ${index}`, createdAt: now, updatedAt: now,
      ...(index === 210 ? { priority: 'low', dueAt: new Date(now.getTime() - 60_000) } : {}),
    }));
    await db.insert(todoItems).values(batch);
    const attention = await listLifecycleTodoAttention({ userId: readerId, workspaceIds: [workspaceId], includeUserScope: false, now });
    assert.equal(attention.total, 212);
    assert.equal(attention.todos.length, 6);
    assert.equal(attention.todos[0]?.id, batch[210]!.id, 'Overdue low priority wins even beyond the former200 cap');
    const notification = await readNotificationAttention({ userId: readerId, workspaces: [workspace], now, todoMode: 'lifecycle' });
    assert.equal(notification.counts.todos, 212);
    const fullInbox = await listMobileInbox({ userId: readerId, workspace, todoMode: 'lifecycle', filter: 'todos', limit: 1 });
    assert.equal(fullInbox.counts.todos, 213, 'Full Inbox count includes all visible open tasks, independent of preview size');
    const fullAggregate = await listMobileAggregateInbox({ userId: readerId, workspaces: [workspace], todoMode: 'lifecycle', filter: 'todos', limit: 1 });
    assert.equal(fullAggregate.counts.todos, 213);
    const routeInbox = await mobileInbox.GET(request('/api/mobile/v1/inbox?filter=todos&limit=1'));
    assert.equal(routeInbox.status, 200);
    const routePage = await routeInbox.json();
    assert.equal(routePage.counts.todos, routePage.categories.todos.badge);
    assert.equal(routePage.counts.todos, 213);
    assert.equal(notification.sections.todoAttention.length, 6);
    assert.ok(notification.sections.todoAttention.every(item => !item.unread));
    // Old cursors continue in legacy mode, but cannot cross the lifecycle contract boundary.
    for (const mode of ['legacy', 'lifecycle'] as const) {
      const first = await listMobileTodos({ userId: ownerId, workspace, todoMode: mode, limit: 1 });
      assert.ok(first.nextCursor);
      assert.equal((await listMobileTodos({ userId: ownerId, workspace, todoMode: mode, limit: 1, cursor: first.nextCursor })).todos.length, 1);
      await assert.rejects(() => listMobileTodos({ userId: ownerId, workspace, todoMode: mode === 'legacy' ? 'lifecycle' : 'legacy', cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
      const page = await listMobileInbox({ userId: ownerId, workspace, todoMode: mode, filter: 'todos', limit: 1 });
      assert.ok(page.nextCursor);
      assert.equal((await listMobileInbox({ userId: ownerId, workspace, todoMode: mode, filter: 'todos', limit: 1, cursor: page.nextCursor })).items.length, 1);
      await assert.rejects(() => listMobileInbox({ userId: ownerId, workspace, todoMode: mode === 'legacy' ? 'lifecycle' : 'legacy', filter: 'todos', cursor: page.nextCursor }), { code: 'INVALID_CURSOR' });
      const aggregate = await listMobileAggregateInbox({ userId: ownerId, workspaces: [workspace], todoMode: mode, filter: 'todos', limit: 1 });
      assert.ok(aggregate.nextCursor);
      assert.equal((await listMobileAggregateInbox({ userId: ownerId, workspaces: [workspace], todoMode: mode, filter: 'todos', limit: 1, cursor: aggregate.nextCursor })).items.length, 1);
      await assert.rejects(() => listMobileAggregateInbox({ userId: ownerId, workspaces: [workspace], todoMode: mode === 'legacy' ? 'lifecycle' : 'legacy', filter: 'todos', cursor: aggregate.nextCursor }), { code: 'INVALID_CURSOR' });
    }
    // User-scoped personal tasks appear once, only through the included default source.
    const personalDefaultId = 'lifecycle-personal-default';
    const personalOtherId = 'lifecycle-personal-other';
    await db.insert(canvasWorkspaces).values([personalDefaultId, personalOtherId].map(id => ({
      id, organizationId, type: 'personal', ownerUserId: ownerId, rootRelativePath: `users/${ownerId}/${id}`, displayName: id, status: 'active', createdAt: now, updatedAt: now,
    })));
    await db.insert(todoItems).values({ id: randomUUID(), userId: ownerId, createdByUserId: ownerId, workspaceId: personalOtherId, workspaceType: 'personal', scopeKind: 'workspace', title: 'Other personal task', createdAt: now, updatedAt: now });
    const personalDefault = { ...workspace, workspaceId: personalDefaultId, workspaceType: 'personal' as const, ownerUserId: ownerId, isDefault: true };
    const personalOther = { ...personalDefault, workspaceId: personalOtherId, isDefault: false };
    const { countMobileOpenTodos } = await import('../app/lib/mobile/todo-counts');
    const personalAll = await listMobileAggregateInbox({ userId: ownerId, workspaces: [personalDefault, personalOther], todoMode: 'lifecycle', filter: 'todos' });
    assert.equal(personalAll.counts.todos, 2);
    assert.equal(personalAll.items.length, 2);
    assert.equal(await countMobileOpenTodos({ userId: ownerId, workspaces: [personalDefault, personalOther], todoMode: 'lifecycle' }), 2);
    assert.equal(await countMobileOpenTodos({ userId: ownerId, workspaces: [personalDefault, personalOther] }), 3, 'Default legacy count remains compatible');
    const personalExcluded = await listMobileAggregateInbox({ userId: ownerId, workspaces: [personalOther], todoMode: 'lifecycle', filter: 'todos' });
    assert.equal(personalExcluded.counts.todos, 1);
    assert.equal(personalExcluded.items.length, 1);
    assert.equal((await listLifecycleTodoAttention({ userId: ownerId, workspaceIds: [personalOtherId], includeUserScope: false, now })).total, 1);
    const scopedSummary = await readNotificationAttention({ userId: ownerId, workspaces: [personalOther], now, todoMode: 'lifecycle' });
    assert.equal(scopedSummary.counts.todos, 1, 'Excluded default personal source cannot leak user-scoped tasks into lifecycle summary');
    currentUserId = outsiderId;
    assert.equal((await web.GET(request(`/api/todos/${teamId}`), context))?.status, 404);
    assert.equal((await mobile.GET(request(`/api/mobile/v1/todos/${teamId}`), mobileContext))?.status, 404);
    currentUserId = null;
    assert.equal((await web.GET(request(`/api/todos/${teamId}`), context))?.status, 401);
    console.log('Todo lifecycle APIs passed: independent opening/completion, reader permissions, DTOs/legacy actions, Inbox/aggregate/cursors, follow-ups, full counts and attention ranking.');
  } finally {
    loader._load = originalLoad;
    await appPool?.end();
    if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
