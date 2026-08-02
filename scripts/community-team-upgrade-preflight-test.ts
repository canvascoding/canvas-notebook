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
  DATABASE_URL: process.env.DATABASE_URL,
  CANVAS_POSTGRES_VECTOR_ENABLED: process.env.CANVAS_POSTGRES_VECTOR_ENABLED,
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
  method: string;
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

function seatPreparePayload() {
  return {
    quote: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      quoteId: 'c2c5d3e2-09ea-44a9-92ca-d5816b98c62b',
      subject: {
        type: 'license',
        licenseId: 'license-community-preflight',
      },
      provider: 'stripe',
      environment: 'production',
      priceVersionId: 'price-version-2026-08',
      quantityBefore: 2,
      quantityAfter: 3,
      quantityDelta: 1,
      unitAmountCents: 1_500,
      currency: 'eur',
      billingInterval: 'month',
      immediateAmountCents: 500,
      recurringAmountCents: 4_500,
      status: 'active',
      expiresAt: '2026-08-01T12:30:00.000Z',
      quoteHash: 'seat-quote-hash',
      nonBillable: false,
    },
    authorization: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      authorizationId: '9186284d-9c7e-4555-904b-5cd60ef8d413',
      quoteId: 'c2c5d3e2-09ea-44a9-92ca-d5816b98c62b',
      quoteHash: 'seat-quote-hash',
      quantityBefore: 2,
      quantityAfter: 3,
      status: 'pending',
      expiresAt: '2026-08-01T12:30:00.000Z',
      approvedAt: null,
      consumedAt: null,
    },
    requiresBillingApproval: true,
    snapshot: {
      revision: 8,
      observedQuantity: 2,
      licensedQuantity: 2,
      approvedQuantity: 2,
      billedQuantity: 2,
      billingStatus: 'active',
    },
  };
}

function seatExecutePayload() {
  return {
    operation: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      operationId: '4aa503af-dbbd-4b79-ae47-ec67a11ca90c',
      operationKey: '9186284d-9c7e-4555-904b-5cd60ef8d413',
      operationType: 'member_create',
      provider: 'stripe',
      environment: 'production',
      status: 'applied',
      paymentStatus: 'paid',
      previousQuantity: 2,
      requestedQuantity: 3,
      effectiveQuantity: 3,
      retryCount: 0,
      lastError: null,
      effectiveAt: '2026-08-01T12:06:00.000Z',
      entitlementsVersion: 9,
      certificateReissueStatus: 'issued',
      createdAt: '2026-08-01T12:06:00.000Z',
      updatedAt: '2026-08-01T12:06:00.000Z',
    },
    replayed: false,
    license: {
      license: 'x'.repeat(128),
      details: {
        id: 'license-community-preflight',
        plan: 'team',
        status: 'active',
        instanceId: 'self_community_team_preflight_test',
        hostingMode: 'community',
        edition: 'team',
        licenseClass: 'commercial',
        licenseEnvironment: 'production',
        billingOrganizationId: 'organization-community-preflight',
        entitlementsVersion: 9,
        deploymentMode: 'self_hosted',
        features: {
          multiUser: true,
          teamWorkspace: true,
        },
        quotas: {
          users: 3,
        },
        activatedAt: '2026-08-01T12:06:00.000Z',
        expiresAt: '2026-08-08T12:06:00.000Z',
      },
    },
  };
}

const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  captured.push({
    url: String(input),
    method: init?.method ?? 'GET',
    headers: new Headers(init?.headers),
    body: typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {},
  });
  if (String(input).includes('/seats/prepare')) {
    return new Response(JSON.stringify(seatPreparePayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (String(input).includes('/seats/quotes/')) {
    const prepared = seatPreparePayload();
    return new Response(JSON.stringify({
      quote: prepared.quote,
      authorization: {
        ...prepared.authorization,
        status: 'approved',
        approvedAt: '2026-08-01T12:05:00.000Z',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (String(input).includes('/seats/execute')) {
    return new Response(JSON.stringify(seatExecutePayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
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
      executeCommunityTeamSeatChange,
      getCommunityTeamSeatQuoteStatus,
      getCommunityTeamUpgradePreflight,
      getCommunityTeamUpgradeRuntimeSnapshot,
      prepareCommunityTeamSeatChange,
    } = await import('../app/lib/license/control-plane');
    const {
      createTeamSeatExecuteRequest,
      createTeamSeatPrepareRequest,
    } = await import('../app/lib/license/team-seat-contract');
    const {
      getCommunityTeamRuntimeReadiness,
      withCommunityTeamVersionReadiness,
    } = await import('../app/lib/license/team-runtime-readiness');
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

    assert.deepEqual(await getCommunityTeamUpgradeRuntimeSnapshot(), {
      notebookVersion: '2026.8.1.2',
      databaseEngine: 'sqlite',
      teamReady: false,
    });
    const sqliteReadiness = await getCommunityTeamRuntimeReadiness({
      storageProbe: async () => true,
    });
    assert.equal(sqliteReadiness.ready, false);
    assert.ok(sqliteReadiness.blockers.some(
      (blocker) => blocker.code === 'TEAM_RUNTIME_DATABASE_POSTGRES_REQUIRED',
    ));
    assert.ok(sqliteReadiness.blockers.some(
      (blocker) => blocker.code === 'TEAM_RUNTIME_PGVECTOR_NOT_CONFIGURED',
    ));

    process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://canvas:test@postgres:5432/canvas';
    process.env.CANVAS_POSTGRES_VECTOR_ENABLED = 'true';
    const readyRuntime = await getCommunityTeamRuntimeReadiness({
      now: new Date('2026-08-01T12:00:00.000Z'),
      postgresProbe: async () => ({
        databaseReachable: true,
        migrationsReady: true,
        pgvectorAvailable: true,
        pgvectorVersion: '0.8.3',
        organizationReady: true,
      }),
      storageProbe: async () => true,
    });
    assert.equal(readyRuntime.ready, true);
    assert.equal(readyRuntime.pgvectorVersion, '0.8.3');
    assert.equal(readyRuntime.checks.length, 6);

    const blockedRuntime = await getCommunityTeamRuntimeReadiness({
      postgresProbe: async () => ({
        databaseReachable: true,
        migrationsReady: false,
        pgvectorAvailable: false,
        pgvectorVersion: null,
        organizationReady: false,
      }),
      storageProbe: async () => false,
    });
    assert.deepEqual(
      new Set(blockedRuntime.blockers.map((blocker) => blocker.code)),
      new Set([
        'TEAM_RUNTIME_MIGRATIONS_INCOMPLETE',
        'TEAM_RUNTIME_PGVECTOR_UNAVAILABLE',
        'TEAM_RUNTIME_CAPABILITIES_UNAVAILABLE',
        'TEAM_RUNTIME_STORAGE_UNWRITABLE',
      ]),
    );
    const outdatedRuntime = withCommunityTeamVersionReadiness(readyRuntime, {
      current: '2026.8.1.2',
      minimum: '2026.9.0',
      supported: false,
    });
    assert.equal(outdatedRuntime.ready, false);
    assert.ok(outdatedRuntime.blockers.some(
      (blocker) => blocker.code === 'TEAM_RUNTIME_NOTEBOOK_UPDATE_REQUIRED',
    ));
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
      runtimeReadiness: readyRuntime,
    });
    assert.equal(result.ready, true);
    assert.equal(result.license.claimed, true);
    assert.equal(result.nextAction, 'start_checkout');
    assert.equal(result.runtime.readiness.ready, true);
    assert.equal(result.runtime.readiness.checks.at(-1)?.area, 'version');
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

    const preparedSeat = await prepareCommunityTeamSeatChange(
      createTeamSeatPrepareRequest({
        desiredQuantity: 3,
        triggerType: 'member_create',
        externalReference: 'membership-local-1',
      }),
      {
        fetchImpl: mockFetch,
        now: new Date('2026-08-01T12:00:00.000Z'),
      },
    );
    assert.equal(preparedSeat.quote.quantityBefore, 2);
    assert.equal(preparedSeat.quote.quantityAfter, 3);
    assert.equal(preparedSeat.quote.priceVersionId, 'price-version-2026-08');
    assert.equal(preparedSeat.authorization.status, 'pending');
    assert.equal(
      captured[1]?.url,
      'https://api.control.example.test/v1/license/community/v1/seats/prepare',
    );
    assert.equal(captured[1]?.method, 'POST');
    assert.equal(captured[1]?.headers.get('Authorization'), `Bearer ${instanceToken}`);
    assert.deepEqual(captured[1]?.body, {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      desiredQuantity: 3,
      triggerType: 'member_create',
      externalReference: 'membership-local-1',
    });

    const currentSeat = await getCommunityTeamSeatQuoteStatus(
      preparedSeat.quote.quoteId,
      {
        fetchImpl: mockFetch,
        now: new Date('2026-08-01T12:05:00.000Z'),
      },
    );
    assert.equal(currentSeat.authorization.status, 'approved');
    assert.equal(currentSeat.quote.quoteHash, preparedSeat.quote.quoteHash);
    assert.equal(
      captured[2]?.url,
      `https://api.control.example.test/v1/license/community/v1/seats/quotes/${preparedSeat.quote.quoteId}`,
    );
    assert.equal(captured[2]?.method, 'GET');
    assert.equal(captured[2]?.headers.get('Authorization'), `Bearer ${instanceToken}`);
    assert.deepEqual(captured[2]?.body, {});

    const executedSeat = await executeCommunityTeamSeatChange(
      createTeamSeatExecuteRequest({
        authorizationId: preparedSeat.authorization.authorizationId,
        operationKey: preparedSeat.authorization.authorizationId,
        operationType: 'member_create',
      }),
      {
        fetchImpl: mockFetch,
        now: new Date('2026-08-01T12:06:00.000Z'),
      },
    );
    assert.equal(executedSeat.operation.status, 'applied');
    assert.equal(executedSeat.operation.effectiveQuantity, 3);
    assert.equal(executedSeat.license?.details.quotas.users, 3);
    assert.equal(
      captured[3]?.url,
      'https://api.control.example.test/v1/license/community/v1/seats/execute',
    );
    assert.equal(captured[3]?.method, 'POST');
    assert.equal(captured[3]?.headers.get('Authorization'), `Bearer ${instanceToken}`);
    assert.deepEqual(captured[3]?.body, {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      authorizationId: preparedSeat.authorization.authorizationId,
      operationKey: preparedSeat.authorization.authorizationId,
      operationType: 'member_create',
    });
    assert.equal(JSON.stringify(captured[3]?.body).includes(instanceToken), false);

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
        runtimeReadiness: readyRuntime,
      }),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'TEAM_SEAT_ACCOUNT_REQUIRED'
      ),
    );
    assert.equal(captured.length, 4);
  } finally {
    restoreEnvironment();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log('community-team-upgrade-preflight-test: ok'));
