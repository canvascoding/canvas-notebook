import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';

// Reuses the managed PostgreSQL server. Every fixture lives in this disposable database.
// Run: node --env-file=<managed notebook-host-dev.env> --import tsx --conditions react-server scripts/todo-detail-api-test.ts
async function main() {
  assert.ok(process.env.DATABASE_URL, 'Provide the managed PostgreSQL environment.');
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const databaseName = `canvas_todo_detail_test_${randomUUID().replaceAll('-', '')}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-todo-detail-api-'));
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  let databaseCreated = false;
  let appPool: Pool | null = null;
  const loader = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    process.env.DATABASE_URL = url.toString();
    process.env.DATA = dataDir;
    process.env.CANVAS_DATA_ROOT = dataDir;
    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.CANVAS_POSTGRES_MODE = 'external';
    process.env.CANVAS_DISABLE_TODO_EMAIL_NOTIFICATIONS = 'true';
    process.env.CANVAS_DISABLE_TODO_PUSH_NOTIFICATIONS = 'true';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const { db, getPostgresRuntimeQueryable } = await import('../app/lib/db');
    appPool = getPostgresRuntimeQueryable();
    assert.ok(appPool);
    await runPostgresMigrations(appPool);
    const email = spawnSync(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', 'scripts/todo-email-notification-test.ts'], {
      env: { ...process.env }, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(email.status, 0, email.stdout + email.stderr);
    console.log(email.stdout.trim());

    const ownerId = 'detail-api-owner';
    const readerId = 'detail-api-reader';
    const outsiderId = 'detail-api-outsider';
    const ownerImage = '/api/account/profile/avatar?v=1';
    const organizationId = 'detail-api-org';
    const workspaceId = 'detail-api-team';
    let currentUserId: string | null = ownerId;
    // Mock authentication only; route validation, authorization, workspace policy and storage remain real.
    loader._load = (request, parent, isMain) => {
      if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => currentUserId ? ({
        user: { id: currentUserId, name: currentUserId, email: `${currentUserId}@example.test`, role: null },
        session: { id: 'detail-api-session', userId: currentUserId },
      }) : null } } };
      return originalLoad(request, parent, isMain);
    };
    const { user, canvasOrganizationSettings, canvasWorkspaces, canvasWorkspaceMembers, organizationUserPermissions, todoItems } = await import('../app/lib/db/schema');
    const now = new Date('2026-09-30T10:00:00.000Z');
    await db.insert(user).values([ownerId, readerId, outsiderId].map(id => ({
      id, name: id, email: `${id}@example.test`, image: null,
      emailVerified: true, createdAt: now, updatedAt: now,
    })));
    const sharp = (await import('sharp')).default;
    const { normalizeUserProfileUpload } = await import('../app/lib/user-profile/upload');
    const { saveUserProfileImage, selectUserProfileInitials } = await import('../app/lib/user-profile/service');
    const makeAvatar = async (background: string) => normalizeUserProfileUpload(await sharp({
      create: { width: 32, height: 32, channels: 3, background },
    }).png().toBuffer());
    const [ownerAvatar, readerAvatar, outsiderAvatar] = await Promise.all([
      makeAvatar('#ff0000'), makeAvatar('#0000ff'), makeAvatar('#00ff00'),
    ]);
    await saveUserProfileImage({ userId: ownerId, buffer: ownerAvatar });
    await saveUserProfileImage({ userId: readerId, buffer: readerAvatar });
    await saveUserProfileImage({ userId: outsiderId, buffer: outsiderAvatar });
    await db.insert(canvasOrganizationSettings).values({
      organizationId, ownerUserId: ownerId, deploymentMode: 'team', teamFeaturesEnabled: true, createdAt: now, updatedAt: now,
    });
    await db.insert(organizationUserPermissions).values([
      { organizationId, userId: ownerId, role: 'owner', canWriteTeamWorkspace: true, createdAt: now, updatedAt: now },
      { organizationId, userId: readerId, role: 'member', canWriteTeamWorkspace: false, createdAt: now, updatedAt: now },
    ]);
    await db.insert(canvasWorkspaces).values({
      id: workspaceId, organizationId, type: 'team', rootRelativePath: `organizations/${organizationId}/team`,
      displayName: 'API test team', status: 'active', createdAt: now, updatedAt: now,
    });
    await db.insert(canvasWorkspaceMembers).values([
      { organizationId, workspaceId, userId: ownerId, role: 'owner', status: 'active', canRead: true,
        canWrite: true, canManage: true, createdAt: now, updatedAt: now },
      { organizationId, workspaceId, userId: readerId, role: 'member', status: 'active', canRead: true,
        canWrite: false, canManage: false, createdAt: now, updatedAt: now },
    ]);
    const personalId = randomUUID();
    const teamId = randomUUID();
    const avatarHref = (id: string, target: string) => `/api/todos/${id}/avatar?${new URLSearchParams({ userId: target, v: '1' })}`;
    await db.insert(todoItems).values([
      { id: personalId, userId: ownerId, createdByUserId: ownerId, title: 'Personal test', createdAt: now, updatedAt: now },
      { id: teamId, userId: ownerId, createdByUserId: ownerId, assigneeUserId: readerId, organizationId, workspaceId, workspaceType: 'team',
        scopeKind: 'workspace', title: 'Private team title', createdAt: now, updatedAt: now },
    ]);
    const route = await import('../app/api/todos/[id]/route');
    const context = (id: string) => ({ params: Promise.resolve({ id }) });
    const request = (id: string, method = 'GET', payload?: unknown) => new NextRequest(`http://localhost/api/todos/${id}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const get = async (id: string) => {
      const response = await route.GET(request(id), context(id));
      assert.ok(response);
      return { status: response.status, body: await response.json() };
    };
    const patch = async (id: string, payload: unknown) => {
      const response = await route.PATCH(request(id, 'PATCH', payload), context(id));
      assert.ok(response);
      return { status: response.status, body: await response.json() };
    };

    const personal = await get(personalId);
    assert.equal(personal.status, 200);
    assert.equal(personal.body.data.canWrite, true);
    assert.equal(personal.body.data.createdBy.image, avatarHref(personalId, ownerId), 'Creator avatar is scoped to the Todo and actual user');
    const saved = await patch(personalId, { expectedUpdatedAt: personal.body.data.updatedAt, title: 'Saved current title' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.canWrite, true);
    const conflict = await patch(personalId, { expectedUpdatedAt: personal.body.data.updatedAt, title: 'Stale overwrite', status: 'archived' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'TODO_UPDATE_CONFLICT');
    assert.equal((await get(personalId)).body.data.title, 'Saved current title');
    assert.equal((await get(personalId)).body.data.status, 'open');
    for (const expectedUpdatedAt of ['not-a-date', null, '', {}]) {
      const invalid = await patch(personalId, { expectedUpdatedAt, title: 'Invalid overwrite' });
      assert.ok([400, 409].includes(invalid.status), `Invalid expectation must fail: ${JSON.stringify(expectedUpdatedAt)}`);
      assert.equal((await get(personalId)).body.data.title, 'Saved current title');
    }
    const team = await get(teamId);
    assert.equal(team.body.data.canWrite, true);
    assert.equal(team.body.data.createdBy.image, avatarHref(teamId, ownerId));
    assert.equal(team.body.data.assignee.image, avatarHref(teamId, readerId), 'Assignee avatar is scoped independently from the viewer');
    const { todoUserAvatarHref } = await import('../app/lib/todos/avatar-href');
    assert.equal(todoUserAvatarHref(teamId, readerId, 'https://example.test/avatar.webp'), 'https://example.test/avatar.webp');
    const avatarRoute = await import('../app/api/todos/[id]/avatar/route');
    const getAvatar = (todoId: string, targetUserId: string, etag?: string) => avatarRoute.GET(new NextRequest(
      `http://localhost${avatarHref(todoId, targetUserId)}`, { headers: etag ? { 'if-none-match': etag } : {} },
    ), context(todoId));
    const assignedAvatar = await getAvatar(teamId, readerId);
    assert.equal(assignedAvatar?.status, 200);
    assert.equal(assignedAvatar!.headers.get('content-type'), 'image/webp');
    assert.equal(assignedAvatar!.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
    assert.equal(assignedAvatar!.headers.get('vary'), 'Cookie');
    assert.deepEqual(Buffer.from(await assignedAvatar!.arrayBuffer()), readerAvatar, 'Owner sees the assigned reader image, not their own');
    const unrelatedAvatar = await getAvatar(teamId, outsiderId);
    assert.equal(unrelatedAvatar?.status, 404, 'Unrelated users remain unavailable even when they have a saved image');
    const assigneesRoute = await import('../app/api/todos/assignees/route');
    const candidatesResponse = await assigneesRoute.GET(new NextRequest(`http://localhost/api/todos/assignees?workspaceId=${workspaceId}`));
    assert.equal(candidatesResponse?.status, 200);
    const candidates = await candidatesResponse!.json();
    assert.equal(candidates.data.find((candidate: { id: string }) => candidate.id === ownerId)?.image, ownerImage);
    assert.equal(candidates.data.find((candidate: { id: string }) => candidate.id === readerId)?.image, null,
      'Unscoped candidate lists do not display the viewer image as a different person');
    currentUserId = readerId;
    const creatorAvatar = await getAvatar(teamId, ownerId);
    assert.equal(creatorAvatar?.status, 200);
    const creatorEtag = creatorAvatar!.headers.get('etag')!;
    assert.deepEqual(Buffer.from(await creatorAvatar!.arrayBuffer()), ownerAvatar, 'Reader sees the creator image, not their own');
    assert.equal((await getAvatar(teamId, ownerId, creatorEtag))?.status, 304);
    const reader = await get(teamId);
    assert.equal(reader.status, 200);
    assert.equal(reader.body.data.canWrite, false);
    const seen = await patch(teamId, { markSeen: true });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.canWrite, false);
    assert.equal(seen.body.data.readState, 'read');
    assert.equal(seen.body.data.updatedAt, reader.body.data.updatedAt, 'Reading does not invalidate shared editor revisions');
    for (const payload of [{ title: 'Unauthorized write' }, { status: 'archived' }]) {
      assert.equal((await patch(teamId, { expectedUpdatedAt: seen.body.data.updatedAt, ...payload })).status, 403);
    }
    const deniedArchive = await route.DELETE(request(teamId, 'DELETE'), context(teamId));
    assert.equal(deniedArchive?.status, 403);
    assert.equal((await get(teamId)).body.data.status, 'open');
    await selectUserProfileInitials(readerId);
    const missingAvatar = await getAvatar(teamId, readerId);
    assert.equal(missingAvatar?.status, 404, 'Selecting initials removes the stored image from avatar access');
    assert.deepEqual(await missingAvatar!.json(), await unrelatedAvatar!.json());
    currentUserId = outsiderId;
    const forbiddenAvatar = await getAvatar(teamId, ownerId, creatorEtag);
    assert.equal(forbiddenAvatar?.status, 404, 'A cached ETag never bypasses revoked or absent Todo access');
    const absentAvatar = await getAvatar(randomUUID(), ownerId);
    assert.equal(absentAvatar?.status, 404);
    assert.deepEqual(await forbiddenAvatar!.json(), await absentAvatar!.json());
    const unavailable = await get(teamId);
    assert.equal(unavailable.status, 404);
    assert.equal(unavailable.body.data, undefined);
    assert.ok(!JSON.stringify(unavailable.body).includes('Private team title'));
    assert.equal((await patch(teamId, { title: 'Outsider overwrite' })).status, 404);
    const missing = await get(randomUUID());
    assert.deepEqual(unavailable, missing, 'Inaccessible and absent Todos disclose the same response');
    currentUserId = null;
    assert.equal((await getAvatar(teamId, ownerId))?.status, 401);
    console.log('Todo detail API: correct scoped avatar bytes and access, canWrite, revision conflicts, read-only actions and inaccessible targets passed.');

  } finally {
    loader._load = originalLoad;
    await appPool?.end();
    if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
