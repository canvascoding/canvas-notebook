import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { fileGuestCookieName } from '../app/lib/file-guests/types';
import { whileWorkspaceOutputBlocked } from './collaboration-output-lock-test-helper';

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', completed = false;
process.once('beforeExit', () => {
  if (!completed) { console.error('Guest access fixture did not complete.', { stage }); process.exitCode = 1; }
});
const watchdog = setTimeout(() => {
  console.error('Guest access fixture exceeded its bounded deadline.', { stage }); process.exit(1);
}, 180_000);

async function main(): Promise<void> {
  const environment = { ...process.env };
  assert(process.env.NODE_ENV === undefined || process.env.NODE_ENV === 'test', 'Guest access fixtures require an unset or test NODE_ENV.');
  if (process.env.NODE_ENV === undefined) Object.assign(process.env, { NODE_ENV: 'test' });
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `guest_access_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^guest_access_[a-f0-9]{32}$/u);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-file-guests-'));
  const originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  let admin: Client | undefined, created = false, networkCalls = 0;
  let closeRuntime: (() => Promise<void>) | undefined;
  let restoreService: (() => void) | undefined;
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, {
      DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: tempRoot, CANVAS_DATA_ROOT: tempRoot,
      CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`, BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
      CANVAS_COLLABORATION_TICKET_SECRET: crypto.randomBytes(32).toString('hex'),
      BETTER_AUTH_BASE_URL: 'http://localhost', BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'org', CANVAS_DEPLOYMENT_MODE: 'team',
      CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production',
      CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
    });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.NEXT_PHASE;
    delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY; delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const licenseClaims = {
      protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'guest-access-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true },
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(licenseClaims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { networkCalls++; throw new Error('No external issuer or email is permitted in the owned Guest access fixture.'); };
    admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-access-fixture` });
    admin.on('error', () => undefined); await admin.connect();
    const fixture = admin;
    stage = 'actual original owned-schema global DDL';
    console.log('Owned Guest access fixture:', JSON.stringify({ pid: process.pid, schema, tempRoot }));
    // PostgreSQL permits the same trigger/constraint names on other relations.
    // These owned witnesses must not suppress this schema's native lifecycle DDL.
    await fixture.query(`CREATE TABLE fixture_lifecycle_name_witness (
      id text, CONSTRAINT collaboration_documents_yjs_state_lifecycle_check CHECK (id IS NOT NULL)
    )`);
    await fixture.query(`CREATE FUNCTION fixture_lifecycle_name_witness_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await fixture.query(`CREATE TRIGGER collaboration_yjs_state_initialized
      AFTER INSERT ON fixture_lifecycle_name_witness FOR EACH ROW EXECUTE FUNCTION fixture_lifecycle_name_witness_insert()`);
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      const before = (await fixture.query("SELECT current_schema() AS name,current_setting('search_path') AS path")).rows[0];
      assert.equal(before.name, schema); assert.deepEqual(before.path.split(',').map((part: string) => part.trim()), [schema, 'pg_catalog']);
      const result = await fixture.query(sql, values);
      assert.equal((await fixture.query('SELECT current_schema() AS name')).rows[0].name, schema); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    stage = 'native lifecycle DDL belongs to the actual relation despite same-name witnesses';
    assert.equal((await fixture.query(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname='collaboration_yjs_state_initialized' AND tgrelid='collaboration_yjs_states'::regclass`)).rows[0].count, 1,
    'An unrelated same-name trigger must not suppress the native initialization marker');
    assert.equal((await fixture.query(`SELECT count(*)::int AS count FROM pg_constraint
      WHERE conname='collaboration_documents_yjs_state_lifecycle_check' AND conrelid='collaboration_documents'::regclass`)).rows[0].count, 1,
    'An unrelated same-name constraint must not suppress the native lifecycle constraint');
    const now = Date.now();
    await fixture.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@example.test',1,'admin',0,$1,$1),('creator','Creator','creator@example.test',1,'user',0,$1,$1)`, [now]);
    await fixture.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('org','owner','team',1,100,100)`);
    await fixture.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('org','owner','owner','active',1,1,100,100),('org','creator','member','active',1,1,100,100)`);
    await fixture.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','org','owner@example.test','owner','owner','active',100,100,100,100),
        ('creator-seat','org','creator@example.test','creator','member','active',100,200,100,100)`);
    await fixture.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('org',100,100)");
    await fixture.query(`INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at)
      VALUES('workspace','org','organization','organizations/org/shared','Test','active',100,100)`);
    for (const userId of ['owner', 'creator']) await fixture.query(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES($1,'org','personal',$2,$3,$2,'active',100,100)`, [`personal-${userId}`, userId, `users/${userId}/workspace`]);
    const database = await import('../app/lib/db'); closeRuntime = database.closeDatabaseConnections;
    const { db } = database;
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime);
    assert.equal((await runtime.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const { user, session, fileGuestInvitations, fileGuestSessions } = await import('../app/lib/db/schema');
    const { requireTeamRuntimeLicense } = await import('../app/lib/license/entitlements');
    const license = await requireTeamRuntimeLicense();
    assert.equal(license.licensed, true); assert.equal(license.edition, 'team');
    assert.equal(license.databaseProvider, 'postgres'); assert.equal(license.capabilities.liveCollaboration, true);
    const tokens: Record<string, string> = {};
    for (const userId of ['owner', 'creator']) {
      tokens[userId] = crypto.randomBytes(32).toString('hex');
      await fixture.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5)`, [`session-${userId}`, tokens[userId], userId, now + 7 * 86400000, now]);
    }
    const memberRequest = () => new NextRequest('http://localhost/api/files/guests', {
      headers: { authorization: `Bearer ${tokens.creator}`, 'x-canvas-workspace-id': 'workspace' },
    });
    const { auth } = await import('../app/lib/auth');
    assert.equal((await auth.api.getSession({ headers: memberRequest().headers }))?.session.id, 'session-creator');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const currentWorkspace = async () => {
      const selected = await readPostgresWorkspaceForActor({ userId: 'creator', role: 'member' }, 'workspace');
      assert(selected); return selected;
    };
    const workspace = await currentWorkspace();
    assert.equal(workspace.actor?.userId, 'creator'); assert.equal(workspace.permissions.canManageWorkspace, false);
    assert.equal(workspace.permissions.canWrite, true); assert.equal(workspace.permissions.canCreatePublicLinks, true);
    assert(workspace.rootPath.startsWith(`${tempRoot}${path.sep}`)); await mkdir(workspace.rootPath, { recursive: true });
    const markdown = '# Shared\n\n![Visible](visible.png)\n\n`![Private](private.png)`\n';
    await writeFile(path.join(workspace.rootPath, 'notes.md'), markdown);
    await writeFile(path.join(workspace.rootPath, 'visible.png'), 'visible-image');
    await writeFile(path.join(workspace.rootPath, 'private.png'), 'private-image');
    const { createFileGuestService, fileGuestService } = await import('../app/lib/file-guests/service');
    const codes: Array<{ email: string; code: string }> = [];
    const guests = createFileGuestService({ sendCode: async (input) => { codes.push(input); } });
    const originalService = { ...fileGuestService }; restoreService = () => Object.assign(fileGuestService, originalService);
    Object.assign(fileGuestService, guests);
    const { GET: info } = await import('../app/api/files/info/route');
    const createGuest = async (filePath: string, email: string, permission: 'read' | 'write', expiresAt: Date | null) => {
      stage = `actual Info and Guest Create for ${filePath} (${permission})`;
      const response = await info(new NextRequest(`http://localhost/api/files/info?${new URLSearchParams({ path: filePath })}`, { headers: memberRequest().headers }));
      assert.equal(response.status, 200);
      const expectedTarget: unknown = (await response.json()).data.metadataTarget;
      try {
        return await guests.create(memberRequest(), { workspaceId: workspace.workspaceId, path: filePath, expectedTarget, email, permission, expiresAt });
      } catch (error) {
        const rows = (await fixture.query(`SELECT d.id,d.workspace_id,d.workspace_type,d.organization_id,d.path,d.lineage_id,
          d.provider,d.status,d.yjs_state_lifecycle,l.id AS lineage_id_actual,l.workspace_id AS lineage_workspace,
          l.workspace_type AS lineage_type,l.organization_id AS lineage_org,l.path AS lineage_path,l.status AS lineage_status,
          s.workspace_id AS state_workspace,s.organization_id AS state_org,s.path AS state_path,s.status AS state_status,
          s.lifecycle_generation,s.representation,s.schema_version FROM collaboration_documents d
          LEFT JOIN file_collaboration_lineages l ON l.id=d.lineage_id LEFT JOIN collaboration_yjs_states s ON s.document_id=d.id
          WHERE d.workspace_id=$1 AND d.path=$2`, [workspace.workspaceId, filePath])).rows;
        const triggers = (await fixture.query(`SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS trigger_name
          FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE t.tgname='collaboration_yjs_state_initialized' ORDER BY n.nspname,c.relname`)).rows;
        console.error('Actual Guest target metadata at failed Create:', { expectedTarget, rows, triggers });
        throw error;
      }
    };
    stage = 'actual member creation and current nonowner ACL';
    const alice = await createGuest('notes.md', 'alice@example.test', 'write', null);
    const bob = await createGuest('notes.md', 'bob@example.test', 'read', new Date(Date.now() + 60_000));
    const expiryGuard = await createGuest('notes.md', 'expiry-guard@example.test', 'write', null);
    await fixture.query("UPDATE organization_user_permissions SET can_write_team_workspace=0 WHERE organization_id='org' AND user_id='creator'");
    const noWriteWorkspace = await currentWorkspace();
    assert.equal(noWriteWorkspace.permissions.canRead, true); assert.equal(noWriteWorkspace.permissions.canWrite, false);
    await assert.rejects(guests.manage(memberRequest(), workspace.workspaceId, expiryGuard.id, {
      policyRevision: expiryGuard.policyRevision,
      expiresAt: new Date(Date.now() + 120_000),
    }), error => error instanceof Error && error.name === 'WorkspaceRequestPrincipalError'
      && Reflect.get(error, 'code') === 'PRINCIPAL_ACCESS_DENIED');
    const downgradedGuard = await guests.manage(memberRequest(), workspace.workspaceId, expiryGuard.id, {
      policyRevision: expiryGuard.policyRevision,
      permission: 'read',
      expiresAt: new Date(Date.now() + 120_000),
    });
    assert.equal(downgradedGuard.permission, 'read', 'Managers without write access may only reduce a write invitation');
    await fixture.query("UPDATE organization_user_permissions SET can_write_team_workspace=1 WHERE organization_id='org' AND user_id='creator'");
    assert.equal((await currentWorkspace()).permissions.canWrite, true);
    assert.equal(alice.assetCount, 1);
    const duplicate = await Promise.all(Array.from({ length: 12 }, () => createGuest('notes.md', 'alice@example.test', 'read', new Date(Date.now() + 60_000))));
    assert.ok(duplicate.every((entry) => entry.id === alice.id && entry.permission === 'write' && entry.expiresAt === null));
    await fixture.query("UPDATE organization_user_permissions SET can_create_public_links=0 WHERE organization_id='org' AND user_id='creator'");
    assert.equal((await currentWorkspace()).permissions.canCreatePublicLinks, false);
    await assert.rejects(createGuest('notes.md', 'mallory@example.test', 'write', null));
    await fixture.query("UPDATE organization_user_permissions SET can_create_public_links=1 WHERE organization_id='org' AND user_id='creator'");
    assert.equal((await currentWorkspace()).permissions.canCreatePublicLinks, true);
    const identityBaseline = { users: (await db.select().from(user)).length, sessions: (await db.select().from(session)).length };
    assert.equal(identityBaseline.users, 2); assert.equal(identityBaseline.sessions, 2);
    stage = 'concurrent OTP redemption, attempts and invitation scope';
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
    assert.equal((await db.select().from(user)).length, identityBaseline.users, 'Guest verification creates no app identity');
    assert.equal((await db.select().from(session)).length, identityBaseline.sessions, 'Guest verification creates no app session');
    assert.equal((await guests.asset(alice.id, credential.token, 'visible.png')).toString(), 'visible-image');
    await assert.rejects(guests.asset(alice.id, credential.token, 'private.png'), /nicht freigegeben/);
    await assert.rejects(guests.asset(alice.id, credential.token, '../private.png'));
    const { fileGuestCollaborationSession } = await import('../app/lib/file-guests/collaboration');
    const { verifyCollaborationTicket } = await import('../app/lib/collaboration/ticket');
    const { revalidateCollaborationAccess } = await import('../app/lib/collaboration/connection-access');
    const ticket = await fileGuestCollaborationSession(alice.id, credential.token);
    const claims = verifyCollaborationTicket(ticket.token);
    await whileWorkspaceOutputBlocked(workspace.workspaceId, async () => {
      await revalidateCollaborationAccess(claims);
      await assert.rejects(revalidateCollaborationAccess({ ...claims, lifecycleGeneration: claims.lifecycleGeneration + 1 }));
    });
    await assert.rejects(revalidateCollaborationAccess({ ...claims, path: 'private.md' }));
    await assert.rejects(revalidateCollaborationAccess({ ...claims, workspaceId: 'elsewhere' }));
    await assert.rejects(revalidateCollaborationAccess({ ...claims, documentId: 'elsewhere' }));
    await assert.rejects(revalidateCollaborationAccess({ ...claims, guestInvitationId: bob.id }));
    const { GET } = await import('../app/api/guest/files/[id]/route');
    const routeContext = { params: Promise.resolve({ id: alice.id }) };
    assert.equal((await GET(new NextRequest(`http://localhost/api/guest/files/${alice.id}`), routeContext)).status, 401);
    const response = await GET(new NextRequest(`http://localhost/api/guest/files/${alice.id}`, { headers: { cookie: `${fileGuestCookieName(alice.id)}=${credential.token}` } }), routeContext);
    assert.equal(response.status, 200);
    const responseBody = await response.json();
    const { isFileGuestContentBootstrap } = await import('../app/lib/file-guests/content-contract');
    assert.equal(isFileGuestContentBootstrap(responseBody.bootstrap), true);
    assert.equal(responseBody.bootstrap.kind, 'native_document');
    assert.match(JSON.stringify(responseBody.bootstrap.content), /Shared/);
    assert.equal(Object.hasOwn(responseBody, 'markdown'), false);
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
    stage = 'actual concurrent policy changes and idle ticket revocation';
    const changes = await Promise.allSettled(Array.from({ length: 8 }, () => guests.manage(memberRequest(), workspace.workspaceId, alice.id, { policyRevision: 1, permission: 'read' })));
    assert.equal(changes.filter((result) => result.status === 'fulfilled').length, 1);
    await whileWorkspaceOutputBlocked(workspace.workspaceId, async () => {
      await assert.rejects(revalidateCollaborationAccess(claims), /revoked/);
    });
    const reader = verifyCollaborationTicket((await fileGuestCollaborationSession(alice.id, credential.token)).token);
    assert.equal(reader.permission, 'read');
    await revalidateCollaborationAccess(reader);
    await guests.manage(memberRequest(), workspace.workspaceId, alice.id, { policyRevision: 2, revoke: true });
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
    stage = 'legacy Plain registry and state initialization before first invitation';
    await writeFile(path.join(workspace.rootPath, 'collaborate.md'), '# Together\n\n![[private-note]]\n');
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const { ensureCollaborationState } = await import('../app/lib/collaboration/persistence');
    const metadata = await getFileCollaborationState({ workspace, path: 'collaborate.md', ensureDocument: true });
    await ensureCollaborationState({ documentId: metadata.document!.id, workspaceId: workspace.workspaceId, organizationId: 'org',
      path: 'collaborate.md', representation: 'plain_text', initialContent: '# Together\n\n![[private-note]]\n' });
    const participants: Array<{ id: string; token: string }> = [];
    for (const name of ['live-alice', 'live-bob', 'live-reader']) {
      const invitation = await createGuest('collaborate.md', `${name}@example.test`, name.endsWith('reader') ? 'read' : 'write', null);
      await guests.challenge(invitation.id);
      const guest = await guests.verify(invitation.id, codes.at(-1)!.code, name);
      participants.push({ id: invitation.id, token: guest.token });
    }
    const { runFileGuestWebsocketScenario } = await import('./helpers/file-guest-websocket-scenario');
    stage = 'real Plain Hocuspocus edit, original restore, delete-only race and revocation';
    await runFileGuestWebsocketScenario({ workspace, path: 'collaborate.md', participants, representation: 'plain_text', memberRequest: memberRequest(), memberSessionId: 'session-creator' });
    stage = 'legacy XML registry and state initialization before first invitation';
    await writeFile(path.join(workspace.rootPath, 'legacy.md'), '# Together\n\nLegacy rich document.\n');
    const legacyMetadata = await getFileCollaborationState({ workspace, path: 'legacy.md', ensureDocument: true });
    await ensureCollaborationState({ documentId: legacyMetadata.document!.id, workspaceId: workspace.workspaceId,
      organizationId: 'org', path: 'legacy.md', representation: 'tiptap_xml', initialContent: '# Together\n\nLegacy rich document.\n' });
    const legacyParticipants: Array<{ id: string; token: string }> = [];
    for (const name of ['legacy-alice', 'legacy-bob', 'legacy-reader']) {
      const invitation = await createGuest('legacy.md', `${name}@example.test`, name.endsWith('reader') ? 'read' : 'write', null);
      await guests.challenge(invitation.id);
      legacyParticipants.push({ id: invitation.id, ...(await guests.verify(invitation.id, codes.at(-1)!.code, name)) });
    }
    stage = 'real XML Hocuspocus edit, original restore, delete-only race and revocation';
    await runFileGuestWebsocketScenario({ workspace, path: 'legacy.md', participants: legacyParticipants, representation: 'tiptap_xml', memberRequest: memberRequest(), memberSessionId: 'session-creator' });
    stage = 'physical rich original before first actual Blocks invitation';
    await writeFile(path.join(workspace.rootPath, 'rich.md'), '# Together\n\nA rich document.\n');
    const richParticipants: Array<{ id: string; token: string }> = [];
    for (const name of ['rich-alice', 'rich-bob', 'rich-reader']) {
      const invitation = await createGuest('rich.md', `${name}@example.test`, name.endsWith('reader') ? 'read' : 'write', null);
      await guests.challenge(invitation.id);
      richParticipants.push({ id: invitation.id, ...(await guests.verify(invitation.id, codes.at(-1)!.code, name)) });
    }
    stage = 'real Blocks Hocuspocus edit, original restore, delete-only race and revocation';
    await runFileGuestWebsocketScenario({ workspace, path: 'rich.md', participants: richParticipants, representation: 'tiptap_blocks', memberRequest: memberRequest(), memberSessionId: 'session-creator' });
    stage = 'Move/back and archive cannot resurrect a Guest grant';
    const { moveFileCollaborationPath, archiveFileCollaborationPaths } = await import('../app/lib/files/collaboration-policy');
    await moveFileCollaborationPath({ workspace, oldPath: 'rich.md', newPath: 'renamed.md' });
    await rename(path.join(workspace.rootPath, 'rich.md'), path.join(workspace.rootPath, 'renamed.md'));
    await assert.rejects(guests.access(richParticipants[1].id, { token: richParticipants[1].token }), /widerrufen/);
    await moveFileCollaborationPath({ workspace, oldPath: 'renamed.md', newPath: 'rich.md' });
    await rename(path.join(workspace.rootPath, 'renamed.md'), path.join(workspace.rootPath, 'rich.md'));
    await assert.rejects(guests.access(richParticipants[1].id, { token: richParticipants[1].token }), /widerrufen/, 'Moving back never resurrects an invitation');
    const renewed = await createGuest('rich.md', 'rich-bob@example.test', 'write', null);
    assert.notEqual(renewed.id, richParticipants[1].id, 'Reinvitation after moving uses a fresh URL');
    await archiveFileCollaborationPaths({ workspace, paths: ['rich.md'] });
    assert.equal((await guests.list(workspace, 'rich.md')).find((invitation) => invitation.id === renewed.id)?.status, 'revoked');
    assert.equal(await readFile(path.join(workspace.rootPath, 'notes.md'), 'utf8'), markdown, 'Guest policy operations do not rewrite the document');
    assert.equal(networkCalls, 0);
    console.log('file-guest-access-test: actual PG18/Auth/Team scoped identities, parallel creation/codes/policies, OTP limits, assets, tickets, routes, revocation, expiry and all three real Hocuspocus representations ok');
  } catch (error) {
    console.error('file guest test failed before cleanup:', error);
    throw error;
  } finally {
    restoreService?.(); globalThis.fetch = originalFetch;
    try { await closeRuntime?.(); }
    finally { try { await admin?.end(); }
      finally { try {
        if (created) {
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true);
        }
      } finally { await control.end(); await rm(tempRoot, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
      } }
    }
  }
}

main().then(() => { completed = true; clearTimeout(watchdog); }, error => {
  console.error('Guest access fixture failed:', { stage }); console.error(error);
  completed = true; clearTimeout(watchdog); process.exitCode = 1;
});
