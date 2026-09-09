import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { createCollaborationAccessMonitor } from '../app/lib/collaboration/access-monitor';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-collaboration-access-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://access-test.invalid/canvas';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  const postgres = new PGlite();
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array'
        ? result.rows.map((row) => result.fields.map((field) => row[field.name])) : result.rows };
  };
  const original = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: async () => ({ query, release() {} }) });
  try {
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { db } = await import('../app/lib/db');
    const { user, session, canvasOrganizationSettings, canvasWorkspaces, organizationUserPermissions } = await import('../app/lib/db/schema');
    const now = new Date();
    await db.insert(user).values(['owner', 'member'].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, role: id === 'owner' ? 'admin' : 'member', createdAt: now, updatedAt: now,
    })));
    await db.insert(canvasOrganizationSettings).values({ organizationId: 'org', ownerUserId: 'owner', deploymentMode: 'managed-team', teamFeaturesEnabled: true, createdAt: now, updatedAt: now });
    await db.insert(canvasWorkspaces).values({ id: 'workspace', organizationId: 'org', type: 'organization', rootRelativePath: 'workspace', displayName: 'Test', createdAt: now, updatedAt: now });
    await db.insert(organizationUserPermissions).values({ organizationId: 'org', userId: 'member', role: 'member', canWriteTeamWorkspace: true, createdAt: now, updatedAt: now });
    await db.insert(session).values({ id: 'member-session', userId: 'member', token: 'synthetic-session', expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now });
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'member', role: 'member' }, 'workspace');
    assert.ok(workspace?.permissions.canWrite);
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const metadata = await getFileCollaborationState({ workspace, path: 'notes.md', ensureDocument: true });
    assert.ok(metadata.document);
    const { ensureCollaborationState } = await import('../app/lib/collaboration/persistence');
    await ensureCollaborationState({ documentId: metadata.document.id, workspaceId: 'workspace', organizationId: 'org', path: 'notes.md', representation: 'plain_text', initialContent: '# Notes\n' });
    const { revalidateCollaborationAccess } = await import('../app/lib/collaboration/connection-access');
    const claims: CollaborationTicketClaims = {
      userId: 'member', sessionId: 'member-session', workspaceId: 'workspace', organizationId: 'org',
      documentId: metadata.document.id, path: 'notes.md', provider: 'yjs', representation: 'plain_text', permission: 'write',
      lifecycleGeneration: 1, schemaVersion: 1, issuedAt: Date.now() - 120_000, expiresAt: Date.now() - 30_000,
    };
    assert.ok((await revalidateCollaborationAccess(claims)).workspace.permissions.canWrite, 'An expired join ticket does not end an otherwise valid ongoing session');
    const readClaims = { ...claims, permission: 'read' as const };
    await db.update(organizationUserPermissions).set({ canWriteTeamWorkspace: false }).where(eq(organizationUserPermissions.userId, 'member'));
    await assert.rejects(revalidateCollaborationAccess(claims), /write access was revoked/);
    await revalidateCollaborationAccess(readClaims);
    await db.update(organizationUserPermissions).set({ status: 'archived' }).where(eq(organizationUserPermissions.userId, 'member'));
    await assert.rejects(revalidateCollaborationAccess(readClaims), /access was revoked/);
    await db.update(organizationUserPermissions).set({ status: 'active', canWriteTeamWorkspace: true }).where(eq(organizationUserPermissions.userId, 'member'));
    await db.update(user).set({ banned: true }).where(eq(user.id, 'member'));
    await assert.rejects(revalidateCollaborationAccess(claims), /no longer authenticated/);
    await db.update(user).set({ banned: false }).where(eq(user.id, 'member'));
    for (const invalid of [{ ...claims, userId: 'owner' }, { ...claims, sessionId: 'missing' }]) {
      await assert.rejects(revalidateCollaborationAccess(invalid), /no longer authenticated/);
    }
    for (const invalid of [{ ...claims, path: 'other.md' }, { ...claims, lifecycleGeneration: 2 }, { ...claims, schemaVersion: 2 }]) {
      await assert.rejects(revalidateCollaborationAccess(invalid), /generation is stale/);
    }
    await db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.id, 'member-session'));
    await assert.rejects(revalidateCollaborationAccess(claims), /no longer authenticated/);
    await db.update(session).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(session.id, 'member-session'));

    const denied: string[] = [];
    const monitor = createCollaborationAccessMonitor<{ name: string; claims: CollaborationTicketClaims }>({
      validate: async (connection) => { await revalidateCollaborationAccess(connection.claims); },
      deny: (connection) => { denied.push(connection.name); },
    });
    try {
      const writer = { name: 'writer', claims };
      const reader = { name: 'reader', claims: readClaims };
      monitor.add(writer); monitor.add(reader);
      await monitor.check(writer); await monitor.check(reader);
      await db.update(organizationUserPermissions).set({ canWriteTeamWorkspace: false }).where(eq(organizationUserPermissions.userId, 'member'));
      let updateApplied = false;
      await assert.rejects(monitor.check(writer).then(() => { updateApplied = true; }));
      assert.equal(updateApplied, false);
      assert.deepEqual(denied, ['writer']);
      await db.delete(session).where(eq(session.id, 'member-session'));
      await monitor.sweep();
      assert.deepEqual(denied, ['writer', 'reader'], 'Idle readers are disconnected after logout without sending another message');
      await assert.rejects(monitor.check(reader));
      assert.equal(denied.length, 2, 'Denial is permanent and reported once per connection');
    } finally {
      monitor.dispose();
    }

    let complete: () => void = () => {};
    let validations = 0;
    const queued = createCollaborationAccessMonitor<object>({
      validate: () => { validations += 1; return new Promise<void>((resolve) => { complete = resolve; }); },
      deny: () => {},
    });
    const connection = {};
    const unregister = queued.add(connection);
    const first = queued.check(connection);
    const second = queued.check(connection);
    await Promise.resolve();
    assert.equal(validations, 1, 'Concurrent timer/message checks share only their in-flight work');
    unregister(); complete();
    const pending = await Promise.allSettled([first, second]);
    assert.ok(pending.every((result) => result.status === 'rejected'), 'Closing during validation prevents queued writes');
    queued.dispose();

    let client = { ...createInitialTextCollaborationClientState(), remoteSynced: true, indexedDbHydrated: true, unsyncedChanges: 2 };
    client = reduceTextCollaborationClientState(client, { type: 'authentication_failed', message: 'Access revoked' });
    client = reduceTextCollaborationClientState(client, { type: 'provider_status', status: 'connected', permission: 'write' });
    client = reduceTextCollaborationClientState(client, { type: 'remote_synced', permission: 'write' });
    assert.equal(client.connection, 'denied');
    assert.equal(client.unsyncedChanges, 2, 'Local pending edits are retained');
    console.log('collaboration-access-revocation-test: session, workspace permissions, document lifecycle, idle readers, queued writes and local recovery ok');
  } finally {
    Object.assign(Pool.prototype, original);
    await postgres.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
