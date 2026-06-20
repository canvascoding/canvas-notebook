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
    canvasWorkspaces,
    organizationUserPermissions,
    user,
  } = await import('../app/lib/db/schema');
  const {
    DEFAULT_TODO_CATEGORY_NAME,
    getDefaultTodoCategoryKey,
    TodoStoreError,
    archiveTodo,
    createTodo,
    ensureTodoCategories,
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
  ]);

  await db.insert(canvasOrganizationSettings).values({
    organizationId: 'org-test',
    ownerUserId: 'todo-user',
    deploymentMode: 'team',
    teamFeaturesEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(canvasWorkspaces).values({
    id: 'team-workspace',
    organizationId: 'org-test',
    type: 'team',
    ownerUserId: null,
    rootRelativePath: 'organizations/org-test/team',
    displayName: 'Team Workspace',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
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
  assert.equal(created.workspaceId, null);
  assert.equal(created.fileLinks.length, 1);
  assert.equal(created.fileLinks[0].workspacePath, 'docs/brief.md');
  assert.equal(created.fileLinks[0].workspaceId, null);

  const todos = await listTodos('todo-user');
  assert.equal(todos.length, 1);
  assert.equal(todos[0].id, created.id);

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
  assert.equal(teamTodo.organizationId, 'org-test');
  assert.equal(teamTodo.workspaceId, 'team-workspace');
  assert.equal(teamTodo.createdBy?.id, 'todo-user');
  assert.equal(teamTodo.assignee?.id, 'other-user');
  assert.equal(teamTodo.fileLinks[0].workspaceType, 'team');
  assert.equal(teamTodo.fileLinks[0].workspaceId, 'team-workspace');

  const memberTeamTodos = await listTodos('other-user', {
    status: 'all',
    workspaceType: 'team',
    organizationId: 'org-test',
    workspaceId: 'team-workspace',
  });
  assert.deepEqual(memberTeamTodos.map((todo) => todo.id), [teamTodo.id]);

  const personalStillPrivate = await listTodos('other-user', {
    status: 'all',
    workspaceType: 'personal',
  });
  assert.equal(personalStillPrivate.length, 0);

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
