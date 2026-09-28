import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashPassword } from 'better-auth/crypto';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

function localDatabaseUrl(): URL {
  const configured = process.env.CANVAS_MANAGED_HTTP_TEST_DATABASE_URL;
  if (!configured) throw new Error('CANVAS_MANAGED_HTTP_TEST_DATABASE_URL is required.');
  const url = new URL(configured);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '55433'
    || url.pathname !== '/canvas_notebook') {
    throw new Error('Managed HTTP test requires the loopback Canvas test PostgreSQL database.');
  }
  return url;
}

function signLicense(privateKey: crypto.KeyObject, payload: Record<string, unknown>, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

async function main() {
  const baseUrl = localDatabaseUrl();
  const databaseName = `canvas_managed_auth_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: baseUrl.toString() });
  const dataDir = await mkdtemp(join(tmpdir(), 'canvas-managed-auth-http-'));
  let created = false;
  let appConnectionsOpened = false;
  try {
    const privilege = await adminPool.query<{ rolcreatedb: boolean }>(
      'SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(privilege.rows[0]?.rolcreatedb, true, 'Local PostgreSQL user cannot create isolated databases.');
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const databaseUrl = new URL(baseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.CANVAS_POSTGRES_MODE = 'external';
    process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
    process.env.CANVAS_TEAM_FEATURES_ENABLED = 'true';
    process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
    process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';
    process.env.CANVAS_INSTANCE_TOKEN = 'isolated-test-token';
    process.env.CANVAS_INSTANCE_ID = crypto.randomUUID();
    process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3001';
    process.env.BASE_URL = 'http://localhost:3001';
    process.env.BETTER_AUTH_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'owner@example.test';
    process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
    process.env.DATA = dataDir;
    delete process.env.CANVAS_LICENSE_CERT;

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = crypto.createHash('sha256').update(
      crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }),
    ).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKey;
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS;

    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const pool = new Pool({ connectionString: databaseUrl.toString() });
    try {
      await runPostgresMigrations(pool);
      const now = Date.now();
      const ownerId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const organizationId = crypto.randomUUID();
      const password = `Isolated-${crypto.randomBytes(18).toString('hex')}`;
      const passwordHash = await hashPassword(password);
      await pool.query(`
        INSERT INTO "user" (id, name, email, email_verified, role, banned, created_at, updated_at)
        VALUES ($1, 'Owner', 'owner@example.test', 1, 'admin', 0, $3, $3),
          ($2, 'Managed Admin', 'member@example.test', 1, 'admin', 0, $3, $3)
      `, [ownerId, memberId, now]);
      await pool.query(`
        INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
        VALUES ($1, $2, 'credential', $2, $3, $4, $4)
      `, [crypto.randomUUID(), memberId, passwordHash, now]);
      await pool.query(`
        INSERT INTO canvas_organization_settings
          (organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at)
        VALUES ($1, $2, 'team', 1, $3, $3)
      `, [organizationId, ownerId, now]);
      await pool.query(`
        INSERT INTO team_memberships
          (id, organization_id, user_id, candidate_email, role, status, accepted_at, created_at, updated_at)
        VALUES ('member-owner', $1, $2, 'owner@example.test', 'owner', 'active', $4, $4, $4),
          ('member-admin', $1, $3, 'member@example.test', 'admin', 'active', $4, $4, $4)
      `, [organizationId, ownerId, memberId, now]);
      await pool.query(`
        INSERT INTO organization_user_permissions
          (organization_id, user_id, role, status, created_at, updated_at)
        VALUES ($1, $2, 'owner', 'active', $4, $4),
          ($1, $3, 'admin', 'active', $4, $4)
      `, [organizationId, ownerId, memberId, now]);

      const certificate = signLicense(keys.privateKey, {
        sub: process.env.CANVAS_INSTANCE_ID,
        instanceId: process.env.CANVAS_INSTANCE_ID,
        iss: 'canvas-control-plane', aud: 'canvas-notebook',
        plan: 'managed', status: 'active', protocolVersion: 'canvas-team-seat-protocol-v1',
        licenseId: crypto.randomUUID(), organizationId: crypto.randomUUID(),
        hostingMode: 'cloud', edition: 'team', licenseClass: 'manual',
        licenseEnvironment: 'production', provider: 'manual', grantId: crypto.randomUUID(),
        nonBillable: true, seatLimit: 2, entitlementsVersion: now,
        deploymentMode: 'managed-team', databaseProvider: 'postgres', vectorProvider: 'pgvector',
        postgresRequired: true, capabilities: { multiUser: true, teamWorkspace: true },
        features: { multiUser: true, teamWorkspace: true }, quotas: { users: 2 },
        iat: Math.floor(now / 1_000) - 60, exp: Math.floor(now / 1_000) + 3_600,
      }, fingerprint.slice(0, 16));
      const claims = JSON.parse(Buffer.from(certificate.split('.')[1], 'base64url').toString()) as {
        organizationId: string; entitlementsVersion: number;
      };
      const { activateLicenseCert } = await import('../app/lib/license');
      const licenseStatus = await activateLicenseCert(certificate);
      assert.equal(licenseStatus.licensed, true);
      appConnectionsOpened = true;

      const { auth } = await import('../app/lib/auth');
      const { GET } = await import('../app/api/admin/organization/status/route');
      const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
      const signIn = async () => auth.handler(new Request('http://localhost:3001/api/auth/sign-in/email', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3001' },
        body: JSON.stringify({ email: 'member@example.test', password }),
      }));
      const firstLogin = await signIn();
      assert.equal(firstLogin.status, 200, `Admin login failed: ${firstLogin.status}`);
      const oldCookie = firstLogin.headers.get('set-cookie')?.split(';')[0];
      assert(oldCookie, 'Better Auth did not issue a session cookie.');
      const adminRequest = (cookie: string) => new NextRequest('http://localhost:3001/api/admin/organization/status', {
        headers: { cookie },
      });
      const before = await GET(adminRequest(oldCookie));
      assert.equal(before.status, 200, `Admin route denied the initial admin: ${before.status}`);

      const members = [
        { externalUserId: 'central-owner', email: 'owner@example.test', role: 'owner', status: 'active', localIdentityKey: 'member-owner', localUserId: ownerId },
        { externalUserId: 'central-member', email: 'member@example.test', role: 'member', status: 'active', localIdentityKey: 'member-admin', localUserId: memberId },
      ];
      const canonical = members.map((member) => ({
        ...member, email: member.email.toLowerCase(),
      })).sort((left, right) => left.externalUserId.localeCompare(right.externalUserId));
      const memberHash = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      const certificateFingerprint = crypto.createHash('sha256').update(certificate).digest('hex');
      const payload = {
        status: 'ready', instanceId: process.env.CANVAS_INSTANCE_ID,
        organizationId: claims.organizationId, membershipRevision: 2, memberHash, members,
        license: {
          certificate, entitlementsVersion: claims.entitlementsVersion,
          fingerprint: certificateFingerprint, seatLimit: 2,
        },
      };
      const acknowledgements: Array<Record<string, unknown>> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/sync')) return Response.json(payload);
        if (path.endsWith('/sync/ack')) {
          acknowledgements.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ status: 'acknowledged' });
        }
        throw new Error(`Unexpected endpoint: ${path}`);
      }) as typeof fetch;
      assert.equal(await runManagedTeamSyncCycle({ fetchImpl }), 'applied');
      assert.equal(acknowledgements.at(-1)?.error, undefined);
      const changed = await pool.query<{ role: string }>('SELECT role FROM "user" WHERE id = $1', [memberId]);
      assert.equal(changed.rows[0]?.role, 'user');
      const sessions = await pool.query('SELECT id FROM "session" WHERE user_id = $1', [memberId]);
      assert.equal(sessions.rows.length, 0);
      const oldSessionResponse = await GET(adminRequest(oldCookie));
      assert.equal(oldSessionResponse.status, 401);

      const memberLogin = await signIn();
      assert.equal(memberLogin.status, 200, `Member re-login failed: ${memberLogin.status}`);
      const memberCookie = memberLogin.headers.get('set-cookie')?.split(';')[0];
      assert(memberCookie, 'Better Auth did not issue a new member session cookie.');
      const memberResponse = await GET(adminRequest(memberCookie));
      assert.equal(memberResponse.status, 403);
      console.info('Managed Team admin HTTP demotion, session revocation, and member re-login passed');
    } finally {
      await pool.end();
    }
  } finally {
    if (appConnectionsOpened) {
      const { closeDatabaseConnections } = await import('../app/lib/db');
      await closeDatabaseConnections();
    }
    if (created) await adminPool.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await adminPool.end();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
