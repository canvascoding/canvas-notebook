import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL || 'http://localhost:3001';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Run this mutable fixture test only on a local server');
const scopeHeader = 'x-canvas-workspace-id';

async function login(email, password) {
  assert.ok(email && password, 'Provide local test credentials through the environment');
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, 'Local fixture login must succeed');
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

async function request(cookie, endpoint, workspaceId, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, {
    method, headers: { Cookie: cookie, Origin: base, ...(workspaceId ? { [scopeHeader]: workspaceId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, payload: await response.json() };
}

async function main() {
  const admin = await login(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);
  const member = await login(process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL, process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD);
  const [adminSpaces, memberSpaces] = await Promise.all([request(admin, '/api/workspaces'), request(member, '/api/workspaces')]);
  assert.equal(adminSpaces.status, 200);
  assert.equal(memberSpaces.status, 200);
  const memberIds = new Set(memberSpaces.payload.workspaces.map((space) => space.id));
  const workspace = adminSpaces.payload.workspaces.find((space) => memberIds.has(space.id) && space.permissions.canWrite && space.permissions.canDelete && space.type !== 'personal');
  assert.ok(workspace, 'The managed stack must contain a writable shared workspace');
  const workspaceId = workspace.id;
  const path = `home-quick-access-${randomUUID()}.md`;
  let created = false;
  try {
    const unauthenticated = await request('', '/api/files/quick-access', workspaceId);
    assert.equal(unauthenticated.status, 401);
    assert.ok([403, 404].includes((await request(member, '/api/files/quick-access', 'inaccessible-workspace')).status));
    assert.equal((await request(admin, '/api/files/quick-access?view=invalid', workspaceId)).status, 400);
    assert.equal((await request(admin, '/api/files/quick-access?limit=9999', workspaceId)).status, 400);
    assert.equal((await request(admin, '/api/files/quick-access', workspaceId, 'POST', { path: '../escape.md' })).status, 400);
    assert.equal((await request(admin, '/api/files/create', workspaceId, 'POST', { path, type: 'file' })).status, 200);
    created = true;
    assert.equal((await request(admin, '/api/files/quick-access', workspaceId, 'POST', { path })).status, 200);
    assert.equal((await request(admin, '/api/files/metadata', workspaceId, 'PATCH', { path, title: 'Home QA searchable title', isFavorite: true, pinned: true })).status, 200);
    const adminFiles = await request(admin, '/api/files/quick-access?view=recent', workspaceId);
    assert.equal(adminFiles.status, 200);
    assert.equal(adminFiles.payload.data.view, 'recent');
    assert.equal(adminFiles.payload.data.files[0].path, path);
    assert.ok(adminFiles.payload.data.files[0].openedAt > 0);
    const favorites = await request(admin, '/api/files/quick-access?view=favorites&limit=50', workspaceId);
    assert.ok(favorites.payload.data.files.some((file) => file.path === path && file.isFavorite && file.pinnedAt));
    const search = await request(admin, '/api/files/quick-access?q=Home%20QA%20searchable%20title', workspaceId);
    assert.ok(search.payload.data.files.some((file) => file.path === path), 'custom titles must be searchable');
    const memberFiles = await request(member, '/api/files/quick-access?view=frequent&limit=50', workspaceId);
    assert.ok(!memberFiles.payload.data.files.some((file) => file.path === path), 'shared visibility must not share personal visit history');
    const memberFavorites = await request(member, '/api/files/quick-access?view=favorites&limit=50', workspaceId);
    assert.ok(!memberFavorites.payload.data.files.some((file) => file.path === path), 'favorites must remain personal');
    assert.equal((await request(admin, '/api/files/delete', workspaceId, 'DELETE', { path })).status, 200);
    created = false;
    const afterDelete = await request(admin, '/api/files/quick-access?view=recent&limit=50', workspaceId);
    assert.ok(!afterDelete.payload.data.files.some((file) => file.path === path), 'deleted files must disappear even while history remains');
    assert.equal((await request(admin, '/api/files/quick-access', workspaceId, 'POST', { path })).status, 404);
    console.log('Home API: real logins, permissions, personal history/favorites, title search, invalid inputs and deleted-file filtering passed');
  } finally {
    if (created) assert.equal((await request(admin, '/api/files/delete', workspaceId, 'DELETE', { path })).status, 200, 'Remove only the file created by this test');
  }
}
await main();
