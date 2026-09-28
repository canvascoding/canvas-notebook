import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
process.env.CANVAS_INSTANCE_ID = 'f183881f-d50b-4ad9-b6ed-bbf3b1d7f405';
process.env.CANVAS_INSTANCE_TOKEN = 'managed-test-token';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';
process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3001';

const organizationId = 'local-organization';
const centralOrganizationId = 'central-organization';

function certificate(seatLimit: number, entitlementsVersion = 1783338368, recovery = false, expiresAt?: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID,
      organizationId: centralOrganizationId,
      entitlementsVersion,
      seatLimit,
      ...(recovery ? {
        licenseClass: 'manual', nonBillable: true, grantId: 'manual-grant',
        licenseEnvironment: 'production', provider: 'manual',
        exp: Math.floor((expiresAt ?? Date.now() + 15 * 60_000) / 1000),
      } : {}),
    })).toString('base64url'),
    'signature-placeholder',
  ].join('.');
}

async function setupDatabase(dataDir: string) {
  let pg = new PGlite(dataDir);
  let mutationCount = 0;
  await pg.exec(`
    CREATE TABLE canvas_organization_settings (organization_id text PRIMARY KEY, owner_user_id text);
    CREATE TABLE team_memberships (
      id text PRIMARY KEY, organization_id text NOT NULL, user_id text,
      candidate_email text NOT NULL, role text NOT NULL, status text NOT NULL,
      accepted_at bigint, activated_at bigint, suspended_at bigint, removed_at bigint,
      updated_at bigint
    );
    CREATE TABLE managed_team_pending_identities (
      local_identity_key text PRIMARY KEY, organization_id text NOT NULL,
      pending_user_id text NOT NULL
    );
    CREATE TABLE "user" (
      id text PRIMARY KEY, email text NOT NULL, role text NOT NULL, banned integer NOT NULL,
      ban_reason text, ban_expires bigint, updated_at bigint
    );
    CREATE TABLE "session" (id text PRIMARY KEY, user_id text NOT NULL);
    CREATE TABLE organization_user_permissions (
      organization_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
      status text NOT NULL, can_write_team_workspace integer,
      can_create_public_links integer, can_create_team_automations integer,
      can_share_plugins_and_skills integer, can_export integer,
      can_delete_team_files integer, can_delete_studio_assets integer,
      can_manage_backups integer, can_manage_organization_memory integer,
      can_migrate_database integer, can_enable_knowledge integer,
      can_recover_workspaces integer, created_at bigint, updated_at bigint,
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE audit_events (
      id text PRIMARY KEY, organization_id text NOT NULL, user_id text NOT NULL,
      source text NOT NULL, event_type text NOT NULL, entity_type text NOT NULL,
      entity_id text NOT NULL, action text NOT NULL, status text NOT NULL,
      summary text NOT NULL, metadata_json text, created_at bigint NOT NULL
    );
    CREATE TABLE team_license_email_outbox (
      id text PRIMARY KEY, audit_event_id text NOT NULL, organization_id text NOT NULL,
      user_id text NOT NULL, event_kind text NOT NULL, reason text NOT NULL,
      seat_limit bigint NOT NULL, status text NOT NULL, attempts bigint NOT NULL,
      next_attempt_at bigint NOT NULL, lease_until bigint, message_id text,
      error text, created_at bigint NOT NULL, delivered_at bigint, updated_at bigint NOT NULL,
      UNIQUE (audit_event_id, user_id)
    );
  `);
  await pg.query('INSERT INTO canvas_organization_settings (organization_id, owner_user_id) VALUES ($1, $2)', [organizationId, 'user-owner']);
  return {
    get pg() { return pg; },
    async reopen() {
      await pg.close();
      pg = new PGlite(dataDir);
    },
    async close() { await pg.close(); },
    get mutationCount() { return mutationCount; },
    database: {
      async all(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows; },
      async get(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows[0]; },
      async run(sql: string, params?: unknown[]) {
        const result = await pg.query(sql, params);
        if (/^\s*(UPDATE|DELETE)\s/i.test(sql)) mutationCount += result.affectedRows ?? 0;
        return { changes: result.affectedRows ?? 0 };
      },
      async close() {},
    },
  };
}

async function crashBoundaryScenario() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-managed-sync-crash-'));
  process.env.DATA = dataDir;
  const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
  const fixture = await setupDatabase(dataDir);
  const { database } = fixture;
  const certificatePath = join(dataDir, 'activated-certificate.txt');
  try {
    await fixture.pg.query(`
      INSERT INTO team_memberships (id, organization_id, user_id, candidate_email, role, status)
      VALUES ('member-owner', $1, 'user-owner', 'owner@example.test', 'owner', 'active'),
        ('member-revoked', $1, 'user-revoked', 'revoked@example.test', 'member', 'active'),
        ('member-new', $1, NULL, 'new@example.test', 'member', 'approval_required')
    `, [organizationId]);
    await fixture.pg.query(`
      INSERT INTO "user" (id, email, role, banned, ban_reason)
      VALUES ('user-owner', 'owner@example.test', 'admin', 0, NULL),
        ('user-revoked', 'revoked@example.test', 'user', 0, NULL),
        ('user-new', 'new@example.test', 'user', 1, 'canvas_team_membership_pending')
    `);
    await fixture.pg.query(`
      INSERT INTO managed_team_pending_identities (local_identity_key, organization_id, pending_user_id)
      VALUES ('member-new', $1, 'user-new')
    `, [organizationId]);
    await fixture.pg.query(`
      INSERT INTO organization_user_permissions (organization_id, user_id, role, status)
      VALUES ($1, 'user-owner', 'owner', 'active'), ($1, 'user-revoked', 'member', 'active')
    `, [organizationId]);
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('revoked-session', 'user-revoked')`);
    const members = [
      { externalUserId: 'central-owner', email: 'owner@example.test', role: 'owner', status: 'active', localIdentityKey: 'member-owner', localUserId: 'user-owner' },
      { externalUserId: 'central-revoked', email: 'revoked@example.test', role: 'member', status: 'removed', localIdentityKey: 'member-revoked', localUserId: 'user-revoked' },
      { externalUserId: 'central-new', email: 'new@example.test', role: 'member', status: 'active', localIdentityKey: 'member-new', localUserId: 'user-new' },
    ];
    const cert = certificate(2);
    const fingerprint = createHash('sha256').update(cert).digest('hex');
    let payload: Record<string, unknown> = {
      status: 'ready', instanceId: process.env.CANVAS_INSTANCE_ID,
      organizationId: centralOrganizationId, membershipRevision: 20,
      memberHash: createHash('sha256').update(JSON.stringify([...members]
        .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId)))).digest('hex'), members,
      license: { certificate: cert, entitlementsVersion: 1783338368, fingerprint, seatLimit: 2 },
    };
    const acknowledgements: Array<Record<string, unknown>> = [];
    let loseAck = false;
    let offline = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (offline) throw new Error('CONTROL_PLANE_OFFLINE');
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/sync')) return new Response(JSON.stringify(payload), { status: 200 });
      if (path.endsWith('/sync/ack')) {
        acknowledgements.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (loseAck) throw new Error('ACK_RESPONSE_LOST');
        return new Response(JSON.stringify({ status: 'acknowledged' }), { status: 200 });
      }
      throw new Error(`Unexpected endpoint ${path}`);
    }) as typeof fetch;
    const options = {
      database, fetchImpl, verifyCertificate: async () => true,
      activateCertificate: async () => {
        await writeFile(certificatePath, fingerprint);
        return { licensed: true, hostingMode: 'cloud', edition: 'team', seatLimit: 2 } as
          Awaited<ReturnType<typeof import('../app/lib/license').activateLicenseCert>>;
      },
    };
    assert.equal(await runManagedTeamSyncCycle({
      ...options, activateCertificate: async () => { throw new Error('CERTIFICATE_STORAGE_FAILED'); },
    }), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'CERTIFICATE_STORAGE_FAILED');
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-revoked'`)).rows[0].status, 'removed');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-revoked'`)).rows.length, 0);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'approval_required');
    assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 1);
    await assert.rejects(readFile(certificatePath), { code: 'ENOENT' });

    await fixture.reopen();
    const failedActivationDatabase = {
      ...database,
      async run(sql: string, params?: unknown[]) {
        if (/UPDATE "user" SET role = \$1, banned = 0/u.test(sql)) return { changes: 0 };
        return database.run(sql, params);
      },
    };
    assert.equal(await runManagedTeamSyncCycle({ ...options, database: failedActivationDatabase }), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_PENDING_IDENTITY_CHANGED');
    assert.equal(await readFile(certificatePath, 'utf8'), fingerprint);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'approval_required');
    assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 1);
    assert.equal((await fixture.pg.query(`SELECT user_id FROM organization_user_permissions WHERE user_id = 'user-new'`)).rows.length, 0);

    await fixture.reopen();
    loseAck = true;
    await assert.rejects(runManagedTeamSyncCycle(options), /ACK_RESPONSE_LOST/);
    assert.equal(acknowledgements.at(-1)?.error, undefined);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'active');
    assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 0);
    const mutationsAfterApply = fixture.mutationCount;
    await fixture.reopen();
    loseAck = false;
    assert.equal(await runManagedTeamSyncCycle(options), 'applied');
    assert.equal(acknowledgements.at(-1)?.error, undefined);
    assert.equal(fixture.mutationCount, mutationsAfterApply);
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-revoked'`)).rows.length, 0);
    assert.equal(await readFile(certificatePath, 'utf8'), fingerprint);

    const originalNow = Date.now;
    const certificateEnd = Math.floor(originalNow() / 1000) * 1000 + 60_000;
    const restrictedMembers = members.map((member) => member.externalUserId === 'central-new'
      ? { ...member, status: 'suspended' } : member);
    const restrictedCertificate = certificate(1, 1783338369, true, certificateEnd);
    payload = {
      status: 'policy_ready', instanceId: process.env.CANVAS_INSTANCE_ID,
      organizationId: centralOrganizationId, membershipRevision: 21,
      memberHash: createHash('sha256').update(JSON.stringify([...restrictedMembers]
        .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId)))).digest('hex'),
      members: restrictedMembers,
      accessPolicy: {
        state: 'restricted', reason: 'grant_revoked', termEndsAt: new Date(certificateEnd - 60_000).toISOString(),
        graceEndsAt: null, allowNewMembers: false,
      },
      license: {
        certificate: restrictedCertificate, entitlementsVersion: 1783338369,
        fingerprint: createHash('sha256').update(restrictedCertificate).digest('hex'), seatLimit: 1,
      },
    };
    try {
      Date.now = () => certificateEnd;
      assert.equal(await runManagedTeamSyncCycle(options), 'pending');
      assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_ACCESS_POLICY_CERTIFICATE_MISMATCH');
      assert.equal(fixture.mutationCount, mutationsAfterApply);
      assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'active');

      Date.now = () => certificateEnd - 1_000;
      assert.equal(await runManagedTeamSyncCycle({
        ...options,
        activateCertificate: async () => ({
          licensed: true, hostingMode: 'cloud', edition: 'team', seatLimit: 1,
        }) as Awaited<ReturnType<typeof import('../app/lib/license').activateLicenseCert>>,
      }), 'applied');
      assert.equal(acknowledgements.at(-1)?.error, undefined);
      assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'suspended');
      assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 1);
      await fixture.reopen();
      offline = true;
      Date.now = () => certificateEnd + 1_000;
      await assert.rejects(runManagedTeamSyncCycle(options), /CONTROL_PLANE_OFFLINE/);
      assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'suspended');
      assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 1);
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function emailChangeScenario() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-managed-sync-email-'));
  process.env.DATA = dataDir;
  const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
  const fixture = await setupDatabase(dataDir);
  try {
    await fixture.pg.query(`
      INSERT INTO team_memberships (id, organization_id, user_id, candidate_email, role, status)
      VALUES ('member-owner', $1, 'user-owner', 'owner@example.test', 'owner', 'active'),
        ('member-other', $1, 'user-other', 'other@example.test', 'member', 'active')
    `, [organizationId]);
    await fixture.pg.query(`
      INSERT INTO "user" (id, email, role, banned)
      VALUES ('user-owner', 'owner@example.test', 'admin', 0),
        ('user-other', 'other@example.test', 'user', 0),
        ('user-conflict', 'conflict@example.test', 'user', 0)
    `);
    await fixture.pg.query(`
      INSERT INTO organization_user_permissions (organization_id, user_id, role, status)
      VALUES ($1, 'user-owner', 'owner', 'active'), ($1, 'user-other', 'member', 'active')
    `, [organizationId]);
    const members = [
      { externalUserId: 'central-owner', email: 'owner@example.test', role: 'owner', status: 'active', localIdentityKey: 'member-owner', localUserId: 'user-owner' },
      { externalUserId: 'central-other', email: 'other@example.test', role: 'member', status: 'active', localIdentityKey: 'member-other', localUserId: 'user-other' },
    ];
    const cert = certificate(2);
    const fingerprint = createHash('sha256').update(cert).digest('hex');
    const acknowledgements: Array<Record<string, unknown>> = [];
    let desiredMembers = members;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/sync')) return new Response(JSON.stringify({
        status: 'ready', instanceId: process.env.CANVAS_INSTANCE_ID,
        organizationId: centralOrganizationId, membershipRevision: 10,
        memberHash: createHash('sha256').update(JSON.stringify([...desiredMembers]
          .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId))
          .map((member) => ({ ...member, email: member.email.toLowerCase() })))).digest('hex'),
        members: desiredMembers,
        license: { certificate: cert, entitlementsVersion: 1783338368, fingerprint, seatLimit: 2 },
      }), { status: 200 });
      if (path.endsWith('/sync/ack')) {
        acknowledgements.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ status: 'acknowledged' }), { status: 200 });
      }
      throw new Error(`Unexpected endpoint ${path}`);
    }) as typeof fetch;
    const options = {
      database: fixture.database, fetchImpl, verifyCertificate: async () => true,
      activateCertificate: async () => ({ licensed: true, hostingMode: 'cloud', edition: 'team', seatLimit: 2 }) as
        Awaited<ReturnType<typeof import('../app/lib/license').activateLicenseCert>>,
    };
    assert.equal(await runManagedTeamSyncCycle(options), 'applied');
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('old-email-session', 'user-other')`);
    desiredMembers = members.map((member) => member.externalUserId === 'central-other'
      ? { ...member, email: 'renamed@example.test' } : member);
    assert.equal(await runManagedTeamSyncCycle(options), 'applied');
    assert.equal(acknowledgements.at(-1)?.error, undefined);
    assert.deepEqual((await fixture.pg.query<{ user_id: string; candidate_email: string }>(`
      SELECT user_id, candidate_email FROM team_memberships WHERE id = 'member-other'
    `)).rows[0], { user_id: 'user-other', candidate_email: 'renamed@example.test' });
    assert.equal((await fixture.pg.query<{ email: string }>(`
      SELECT email FROM "user" WHERE id = 'user-other'
    `)).rows[0].email, 'renamed@example.test');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-other'`)).rows.length, 0);
    const mutationsAfterChange = fixture.mutationCount;
    assert.equal(await runManagedTeamSyncCycle(options), 'applied');
    assert.equal(fixture.mutationCount, mutationsAfterChange);

    desiredMembers = members.map((member) => member.externalUserId === 'central-other'
      ? { ...member, email: 'next@example.test' } : member);
    const failingEmailDatabase = {
      ...fixture.database,
      async run(sql: string, params?: unknown[]) {
        if (/UPDATE "user" SET email = \$1/u.test(sql)) return { changes: 0 };
        return fixture.database.run(sql, params);
      },
    };
    assert.equal(await runManagedTeamSyncCycle({ ...options, database: failingEmailDatabase }), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_ACTIVE_IDENTITY_CHANGED');
    assert.equal((await fixture.pg.query<{ candidate_email: string }>(`
      SELECT candidate_email FROM team_memberships WHERE id = 'member-other'
    `)).rows[0].candidate_email, 'renamed@example.test');
    assert.equal((await fixture.pg.query<{ email: string }>(`
      SELECT email FROM "user" WHERE id = 'user-other'
    `)).rows[0].email, 'renamed@example.test');

    desiredMembers = members.map((member) => member.externalUserId === 'central-other'
      ? { ...member, email: 'conflict@example.test' } : member);
    assert.equal(await runManagedTeamSyncCycle(options), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_EMAIL_CONFLICT');
    assert.equal((await fixture.pg.query<{ candidate_email: string }>(`
      SELECT candidate_email FROM team_memberships WHERE id = 'member-other'
    `)).rows[0].candidate_email, 'renamed@example.test');
    assert.equal((await fixture.pg.query<{ email: string }>(`
      SELECT email FROM "user" WHERE id = 'user-other'
    `)).rows[0].email, 'renamed@example.test');
    assert.equal((await fixture.pg.query<{ email: string }>(`
      SELECT email FROM "user" WHERE id = 'user-conflict'
    `)).rows[0].email, 'conflict@example.test');
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('remove-session', 'user-other')`);
    desiredMembers = desiredMembers.map((member) => member.externalUserId === 'central-other'
      ? { ...member, status: 'removed' } : member);
    assert.equal(await runManagedTeamSyncCycle(options), 'applied');
    assert.equal(acknowledgements.at(-1)?.error, undefined);
    assert.equal((await fixture.pg.query<{ status: string }>(`
      SELECT status FROM team_memberships WHERE id = 'member-other'
    `)).rows[0].status, 'removed');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-other'`)).rows.length, 0);
    console.info('managed team stable-ID email changes and conflicts passed');
  } finally {
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-managed-sync-recovery-'));
  process.env.DATA = dataDir;
  const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
  const { readManagedTeamAccessPolicy } = await import('../app/lib/license/managed-team-access-policy');
  const { recordHumanActivity } = await import('../app/lib/instance/human-activity');
  const { isAdminUser } = await import('../app/lib/admin-auth');
  const fixture = await setupDatabase(dataDir);
  const { database } = fixture;
  try {
    await fixture.pg.query(`
      INSERT INTO team_memberships (id, organization_id, user_id, candidate_email, role, status)
      VALUES ('member-owner', $1, 'user-owner', 'owner@example.test', 'owner', 'active'),
        ('member-revoked', $1, 'user-revoked', 'revoked@example.test', 'member', 'active'),
        ('member-new', $1, NULL, 'new@example.test', 'member', 'approval_required'),
        ('member-grace-new', $1, NULL, 'grace-new@example.test', 'member', 'approval_required')
    `, [organizationId]);
    await fixture.pg.query(`
      INSERT INTO "user" (id, email, role, banned, ban_reason)
      VALUES ('user-owner', 'owner@example.test', 'admin', 0, NULL),
        ('user-revoked', 'revoked@example.test', 'user', 0, NULL),
        ('user-new', 'new@example.test', 'user', 1, 'canvas_team_membership_pending'),
        ('user-grace-new', 'grace-new@example.test', 'user', 1, 'canvas_team_membership_pending')
    `);
    await fixture.pg.query(`
      INSERT INTO managed_team_pending_identities (local_identity_key, organization_id, pending_user_id)
      VALUES ('member-new', $1, 'user-new'), ('member-grace-new', $1, 'user-grace-new')
    `, [organizationId]);
    await fixture.pg.query(`
      INSERT INTO organization_user_permissions (organization_id, user_id, role, status)
      VALUES ($1, 'user-owner', 'owner', 'active'), ($1, 'user-revoked', 'member', 'active')
    `, [organizationId]);
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('revoked-session', 'user-revoked')`);
    const members = [
      { externalUserId: 'central-new', email: 'new@example.test', role: 'member', status: 'active', localIdentityKey: 'member-new', localUserId: 'user-new' },
      { externalUserId: 'central-owner', email: 'owner@example.test', role: 'owner', status: 'active', localIdentityKey: 'member-owner', localUserId: 'user-owner' },
      { externalUserId: 'central-revoked', email: 'revoked@example.test', role: 'member', status: 'removed', localIdentityKey: 'member-revoked', localUserId: 'user-revoked' },
    ];
    const cert = certificate(2);
    let offeredSeatLimit = 2;
    let syncPayload: Record<string, unknown> = {
      status: 'ready', instanceId: process.env.CANVAS_INSTANCE_ID,
      organizationId: centralOrganizationId, membershipRevision: 2,
      memberHash: createHash('sha256').update(JSON.stringify(members)).digest('hex'),
      members,
      license: {
        certificate: cert, entitlementsVersion: 1783338368,
        fingerprint: createHash('sha256').update(cert).digest('hex'), seatLimit: 2,
      },
    };
    const acknowledgements: Array<Record<string, unknown>> = [];
    let transport: 'offline' | 'ack_lost' | 'online' = 'offline';
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (transport === 'offline') throw new Error('CONTROL_PLANE_OFFLINE');
      if (path.endsWith('/sync')) {
        return new Response(JSON.stringify(syncPayload), { status: 200 });
      }
      if (path.endsWith('/sync/ack')) {
        acknowledgements.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (transport === 'ack_lost') throw new Error('ACK_RESPONSE_LOST');
        return new Response(JSON.stringify({ status: 'acknowledged' }), { status: 200 });
      }
      throw new Error(`Unexpected endpoint ${path}`);
    }) as typeof fetch;
    let activationCount = 0;
    const syncOptions = {
      database,
      fetchImpl,
      activateCertificate: async () => {
        activationCount++;
        return { licensed: true, hostingMode: 'cloud', edition: 'team', seatLimit: offeredSeatLimit } as
          Awaited<ReturnType<typeof import('../app/lib/license').activateLicenseCert>>;
      },
      verifyCertificate: async () => true,
    };
    await assert.rejects(runManagedTeamSyncCycle(syncOptions), /CONTROL_PLANE_OFFLINE/);
    assert.equal(activationCount, 0);
    assert.equal(fixture.mutationCount, 0);
    assert.equal(await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!), null);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-revoked'`)).rows[0].status, 'active');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-revoked'`)).rows.length, 1);

    transport = 'ack_lost';
    await assert.rejects(runManagedTeamSyncCycle(syncOptions), /ACK_RESPONSE_LOST/);
    assert.equal(activationCount, 1);
    assert.equal(acknowledgements.length, 2);
    assert(acknowledgements.every((ack) => ack.error === undefined && ack.appliedMemberCount === 2));
    assert(acknowledgements.every((ack) => ack.lastHumanActivityAt === undefined));
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-revoked'`)).rows[0].status, 'removed');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-revoked'`)).rows.length, 0);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'active');
    const mutationsAfterApply = fixture.mutationCount;

    await fixture.reopen();
    transport = 'online';
    const result = await runManagedTeamSyncCycle(syncOptions);
    assert.equal(result, 'applied');
    assert.equal(acknowledgements.length, 3);
    assert.deepEqual(acknowledgements[2], acknowledgements[0]);
    assert.equal(fixture.mutationCount, mutationsAfterApply);
    const revoked = await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-revoked'`);
    assert.equal(revoked.rows[0].status, 'removed');
    const sessions = await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-revoked'`);
    assert.equal(sessions.rows.length, 0);
    const activated = await fixture.pg.query<{ status: string; user_id: string }>(`SELECT status, user_id FROM team_memberships WHERE id = 'member-new'`);
    assert.deepEqual(activated.rows[0].status, 'active');
    assert.equal(activated.rows[0].user_id, 'user-new');
    const pendingUser = await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`);
    assert.equal(pendingUser.rows[0].banned, 0);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal(fixture.mutationCount, mutationsAfterApply);
    assert.deepEqual(acknowledgements[3], acknowledgements[2]);
    assert.equal((await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!))?.allowNewMembers, true);
    const humanActivityAt = (await recordHumanActivity(new Date(Date.now() - 90_000))).lastHumanActivityAt;

    const graceEndsAt = Date.now() + 7 * 24 * 60 * 60_000;
    const graceMembers = [
      ...members,
      { externalUserId: 'central-grace-new', email: 'grace-new@example.test', role: 'member',
        status: 'suspended', localIdentityKey: 'member-grace-new', localUserId: 'user-grace-new' },
    ];
    const policyOffer = (
      revision: number,
      desiredMembers: typeof graceMembers,
      seatLimit: number,
      state: 'grace' | 'restricted',
      reason: 'grant_expired' | 'grant_revoked',
      expiry: number,
    ) => {
      const version = 1783338368 + revision;
      const offeredCertificate = certificate(seatLimit, version, true, expiry);
      offeredSeatLimit = seatLimit;
      syncPayload = {
        status: 'policy_ready', instanceId: process.env.CANVAS_INSTANCE_ID,
        organizationId: centralOrganizationId, membershipRevision: revision,
        memberHash: createHash('sha256').update(JSON.stringify([...desiredMembers]
          .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId)))).digest('hex'),
        members: desiredMembers,
        accessPolicy: { state, reason, termEndsAt: new Date(graceEndsAt - 7 * 24 * 60 * 60_000).toISOString(), graceEndsAt: reason === 'grant_expired'
          ? new Date(graceEndsAt).toISOString() : null, allowNewMembers: false },
        license: { certificate: offeredCertificate, entitlementsVersion: version,
          fingerprint: createHash('sha256').update(offeredCertificate).digest('hex'), seatLimit },
      };
    };
    policyOffer(3, graceMembers, 2, 'grace', 'grant_expired', graceEndsAt - 60_000);
    const validGraceOffer = syncPayload;
    syncPayload = { ...validGraceOffer, accessPolicy: undefined };
    await assert.rejects(runManagedTeamSyncCycle(syncOptions), /MANAGED_TEAM_ACCESS_POLICY_INVALID/);
    syncPayload = validGraceOffer;
    const mutationsBeforeGrace = fixture.mutationCount;
    assert.equal(await runManagedTeamSyncCycle({ ...syncOptions, verifyCertificate: async () => false }), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_CERTIFICATE_INVALID');
    assert.equal(fixture.mutationCount, mutationsBeforeGrace);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal(acknowledgements.at(-1)?.appliedMemberCount, 2);
    assert.equal(acknowledgements.at(-1)?.lastHumanActivityAt, humanActivityAt);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-grace-new'`)).rows[0].status, 'approval_required');
    assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-grace-new'`)).rows[0].banned, 1);
    assert.deepEqual(await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!), {
      state: 'grace', reason: 'grant_expired', graceEndsAt: new Date(graceEndsAt).toISOString(), allowNewMembers: false,
    });

    const restrictedMembers = graceMembers.map((member) => member.externalUserId === 'central-new'
      ? { ...member, status: 'suspended' } : member);
    policyOffer(4, restrictedMembers, 1, 'restricted', 'grant_revoked', Date.now() + 15 * 60_000);
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('owner-session', 'user-owner'), ('new-session', 'user-new')`);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal(acknowledgements.at(-1)?.appliedMemberCount, 1);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'suspended');
    assert.equal((await fixture.pg.query<{ ban_reason: string }>(`SELECT ban_reason FROM "user" WHERE id = 'user-new'`)).rows[0].ban_reason, 'canvas_team_license_fallback');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-new'`)).rows.length, 0);
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-owner'`)).rows.length, 1);
    assert.equal((await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!))?.state, 'restricted');
    const mutationsAfterRestriction = fixture.mutationCount;
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal(fixture.mutationCount, mutationsAfterRestriction);
    assert.equal(acknowledgements.at(-1)?.lastHumanActivityAt, humanActivityAt);

    const restoredMembers = graceMembers.map((member) => member.status === 'suspended'
      ? { ...member, status: 'active' } : member);
    const restoredCertificate = certificate(3, 1783338373, true, Date.now() + 15 * 60_000);
    const restoredTerm = new Date(Date.now() + 13 * 24 * 60 * 60_000).toISOString();
    offeredSeatLimit = 3;
    syncPayload = {
      status: 'ready', instanceId: process.env.CANVAS_INSTANCE_ID,
      organizationId: centralOrganizationId, membershipRevision: 5,
      memberHash: createHash('sha256').update(JSON.stringify([...restoredMembers]
        .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId)))).digest('hex'),
      members: restoredMembers,
      accessPolicy: { state: 'active', reason: null, termEndsAt: restoredTerm, graceEndsAt: null, allowNewMembers: true },
      license: { certificate: restoredCertificate, entitlementsVersion: 1783338373,
        fingerprint: createHash('sha256').update(restoredCertificate).digest('hex'), seatLimit: 3 },
    };
    const warningsBeforeInvalidCertificate = (await fixture.pg.query(`
      SELECT id FROM audit_events WHERE event_type = 'license_term_warning'
    `)).rows.length;
    assert.equal(await runManagedTeamSyncCycle({ ...syncOptions, verifyCertificate: async () => false }), 'pending');
    assert.equal((await fixture.pg.query(`SELECT id FROM audit_events WHERE event_type = 'license_term_warning'`)).rows.length,
      warningsBeforeInvalidCertificate);
    assert.equal(await runManagedTeamSyncCycle({
      ...syncOptions,
      recordTermWarning: async () => { throw new Error('FAKE_NOTIFICATION_STORE_OFFLINE'); },
    }), 'applied');
    assert.equal(acknowledgements.at(-1)?.error, undefined);
    assert.equal((await fixture.pg.query(`SELECT id FROM audit_events WHERE event_type = 'license_term_warning'`)).rows.length,
      warningsBeforeInvalidCertificate);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal(acknowledgements.at(-1)?.appliedMemberCount, 3);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'active');
    assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 0);
    assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-grace-new'`)).rows[0].status, 'active');
    assert.equal((await readManagedTeamAccessPolicy(process.env.CANVAS_INSTANCE_ID!))?.allowNewMembers, true);
    assert.equal((await fixture.pg.query(`SELECT id FROM audit_events WHERE event_type = 'license_term_warning'`)).rows.length,
      warningsBeforeInvalidCertificate + 3);
    assert.equal((await fixture.pg.query(`SELECT id FROM team_license_email_outbox WHERE event_kind = 'owner_term_14d'`)).rows.length, 1);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal((await fixture.pg.query(`SELECT id FROM audit_events WHERE event_type = 'license_term_warning'`)).rows.length,
      warningsBeforeInvalidCertificate + 3);
    const perpetualCertificate = certificate(3, 1783338374, true, Date.now() + 15 * 60_000);
    syncPayload = {
      ...syncPayload,
      membershipRevision: 6,
      accessPolicy: { state: 'active', reason: null, termEndsAt: null, graceEndsAt: null, allowNewMembers: true },
      license: { certificate: perpetualCertificate, entitlementsVersion: 1783338374,
        fingerprint: createHash('sha256').update(perpetualCertificate).digest('hex'), seatLimit: 3 },
    };
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    assert.equal((await fixture.pg.query(`SELECT id FROM audit_events WHERE event_type = 'license_term_warning'`)).rows.length,
      warningsBeforeInvalidCertificate + 3);
    const offerRole = (revision: number, role: 'admin' | 'member') => {
      const nextMembers = restoredMembers.map((member) => member.externalUserId === 'central-new'
        ? { ...member, role } : member);
      const version = 1783338374 + revision - 6;
      const nextCertificate = certificate(3, version, true, Date.now() + 15 * 60_000);
      syncPayload = {
        ...syncPayload,
        membershipRevision: revision,
        memberHash: createHash('sha256').update(JSON.stringify([...nextMembers]
          .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId)))).digest('hex'),
        members: nextMembers,
        license: { certificate: nextCertificate, entitlementsVersion: version,
          fingerprint: createHash('sha256').update(nextCertificate).digest('hex'), seatLimit: 3 },
      };
    };
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('pre-promotion-session', 'user-new')`);
    offerRole(7, 'admin');
    const failingRoleDatabase = {
      ...database,
      async run(sql: string, params?: unknown[]) {
        if (/UPDATE "user" SET role = \$1, updated_at = \$2/u.test(sql)) return { changes: 0 };
        return database.run(sql, params);
      },
    };
    assert.equal(await runManagedTeamSyncCycle({ ...syncOptions, database: failingRoleDatabase }), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_ACTIVE_IDENTITY_CHANGED');
    assert.equal((await fixture.pg.query<{ role: string }>(`SELECT role FROM team_memberships WHERE id = 'member-new'`)).rows[0].role, 'member');
    assert.equal((await fixture.pg.query<{ role: string }>(`SELECT role FROM organization_user_permissions WHERE user_id = 'user-new'`)).rows[0].role, 'member');
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-new'`)).rows.length, 1);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    let identity = (await fixture.pg.query<{ email: string; role: string }>(`SELECT email, role FROM "user" WHERE id = 'user-new'`)).rows[0];
    assert.equal(isAdminUser(identity), true);
    assert.equal((await fixture.pg.query<{ role: string; can_manage_backups: number }>(`
      SELECT role, can_manage_backups FROM organization_user_permissions WHERE user_id = 'user-new'
    `)).rows[0].can_manage_backups, 1);
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-new'`)).rows.length, 0);
    const previousBootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'new@example.test';
    for (const status of ['suspended', 'removed'] as const) {
      const blockedMembers = (syncPayload.members as typeof restoredMembers).map((member) => member.externalUserId === 'central-new'
        ? { ...member, status } : member);
      syncPayload = {
        ...syncPayload,
        members: blockedMembers,
        memberHash: createHash('sha256').update(JSON.stringify([...blockedMembers]
          .sort((left, right) => left.externalUserId.localeCompare(right.externalUserId)))).digest('hex'),
      };
      assert.equal(await runManagedTeamSyncCycle(syncOptions), 'pending');
      assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_BOOTSTRAP_ADMIN_ACCESS_DENIED');
      assert.equal((await fixture.pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-new'`)).rows[0].status, 'active');
      assert.equal((await fixture.pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`)).rows[0].banned, 0);
    }
    offerRole(8, 'member');
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'pending');
    assert.equal(acknowledgements.at(-1)?.error, 'MANAGED_TEAM_BOOTSTRAP_ADMIN_ACCESS_DENIED');
    assert.equal((await fixture.pg.query<{ role: string }>(`SELECT role FROM "user" WHERE id = 'user-new'`)).rows[0].role, 'admin');
    if (previousBootstrapEmail === undefined) delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    else process.env.BOOTSTRAP_ADMIN_EMAIL = previousBootstrapEmail;
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('pre-demotion-session', 'user-new')`);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    identity = (await fixture.pg.query<{ email: string; role: string }>(`SELECT email, role FROM "user" WHERE id = 'user-new'`)).rows[0];
    assert.equal(isAdminUser(identity), false);
    assert.deepEqual((await fixture.pg.query<{ role: string; can_manage_backups: number }>(`
      SELECT role, can_manage_backups FROM organization_user_permissions WHERE user_id = 'user-new'
    `)).rows[0], { role: 'member', can_manage_backups: 0 });
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-new'`)).rows.length, 0);
    await fixture.pg.query(`UPDATE "user" SET role = 'admin' WHERE id = 'user-new'`);
    await fixture.pg.query(`INSERT INTO "session" (id, user_id) VALUES ('drifted-admin-session', 'user-new')`);
    assert.equal(await runManagedTeamSyncCycle(syncOptions), 'applied');
    identity = (await fixture.pg.query<{ email: string; role: string }>(`SELECT email, role FROM "user" WHERE id = 'user-new'`)).rows[0];
    assert.equal(isAdminUser(identity), false);
    assert.equal((await fixture.pg.query(`SELECT id FROM "session" WHERE user_id = 'user-new'`)).rows.length, 0);
    console.info('managed team offline recovery, grace, restriction, replay, and restoration passed');
  } finally {
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().then(crashBoundaryScenario).then(emailChangeScenario).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
