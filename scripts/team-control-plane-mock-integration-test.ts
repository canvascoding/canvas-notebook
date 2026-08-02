import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-team-control-plane-mock-'));
const instanceId = 'instance-control-plane-mock';
const instanceToken = `lit_${'m'.repeat(64)}`;
const environmentNames = [
  'DATA',
  'CANVAS_INSTANCE_ID',
  'CANVAS_DATABASE_PROVIDER',
  'CANVAS_LICENSE_CERT',
  'CANVAS_LICENSE_CONTROL_PLANE_URL',
  'CANVAS_LICENSE_PUBLIC_KEY',
  'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS',
  'CANVAS_LICENSE_RUNTIME_ENVIRONMENT',
  'CANVAS_TEAM_SEAT_CLIENT_ENABLED',
  'CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
] as const;
const previousEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(
  privateKey: crypto.KeyObject,
  kid: string,
  payload: Record<string, unknown>,
): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${encodedPayload}`),
    privateKey,
  );
  return `${header}.${encodedPayload}.${signature.toString('base64url')}`;
}

const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keyPair.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const fingerprint = publicKeyFingerprint(publicKeyPem);
const keyId = fingerprint.slice(0, 16);
const nowSeconds = Math.floor(Date.now() / 1_000);
const certificateExpiresAt = nowSeconds + 7_200;
const refreshedCertificate = signLicense(keyPair.privateKey, keyId, {
  sub: instanceId,
  iss: 'canvas-control-plane',
  aud: 'canvas-notebook',
  plan: 'community',
  status: 'active',
  protocolVersion: 'canvas-team-seat-protocol-v1',
  licenseId: 'license-control-plane-mock',
  instanceId,
  hostingMode: 'community',
  edition: 'team',
  licenseClass: 'commercial',
  licenseEnvironment: 'production',
  provider: 'stripe',
  seatLimit: 2,
  entitlementsVersion: 2,
  nonBillable: false,
  deploymentMode: 'community',
  databaseProvider: 'postgres',
  vectorProvider: 'pgvector',
  postgresRequired: true,
  capabilities: {
    multiUser: true,
    teamWorkspace: true,
    vectorSearch: true,
    liveCollaboration: true,
  },
  features: {
    multiUser: true,
    teamWorkspace: true,
    vectorSearch: true,
    liveCollaboration: true,
  },
  quotas: { users: 2 },
  iat: nowSeconds - 60,
  exp: certificateExpiresAt,
});

process.env.DATA = dataRoot;
process.env.CANVAS_INSTANCE_ID = instanceId;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_LICENSE_CERT = 'community-certificate-for-mock-claim'.padEnd(96, 'x');
process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'production';
process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED = 'true';
process.env.CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED = 'true';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

type CapturedRequest = {
  authorization: string | null;
  body: Record<string, unknown>;
  method: string;
  operationId: string | null;
  path: string;
  protocolVersion: string | null;
};

const requests: CapturedRequest[] = [];
let prepareAttempts = 0;
let lostExecuteAttempts = 0;
let authenticationMode: 'none' | '401' | '403' = 'none';

function json(
  response: ServerResponse,
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function seatQuote(desiredQuantity: number) {
  return {
    protocolVersion: 'canvas-team-seat-protocol-v1',
    quoteId: 'quote-control-plane-mock',
    subject: {
      type: 'license',
      licenseId: 'license-control-plane-mock',
    },
    provider: 'test',
    environment: 'development',
    priceVersionId: 'test-price-control-plane-mock',
    quantityBefore: desiredQuantity - 1,
    quantityAfter: desiredQuantity,
    quantityDelta: 1,
    unitAmountCents: 0,
    currency: 'eur',
    billingInterval: 'month',
    immediateAmountCents: 0,
    recurringAmountCents: 0,
    status: 'active',
    expiresAt: '2030-01-01T00:05:00.000Z',
    quoteHash: 'quote-hash-control-plane-mock',
    nonBillable: true,
  };
}

function seatAuthorization(
  desiredQuantity: number,
  status: 'pending' | 'approved',
) {
  return {
    protocolVersion: 'canvas-team-seat-protocol-v1',
    authorizationId: 'authorization-control-plane-mock',
    quoteId: 'quote-control-plane-mock',
    quoteHash: 'quote-hash-control-plane-mock',
    quantityBefore: desiredQuantity - 1,
    quantityAfter: desiredQuantity,
    status,
    expiresAt: '2030-01-01T00:05:00.000Z',
    approvedAt: status === 'approved' ? '2030-01-01T00:00:01.000Z' : null,
    consumedAt: null,
  };
}

function executeResponse(input: {
  operationKey: string;
  status: 'applied' | 'requires_action';
  replayed: boolean;
}) {
  const applied = input.status === 'applied';
  return {
    operation: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      operationId: 'execute-control-plane-mock',
      operationKey: input.operationKey,
      operationType: 'member_create',
      provider: 'test',
      environment: 'development',
      status: input.status,
      paymentStatus: applied ? 'test' : 'requires_action',
      previousQuantity: 1,
      requestedQuantity: 2,
      effectiveQuantity: applied ? 2 : null,
      retryCount: input.replayed ? 1 : 0,
      lastError: null,
      effectiveAt: applied ? '2030-01-01T00:00:02.000Z' : null,
      entitlementsVersion: applied ? 2 : null,
      certificateReissueStatus: applied ? 'issued' : 'pending',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:02.000Z',
    },
    replayed: input.replayed,
    license: applied
      ? {
          license: 'signed-test-certificate'.padEnd(96, 'x'),
          details: {
            id: 'license-control-plane-mock',
            plan: 'community',
            status: 'active',
            instanceId,
            hostingMode: 'community',
            edition: 'team',
            licenseClass: 'test',
            licenseEnvironment: 'development',
            billingOrganizationId: 'organization-control-plane-mock',
            entitlementsVersion: 2,
            deploymentMode: 'community',
            features: { multiUser: true, teamWorkspace: true },
            quotas: { users: 2 },
            activatedAt: '2030-01-01T00:00:00.000Z',
            expiresAt: '2030-01-02T00:00:00.000Z',
          },
        }
      : null,
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const body = await requestBody(request);
  requests.push({
    authorization: request.headers.authorization || null,
    body,
    method: request.method || 'GET',
    operationId: typeof request.headers['x-canvas-operation-id'] === 'string'
      ? request.headers['x-canvas-operation-id']
      : null,
    path: url.pathname,
    protocolVersion: typeof request.headers['x-canvas-team-seat-protocol'] === 'string'
      ? request.headers['x-canvas-team-seat-protocol']
      : null,
  });

  if (url.pathname === '/v1/license/claim/v1/start') {
    json(response, {
      claim: {
        protocolVersion: 'canvas-team-seat-protocol-v1',
        deviceCode: `dc_${'c'.repeat(64)}`,
        userCode: 'MOCK-CLAIM',
        verificationUrl: 'https://control.example.test/claim?code=MOCK-CLAIM',
        expiresAt: '2030-01-01T00:10:00.000Z',
        pollIntervalSeconds: 1,
      },
    }, 201);
    return;
  }

  if (url.pathname === '/v1/license/claim/v1/poll') {
    json(response, {
      claim: {
        protocolVersion: 'canvas-team-seat-protocol-v1',
        status: 'approved',
        instanceToken,
        tokenType: 'Bearer',
        scopes: [
          'license:refresh',
          'license:verify',
          'seat:prepare',
          'seat:execute',
          'seat:snapshot',
          'token:rotate',
        ],
        expiresAt: '2030-04-01T00:00:00.000Z',
        organizationId: 'organization-control-plane-mock',
        instanceId,
      },
    });
    return;
  }

  if (url.pathname === '/v1/license/community/v1/seats/prepare') {
    if (authenticationMode === '401') {
      json(response, {
        error: 'The instance token was revoked.',
        code: 'TEAM_SEAT_TOKEN_INVALID',
        retryable: false,
      }, 401);
      return;
    }
    if (authenticationMode === '403') {
      json(response, {
        error: 'The instance token lacks the required scope.',
        code: 'TEAM_SEAT_TOKEN_SCOPE_DENIED',
        retryable: false,
      }, 403);
      return;
    }
    prepareAttempts += 1;
    if (prepareAttempts === 1) {
      json(response, {
        error: 'The deterministic mock is temporarily unavailable.',
        code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
        retryable: true,
      }, 503, { 'retry-after': '0' });
      return;
    }
    const desiredQuantity = Number(body.desiredQuantity);
    json(response, {
      quote: seatQuote(desiredQuantity),
      authorization: seatAuthorization(desiredQuantity, 'pending'),
      requiresBillingApproval: true,
      snapshot: {
        revision: 1,
        observedQuantity: desiredQuantity - 1,
        licensedQuantity: desiredQuantity - 1,
        approvedQuantity: desiredQuantity - 1,
        billedQuantity: 0,
        billingStatus: 'active',
      },
    });
    return;
  }

  if (url.pathname === '/v1/license/community/v1/seats/quotes/quote-control-plane-mock') {
    json(response, {
      quote: seatQuote(2),
      authorization: seatAuthorization(2, 'approved'),
    });
    return;
  }

  if (url.pathname === '/v1/license/community/v1/seats/execute') {
    const operationKey = String(body.operationKey);
    if (operationKey === 'operation-requires-action') {
      json(response, executeResponse({
        operationKey,
        status: 'requires_action',
        replayed: false,
      }));
      return;
    }
    lostExecuteAttempts += 1;
    if (lostExecuteAttempts === 1) {
      request.socket.destroy();
      return;
    }
    json(response, executeResponse({
      operationKey,
      status: 'applied',
      replayed: true,
    }));
    return;
  }

  if (url.pathname === '/v1/license/community/v1/seats/snapshot') {
    json(response, {
      snapshot: {
        ...body,
        snapshotId: 'snapshot-control-plane-mock',
        receivedAt: '2030-01-01T00:00:01.000Z',
        reconciledAt: null,
        driftStatus: 'licensed_below_approved',
      },
      observedQuantity: body.observedQuantity,
      billedQuantity: 1,
      licensedQuantity: 1,
      expectedLicensedQuantity: 2,
      approvedQuantity: 2,
      billingStatus: 'active',
      nextReportAt: '2030-01-01T00:05:01.000Z',
      replayed: false,
    });
    return;
  }

  if (url.pathname === '/v1/license/community/v1/refresh') {
    json(response, {
      license: refreshedCertificate,
      details: {
        id: 'license-control-plane-mock',
        plan: 'community',
        status: 'active',
        instanceId,
        hostingMode: 'community',
        edition: 'team',
        licenseClass: 'commercial',
        licenseEnvironment: 'production',
        billingOrganizationId: 'organization-control-plane-mock',
        entitlementsVersion: 2,
        deploymentMode: 'community',
        features: {
          multiUser: true,
          teamWorkspace: true,
          vectorSearch: true,
          liveCollaboration: true,
        },
        quotas: { users: 2 },
        activatedAt: new Date((nowSeconds - 60) * 1_000).toISOString(),
        expiresAt: new Date(certificateExpiresAt * 1_000).toISOString(),
      },
    });
    return;
  }

  if (url.pathname === '/mock/timeout') {
    setTimeout(() => {
      if (!response.destroyed) json(response, { unexpected: true });
    }, 50);
    return;
  }

  json(response, { error: 'Not found' }, 404);
});

function restoreEnvironment(): void {
  for (const name of environmentNames) {
    const value = previousEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function listen(): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const baseUrl = await listen();
  process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = baseUrl;
  try {
    const {
      getCommunityLicenseClaimStatus,
      getCommunityTeamSeatQuoteStatus,
      LicenseControlPlaneError,
      pollCommunityLicenseClaim,
      prepareCommunityTeamSeatChange,
      refreshCommunityLicenseCertificate,
      startCommunityLicenseClaim,
      executeCommunityTeamSeatChange,
      submitCommunityTeamMembershipSnapshot,
    } = await import('../app/lib/license/control-plane');
    const {
      createTeamSeatExecuteRequest,
      createTeamSeatPrepareRequest,
      createTeamSeatSnapshotRequest,
    } = await import('../app/lib/license/team-seat-contract');
    const {
      loadCommunityInstanceToken,
      saveCommunityInstanceToken,
    } = await import('../app/lib/license/storage');
    const {
      requestTeamControlPlane,
      TeamControlPlaneTransportError,
    } = await import('../app/lib/control-plane/team-client');

    const claimNow = new Date('2026-08-01T00:00:00.000Z');
    const started = await startCommunityLicenseClaim({ now: claimNow });
    assert.equal(started.state, 'authorization_pending');
    const connected = await pollCommunityLicenseClaim(started.claimId, {
      now: new Date('2026-08-01T00:00:01.000Z'),
    });
    assert.equal(connected.state, 'connected');
    assert.equal(
      (await loadCommunityInstanceToken(instanceId))?.instanceToken,
      instanceToken,
    );

    const prepareOperationId = 'operation-prepare-control-plane-mock';
    const prepared = await prepareCommunityTeamSeatChange(
      createTeamSeatPrepareRequest({
        desiredQuantity: 2,
        triggerType: 'member_create',
      }),
      { operationId: prepareOperationId },
    );
    assert.equal(prepared.requiresBillingApproval, true);
    assert.equal(prepared.authorization.status, 'pending');
    assert.equal(prepareAttempts, 2);
    const prepareRequests = requests.filter(
      (request) => request.path.endsWith('/seats/prepare')
        && request.body.desiredQuantity === 2
        && authenticationMode === 'none',
    ).slice(0, 2);
    assert.deepEqual(
      prepareRequests.map((request) => request.operationId),
      [prepareOperationId, prepareOperationId],
    );
    assert.deepEqual(prepareRequests[0]?.body, prepareRequests[1]?.body);

    const approved = await getCommunityTeamSeatQuoteStatus(
      prepared.quote.quoteId,
      { operationId: prepareOperationId },
    );
    assert.equal(approved.authorization.status, 'approved');

    const requiresAction = await executeCommunityTeamSeatChange(
      createTeamSeatExecuteRequest({
        authorizationId: prepared.authorization.authorizationId,
        operationKey: 'operation-requires-action',
        operationType: 'member_create',
      }),
      { operationId: 'operation-requires-action' },
    );
    assert.equal(requiresAction.operation.status, 'requires_action');
    assert.equal(requiresAction.operation.effectiveQuantity, null);
    assert.equal(requiresAction.operation.certificateReissueStatus, 'pending');
    assert.equal(requiresAction.license, null);

    const recovered = await executeCommunityTeamSeatChange(
      createTeamSeatExecuteRequest({
        authorizationId: prepared.authorization.authorizationId,
        operationKey: 'operation-lost-success',
        operationType: 'member_create',
      }),
      { operationId: 'operation-lost-success' },
    );
    assert.equal(recovered.operation.status, 'applied');
    assert.equal(recovered.operation.effectiveQuantity, 2);
    assert.equal(recovered.replayed, true);
    assert.equal(lostExecuteAttempts, 2);
    assert.deepEqual(
      requests
        .filter((request) => request.body.operationKey === 'operation-lost-success')
        .map((request) => request.operationId),
      ['operation-lost-success', 'operation-lost-success'],
    );

    const snapshotRequest = createTeamSeatSnapshotRequest({
      revision: 2,
      snapshotHash: 'c'.repeat(64),
      observedQuantity: 2,
      roleSummary: { owner: 1, member: 1 },
      memberHashes: ['a'.repeat(64), 'b'.repeat(64)],
      generatedAt: '2030-01-01T00:00:00.000Z',
      notebookVersion: '2026.8.1.2',
    });
    const drift = await submitCommunityTeamMembershipSnapshot(snapshotRequest, {
      operationId: 'operation-snapshot-control-plane-mock',
    });
    assert.equal(drift.snapshot.driftStatus, 'licensed_below_approved');
    assert.equal(drift.observedQuantity, 2);
    assert.equal(drift.approvedQuantity, 2);
    assert.equal(drift.licensedQuantity, 1);
    assert.equal(drift.expectedLicensedQuantity, 2);

    const refreshed = await refreshCommunityLicenseCertificate({
      operationId: 'operation-refresh-control-plane-mock',
    });
    assert.equal(refreshed.status.licensed, true);
    assert.equal(refreshed.status.edition, 'team');
    assert.equal(refreshed.status.seatLimit, 2);
    assert.equal(refreshed.details.entitlementsVersion, 2);

    authenticationMode = '401';
    await assert.rejects(
      () => prepareCommunityTeamSeatChange(
        createTeamSeatPrepareRequest({
          desiredQuantity: 2,
          triggerType: 'member_create',
        }),
        { operationId: 'operation-authentication-401' },
      ),
      (error: unknown) => (
        error instanceof LicenseControlPlaneError
        && error.status === 401
        && error.code === 'TEAM_SEAT_TOKEN_INVALID'
        && error.category === 'authentication'
        && error.retryable === false
      ),
    );
    const reconnect = await getCommunityLicenseClaimStatus();
    assert.equal(reconnect.state, 'reconnect_required');
    if (reconnect.state === 'reconnect_required') {
      assert.equal(reconnect.reason, 'revoked');
      assert.equal(reconnect.coreUnaffected, true);
    }

    await saveCommunityInstanceToken({
      instanceId,
      instanceToken,
      tokenType: 'Bearer',
      scopes: [
        'license:refresh',
        'license:verify',
        'seat:prepare',
        'seat:execute',
        'seat:snapshot',
        'token:rotate',
      ],
      expiresAt: '2030-04-01T00:00:00.000Z',
    });
    authenticationMode = '403';
    await assert.rejects(
      () => prepareCommunityTeamSeatChange(
        createTeamSeatPrepareRequest({
          desiredQuantity: 2,
          triggerType: 'member_create',
        }),
        { operationId: 'operation-authentication-403' },
      ),
      (error: unknown) => (
        error instanceof LicenseControlPlaneError
        && error.status === 403
        && error.code === 'TEAM_SEAT_TOKEN_SCOPE_DENIED'
        && error.category === 'authentication'
        && error.retryable === false
      ),
    );
    assert.equal(
      (await loadCommunityInstanceToken(instanceId))?.instanceToken,
      instanceToken,
      'a terminal scope error must not silently rotate or replace the instance token',
    );

    const timeoutOperationId = 'operation-timeout-control-plane-mock';
    await assert.rejects(
      () => requestTeamControlPlane({
        baseUrl,
        path: '/mock/timeout',
        method: 'POST',
        body: { protocolVersion: 'canvas-team-seat-protocol-v1' },
        operationId: timeoutOperationId,
        timeoutMs: 5,
        maxAttempts: 2,
        backoffMs: 0,
        maxBackoffMs: 0,
        sleep: async () => undefined,
      }),
      (error: unknown) => (
        error instanceof TeamControlPlaneTransportError
        && error.operationId === timeoutOperationId
        && error.attemptCount === 2
      ),
    );
    const timeoutRequests = requests.filter((request) => request.path === '/mock/timeout');
    assert.equal(timeoutRequests.length, 2);
    assert.deepEqual(
      timeoutRequests.map((request) => request.operationId),
      [timeoutOperationId, timeoutOperationId],
    );

    const protectedRequests = requests.filter((request) => (
      request.path.includes('/license/community/v1/')
    ));
    assert.ok(protectedRequests.length > 0);
    assert.equal(
      protectedRequests.every((request) => request.authorization === `Bearer ${instanceToken}`),
      true,
    );
    assert.equal(
      protectedRequests.every(
        (request) => request.protocolVersion === 'canvas-team-seat-protocol-v1',
      ),
      true,
    );
    assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
    assert.equal(process.env.STRIPE_WEBHOOK_SECRET, undefined);
  } finally {
    await closeServer();
    restoreEnvironment();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    console.log('team-control-plane-mock-integration-test: ok');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
