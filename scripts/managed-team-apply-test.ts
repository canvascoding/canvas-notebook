import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
process.env.CANVAS_INSTANCE_ID = 'f183881f-d50b-4ad9-b6ed-bbf3b1d7f405';
process.env.CANVAS_INSTANCE_TOKEN = 'managed-test-token';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';
process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3001';

const organizationId = 'local-organization';
const centralOrganizationId = 'central-organization';

function certificate(seatLimit: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID,
      organizationId: centralOrganizationId,
      entitlementsVersion: 1783338368,
      seatLimit,
    })).toString('base64url'),
    'signature-placeholder',
  ].join('.');
}

async function setupDatabase() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE canvas_organization_settings (organization_id text PRIMARY KEY);
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
  `);
  await pg.query('INSERT INTO canvas_organization_settings (organization_id) VALUES ($1)', [organizationId]);
  return {
    pg,
    database: {
      async all(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows; },
      async get(sql: string, params?: unknown[]) { return (await pg.query(sql, params)).rows[0]; },
      async run(sql: string, params?: unknown[]) {
        const result = await pg.query(sql, params);
        return { changes: result.affectedRows ?? 0 };
      },
      async close() {},
    },
  };
}

async function main() {
  const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
  const { pg, database } = await setupDatabase();
  try {
    await pg.query(`
      INSERT INTO team_memberships (id, organization_id, user_id, candidate_email, role, status)
      VALUES ('member-owner', $1, 'user-owner', 'owner@example.test', 'owner', 'active'),
        ('member-revoked', $1, 'user-revoked', 'revoked@example.test', 'member', 'active'),
        ('member-new', $1, NULL, 'new@example.test', 'member', 'approval_required')
    `, [organizationId]);
    await pg.query(`
      INSERT INTO "user" (id, email, banned, ban_reason)
      VALUES ('user-owner', 'owner@example.test', 0, NULL),
        ('user-revoked', 'revoked@example.test', 0, NULL),
        ('user-new', 'new@example.test', 1, 'canvas_team_membership_pending')
    `);
    await pg.query(`
      INSERT INTO managed_team_pending_identities (local_identity_key, organization_id, pending_user_id)
      VALUES ('member-new', $1, 'user-new')
    `, [organizationId]);
    await pg.query(`
      INSERT INTO organization_user_permissions (organization_id, user_id, role, status)
      VALUES ($1, 'user-owner', 'owner', 'active'), ($1, 'user-revoked', 'member', 'active')
    `, [organizationId]);
    await pg.query(`INSERT INTO "session" (id, user_id) VALUES ('revoked-session', 'user-revoked')`);
    const members = [
      { externalUserId: 'central-new', email: 'new@example.test', role: 'member', status: 'active', localIdentityKey: 'member-new', localUserId: 'user-new' },
      { externalUserId: 'central-owner', email: 'owner@example.test', role: 'owner', status: 'active', localIdentityKey: 'member-owner', localUserId: 'user-owner' },
      { externalUserId: 'central-revoked', email: 'revoked@example.test', role: 'member', status: 'removed', localIdentityKey: 'member-revoked', localUserId: 'user-revoked' },
    ];
    const cert = certificate(2);
    const acknowledgements: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/sync')) {
        return new Response(JSON.stringify({
          status: 'ready', instanceId: process.env.CANVAS_INSTANCE_ID,
          organizationId: centralOrganizationId, membershipRevision: 2,
          memberHash: createHash('sha256').update(JSON.stringify(members)).digest('hex'),
          members,
          license: {
            certificate: cert, entitlementsVersion: 1783338368,
            fingerprint: createHash('sha256').update(cert).digest('hex'), seatLimit: 2,
          },
        }), { status: 200 });
      }
      if (path.endsWith('/sync/ack')) {
        acknowledgements.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ status: 'acknowledged' }), { status: 200 });
      }
      throw new Error(`Unexpected endpoint ${path}`);
    }) as typeof fetch;
    const result = await runManagedTeamSyncCycle({
      database,
      fetchImpl,
      activateCertificate: async () => ({
        licensed: true, hostingMode: 'cloud', edition: 'team', seatLimit: 2,
      }) as Awaited<ReturnType<typeof import('../app/lib/license').activateLicenseCert>>,
    });
    assert.equal(result, 'applied');
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0].error, undefined);
    assert.equal(acknowledgements[0].appliedMemberCount, 2);
    const revoked = await pg.query<{ status: string }>(`SELECT status FROM team_memberships WHERE id = 'member-revoked'`);
    assert.equal(revoked.rows[0].status, 'removed');
    const sessions = await pg.query(`SELECT id FROM "session" WHERE user_id = 'user-revoked'`);
    assert.equal(sessions.rows.length, 0);
    const activated = await pg.query<{ status: string; user_id: string }>(`SELECT status, user_id FROM team_memberships WHERE id = 'member-new'`);
    assert.deepEqual(activated.rows[0].status, 'active');
    assert.equal(activated.rows[0].user_id, 'user-new');
    const pendingUser = await pg.query<{ banned: number }>(`SELECT banned FROM "user" WHERE id = 'user-new'`);
    assert.equal(pendingUser.rows[0].banned, 0);
    console.info('managed team apply, revoke, and ACK passed');
  } finally {
    await pg.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
