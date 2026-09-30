import assert from 'node:assert/strict';

import { adoptActiveTeamMembership, getActiveTeamMembershipProjection } from '../app/lib/organization/team-membership';
import { runManagedTeamSyncCycle } from '../app/lib/license/managed-team-sync';
import {
  ensurePostgresCredentialPassword,
  ensurePostgresOrganizationBootstrapForUser,
  getPostgresAuthUserCount,
  insertPostgresAuthUser,
} from '../app/lib/workspaces/postgres-runtime';
import { withTeamSeatTestDatabase } from './team-seat-test-db';

process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
process.env.CANVAS_INSTANCE_ID = 'b2f576c6-e4cc-4099-82fc-e97bcc83091d';
process.env.CANVAS_INSTANCE_TOKEN = 'bootstrap-test-token';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';
delete process.env.CANVAS_LICENSE_CERT;

async function main(): Promise<void> {
  await withTeamSeatTestDatabase(async (database) => {
    assert.equal(await getPostgresAuthUserCount(database), 0);
    const ownerId = await insertPostgresAuthUser(database, {
      userId: 'bootstrap-owner', name: 'Bootstrap Owner', email: 'owner@example.test', role: 'admin',
    });
    await ensurePostgresCredentialPassword(database, {
      userId: ownerId, passwordHash: 'test-hash', accountId: 'bootstrap-credential',
    });
    const first = await ensurePostgresOrganizationBootstrapForUser(database, ownerId);
    assert.ok(first.organizationId);
    assert.equal(await getPostgresAuthUserCount(database), 1);
    const membership = await adoptActiveTeamMembership(database, {
      organizationId: first.organizationId, userId: ownerId, role: 'owner',
      source: 'first_owner', now: Date.now(),
    });
    assert.equal(membership.status, 'active');
    assert.equal((await getActiveTeamMembershipProjection(database, first.organizationId)).observedQuantity, 1);
    const repeat = await ensurePostgresOrganizationBootstrapForUser(database, ownerId);
    assert.equal(repeat.organizationId, first.organizationId);
    assert.equal((await database.get(`
      SELECT COUNT(*) AS count FROM organization_user_permissions
      WHERE organization_id = $1 AND user_id = $2 AND role = 'owner'
    `, [first.organizationId, ownerId]) as { count: number }).count, 1);

    const reports: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/managed/team/sync') {
        return new Response(JSON.stringify({
          status: 'adoption_required', instanceId: process.env.CANVAS_INSTANCE_ID,
          organizationId: 'control-plane-organization', membershipRevision: 0,
          memberHash: null, members: [], license: null,
        }), { status: 200 });
      }
      assert.equal(path, '/v1/managed/team/adoption-report');
      reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ status: 'adoption_required' }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await runManagedTeamSyncCycle({
      database, fetchImpl, loadLegacyCertificate: async () => null,
    }), 'adoption_required');
    assert.equal(reports.length, 1);
    assert.equal('legacyCertificate' in reports[0], false);
    assert.deepEqual(reports[0].members, [{
      localIdentityKey: membership.id,
      localUserId: ownerId,
      email: 'owner@example.test', role: 'owner', status: 'active',
    }]);
  });
  console.info('first owner bootstrap stays idempotent and reports active owner before certificate issuance');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
