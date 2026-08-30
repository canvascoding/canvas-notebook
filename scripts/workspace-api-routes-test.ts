import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

type RouteSession = {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
  session: {
    id: string;
  };
};

type JsonObject = Record<string, unknown>;
type RouteRequestInit = Omit<RequestInit, 'headers' | 'signal'> & {
  headers?: HeadersInit;
};

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' },
) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

function installTeamRuntimeLicense() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = publicKeyFingerprint(publicKeyPem);
  process.env.CANVAS_LICENSE_CERT = signLicense(privateKey, {
    sub: process.env.CANVAS_INSTANCE_ID,
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'managed',
    status: 'active',
    deploymentMode: 'managed-team',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: { teamWorkspace: true, multiUser: true, vectorSearch: true },
    features: { teamWorkspace: true, multiUser: true, vectorSearch: true },
    quotas: { users: 25 },
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

async function insertUser(pool: Pool, userId: string, name: string, email: string, role = 'user') {
  const now = Date.now();
  await pool.query(`
    INSERT INTO "user" (
      id, name, email, email_verified, image, role, banned, ban_reason, ban_expires, created_at, updated_at
    ) VALUES ($1, $2, $3, 1, NULL, $4, NULL, NULL, NULL, $5, $6)
  `, [userId, name, email, role, now, now]);
}

function request(url: string, init: RouteRequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('origin')) {
    headers.set('origin', new URL(url).origin);
  }
  return new NextRequest(url, {
    ...init,
    headers,
  });
}

function jsonRequest(url: string, method: string, body: JsonObject) {
  return request(url, {
    method,
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return await response.json() as JsonObject;
}

function expectObject(value: unknown, label: string): JsonObject {
  assert.equal(typeof value, 'object', `${label} should be object`);
  assert.notEqual(value, null, `${label} should not be null`);
  return value as JsonObject;
}

function workspaceId(payload: JsonObject, key = 'workspace'): string {
  const workspace = expectObject(payload[key], key);
  assert.equal(typeof workspace.id, 'string');
  return workspace.id as string;
}

function workspaceByType(payload: JsonObject, type: string) {
  const workspaces = payload.workspaces;
  assert.ok(Array.isArray(workspaces), 'workspaces should be array');
  const workspace = workspaces.find((item) => expectObject(item, 'workspace').type === type);
  return expectObject(workspace, `${type} workspace`);
}

async function main() {
  assert.equal(
    process.env.CANVAS_WORKSPACE_API_TEST_CHILD,
    'true',
    'Run this integration suite through workspace-api-routes-postgres-runner.ts.',
  );
  const environmentKeys = [
    'DATA',
    'DATABASE_URL',
    'BASE_URL',
    'BETTER_AUTH_BASE_URL',
    'CANVAS_DATABASE_PROVIDER',
    'CANVAS_DATABASE_MIGRATIONS_COMPLETED',
    'CANVAS_DEPLOYMENT_MODE',
    'CANVAS_EXTERNAL_USERS_ENABLED',
    'CANVAS_INSTANCE_ID',
    'CANVAS_LICENSE_CERT',
    'CANVAS_LICENSE_PUBLIC_KEY',
    'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
    'CANVAS_POSTGRES_VECTOR_ENABLED',
    'CANVAS_TEAM_FEATURES_ENABLED',
    'CANVAS_VECTOR_PROVIDER',
  ] as const;
  const originalEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]] as const),
  );
  const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
  assert(configuredDatabaseUrl, 'Workspace API route tests require a local PostgreSQL DATABASE_URL.');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-api-routes-'));
  const dataRoot = path.join(tempRoot, 'data');
  let testPoolForCleanup: Pool | null = null;
  let closeRuntimeDatabase: (() => Promise<void>) | null = null;
  try {
    process.env.DATA = dataRoot;
    process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
    process.env.CANVAS_TEAM_FEATURES_ENABLED = 'true';
    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.CANVAS_INSTANCE_ID = 'self_workspace_api_routes_test';
    process.env.CANVAS_EXTERNAL_USERS_ENABLED = 'false';
    process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'false';
    process.env.CANVAS_VECTOR_PROVIDER = 'none';
    process.env.BASE_URL = 'http://localhost';
    process.env.BETTER_AUTH_BASE_URL = 'http://localhost';
    installTeamRuntimeLicense();
    await fs.mkdir(dataRoot, { recursive: true });

    const testPool = new Pool({ connectionString: configuredDatabaseUrl, max: 4 });
    testPoolForCleanup = testPool;
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(testPool);
    const { runMigrations } = await import('../app/lib/db/migrate');
    const collaborationSidecar = new Database(path.join(dataRoot, 'sqlite.db'));
    try {
      runMigrations(collaborationSidecar);
    } finally {
      collaborationSidecar.close();
    }
    process.env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true';
    await insertUser(testPool, 'owner-user', 'Owner User', 'owner@example.test', 'admin');
    await insertUser(testPool, 'member-user', 'Member User', 'member@example.test', 'user');

    const { requireTeamRuntimeLicense } = await import('../app/lib/license/entitlements');
    await requireTeamRuntimeLicense();

    const databaseModule = await import('../app/lib/db');
    closeRuntimeDatabase = databaseModule.closeDatabaseConnections;

  const { auth } = await import('../app/lib/auth');
  let currentSession: RouteSession | null = {
    user: {
      id: 'owner-user',
      email: 'owner@example.test',
      name: 'Owner User',
      role: 'admin',
    },
    session: {
      id: 'route-test-session',
    },
  };
  const didPatchSession = Reflect.set(auth.api, 'getSession', async () => currentSession);
  assert.equal(didPatchSession, true);

  const workspacesRoute = await import('../app/api/workspaces/route');
  const workspaceRoute = await import('../app/api/workspaces/[id]/route');
  const membersRoute = await import('../app/api/workspaces/[id]/members/route');
  const memberRoute = await import('../app/api/workspaces/[id]/members/[userId]/route');
  const permissionsRoute = await import('../app/api/admin/organization/users/[userId]/permissions/route');
  const roleRoute = await import('../app/api/admin/organization/users/[userId]/role/route');
  const downloadRoute = await import('../app/api/files/download/route');
  const renameRoute = await import('../app/api/files/rename/route');
  const workspaceStatsRoute = await import('../app/api/files/workspace-stats/route');
  const {
    requireMigrationExportPermission,
    requireMigrationRestorePermission,
  } = await import('../app/lib/migration/auth');

  currentSession = null;
  const unauthorized = await workspacesRoute.GET(request('http://localhost/api/workspaces'));
  assert.equal(unauthorized.status, 401);
  currentSession = {
    user: {
      id: 'owner-user',
      email: 'owner@example.test',
      name: 'Owner User',
      role: 'admin',
    },
    session: {
      id: 'route-test-session',
    },
  };

  const initialListResponse = await workspacesRoute.GET(request('http://localhost/api/workspaces'));
  assert.equal(initialListResponse.status, 200);
  const initialList = await responseJson(initialListResponse);
  assert.equal(initialList.success, true);
  const personalDefault = workspaceByType(initialList, 'personal');
  assert.equal(personalDefault.isDefault, true);
  assert.equal(
    (initialList.workspaces as unknown[]).some((workspace) => (
      expectObject(workspace, 'workspace').type === 'organization'
    )),
    false,
  );
  assert.equal(initialList.canCreateSharedWorkspaces, true);
  assert.equal(typeof initialList.organizationId, 'string');
  const organizationId = initialList.organizationId as string;
  const membershipCreatedAt = Date.now();
  for (const membership of [
    { id: 'membership-owner-route-test', userId: 'owner-user', email: 'owner@example.test', role: 'owner' },
    { id: 'membership-member-route-test', userId: 'member-user', email: 'member@example.test', role: 'member' },
  ]) {
    await testPool.query(`
      INSERT INTO team_memberships (
        id, organization_id, candidate_email, user_id, role, status,
        invited_at, accepted_at, activated_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $6, $6, $6)
    `, [
      membership.id,
      organizationId,
      membership.email,
      membership.userId,
      membership.role,
      membershipCreatedAt,
    ]);
  }

  const organizationCreateResponse = await workspacesRoute.POST(jsonRequest('http://localhost/api/workspaces', 'POST', {
    type: 'organization',
    name: 'Route Organization',
    description: 'Shared by every active internal organization member.',
    icon: 'landmark',
  }));
  assert.equal(organizationCreateResponse.status, 201);
  const organizationCreate = await responseJson(organizationCreateResponse);
  const organizationWorkspace = expectObject(organizationCreate.workspace, 'organization workspace');
  const organizationWorkspaceId = workspaceId(organizationCreate);
  assert.equal(organizationWorkspace.type, 'organization');
  assert.equal(organizationWorkspace.isDefault, false);
  assert.equal(organizationWorkspace.icon, 'landmark');

  const duplicateOrganizationResponse = await workspacesRoute.POST(jsonRequest('http://localhost/api/workspaces', 'POST', {
    type: 'organization',
    name: 'Duplicate Organization',
  }));
  assert.equal(duplicateOrganizationResponse.status, 409);
  assert.equal(
    (await responseJson(duplicateOrganizationResponse)).code,
    'WORKSPACE_ORGANIZATION_ALREADY_EXISTS',
  );

  const teamCreateResponse = await workspacesRoute.POST(jsonRequest('http://localhost/api/workspaces', 'POST', {
    type: 'team',
    name: 'Route Team',
    description: 'Shared planning and delivery workspace for the route team.',
    icon: 'briefcase-business',
  }));
  assert.equal(teamCreateResponse.status, 201);
  const teamCreate = await responseJson(teamCreateResponse);
  const teamWorkspaceId = workspaceId(teamCreate);
  assert.equal(expectObject(teamCreate.workspace, 'workspace').icon, 'briefcase-business');
  assert.equal(
    expectObject(teamCreate.workspace, 'workspace').description,
    'Shared planning and delivery workspace for the route team.',
  );

  const personalWorkspacePathResult = await testPool.query<{ rootRelativePath: string }>(
    'SELECT root_relative_path AS "rootRelativePath" FROM canvas_workspaces WHERE id = $1',
    [personalDefault.id],
  );
  const teamWorkspacePathResult = await testPool.query<{ rootRelativePath: string }>(
    'SELECT root_relative_path AS "rootRelativePath" FROM canvas_workspaces WHERE id = $1',
    [teamWorkspaceId],
  );
  const personalWorkspacePath = personalWorkspacePathResult.rows[0]?.rootRelativePath;
  const teamWorkspacePath = teamWorkspacePathResult.rows[0]?.rootRelativePath;
  assert(personalWorkspacePath);
  assert(teamWorkspacePath);
  await fs.mkdir(path.join(dataRoot, personalWorkspacePath), { recursive: true });
  await fs.mkdir(path.join(dataRoot, teamWorkspacePath), { recursive: true });
  await fs.writeFile(path.join(dataRoot, personalWorkspacePath, 'personal-only.txt'), 'personal export');
  await fs.writeFile(path.join(dataRoot, teamWorkspacePath, 'team-only.txt'), 'team workspace');

  const personalStatsResponse = await workspaceStatsRoute.GET(
    request(`http://localhost/api/files/workspace-stats?scope=personal&workspaceId=${teamWorkspaceId}`, {
      headers: { 'x-canvas-workspace-id': teamWorkspaceId },
    }),
  );
  assert.equal(personalStatsResponse.status, 200);
  const personalStats = expectObject(await responseJson(personalStatsResponse), 'personal workspace stats');
  assert.equal(expectObject(personalStats.data, 'personal workspace stats data').fileCount, 1);

  const personalDownloadResponse = await downloadRoute.GET(
    request(`http://localhost/api/files/download?scope=personal&workspaceId=${teamWorkspaceId}`, {
      headers: { 'x-canvas-workspace-id': teamWorkspaceId },
    }),
  );
  assert.equal(personalDownloadResponse.status, 200);
  assert.equal(personalDownloadResponse.headers.get('content-disposition'), 'attachment; filename="workspace.zip"');

  const missingWorkspaceStatsResponse = await workspaceStatsRoute.GET(
    request('http://localhost/api/files/workspace-stats?scope=workspace'),
  );
  assert.equal(missingWorkspaceStatsResponse.status, 400);

  const missingWorkspaceDownloadResponse = await downloadRoute.GET(
    request('http://localhost/api/files/download?scope=workspace'),
  );
  assert.equal(missingWorkspaceDownloadResponse.status, 400);

  const selectedTeamStatsResponse = await workspaceStatsRoute.GET(
    request(`http://localhost/api/files/workspace-stats?scope=workspace&workspaceId=${teamWorkspaceId}`),
  );
  assert.equal(selectedTeamStatsResponse.status, 200);
  const selectedTeamStats = expectObject(await responseJson(selectedTeamStatsResponse), 'selected team workspace stats');
  assert.equal(expectObject(selectedTeamStats.data, 'selected team workspace stats data').fileCount, 1);

  const adminTeamDownloadResponse = await downloadRoute.GET(
    request(`http://localhost/api/files/download?scope=workspace&workspaceId=${teamWorkspaceId}`),
  );
  assert.equal(adminTeamDownloadResponse.status, 200);
  assert.equal(adminTeamDownloadResponse.headers.get('content-disposition'), 'attachment; filename="workspace.zip"');

  const movedSourcePath = path.join(dataRoot, teamWorkspacePath, 'files', '00_dashboard');
  const movedDestinationPath = path.join(dataRoot, teamWorkspacePath, '00_dashboard');
  await fs.rm(movedDestinationPath, { recursive: true, force: true });
  await fs.mkdir(movedSourcePath, { recursive: true });
  const moveRequest = () => renameRoute.POST(request('http://localhost/api/files/rename', {
    method: 'POST',
    headers: { 'x-canvas-workspace-id': teamWorkspaceId },
    body: JSON.stringify({
      oldPath: 'files/00_dashboard',
      newPath: '00_dashboard',
    }),
  }));
  const moveResponse = await moveRequest();
  const movePayload = await responseJson(moveResponse);
  assert.equal(moveResponse.status, 200, JSON.stringify(movePayload));
  await fs.access(movedDestinationPath);
  await assert.rejects(
    () => fs.access(movedSourcePath),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'),
  );

  const staleMoveResponse = await moveRequest();
  assert.equal(staleMoveResponse.status, 409);
  const staleMovePayload = await responseJson(staleMoveResponse);
  assert.equal(staleMovePayload.code, 'SOURCE_NOT_FOUND');
  assert.equal(staleMovePayload.sourcePath, 'files/00_dashboard');
  assert.equal(staleMovePayload.destPath, '00_dashboard');

  const retiredDataDownloadResponse = await downloadRoute.GET(
    request('http://localhost/api/files/download?scope=data'),
  );
  assert.equal(retiredDataDownloadResponse.status, 410);

  const extraPersonalResponse = await workspacesRoute.POST(jsonRequest('http://localhost/api/workspaces', 'POST', {
    type: 'personal',
    name: 'Route Personal',
  }));
  assert.equal(extraPersonalResponse.status, 201);
  const extraPersonalId = workspaceId(await responseJson(extraPersonalResponse));

  const workspaceUpdateResponse = await workspaceRoute.PATCH(
    jsonRequest(`http://localhost/api/workspaces/${extraPersonalId}`, 'PATCH', {
      name: 'Canvas Notebook',
      description: 'Notebook experiments and implementation notes.',
      icon: 'notebook-pen',
    }),
    { params: Promise.resolve({ id: extraPersonalId }) },
  );
  assert.equal(workspaceUpdateResponse.status, 200);
  const updatedWorkspace = expectObject((await responseJson(workspaceUpdateResponse)).workspace, 'updated workspace');
  assert.equal(updatedWorkspace.displayName, 'Canvas Notebook');
  assert.equal(updatedWorkspace.description, 'Notebook experiments and implementation notes.');
  assert.equal(updatedWorkspace.icon, 'notebook-pen');

  const tooLongDescriptionResponse = await workspaceRoute.PATCH(
    jsonRequest(`http://localhost/api/workspaces/${extraPersonalId}`, 'PATCH', {
      description: 'x'.repeat(281),
    }),
    { params: Promise.resolve({ id: extraPersonalId }) },
  );
  assert.equal(tooLongDescriptionResponse.status, 400);
  assert.equal((await responseJson(tooLongDescriptionResponse)).code, 'WORKSPACE_DESCRIPTION_TOO_LONG');

  const invalidIconResponse = await workspaceRoute.PATCH(
    jsonRequest(`http://localhost/api/workspaces/${extraPersonalId}`, 'PATCH', { icon: 'not-an-icon' }),
    { params: Promise.resolve({ id: extraPersonalId }) },
  );
  assert.equal(invalidIconResponse.status, 400);
  assert.equal((await responseJson(invalidIconResponse)).code, 'WORKSPACE_ICON_INVALID');

  const defaultTypeChangeResponse = await workspaceRoute.PATCH(
    jsonRequest(`http://localhost/api/workspaces/${personalDefault.id}`, 'PATCH', { type: 'team' }),
    { params: Promise.resolve({ id: personalDefault.id as string }) },
  );
  assert.equal(defaultTypeChangeResponse.status, 409);
  assert.equal((await responseJson(defaultTypeChangeResponse)).code, 'WORKSPACE_DEFAULT_TYPE_LOCKED');

  const typeChangeResponse = await workspaceRoute.PATCH(
    jsonRequest(`http://localhost/api/workspaces/${extraPersonalId}`, 'PATCH', { type: 'team' }),
    { params: Promise.resolve({ id: extraPersonalId }) },
  );
  assert.equal(typeChangeResponse.status, 200);
  const changedWorkspace = expectObject((await responseJson(typeChangeResponse)).workspace, 'changed workspace');
  assert.equal(changedWorkspace.workspaceType, 'team');

  const memberListResponse = await membersRoute.GET(
    request(`http://localhost/api/workspaces/${teamWorkspaceId}/members`),
    { params: Promise.resolve({ id: teamWorkspaceId }) },
  );
  assert.equal(memberListResponse.status, 200);
  const memberList = await responseJson(memberListResponse);
  assert.equal(memberList.success, true);
  assert.ok(Array.isArray(memberList.members));
  assert.ok(Array.isArray(memberList.candidates));
  assert.ok(memberList.candidates.some((candidate) => (
    expectObject(candidate, 'workspace member candidate').userId === 'member-user'
  )));

  const organizationMembersResponse = await membersRoute.GET(
    request(`http://localhost/api/workspaces/${organizationWorkspaceId}/members`),
    { params: Promise.resolve({ id: organizationWorkspaceId }) },
  );
  assert.equal(organizationMembersResponse.status, 403);
  assert.equal(
    (await responseJson(organizationMembersResponse)).code,
    'WORKSPACE_ORGANIZATION_MANAGED_VIA_ORG',
  );

  const personalMembersResponse = await membersRoute.GET(
    request(`http://localhost/api/workspaces/${personalDefault.id}/members`),
    { params: Promise.resolve({ id: personalDefault.id as string }) },
  );
  assert.equal(personalMembersResponse.status, 403);
  assert.equal((await responseJson(personalMembersResponse)).code, 'WORKSPACE_PERSONAL_NO_MEMBERS');

  const addMemberResponse = await membersRoute.POST(
    jsonRequest(`http://localhost/api/workspaces/${teamWorkspaceId}/members`, 'POST', {
      userId: 'member-user',
      role: 'member',
      canRead: true,
      canWrite: true,
      canManage: false,
    }),
    { params: Promise.resolve({ id: teamWorkspaceId }) },
  );
  assert.equal(addMemberResponse.status, 200);
  const addedMember = expectObject((await responseJson(addMemberResponse)).member, 'added member');
  assert.equal(addedMember.userId, 'member-user');
  assert.equal(addedMember.canManage, false);

  const removeLastManagerResponse = await memberRoute.DELETE(
    request(`http://localhost/api/workspaces/${teamWorkspaceId}/members/owner-user`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: teamWorkspaceId, userId: 'owner-user' }) },
  );
  assert.equal(removeLastManagerResponse.status, 409);
  assert.equal((await responseJson(removeLastManagerResponse)).code, 'WORKSPACE_LAST_MANAGER');

  const downgradeLastManagerResponse = await membersRoute.POST(
    jsonRequest(`http://localhost/api/workspaces/${teamWorkspaceId}/members`, 'POST', {
      userId: 'owner-user',
      role: 'member',
      canRead: true,
      canWrite: true,
      canManage: false,
    }),
    { params: Promise.resolve({ id: teamWorkspaceId }) },
  );
  assert.equal(downgradeLastManagerResponse.status, 409);
  assert.equal((await responseJson(downgradeLastManagerResponse)).code, 'WORKSPACE_LAST_MANAGER');

  const promoteMemberResponse = await membersRoute.POST(
    jsonRequest(`http://localhost/api/workspaces/${teamWorkspaceId}/members`, 'POST', {
      userId: 'member-user',
      role: 'admin',
      canRead: true,
      canWrite: true,
      canManage: true,
    }),
    { params: Promise.resolve({ id: teamWorkspaceId }) },
  );
  assert.equal(promoteMemberResponse.status, 200);

  const removeOwnerResponse = await memberRoute.DELETE(
    request(`http://localhost/api/workspaces/${teamWorkspaceId}/members/owner-user`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: teamWorkspaceId, userId: 'owner-user' }) },
  );
  assert.equal(removeOwnerResponse.status, 200);

  const permissionGetResponse = await permissionsRoute.GET(
    request('http://localhost/api/admin/organization/users/member-user/permissions'),
    { params: Promise.resolve({ userId: 'member-user' }) },
  );
  assert.equal(permissionGetResponse.status, 200);
  const permissionGet = await responseJson(permissionGetResponse);
  assert.equal(permissionGet.success, true);
  assert.equal(expectObject(permissionGet.user, 'permission user').role, 'member');

  const sessionCreatedAt = Date.now();
  await testPool.query(`
    INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
    VALUES ('member-session-route-test', $1, 'member-token-route-test', $2, $3, 'member-user')
  `, [sessionCreatedAt + 60_000, sessionCreatedAt, sessionCreatedAt]);

  const permissionPatchResponse = await permissionsRoute.PATCH(
    jsonRequest('http://localhost/api/admin/organization/users/member-user/permissions', 'PATCH', {
      canExport: true,
      canManageBackups: true,
    }),
    { params: Promise.resolve({ userId: 'member-user' }) },
  );
  const permissionPatch = await responseJson(permissionPatchResponse);
  assert.equal(permissionPatchResponse.status, 200, JSON.stringify(permissionPatch));
  assert.equal(permissionPatch.success, true);
  assert.equal(permissionPatch.sessionsRevoked, 1);
  assert.equal(expectObject(expectObject(permissionPatch.user, 'patched user').permissions, 'patched permissions').canExport, true);

  currentSession = {
    user: {
      id: 'member-user',
      email: 'member@example.test',
      name: 'Member User',
      role: 'user',
    },
    session: {
      id: 'member-route-test-session',
    },
  };

  const memberWorkspacesResponse = await workspacesRoute.GET(request('http://localhost/api/workspaces'));
  assert.equal(memberWorkspacesResponse.status, 200);
  const memberWorkspaces = await responseJson(memberWorkspacesResponse);
  const memberPersonalWorkspace = workspaceByType(memberWorkspaces, 'personal');
  const memberOrganizationWorkspace = workspaceByType(memberWorkspaces, 'organization');
  assert.equal(typeof memberPersonalWorkspace.id, 'string');
  assert.equal(typeof memberPersonalWorkspace.rootRelativePath, 'string');
  assert.equal(memberOrganizationWorkspace.id, organizationWorkspaceId);
  assert.equal(
    expectObject(memberOrganizationWorkspace.permissions, 'organization permissions').canRead,
    true,
  );
  assert.equal(memberWorkspaces.canCreateSharedWorkspaces, false);

  const memberOrganizationCreateResponse = await workspacesRoute.POST(jsonRequest('http://localhost/api/workspaces', 'POST', {
    type: 'organization',
    name: 'Member Organization',
  }));
  assert.equal(memberOrganizationCreateResponse.status, 403);
  assert.equal(
    (await responseJson(memberOrganizationCreateResponse)).code,
    'WORKSPACE_PERMISSION_DENIED',
  );

  const memberPersonalRoot = path.join(dataRoot, memberPersonalWorkspace.rootRelativePath as string);
  await fs.mkdir(memberPersonalRoot, { recursive: true });
  await fs.writeFile(path.join(memberPersonalRoot, 'member-personal.txt'), 'member personal export');

  const memberPersonalDownloadResponse = await downloadRoute.GET(
    request(`http://localhost/api/files/download?scope=workspace&workspaceId=${memberPersonalWorkspace.id}`),
  );
  assert.equal(memberPersonalDownloadResponse.status, 200);

  const memberTeamDownloadResponse = await downloadRoute.GET(
    request(`http://localhost/api/files/download?scope=workspace&workspaceId=${teamWorkspaceId}`),
  );
  assert.equal(memberTeamDownloadResponse.status, 403);
  assert.equal((await responseJson(memberTeamDownloadResponse)).code, 'WORKSPACE_EXPORT_ADMIN_REQUIRED');

  const deniedMigrationExport = await requireMigrationExportPermission(request('http://localhost/api/migration/export'));
  assert.equal(deniedMigrationExport.ok, false);
  if (!deniedMigrationExport.ok) assert.equal(deniedMigrationExport.response.status, 403);
  const deniedMigrationRestore = await requireMigrationRestorePermission(request('http://localhost/api/migration/restore'));
  assert.equal(deniedMigrationRestore.ok, false);
  if (!deniedMigrationRestore.ok) assert.equal(deniedMigrationRestore.response.status, 403);

  currentSession = {
    user: {
      id: 'owner-user',
      email: 'owner@example.test',
      name: 'Owner User',
      role: 'admin',
    },
    session: {
      id: 'route-test-session',
    },
  };
  const allowedMigrationExport = await requireMigrationExportPermission(request('http://localhost/api/migration/export'));
  assert.equal(allowedMigrationExport.ok, true);

  const invalidRoleResponse = await roleRoute.PATCH(
    jsonRequest('http://localhost/api/admin/organization/users/member-user/role', 'PATCH', { role: 'owner' }),
    { params: Promise.resolve({ userId: 'member-user' }) },
  );
  assert.equal(invalidRoleResponse.status, 400);
  assert.equal((await responseJson(invalidRoleResponse)).code, 'INVALID_ROLE');

  const rolePatchResponse = await roleRoute.PATCH(
    jsonRequest('http://localhost/api/admin/organization/users/member-user/role', 'PATCH', { role: 'admin' }),
    { params: Promise.resolve({ userId: 'member-user' }) },
  );
  assert.equal(rolePatchResponse.status, 200);
  const rolePatch = await responseJson(rolePatchResponse);
  assert.equal(rolePatch.success, true);
  assert.equal(expectObject(rolePatch.user, 'role user').role, 'admin');

  const externalRoleResponse = await roleRoute.PATCH(
    jsonRequest('http://localhost/api/admin/organization/users/member-user/role', 'PATCH', { role: 'external' }),
    { params: Promise.resolve({ userId: 'member-user' }) },
  );
  assert.equal(externalRoleResponse.status, 403);
  assert.equal((await responseJson(externalRoleResponse)).code, 'EXTERNAL_USERS_DISABLED');

  const deleteDefaultResponse = await workspaceRoute.DELETE(
    request(`http://localhost/api/workspaces/${personalDefault.id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: personalDefault.id as string }) },
  );
  assert.equal(deleteDefaultResponse.status, 409);
  assert.equal((await responseJson(deleteDefaultResponse)).code, 'WORKSPACE_IS_DEFAULT');

  const deleteOrganizationResponse = await workspaceRoute.DELETE(
    request(`http://localhost/api/workspaces/${organizationWorkspaceId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: organizationWorkspaceId }) },
  );
  assert.equal(deleteOrganizationResponse.status, 200);

  const deleteChangedWorkspaceResponse = await workspaceRoute.DELETE(
    request(`http://localhost/api/workspaces/${extraPersonalId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: extraPersonalId }) },
  );
  assert.equal(deleteChangedWorkspaceResponse.status, 200);

  const disabledResult = await testPool.query<{ status: string }>(
    'SELECT status FROM canvas_workspaces WHERE id = $1',
    [extraPersonalId],
  );
  assert.equal(disabledResult.rows[0]?.status, 'disabled');
  const disabledOrganizationResult = await testPool.query<{ status: string; isDefault: number | string }>(
    'SELECT status, is_default AS "isDefault" FROM canvas_workspaces WHERE id = $1',
    [organizationWorkspaceId],
  );
  assert.deepEqual(
    {
      status: disabledOrganizationResult.rows[0]?.status,
      isDefault: Number(disabledOrganizationResult.rows[0]?.isDefault),
    },
    { status: 'disabled', isDefault: 0 },
  );
  const auditCountResult = await testPool.query<{ count: number | string }>(`
    SELECT COUNT(*) AS count
    FROM audit_events
    WHERE entity_id = 'member-user'
      AND action IN ('organization.permissions.update', 'organization.role.update')
  `);
  assert.equal(Number(auditCountResult.rows[0]?.count) >= 2, true);

    console.log('workspace api route PostgreSQL tests passed');
  } finally {
    try {
      await closeRuntimeDatabase?.();
    } finally {
      await testPoolForCleanup?.end();
      await fs.rm(tempRoot, { recursive: true, force: true });
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
