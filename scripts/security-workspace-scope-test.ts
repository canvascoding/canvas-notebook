import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import type { RequestWorkspaceSession } from '../app/lib/workspaces/request';

async function verifyWorkspaceScope() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-security-workspaces-'));
  process.env.DATA = temporary;
  process.env.CANVAS_DATA_ROOT = temporary;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  process.env.BASE_URL = process.env.BETTER_AUTH_BASE_URL;
  process.env.BETTER_AUTH_SECRET = 'workspace-security-fixture-secret-at-least-32-characters';
  process.env.CANVAS_DEPLOYMENT_MODE = 'self-hosted';
  process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'false';
  if (process.env.CANVAS_DATABASE_PROVIDER === 'postgres') {
    const migrationPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const { runPostgresMigrations } = await import('../app/lib/db/postgres');
      await runPostgresMigrations(migrationPool);
    } finally { await migrationPool.end(); }
  }
  const { db, openDb, closeDatabaseConnections } = await import('../app/lib/db');
  try {
    const { user } = await import('../app/lib/db/schema');
    const now = new Date();
    for (const [id, role] of [['scope-owner', 'admin'], ['scope-a', 'user'], ['scope-b', 'user']]) {
      await db.insert(user).values({ id, name: id, email: id + '@example.test', emailVerified: true, role, createdAt: now, updatedAt: now });
    }
    const session = (id: string) => ({
      user: { id, name: id, email: id + '@example.test', role: 'admin' },
      session: { id: 'fixture-' + id, userId: id, expiresAt: new Date(Date.now() + 60_000) },
    } as RequestWorkspaceSession);
    const legacyRoot = path.join(temporary, 'workspace');
    const ownerRoot = path.join(temporary, 'workspaces/personal/scope-owner/files');
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'old.json'), '{"legacy":true}');
    await fs.writeFile(path.join(legacyRoot, 'conflict.json'), '{"version":"legacy"}');
    await fs.writeFile(path.join(ownerRoot, 'conflict.json'), '{"version":"personal"}');
    const { requireSessionWorkspace, requireRequestWorkspace } = await import('../app/lib/workspaces/request');
    const { LEGACY_PERSONAL_WORKSPACE_ID } = await import('../app/lib/workspaces/constants');
    const { readFile } = await import('../app/lib/filesystem/workspace-files');
    const owner = await requireSessionWorkspace(session('scope-owner'));
    assert.ok(owner.workspace); assert.equal(owner.workspace.legacy, false);
    assert.equal(owner.workspace.rootPath, ownerRoot);
    assert.equal((await readFile('old.json', { workspace: owner.workspace })).toString(), '{"legacy":true}');
    assert.equal(await fs.readFile(path.join(ownerRoot, 'conflict.json'), 'utf8'), '{"version":"personal"}');
    const imports = await fs.readdir(path.join(ownerRoot, '_legacy-workspace-import'));
    assert.equal(imports.length, 1);
    assert.equal(await fs.readFile(path.join(ownerRoot, '_legacy-workspace-import', imports[0], 'conflict.json'), 'utf8'), '{"version":"legacy"}');
    assert.equal(await fs.readFile(path.join(legacyRoot, 'old.json'), 'utf8'), '{"legacy":true}');
    const { auth } = await import('../app/lib/auth');
    const original = auth.api.getSession;
    const { NextRequest } = await import('next/server');
    const { resolveAgentSessionWorkspaceForUser } = await import('../app/lib/pi/session-workspace-context');
    try {
      const roots = [];
      for (const id of ['scope-a', 'scope-b']) {
        Reflect.set(auth.api, 'getSession', async () => session(id));
        const own = await requireRequestWorkspace(new NextRequest('http://localhost:3000/api/files/list'));
        assert.ok(own.workspace); assert.equal(own.workspace.ownerUserId, id); assert.equal(own.workspace.legacy, false);
        roots.push(own.workspace.rootPath);
        await fs.writeFile(path.join(own.workspace.rootPath, 'own.json'), JSON.stringify({ id }));
        assert.equal((await readFile('own.json', { workspace: own.workspace })).toString(), JSON.stringify({ id }));
        await assert.rejects(() => readFile('old.json', { workspace: own.workspace! }));
        const denied = await requireRequestWorkspace(new NextRequest('http://localhost:3000/api/files/list?workspaceId=' + LEGACY_PERSONAL_WORKSPACE_ID));
        assert.equal(denied.response?.status, 404, 'even a claimed admin role cannot grant legacy ownership');
        await assert.rejects(() => resolveAgentSessionWorkspaceForUser({ userId: id, workspaceId: LEGACY_PERSONAL_WORKSPACE_ID }), /inaccessible/u);
        assert.equal((await requireSessionWorkspace(session(id), { workspaceId: owner.workspace.workspaceId })).response?.status, 404);
      }
      assert.notEqual(roots[0], roots[1]);
    } finally { Reflect.set(auth.api, 'getSession', original); }
    const recovery = await requireSessionWorkspace(session('scope-owner'), { workspaceId: LEGACY_PERSONAL_WORKSPACE_ID, permissions: 'canRead' });
    assert.ok(recovery.workspace); assert.equal(recovery.workspace.rootPath, legacyRoot); assert.equal(recovery.workspace.permissions.canWrite, false);
    assert.equal((await requireSessionWorkspace(session('scope-owner'), { workspaceId: LEGACY_PERSONAL_WORKSPACE_ID, permissions: 'canWrite' })).response?.status, 403);
    const migratedAgent = await resolveAgentSessionWorkspaceForUser({ userId: 'scope-owner', workspaceId: LEGACY_PERSONAL_WORKSPACE_ID });
    assert.equal(migratedAgent.workspaceId, owner.workspace.workspaceId); assert.equal(migratedAgent.legacy, false);
    const database = await openDb();
    try {
      await database.run('UPDATE "user" SET banned=1 WHERE id=?', ['scope-owner']);
      assert.equal((await requireSessionWorkspace(session('scope-owner'), { workspaceId: LEGACY_PERSONAL_WORKSPACE_ID })).response?.status, 404);
      await database.run('UPDATE "user" SET banned=0 WHERE id=?', ['scope-owner']);
    } finally { await database.close(); }
    console.log('Workspace security tests passed:', process.env.CANVAS_DATABASE_PROVIDER, '(two accounts, owner recovery, preserved conflicts, agent legacy denial)');
  } finally {
    await closeDatabaseConnections();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.env.TEST_DATABASE_URL || process.env.CANVAS_SECURITY_WORKSPACE_CHILD) return verifyWorkspaceScope();
  const base = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only an explicitly configured local test PostgreSQL server is allowed');
  const databaseName = `canvas_security_workspace_${process.pid}_${Date.now()}`;
  const adminUrl = new URL(base); adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(base); url.pathname = '/' + databaseName;
    const child = spawn(process.execPath, ['--conditions=react-server', '--import=tsx', path.resolve('scripts/security-workspace-scope-test.ts')], {
      env: { ...process.env, DATABASE_URL: url.href, CANVAS_SECURITY_WORKSPACE_CHILD: 'true' }, stdio: 'inherit',
    });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'PostgreSQL workspace security child must pass');
  } finally {
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
