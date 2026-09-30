import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

async function main() {
  let authenticated = true;
  let owner = true;
  let trusted = true;
  let limited = false;
  let runtimeReady = true;
  let organizations = ['organization'];
  let triggers = 0;
  let audits = 0;
  let closes = 0;
  const database = {
    all: async () => organizations.map((organization_id) => ({ organization_id })),
    run: async () => { audits += 1; },
    close: async () => { closes += 1; },
  };
  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () => authenticated ? { user: { id: 'owner' } } : null } } } });
  mock.module('@/app/lib/db', { exports: { openDb: async () => database } });
  mock.module('@/app/lib/organization/config', { exports: { getDeploymentMode: () => 'managed-team' } });
  mock.module('@/app/lib/license/managed-team-sync', { exports: { triggerManagedTeamSync: () => { triggers += 1; return runtimeReady; } } });
  mock.module('@/app/lib/license/control-plane', { exports: { getCommunityLicenseClaimStatus: async () => { throw new Error('Community claim must not be read'); } } });
  mock.module('@/app/lib/license/community-team-organization', { exports: {
    assertSingleCommunityTeamOrganization: async () => { throw new Error('Community recovery must not run'); },
    CommunityTeamOrganizationError: class extends Error {},
  } });
  mock.module('@/app/lib/license/team-seat-outbox', { exports: {
    enqueueTeamSeatOutboxOperation: async () => { throw new Error('Community enqueue must not run'); },
    getTeamMembershipSyncState: async () => { throw new Error('Community state must not be read'); },
  } });
  mock.module('@/app/lib/license/team-membership-sync-signal', { exports: {
    signalTeamMembershipSnapshotSync: () => { throw new Error('Community signal must not run'); },
  } });
  mock.module('@/app/lib/organization/permissions', { exports: {
    readOrganizationPermissionForUser: async () => ({ organizationId: 'organization', permission: {} }),
    isOrganizationBillingApprover: () => owner,
  } });
  mock.module('@/app/lib/security/mutation-origin', { exports: {
    requireTrustedMutationOrigin: () => trusted ? { ok: true } : { ok: false, response: Response.json({}, { status: 403 }) },
  } });
  mock.module('@/app/lib/utils/rate-limit', { exports: {
    rateLimit: () => limited ? { ok: false, response: Response.json({}, { status: 429 }) } : { ok: true },
  } });
  const { POST } = await import('../app/api/license/team/recovery/route');
  const request = (action = 'sync_snapshot') => new NextRequest('http://localhost/api/license/team/recovery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
  });
  try {
    trusted = false; assert.equal((await POST(request())).status, 403); trusted = true;
    authenticated = false; assert.equal((await POST(request())).status, 401); authenticated = true;
    owner = false; assert.equal((await POST(request())).status, 403); owner = true;
    limited = true; assert.equal((await POST(request())).status, 429); limited = false;
    organizations = ['organization', 'secondary']; assert.equal((await POST(request())).status, 409);
    organizations = ['secondary']; assert.equal((await POST(request())).status, 409);
    organizations = ['organization'];
    assert.equal((await POST(request('refresh_license'))).status, 409);
    assert.equal(triggers, 0);
    runtimeReady = false; assert.equal((await POST(request())).status, 503);
    runtimeReady = true;
    const response = await POST(request());
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { success: true, action: 'sync_snapshot', scheduled: true, costConfirmationRequired: false });
    assert.equal(triggers, 2);
    assert.equal(audits, 1);
    assert.equal(closes, 5);
    console.log('Managed recovery scheduling, organization scope, and authorization passed.');
  } finally { mock.restoreAll(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
