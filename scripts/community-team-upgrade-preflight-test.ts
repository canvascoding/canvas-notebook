import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-community-team-preflight-'));
const previousEnvironment = {
  DATA: process.env.DATA,
  CANVAS_INSTANCE_ID: process.env.CANVAS_INSTANCE_ID,
  CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
  CANVAS_LICENSE_CONTROL_PLANE_URL: process.env.CANVAS_LICENSE_CONTROL_PLANE_URL,
  CANVAS_LICENSE_CONTROL_PLANE_WEB_URL: process.env.CANVAS_LICENSE_CONTROL_PLANE_WEB_URL,
  CANVAS_TEAM_SEAT_CLIENT_ENABLED: process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED,
  CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED: process.env.CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED,
};

process.env.DATA = dataRoot;
process.env.CANVAS_INSTANCE_ID = 'self_community_team_preflight_test';
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://api.control.example.test';
process.env.CANVAS_LICENSE_CONTROL_PLANE_WEB_URL = 'https://control.example.test/';
process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED = 'true';
process.env.CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED = 'true';

const instanceToken = `lit_${'p'.repeat(64)}`;
const captured: Array<{
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}> = [];

function preflightPayload() {
  return {
    preflight: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      ready: true,
      mutating: false,
      nextAction: 'start_checkout',
      license: {
        licenseId: 'license-community-preflight',
        instanceId: 'self_community_team_preflight_test',
        hostingMode: 'community',
        edition: 'solo',
        licenseClass: 'test',
        licenseEnvironment: 'development',
        claimed: true,
        billingOrganizationId: 'organization-community-preflight',
      },
      runtime: {
        notebookVersion: '2026.8.1.2',
        minimumNotebookVersion: '2026.8.1.0',
        versionSupported: true,
        databaseEngine: 'postgres',
        teamReady: true,
      },
      team: {
        active: false,
        provider: null,
        billingStatus: null,
        observedQuantity: 1,
        approvedQuantity: 1,
        billedQuantity: 0,
        licensedQuantity: 1,
        entitlementsVersion: 4,
        nonBillable: false,
      },
      rollout: {
        communityCommercial: { requested: true, effective: true },
        cloudCommercial: { requested: false, effective: false },
        stripeMutations: {
          requested: true,
          effective: true,
          implementationReady: true,
          billingMode: 'stripe',
          credentialsConfigured: true,
          prorationPolicy: 'always_invoice',
          prorationPolicyConfigured: true,
        },
      },
      blockers: [],
    },
  };
}

const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  captured.push({
    url: String(input),
    headers: new Headers(init?.headers),
    body: typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {},
  });
  return new Response(JSON.stringify(preflightPayload()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

function restoreEnvironment() {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function main() {
  try {
    const {
      getCommunityTeamUpgradePreflight,
      getCommunityTeamUpgradeRuntimeSnapshot,
    } = await import('../app/lib/license/control-plane');
    const { getCommunityTeamManagementUrl } = await import('../app/lib/license/instance');
    const {
      removeCommunityInstanceToken,
      saveCommunityInstanceToken,
    } = await import('../app/lib/license/storage');

    await saveCommunityInstanceToken({
      instanceId: 'self_community_team_preflight_test',
      instanceToken,
      tokenType: 'Bearer',
      scopes: ['license:refresh', 'seat:prepare', 'seat:execute', 'seat:snapshot', 'token:rotate'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      now: new Date('2026-08-01T12:00:00.000Z'),
    });

    assert.deepEqual(getCommunityTeamUpgradeRuntimeSnapshot(), {
      notebookVersion: '2026.8.1.2',
      databaseEngine: 'sqlite',
      teamReady: false,
    });
    assert.equal(
      getCommunityTeamManagementUrl(),
      'https://control.example.test/dashboard/billing?intent=community-team-upgrade',
    );

    const result = await getCommunityTeamUpgradePreflight({
      fetchImpl: mockFetch,
      runtime: {
        notebookVersion: '2026.8.1.2',
        databaseEngine: 'postgres',
        teamReady: true,
      },
    });
    assert.equal(result.ready, true);
    assert.equal(result.license.claimed, true);
    assert.equal(result.nextAction, 'start_checkout');
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0]?.url,
      'https://api.control.example.test/v1/license/community/v1/team/preflight',
    );
    assert.equal(captured[0]?.headers.get('Authorization'), `Bearer ${instanceToken}`);
    assert.deepEqual(captured[0]?.body, {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      notebookVersion: '2026.8.1.2',
      databaseEngine: 'postgres',
      teamReady: true,
    });
    assert.equal(JSON.stringify(captured[0]?.body).includes(instanceToken), false);
    assert.equal(JSON.stringify(result).includes(instanceToken), false);

    await removeCommunityInstanceToken({
      instanceId: 'self_community_team_preflight_test',
      expectedToken: instanceToken,
    });
    await assert.rejects(
      () => getCommunityTeamUpgradePreflight({
        fetchImpl: mockFetch,
        runtime: {
          notebookVersion: '2026.8.1.2',
          databaseEngine: 'postgres',
          teamReady: true,
        },
      }),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'TEAM_SEAT_ACCOUNT_REQUIRED'
      ),
    );
    assert.equal(captured.length, 1);
  } finally {
    restoreEnvironment();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log('community-team-upgrade-preflight-test: ok'));
