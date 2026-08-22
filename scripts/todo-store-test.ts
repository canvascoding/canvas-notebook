import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-store-'));
process.env.DATA = dataDir;
process.env.CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS = 'true';

async function main() {
  const workspaceDir = path.join(dataDir, 'workspace');
  mkdirSync(path.join(workspaceDir, 'docs'), { recursive: true });
  writeFileSync(path.join(workspaceDir, 'docs', 'brief.md'), '# Brief');

  const { db } = await import('../app/lib/db');
  const {
    canvasOrganizationSettings,
    canvasProjectMembers,
    canvasProjects,
    canvasWorkspaces,
    organizationUserPermissions,
    todoReadStates,
    user,
  } = await import('../app/lib/db/schema');
  const {
    clearTodoReadState,
    getTodoReadState,
    listTodoReadStates,
    setTodoReadState,
  } = await import('../app/lib/todos/read-state-store');
  const { setTodoReadStateForUser } = await import('../app/lib/todos/read-state-actions');
  const {
    DEFAULT_TODO_CATEGORY_NAME,
    getDefaultTodoCategoryKey,
    TodoStoreError,
    archiveTodo,
    createTodo,
    ensureTodoCategories,
    getTodo,
    listTodos,
    markTodoSeen,
    normalizeWorkspaceTodoPath,
    restoreTodo,
    updateTodo,
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
    {
      id: 'external-user',
      name: 'External User',
      email: 'external-todo-user@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'readonly-user',
      name: 'Readonly User',
      email: 'readonly-todo-user@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(canvasOrganizationSettings).values({
    organizationId: 'org-test',
    ownerUserId: 'todo-user',
    deploymentMode: 'team',
    teamFeaturesEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(canvasProjects).values({
    id: 'project-test',
    organizationId: 'org-test',
    customerId: null,
    name: 'Project Workspace',
    slug: 'project-workspace',
    status: 'active',
    description: null,
    metadataJson: null,
    createdByUserId: 'todo-user',
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(canvasWorkspaces).values([
    {
      id: 'personal-workspace',
      organizationId: 'org-test',
      type: 'personal',
      ownerUserId: 'todo-user',
      rootRelativePath: 'users/todo-user/files',
      displayName: 'Todo User Workspace',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'team-workspace',
      organizationId: 'org-test',
      type: 'team',
      ownerUserId: null,
      rootRelativePath: 'organizations/org-test/team',
      displayName: 'Team Workspace',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'project-workspace',
      organizationId: 'org-test',
      type: 'project',
      ownerUserId: null,
      projectId: 'project-test',
      rootRelativePath: 'workspaces/project/project-test/files',
      displayName: 'Project Workspace',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(organizationUserPermissions).values([
    {
      organizationId: 'org-test',
      userId: 'todo-user',
      role: 'owner',
      canWriteTeamWorkspace: true,
      canCreatePublicLinks: true,
      canCreateTeamAutomations: true,
      canSharePluginsAndSkills: true,
      canExport: true,
      canDeleteTeamFiles: true,
      canDeleteStudioAssets: true,
      canManageBackups: true,
      canMigrateDatabase: true,
      canEnableKnowledge: true,
      canRecoverWorkspaces: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      organizationId: 'org-test',
      userId: 'other-user',
      role: 'member',
      canWriteTeamWorkspace: true,
      canCreatePublicLinks: true,
      canCreateTeamAutomations: false,
      canSharePluginsAndSkills: false,
      canExport: false,
      canDeleteTeamFiles: true,
      canDeleteStudioAssets: true,
      canManageBackups: false,
      canMigrateDatabase: false,
      canEnableKnowledge: false,
      canRecoverWorkspaces: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      organizationId: 'org-test',
      userId: 'external-user',
      role: 'external',
      canWriteTeamWorkspace: false,
      canCreatePublicLinks: false,
      canCreateTeamAutomations: false,
      canSharePluginsAndSkills: false,
      canExport: false,
      canDeleteTeamFiles: false,
      canDeleteStudioAssets: false,
      canManageBackups: false,
      canMigrateDatabase: false,
      canEnableKnowledge: false,
      canRecoverWorkspaces: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      organizationId: 'org-test',
      userId: 'readonly-user',
      role: 'member',
      canWriteTeamWorkspace: false,
      canCreatePublicLinks: true,
      canCreateTeamAutomations: false,
      canSharePluginsAndSkills: false,
      canExport: false,
      canDeleteTeamFiles: false,
      canDeleteStudioAssets: true,
      canManageBackups: false,
      canMigrateDatabase: false,
      canEnableKnowledge: false,
      canRecoverWorkspaces: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(canvasProjectMembers).values([
    {
      organizationId: 'org-test',
      projectId: 'project-test',
      userId: 'todo-user',
      role: 'owner',
      status: 'active',
      canRead: true,
      canWrite: true,
      canManage: true,
      invitedByUserId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      organizationId: 'org-test',
      projectId: 'project-test',
      userId: 'other-user',
      role: 'member',
      status: 'active',
      canRead: true,
      canWrite: true,
      canManage: true,
      invitedByUserId: 'todo-user',
      createdAt: now,
      updatedAt: now,
    },
    {
      organizationId: 'org-test',
      projectId: 'project-test',
      userId: 'readonly-user',
      role: 'member',
      status: 'active',
      canRead: true,
      canWrite: false,
      canManage: false,
      invitedByUserId: 'todo-user',
      createdAt: now,
      updatedAt: now,
    },
    {
      organizationId: 'org-test',
      projectId: 'project-test',
      userId: 'external-user',
      role: 'external',
      status: 'active',
      canRead: true,
      canWrite: false,
      canManage: false,
      invitedByUserId: 'todo-user',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const categories = await ensureTodoCategories('todo-user');
  assert.equal(categories.length, 4);
  assert.equal(categories[0].name, DEFAULT_TODO_CATEGORY_NAME);

  const created = await createTodo('todo-user', {
    title: '  Review the brief  ',
    description: 'Human review required',
    categoryName: 'Prüfen',
    priority: 'high',
    sourceType: 'agent',
    sourceAgentId: 'canvas-agent',
    sourceSessionId: 'sess-test',
    workspaceId: 'team-workspace',
    fileLinks: [
      { workspacePath: './docs/brief.md', label: 'Brief' },
      'docs/brief.md',
    ],
  });

  assert.equal(created.title, 'Review the brief');
  assert.equal(created.priority, 'high');
  assert.equal(created.sourceType, 'agent');
  assert.equal(created.category?.name, 'Review');
  assert.equal(getDefaultTodoCategoryKey(created.category), 'review');
  assert.equal(created.workspaceType, 'personal');
  assert.equal(created.scopeKind, 'user');
  assert.equal(created.workspaceId, null);
  assert.equal(created.workspace, null);
  assert.equal(created.fileLinks.length, 1);
  assert.equal(created.fileLinks[0].workspacePath, 'docs/brief.md');
  assert.equal(created.fileLinks[0].workspaceId, null);

  const firstReadAt = new Date('2026-05-31T12:01:00.000Z');
  const replacementReadAt = new Date('2026-05-31T12:02:00.000Z');
  await setTodoReadState('todo-user', created.id, firstReadAt);
  assert.equal((await getTodoReadState('todo-user', created.id))?.toISOString(), firstReadAt.toISOString());
  await setTodoReadState('todo-user', created.id, replacementReadAt);
  assert.equal((await getTodoReadState('todo-user', created.id))?.toISOString(), replacementReadAt.toISOString());
  assert.equal((await listTodoReadStates('other-user', [created.id])).size, 0);
  await clearTodoReadState('todo-user', created.id);
  assert.equal(await getTodoReadState('todo-user', created.id), null);
  assert.equal((await db.select().from(todoReadStates)).length, 0);

  const todos = await listTodos('todo-user');
  assert.equal(todos.length, 1);
  assert.equal(todos[0].id, created.id);

  const personalWorkspaceTodo = await createTodo('todo-user', {
    title: 'Workspace notes',
    scopeKind: 'workspace',
    workspaceType: 'personal',
    workspaceId: 'personal-workspace',
    assigneeUserId: 'todo-user',
  });
  assert.equal(personalWorkspaceTodo.scopeKind, 'workspace');
  assert.equal(personalWorkspaceTodo.workspaceId, 'personal-workspace');
  assert.equal(personalWorkspaceTodo.workspace?.name, 'Todo User Workspace');

  const currentPersonalWorkspaceTodos = await listTodos('todo-user', {
    status: 'all',
    scopeKind: 'workspace',
    workspaceType: 'personal',
    workspaceId: 'personal-workspace',
  });
  assert.deepEqual(currentPersonalWorkspaceTodos.map((todo) => todo.id), [personalWorkspaceTodo.id]);

  const combinedPersonalWorkspaceTodos = await listTodos('todo-user', {
    status: 'all',
    scopeKind: 'all',
    workspaceType: 'personal',
    workspaceId: 'personal-workspace',
  });
  assert.equal(combinedPersonalWorkspaceTodos.some((todo) => todo.id === created.id), true);
  assert.equal(combinedPersonalWorkspaceTodos.some((todo) => todo.id === personalWorkspaceTodo.id), true);

  const otherUserTodos = await listTodos('other-user', { status: 'all' });
  assert.equal(otherUserTodos.length, 0);

  const teamTodo = await createTodo('todo-user', {
    title: 'Team handoff',
    description: 'Shared org task',
    workspaceType: 'team',
    organizationId: 'org-test',
    workspaceId: 'team-workspace',
    assigneeUserId: 'other-user',
    fileLinks: ['docs/brief.md'],
  });
  assert.equal(teamTodo.workspaceType, 'team');
  assert.equal(teamTodo.scopeKind, 'workspace');
  assert.equal(teamTodo.organizationId, 'org-test');
  assert.equal(teamTodo.workspaceId, 'team-workspace');
  assert.equal(teamTodo.createdBy?.id, 'todo-user');
  assert.equal(teamTodo.assignee?.id, 'other-user');
  assert.equal(teamTodo.fileLinks[0].workspaceType, 'team');
  assert.equal(teamTodo.fileLinks[0].workspaceId, 'team-workspace');

  const sharedTodoUpdatedAt = teamTodo.updatedAt.toISOString();
  const readonlyRead = await setTodoReadStateForUser({
    userId: 'readonly-user',
    todoId: teamTodo.id,
    read: true,
    readAt: new Date('2026-05-31T12:03:00.000Z'),
  });
  assert.equal(readonlyRead.todo.readState, 'read');
  assert.equal(readonlyRead.todo.readAt?.toISOString(), '2026-05-31T12:03:00.000Z');
  assert.equal((await getTodoReadState('todo-user', teamTodo.id)), null);
  assert.equal((await getTodoReadState('readonly-user', teamTodo.id))?.toISOString(), '2026-05-31T12:03:00.000Z');
  const readonlyUnread = await setTodoReadStateForUser({ userId: 'readonly-user', todoId: teamTodo.id, read: false });
  assert.equal(readonlyUnread.todo.readState, 'unread');
  assert.equal((await getTodo('todo-user', teamTodo.id))?.updatedAt.toISOString(), sharedTodoUpdatedAt);

  const memberTeamTodos = await listTodos('other-user', {
    status: 'all',
    workspaceType: 'team',
    organizationId: 'org-test',
    workspaceId: 'team-workspace',
  });
  assert.deepEqual(memberTeamTodos.map((todo) => todo.id), [teamTodo.id]);

  const readonlyTeamTodos = await listTodos('readonly-user', {
    status: 'all',
    workspaceType: 'team',
    organizationId: 'org-test',
    workspaceId: 'team-workspace',
  });
  assert.deepEqual(readonlyTeamTodos.map((todo) => todo.id), [teamTodo.id]);

  const projectTodo = await createTodo('other-user', {
    title: 'Project handoff',
    description: 'Project scoped task',
    workspaceType: 'project',
    organizationId: 'org-test',
    workspaceId: 'project-workspace',
    assigneeUserId: 'external-user',
    fileLinks: ['docs/brief.md'],
  });
  assert.equal(projectTodo.workspaceType, 'project');
  assert.equal(projectTodo.scopeKind, 'workspace');
  assert.equal(projectTodo.organizationId, 'org-test');
  assert.equal(projectTodo.projectId, 'project-test');
  assert.equal(projectTodo.workspaceId, 'project-workspace');
  assert.equal(projectTodo.assignee?.id, 'external-user');
  assert.equal(projectTodo.fileLinks[0].workspaceType, 'project');
  assert.equal(projectTodo.fileLinks[0].projectId, 'project-test');
  assert.equal(projectTodo.fileLinks[0].workspaceId, 'project-workspace');

  const ownerProjectTodos = await listTodos('todo-user', {
    status: 'all',
    workspaceType: 'project',
    organizationId: 'org-test',
    workspaceId: 'project-workspace',
  });
  assert.deepEqual(ownerProjectTodos.map((todo) => todo.id), [projectTodo.id]);

  const readonlyProjectTodos = await listTodos('readonly-user', {
    status: 'all',
    workspaceType: 'project',
    organizationId: 'org-test',
    workspaceId: 'project-workspace',
  });
  assert.deepEqual(readonlyProjectTodos.map((todo) => todo.id), [projectTodo.id]);

  const externalProjectTodos = await listTodos('external-user', {
    status: 'all',
    workspaceType: 'project',
    organizationId: 'org-test',
    workspaceId: 'project-workspace',
  });
  assert.deepEqual(externalProjectTodos.map((todo) => todo.id), [projectTodo.id]);

  const explicitGlobalTodos = await listTodos('todo-user', {
    status: 'all',
    workspaceType: 'all',
    workspaceIds: ['personal-workspace', 'team-workspace', 'project-workspace'],
  });
  assert.equal(explicitGlobalTodos.some((todo) => todo.id === created.id), true);
  assert.equal(explicitGlobalTodos.some((todo) => todo.id === personalWorkspaceTodo.id), true);
  assert.equal(explicitGlobalTodos.some((todo) => todo.id === teamTodo.id), true);
  assert.equal(explicitGlobalTodos.some((todo) => todo.id === projectTodo.id), true);

  const lowPriorityTodo = await createTodo('todo-user', { title: 'Low priority ranking', priority: 'low' });
  const highPriorityTodo = await createTodo('todo-user', { title: 'High priority ranking', priority: 'high' });
  const rankedPersonalTodos = await listTodos('todo-user', { status: 'all' });
  assert.ok(rankedPersonalTodos.findIndex((todo) => todo.id === highPriorityTodo.id) < rankedPersonalTodos.findIndex((todo) => todo.id === lowPriorityTodo.id));
  assert.equal((await listTodos('todo-user', { status: 'all', priority: 'high' })).some((todo) => todo.id === highPriorityTodo.id), true);
  const firstRankedPage = await listTodos('todo-user', { status: 'all', limit: 1 });
  const firstRankedTodo = firstRankedPage[0]!;
  const nextRankedPage = await listTodos('todo-user', {
    status: 'all',
    limit: 20,
    beforeCursor: {
      status: firstRankedTodo.status,
      priority: firstRankedTodo.priority,
      dueAt: firstRankedTodo.dueAt,
      createdAt: firstRankedTodo.createdAt,
      id: firstRankedTodo.id,
    },
  });
  assert.equal(nextRankedPage.some((todo) => todo.id === firstRankedTodo.id), false);

  const readonlyAllTodos = await listTodos('readonly-user', {
    status: 'all',
    workspaceType: 'all',
    organizationId: 'org-test',
  });
  assert.equal(readonlyAllTodos.some((todo) => todo.id === teamTodo.id), true);
  assert.equal(readonlyAllTodos.some((todo) => todo.id === projectTodo.id), true);

  const personalStillPrivate = await listTodos('other-user', {
    status: 'all',
    workspaceType: 'personal',
  });
  assert.equal(personalStillPrivate.length, 0);

  await assert.rejects(
    () => createTodo('todo-user', {
      title: 'Invalid global team task',
      scopeKind: 'user',
      workspaceType: 'team',
      organizationId: 'org-test',
      workspaceId: 'team-workspace',
    }),
    (error) => error instanceof TodoStoreError && error.code === 'INVALID_INPUT',
  );

  await assert.rejects(
    () => createTodo('todo-user', {
      title: 'Invalid personal assignee',
      scopeKind: 'workspace',
      workspaceType: 'personal',
      workspaceId: 'personal-workspace',
      assigneeUserId: 'other-user',
    }),
    (error) => error instanceof TodoStoreError && error.code === 'ASSIGNEE_NOT_FOUND',
  );

  await assert.rejects(
    () => listTodos('external-user', {
      status: 'all',
      workspaceType: 'team',
      organizationId: 'org-test',
      workspaceId: 'team-workspace',
    }),
    (error) => error instanceof TodoStoreError && error.code === 'ORGANIZATION_ACCESS_DENIED',
  );

  await assert.rejects(
    () => listTodos('todo-user', {
      status: 'all',
      workspaceType: 'team',
      organizationId: 'org-test',
      workspaceId: 'missing-team-workspace',
    }),
    (error) => error instanceof TodoStoreError && error.code === 'INVALID_INPUT',
  );

  await assert.rejects(
    () => createTodo('readonly-user', {
      title: 'Read-only cannot create',
      workspaceType: 'team',
      organizationId: 'org-test',
      workspaceId: 'team-workspace',
    }),
    (error) => error instanceof TodoStoreError && error.code === 'ORGANIZATION_ACCESS_DENIED',
  );

  await assert.rejects(
    () => updateTodo('readonly-user', teamTodo.id, { status: 'done' }),
    (error) => error instanceof TodoStoreError && error.code === 'ORGANIZATION_ACCESS_DENIED',
  );

  await assert.rejects(
    () => createTodo('readonly-user', {
      title: 'Read-only cannot create project task',
      workspaceType: 'project',
      organizationId: 'org-test',
      workspaceId: 'project-workspace',
    }),
    (error) => error instanceof TodoStoreError && error.code === 'ORGANIZATION_ACCESS_DENIED',
  );

  await assert.rejects(
    () => updateTodo('readonly-user', projectTodo.id, { status: 'done' }),
    (error) => error instanceof TodoStoreError && error.code === 'ORGANIZATION_ACCESS_DENIED',
  );

  await assert.rejects(
    () => updateTodo('todo-user', teamTodo.id, { assigneeUserId: 'external-user' }),
    (error) => error instanceof TodoStoreError && error.code === 'ASSIGNEE_NOT_FOUND',
  );

  const seen = await markTodoSeen('todo-user', created.id, new Date('2026-05-31T12:05:00.000Z'));
  assert.equal(seen?.seenAt?.toISOString(), '2026-05-31T12:05:00.000Z');

  const completed = await updateTodo('todo-user', created.id, {
    status: 'done',
    completionComment: 'Erledigt, bitte weiterarbeiten.',
    followUpSentAt: new Date('2026-05-31T12:06:00.000Z'),
  });
  assert.equal(completed?.status, 'done');
  assert.equal(completed?.completionComment, 'Erledigt, bitte weiterarbeiten.');
  assert.equal(completed?.followUpSentAt?.toISOString(), '2026-05-31T12:06:00.000Z');

  const archived = await archiveTodo('todo-user', created.id);
  assert.equal(archived?.status, 'archived');
  assert.ok(archived?.archivedAt instanceof Date);
  assert.equal((await listTodos('todo-user')).some((todo) => todo.id === created.id), false);
  assert.equal((await listTodos('todo-user', { status: 'archived' })).length, 1);

  const restored = await restoreTodo('todo-user', created.id);
  assert.equal(restored?.status, 'open');
  assert.equal(restored?.archivedAt, null);

  await updateTodo('todo-user', created.id, { dueAt: new Date('2000-01-01T12:00:00.000Z') });
  assert.ok((await listTodos('todo-user', { due: 'overdue' })).some((todo) => todo.id === created.id));

  const todayDue = new Date();
  todayDue.setHours(12, 0, 0, 0);
  await updateTodo('todo-user', created.id, { dueAt: todayDue });
  assert.ok((await listTodos('todo-user', { due: 'today' })).some((todo) => todo.id === created.id));

  await updateTodo('todo-user', created.id, { dueAt: new Date('2999-01-01T12:00:00.000Z') });
  assert.ok((await listTodos('todo-user', { due: 'upcoming' })).some((todo) => todo.id === created.id));

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
