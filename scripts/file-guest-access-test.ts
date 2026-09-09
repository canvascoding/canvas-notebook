import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { fileGuestCookieName } from '../app/lib/file-guests/types';

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-file-guests-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://guest-test.invalid/canvas';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost';
  process.env.BETTER_AUTH_SECRET = 'synthetic-file-guest-test-secret-not-for-production';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  const postgres = new PGlite();
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array' ? result.rows.map((row) => result.fields.map((field) => row[field.name])) : result.rows };
  };
  const original = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: async () => ({ query, release() {} }) });
  try {
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { db } = await import('../app/lib/db');
    const { user, session, canvasOrganizationSettings, canvasWorkspaces, organizationUserPermissions, fileGuestInvitations, fileGuestSessions } = await import('../app/lib/db/schema');
    const now = new Date();
    await db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test', emailVerified: true, role: 'admin', createdAt: now, updatedAt: now });
    await db.insert(canvasOrganizationSettings).values({ organizationId: 'org', ownerUserId: 'owner', deploymentMode: 'managed-team', teamFeaturesEnabled: true, createdAt: now, updatedAt: now });
    await db.insert(canvasWorkspaces).values({ id: 'workspace', organizationId: 'org', type: 'organization', rootRelativePath: 'workspace', displayName: 'Test', createdAt: now, updatedAt: now });
    await db.insert(organizationUserPermissions).values({ organizationId: 'org', userId: 'owner', role: 'owner', canWriteTeamWorkspace: true, canCreatePublicLinks: true, createdAt: now, updatedAt: now });
    await mkdir(path.join(tempRoot, 'workspace'), { recursive: true });
    const markdown = '# Shared\n\n![Visible](visible.png)\n\n`![Private](private.png)`\n';
    await writeFile(path.join(tempRoot, 'workspace', 'notes.md'), markdown);
    await writeFile(path.join(tempRoot, 'workspace', 'visible.png'), 'visible-image');
    await writeFile(path.join(tempRoot, 'workspace', 'private.png'), 'private-image');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'owner', role: 'admin' }, 'workspace');
    assert.ok(workspace);
    const { createFileGuestService, fileGuestService } = await import('../app/lib/file-guests/service');
    const { auth } = await import('../app/lib/auth');
    await auth.$context;
    const codes: Array<{ email: string; code: string }> = [];
    const guests = createFileGuestService({ assertEntitlement: async () => undefined, sendCode: async (input) => { codes.push(input); } });
    Object.assign(fileGuestService, guests);
    const alice = await guests.create({ workspace, path: 'notes.md', email: 'alice@example.test', permission: 'write', expiresAt: null });
    const bob = await guests.create({ workspace, path: 'notes.md', email: 'bob@example.test', permission: 'read', expiresAt: new Date(Date.now() + 60_000) });
    const expiryGuard = await guests.create({ workspace, path: 'notes.md', email: 'expiry-guard@example.test', permission: 'write', expiresAt: null });
    const noWriteWorkspace = { ...workspace, permissions: { ...workspace.permissions, canWrite: false } };
    await assert.rejects(guests.manage(noWriteWorkspace, expiryGuard.id, {
      policyRevision: expiryGuard.policyRevision,
      expiresAt: new Date(Date.now() + 120_000),
    }), /Schreibrechte/);
    const downgradedGuard = await guests.manage(noWriteWorkspace, expiryGuard.id, {
      policyRevision: expiryGuard.policyRevision,
      permission: 'read',
      expiresAt: new Date(Date.now() + 120_000),
    });
    assert.equal(downgradedGuard.permission, 'read', 'Managers without write access may only reduce a write invitation');
    assert.equal(alice.assetCount, 1);
    const duplicate = await Promise.all(Array.from({ length: 12 }, () => guests.create({ workspace, path: 'notes.md', email: 'alice@example.test', permission: 'read', expiresAt: new Date(Date.now() + 60_000) })));
    assert.ok(duplicate.every((entry) => entry.id === alice.id && entry.permission === 'write' && entry.expiresAt === null));
    await assert.rejects(guests.create({ workspace: { ...workspace, permissions: { ...workspace.permissions, canCreatePublicLinks: false } }, path: 'notes.md', email: 'mallory@example.test', permission: 'write', expiresAt: null }));
    const challengeResults = await Promise.allSettled(Array.from({ length: 8 }, () => guests.challenge(alice.id)));
    assert.equal(challengeResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(codes.length, 1);
    for (let index = 0; index < 5; index += 1) await assert.rejects(guests.verify(alice.id, codes[0].code === '000000' ? '111111' : '000000', 'Alice'));
    await assert.rejects(guests.verify(alice.id, codes[0].code, 'Alice'), /ungültig|abgelaufen/);
    await db.update(fileGuestInvitations).set({ challengeSentAt: new Date(Date.now() - 61_000) }).where(eq(fileGuestInvitations.id, alice.id));
    await guests.challenge(alice.id);
    const verified = await Promise.allSettled(Array.from({ length: 8 }, () => guests.verify(alice.id, codes.at(-1)!.code, 'Alice')));
    const accepted = verified.filter((result) => result.status === 'fulfilled');
    assert.equal(accepted.length, 1, 'A code is consumed only once under concurrent redemption');
    const credential = accepted[0].value;
    await assert.rejects(guests.access(bob.id, { token: credential.token }), /bestätig|abgelaufen/);
    const access = await guests.access(alice.id, { token: credential.token });
    assert.equal(access.workspace.permissions.canWrite, true);
    assert.equal(access.workspace.permissions.canRunAgent, false);
    assert.equal(access.workspace.permissions.canCreatePublicLinks, false);
    assert.equal(access.workspace.permissions.canDelete, false);
    assert.equal((await db.select().from(user)).length, 1, 'Guest verification creates no app identity');
    assert.equal((await db.select().from(session)).length, 0, 'Guest verification creates no app session');
    assert.equal((await guests.asset(alice.id, credential.token, 'visible.png')).toString(), 'visible-image');
    await assert.rejects(guests.asset(alice.id, credential.token, 'private.png'), /nicht freigegeben/);
    await assert.rejects(guests.asset(alice.id, credential.token, '../private.png'));
    const { fileGuestCollaborationSession } = await import('../app/lib/file-guests/collaboration');
    const { verifyCollaborationTicket } = await import('../app/lib/collaboration/ticket');
    const { revalidateCollaborationAccess } = await import('../app/lib/collaboration/connection-access');
    const ticket = await fileGuestCollaborationSession(alice.id, credential.token);
    const claims = verifyCollaborationTicket(ticket.token);
    await revalidateCollaborationAccess(claims);
    await assert.rejects(revalidateCollaborationAccess({ ...claims, path: 'private.md' }));
    await assert.rejects(revalidateCollaborationAccess({ ...claims, workspaceId: 'elsewhere' }));
    await assert.rejects(revalidateCollaborationAccess({ ...claims, documentId: 'elsewhere' }));
    await assert.rejects(revalidateCollaborationAccess({ ...claims, guestInvitationId: bob.id }));
    const { GET } = await import('../app/api/guest/files/[id]/route');
    const routeContext = { params: Promise.resolve({ id: alice.id }) };
    assert.equal((await GET(new NextRequest(`http://localhost/api/guest/files/${alice.id}`), routeContext)).status, 401);
    const response = await GET(new NextRequest(`http://localhost/api/guest/files/${alice.id}`, { headers: { cookie: `${fileGuestCookieName(alice.id)}=${credential.token}` } }), routeContext);
    assert.equal(response.status, 200);
    assert.match((await response.json()).markdown, /Shared/);
    const guestHeaders = { cookie: `${fileGuestCookieName(alice.id)}=${credential.token}`, 'x-canvas-workspace-id': workspace.workspaceId };
    const { GET: listFiles } = await import('../app/api/files/list/route');
    assert.equal((await listFiles(new NextRequest('http://localhost/api/files/list', { headers: guestHeaders }))).status, 401, 'Guest cookies cannot browse a workspace');
    const { POST: memberSession } = await import('../app/api/files/collaboration/session/route');
    assert.equal((await memberSession(new NextRequest('http://localhost/api/files/collaboration/session', { method: 'POST', headers: guestHeaders, body: '{}' }))).status, 401, 'Guest cookies cannot issue member tickets');
    const { GET: versionsRoute } = await import('../app/api/security/file-guests/versions/route');
    assert.equal((await versionsRoute(new NextRequest('http://localhost/api/security/file-guests/versions?path=notes.md', { headers: guestHeaders }))).status, 401, 'Guests cannot inspect pre-invitation document history');
    const { default: middleware } = await import('../proxy');
    assert.equal((await middleware(new NextRequest('http://localhost/api/files/list', { headers: guestHeaders }))).status, 401);
    const { POST } = await import('../app/api/guest/files/[id]/[action]/route');
    assert.equal((await POST(new NextRequest(`http://localhost/api/guest/files/${alice.id}/challenge`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ id: alice.id, action: 'challenge' }) })).status, 403);
    const changes = await Promise.allSettled(Array.from({ length: 8 }, () => guests.manage(workspace, alice.id, { policyRevision: 1, permission: 'read' })));
    assert.equal(changes.filter((result) => result.status === 'fulfilled').length, 1);
    await assert.rejects(revalidateCollaborationAccess(claims), /revoked/);
    const reader = verifyCollaborationTicket((await fileGuestCollaborationSession(alice.id, credential.token)).token);
    assert.equal(reader.permission, 'read');
    await revalidateCollaborationAccess(reader);
    await guests.manage(workspace, alice.id, { policyRevision: 2, revoke: true });
    await assert.rejects(revalidateCollaborationAccess(reader), /widerrufen/);
    await assert.rejects(guests.content(alice.id, credential.token));
    await assert.rejects(guests.challenge(alice.id));
    await guests.challenge(bob.id);
    const bobCredential = await guests.verify(bob.id, codes.at(-1)!.code, 'Bob');
    await guests.logout(bob.id, bobCredential.token);
    await assert.rejects(guests.access(bob.id, { token: bobCredential.token }));
    await db.update(fileGuestInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(fileGuestInvitations.id, bob.id));
    await assert.rejects(guests.challenge(bob.id), /abgelaufen/);
    await db.update(fileGuestSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    await writeFile(path.join(tempRoot, 'workspace', 'collaborate.md'), '# Together\n\n![[private-note]]\n');
    await db.insert(session).values({ id: 'owner-session', userId: 'owner', token: 'synthetic-owner-token', expiresAt: new Date(Date.now() + 60_000), createdAt: now, updatedAt: now });
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const { ensureCollaborationState } = await import('../app/lib/collaboration/persistence');
    const metadata = await getFileCollaborationState({ workspace, path: 'collaborate.md', ensureDocument: true });
    await ensureCollaborationState({ documentId: metadata.document!.id, workspaceId: workspace.workspaceId, organizationId: 'org',
      path: 'collaborate.md', representation: 'plain_text', initialContent: '# Together\n\n![[private-note]]\n' });
    const participants: Array<{ id: string; token: string }> = [];
    for (const name of ['live-alice', 'live-bob', 'live-reader']) {
      const invitation = await guests.create({ workspace, path: 'collaborate.md', email: `${name}@example.test`, permission: name.endsWith('reader') ? 'read' : 'write', expiresAt: null });
      await guests.challenge(invitation.id);
      const guest = await guests.verify(invitation.id, codes.at(-1)!.code, name);
      participants.push({ id: invitation.id, token: guest.token });
    }
    const { runFileGuestWebsocketScenario } = await import('./helpers/file-guest-websocket-scenario');
    await runFileGuestWebsocketScenario({ workspace, path: 'collaborate.md', participants, representation: 'plain_text' });
    await writeFile(path.join(tempRoot, 'workspace', 'legacy.md'), '# Together\n\nLegacy rich document.\n');
    const legacyMetadata = await getFileCollaborationState({ workspace, path: 'legacy.md', ensureDocument: true });
    await ensureCollaborationState({ documentId: legacyMetadata.document!.id, workspaceId: workspace.workspaceId,
      organizationId: 'org', path: 'legacy.md', representation: 'tiptap_xml', initialContent: '# Together\n\nLegacy rich document.\n' });
    const legacyParticipants: Array<{ id: string; token: string }> = [];
    for (const name of ['legacy-alice', 'legacy-bob', 'legacy-reader']) {
      const invitation = await guests.create({ workspace, path: 'legacy.md', email: `${name}@example.test`, permission: name.endsWith('reader') ? 'read' : 'write', expiresAt: null });
      await guests.challenge(invitation.id);
      legacyParticipants.push({ id: invitation.id, ...(await guests.verify(invitation.id, codes.at(-1)!.code, name)) });
    }
    await runFileGuestWebsocketScenario({ workspace, path: 'legacy.md', participants: legacyParticipants, representation: 'tiptap_xml' });
    await writeFile(path.join(tempRoot, 'workspace', 'rich.md'), '# Together\n\nA rich document.\n');
    const richParticipants: Array<{ id: string; token: string }> = [];
    for (const name of ['rich-alice', 'rich-bob', 'rich-reader']) {
      const invitation = await guests.create({ workspace, path: 'rich.md', email: `${name}@example.test`, permission: name.endsWith('reader') ? 'read' : 'write', expiresAt: null });
      await guests.challenge(invitation.id);
      richParticipants.push({ id: invitation.id, ...(await guests.verify(invitation.id, codes.at(-1)!.code, name)) });
    }
    await runFileGuestWebsocketScenario({ workspace, path: 'rich.md', participants: richParticipants, representation: 'tiptap_blocks' });
    const { moveFileCollaborationPath, archiveFileCollaborationPaths } = await import('../app/lib/files/collaboration-policy');
    await moveFileCollaborationPath({ workspace, oldPath: 'rich.md', newPath: 'renamed.md' });
    await rename(path.join(tempRoot, 'workspace', 'rich.md'), path.join(tempRoot, 'workspace', 'renamed.md'));
    await assert.rejects(guests.access(richParticipants[1].id, { token: richParticipants[1].token }), /widerrufen/);
    await moveFileCollaborationPath({ workspace, oldPath: 'renamed.md', newPath: 'rich.md' });
    await rename(path.join(tempRoot, 'workspace', 'renamed.md'), path.join(tempRoot, 'workspace', 'rich.md'));
    await assert.rejects(guests.access(richParticipants[1].id, { token: richParticipants[1].token }), /widerrufen/, 'Moving back never resurrects an invitation');
    const renewed = await guests.create({ workspace, path: 'rich.md', email: 'rich-bob@example.test', permission: 'write', expiresAt: null });
    assert.notEqual(renewed.id, richParticipants[1].id, 'Reinvitation after moving uses a fresh URL');
    await archiveFileCollaborationPaths({ workspace, paths: ['rich.md'] });
    assert.equal((await guests.list(workspace, 'rich.md')).find((invitation) => invitation.id === renewed.id)?.status, 'revoked');
    assert.equal(await readFile(path.join(tempRoot, 'workspace', 'notes.md'), 'utf8'), markdown, 'Guest policy operations do not rewrite the document');
    console.log('file-guest-access-test: scoped identities, parallel creation/codes/policies, OTP limits, assets, tickets, routes, revocation and expiry ok');
  } catch (error) {
    console.error('file guest test failed before cleanup:', error);
    throw error;
  } finally {
    Object.assign(Pool.prototype, original);
    await postgres.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
