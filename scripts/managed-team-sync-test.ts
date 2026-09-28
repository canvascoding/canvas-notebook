import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const previous = {
  CANVAS_INSTANCE_ID: process.env.CANVAS_INSTANCE_ID,
  CANVAS_INSTANCE_TOKEN: process.env.CANVAS_INSTANCE_TOKEN,
  CANVAS_DEPLOYMENT_MODE: process.env.CANVAS_DEPLOYMENT_MODE,
  CANVAS_LICENSE_CERT: process.env.CANVAS_LICENSE_CERT,
  CANVAS_LICENSE_CONTROL_PLANE_URL: process.env.CANVAS_LICENSE_CONTROL_PLANE_URL,
};

process.env.CANVAS_INSTANCE_ID = 'f183881f-d50b-4ad9-b6ed-bbf3b1d7f405';
process.env.CANVAS_INSTANCE_TOKEN = 'managed-test-token';
process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
process.env.CANVAS_LICENSE_CERT = 'legacy-signed-certificate';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';

async function main() {
  const { runManagedTeamSyncCycle } = await import('../app/lib/license/managed-team-sync');
  const requests: Array<{ path: string; method: string; authorization: string | null; body: unknown }> = [];
  let syncResponse: Record<string, unknown> = {
    status: 'adoption_required',
    instanceId: process.env.CANVAS_INSTANCE_ID,
    organizationId: 'control-plane-organization',
    membershipRevision: 0,
    memberHash: null,
    members: [],
    license: null,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      method: init?.method || 'GET',
      authorization: new Headers(init?.headers).get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.pathname.endsWith('/sync')) {
      return new Response(JSON.stringify(syncResponse), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'adoption_required' }), { status: 200 });
  }) as typeof fetch;
  const database = {
    async all(sql: string) {
      if (sql.includes('FROM canvas_organization_settings')) {
        return [{ organization_id: 'local-organization' }];
      }
      if (sql.includes('FROM team_memberships')) {
        return [{
          id: 'membership-owner', user_id: 'local-owner', candidate_email: 'owner@example.test',
          role: 'owner', status: 'active',
        }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async run() { throw new Error('Adoption must not mutate local membership.'); },
    async close() {},
  };
  const result = await runManagedTeamSyncCycle({ database, fetchImpl });
  assert.equal(result, 'adoption_required');
  assert.deepEqual(requests.map((request) => request.path), [
    '/v1/managed/team/sync', '/v1/managed/team/adoption-report',
  ]);
  assert(requests.every((request) => request.authorization === 'Bearer managed-test-token'));
  assert.deepEqual(requests[1].body, {
    instanceId: process.env.CANVAS_INSTANCE_ID,
    legacyCertificate: 'legacy-signed-certificate',
    members: [{ localIdentityKey: 'membership-owner', localUserId: 'local-owner', email: 'owner@example.test', role: 'owner', status: 'active' }],
  });
  requests.length = 0;
  const managedMembers = [{
    externalUserId: 'central-owner', email: 'owner@example.test', role: 'owner', status: 'active',
    localIdentityKey: null,
    localUserId: null,
  }];
  syncResponse = {
    status: 'ready',
    instanceId: process.env.CANVAS_INSTANCE_ID,
    organizationId: 'control-plane-organization',
    membershipRevision: 1,
    memberHash: createHash('sha256').update(JSON.stringify(managedMembers)).digest('hex'),
    members: managedMembers,
    license: {
      certificate: 'signed-placeholder', entitlementsVersion: 1,
      fingerprint: createHash('sha256').update('signed-placeholder').digest('hex'),
      seatLimit: 5,
    },
  };
  assert.equal(await runManagedTeamSyncCycle({ database, fetchImpl }), 'pending');
  assert.deepEqual(requests.map((request) => request.path), [
    '/v1/managed/team/sync', '/v1/managed/team/identity-report', '/v1/managed/team/sync/ack',
  ]);
  assert.equal((requests[2].body as { error?: string }).error, 'LOCAL_IDENTITY_MAPPING_REQUIRED');
  requests.length = 0;
  const boundMembers = [{ ...managedMembers[0], localIdentityKey: 'membership-owner', localUserId: 'local-owner' }];
  const falseCertificate = [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      sub: process.env.CANVAS_INSTANCE_ID,
      organizationId: 'wrong-organization',
      seatLimit: 5,
      entitlementsVersion: 1,
    })).toString('base64url'),
    'invalid-signature',
  ].join('.');
  syncResponse = {
    ...syncResponse,
    memberHash: createHash('sha256').update(JSON.stringify(boundMembers)).digest('hex'),
    members: boundMembers,
    license: {
      certificate: falseCertificate,
      entitlementsVersion: 1,
      fingerprint: createHash('sha256').update(falseCertificate).digest('hex'),
      seatLimit: 5,
    },
  };
  assert.equal(await runManagedTeamSyncCycle({ database, fetchImpl }), 'pending');
  assert.deepEqual(requests.map((request) => request.path), [
    '/v1/managed/team/sync', '/v1/managed/team/sync/ack',
  ]);
  assert.equal((requests[1].body as { error?: string }).error, 'MANAGED_TEAM_CERTIFICATE_CLAIMS_MISMATCH');
  console.info('managed team adoption transport passed');
}

main().finally(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
