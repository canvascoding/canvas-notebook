import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
      id text PRIMARY KEY, email text NOT NULL, banned integer NOT NULL,
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

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-managed-sync-recovery-'));
  process.env.DATA = dataDir;
  const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
  const { readManagedTeamAccessPolicy } = await import('../app/lib/license/managed-team-access-policy');
  const { recordHumanActivity } = await import('../app/lib/instance/human-activity');
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
      INSERT INTO "user" (id, email, banned, ban_reason)
      VALUES ('user-owner', 'owner@example.test', 0, NULL),
        ('user-revoked', 'revoked@example.test', 0, NULL),
        ('user-new', 'new@example.test', 1, 'canvas_team_membership_pending'),
        ('user-grace-new', 'grace-new@example.test', 1, 'canvas_team_membership_pending')
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
    console.info('managed team offline recovery, grace, restriction, replay, and restoration passed');
  } finally {
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
