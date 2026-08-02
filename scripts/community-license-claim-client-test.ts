import assert from 'node:assert/strict';
import {
  chmod,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-community-claim-'));
const previousEnvironment = {
  DATA: process.env.DATA,
  CANVAS_INSTANCE_ID: process.env.CANVAS_INSTANCE_ID,
  CANVAS_LICENSE_CERT: process.env.CANVAS_LICENSE_CERT,
  CANVAS_TEAM_SEAT_CLIENT_ENABLED: process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED,
  CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: process.env.CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED,
  CANVAS_LICENSE_CONTROL_PLANE_URL: process.env.CANVAS_LICENSE_CONTROL_PLANE_URL,
};

process.env.DATA = dataRoot;
process.env.CANVAS_INSTANCE_ID = 'self_claim_client_test';
const licenseCertificate = 'certificate.'.padEnd(96, 'x');
process.env.CANVAS_LICENSE_CERT = licenseCertificate;
process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED = 'true';
process.env.CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED = 'true';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';

type FetchStep = Response | Error;
type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const fetchSteps: FetchStep[] = [];
const capturedRequests: CapturedRequest[] = [];
const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === 'string'
    ? JSON.parse(init.body) as Record<string, unknown>
    : {};
  capturedRequests.push({ url: String(input), body });
  const step = fetchSteps.shift();
  if (!step) throw new Error('Unexpected Community claim fetch.');
  if (step instanceof Error) throw step;
  return step;
}) as typeof fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pendingClaim(deviceCode: string, expiresAt: string, pollIntervalSeconds = 5) {
  return {
    claim: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      deviceCode,
      userCode: 'ABCD-2345',
      verificationUrl: 'https://app.example.test/claim-license?code=ABCD-2345',
      expiresAt,
      pollIntervalSeconds,
    },
  };
}

function pendingPoll(expiresAt: string, pollIntervalSeconds = 5) {
  return {
    claim: {
      protocolVersion: 'canvas-team-seat-protocol-v1',
      status: 'authorization_pending',
      expiresAt,
      pollIntervalSeconds,
    },
  };
}

function approvedPoll(instanceToken: string, expiresAt: string) {
  return {
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
      expiresAt,
      organizationId: 'organization-claim-test',
      instanceId: 'self_claim_client_test',
    },
  };
}

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function main(): Promise<void> {
  try {
  const {
    cancelCommunityLicenseClaim,
    getCommunityLicenseClaimStatus,
    LicenseControlPlaneError,
    pollCommunityLicenseClaim,
    startCommunityLicenseClaim,
  } = await import('../app/lib/license/control-plane');
  const {
    loadCommunityClaimSession,
    loadCommunityInstanceToken,
    removeCommunityInstanceToken,
    resolveCommunityClaimSessionPath,
    resolveCommunityInstanceTokenPath,
  } = await import('../app/lib/license/storage');
  const {
    registerTeamMembershipSyncSignal,
  } = await import('../app/lib/license/team-membership-sync-signal');
  let membershipSyncSignals = 0;
  registerTeamMembershipSyncSignal(() => {
    membershipSyncSignals += 1;
  });

  const startedAt = new Date('2026-08-01T10:00:00.000Z');
  const claimExpiresAt = '2026-08-01T10:10:00.000Z';
  const deviceCode = `dc_${'a'.repeat(64)}`;
  const instanceToken = `lit_${'b'.repeat(64)}`;

  fetchSteps.push(jsonResponse(pendingClaim(deviceCode, claimExpiresAt), 201));
  const started = await startCommunityLicenseClaim({
    fetchImpl: mockFetch,
    now: startedAt,
  });
  assert.equal(started.state, 'authorization_pending');
  assert.match(started.claimId, /^community-claim-/u);
  assert.equal(started.userCode, 'ABCD-2345');
  assert.equal(JSON.stringify(started).includes(deviceCode), false);
  assert.equal(JSON.stringify(started).includes(licenseCertificate), false);
  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0]?.url, 'https://control.example.test/v1/license/claim/v1/start');
  assert.equal(capturedRequests[0]?.body.instanceId, 'self_claim_client_test');
  assert.equal(capturedRequests[0]?.body.licenseCertificate, licenseCertificate);

  const claimPath = resolveCommunityClaimSessionPath();
  assert.equal((await stat(claimPath)).mode & 0o777, 0o600);
  const storedClaim = await loadCommunityClaimSession('self_claim_client_test');
  assert.equal(storedClaim?.deviceCode, deviceCode);
  assert.equal((await readFile(claimPath, 'utf8')).includes(deviceCode), true);

  const idempotentStart = await startCommunityLicenseClaim({
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T10:00:00.500Z'),
  });
  assert.equal(idempotentStart.claimId, started.claimId);
  assert.equal(capturedRequests.length, 1);

  fetchSteps.push(jsonResponse(pendingPoll(claimExpiresAt)));
  const pending = await pollCommunityLicenseClaim(started.claimId, {
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T10:00:01.000Z'),
  });
  assert.equal(pending.state, 'authorization_pending');
  assert.equal(pending.retryAfterSeconds, 5);
  assert.equal(capturedRequests.length, 2);
  assert.equal(capturedRequests[1]?.url, 'https://control.example.test/v1/license/claim/v1/poll');
  assert.equal(capturedRequests[1]?.body.deviceCode, deviceCode);

  const locallyThrottled = await pollCommunityLicenseClaim(started.claimId, {
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T10:00:02.000Z'),
  });
  assert.equal(locallyThrottled.state, 'authorization_pending');
  assert.equal(locallyThrottled.retryAfterSeconds, 4);
  assert.equal(capturedRequests.length, 2);

  fetchSteps.push(jsonResponse({
    error: 'Poll interval not reached',
    code: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
    retryable: true,
  }, 429));
  await assert.rejects(
    () => pollCommunityLicenseClaim(started.claimId, {
      fetchImpl: mockFetch,
      now: new Date('2026-08-01T10:00:06.000Z'),
    }),
    (error: unknown) => (
      error instanceof LicenseControlPlaneError
      && error.code === 'TEAM_SEAT_TEMPORARY_UNAVAILABLE'
      && error.retryable
      && error.retryAfterSeconds === 5
    ),
  );
  const backoffStatus = await getCommunityLicenseClaimStatus({
    now: new Date('2026-08-01T10:00:07.000Z'),
  });
  assert.equal(backoffStatus.state, 'authorization_pending');
  if (backoffStatus.state === 'authorization_pending') {
    assert.equal(backoffStatus.retryAfterSeconds, 4);
    assert.equal(backoffStatus.lastErrorCode, 'TEAM_SEAT_TEMPORARY_UNAVAILABLE');
  }

  fetchSteps.push(jsonResponse(approvedPoll(instanceToken, '2026-11-01T00:00:00.000Z')));
  const connected = await pollCommunityLicenseClaim(started.claimId, {
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T10:00:11.000Z'),
  });
  assert.equal(connected.state, 'connected');
  assert.equal(connected.organizationId, 'organization-claim-test');
  assert.equal(connected.token.configured, true);
  assert.equal(JSON.stringify(connected).includes(instanceToken), false);
  assert.equal(await loadCommunityClaimSession('self_claim_client_test'), null);
  assert.equal((await stat(resolveCommunityInstanceTokenPath())).mode & 0o777, 0o600);
  assert.equal((await loadCommunityInstanceToken('self_claim_client_test'))?.instanceToken, instanceToken);
  assert.equal(membershipSyncSignals, 1);

  const recoveredConnected = await pollCommunityLicenseClaim(started.claimId, {
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T10:00:12.000Z'),
  });
  assert.equal(recoveredConnected.state, 'connected');
  assert.equal(JSON.stringify(recoveredConnected).includes(instanceToken), false);
  assert.equal(capturedRequests.length, 4);

  await removeCommunityInstanceToken({
    instanceId: 'self_claim_client_test',
    expectedToken: instanceToken,
  });

  const cancelDeviceCode = `dc_${'c'.repeat(64)}`;
  fetchSteps.push(jsonResponse(pendingClaim(
    cancelDeviceCode,
    '2026-08-01T11:10:00.000Z',
  ), 201));
  const cancelable = await startCommunityLicenseClaim({
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T11:00:00.000Z'),
  });
  const canceled = await cancelCommunityLicenseClaim(cancelable.claimId);
  assert.deepEqual(canceled, { state: 'canceled', claimId: cancelable.claimId });
  assert.equal(await loadCommunityClaimSession('self_claim_client_test'), null);
  assert.deepEqual(
    await getCommunityLicenseClaimStatus({ now: new Date('2026-08-01T11:00:01.000Z') }),
    { state: 'idle', claimId: null },
  );

  const timeoutDeviceCode = `dc_${'d'.repeat(64)}`;
  fetchSteps.push(jsonResponse(pendingClaim(
    timeoutDeviceCode,
    '2026-08-01T12:10:00.000Z',
  ), 201));
  const timeoutClaim = await startCommunityLicenseClaim({
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T12:00:00.000Z'),
  });
  fetchSteps.push(new Error('request timed out'));
  await assert.rejects(
    () => pollCommunityLicenseClaim(timeoutClaim.claimId, {
      fetchImpl: mockFetch,
      now: new Date('2026-08-01T12:00:01.000Z'),
    }),
    (error: unknown) => (
      error instanceof LicenseControlPlaneError
      && error.code === 'TEAM_SEAT_TEMPORARY_UNAVAILABLE'
      && error.retryable
    ),
  );
  assert.equal((await loadCommunityClaimSession('self_claim_client_test'))?.claimId, timeoutClaim.claimId);
  assert.equal(await loadCommunityInstanceToken('self_claim_client_test'), null);
  await cancelCommunityLicenseClaim(timeoutClaim.claimId);

  const expiringDeviceCode = `dc_${'e'.repeat(64)}`;
  fetchSteps.push(jsonResponse(pendingClaim(
    expiringDeviceCode,
    '2026-08-01T13:00:02.000Z',
  ), 201));
  const expiringClaim = await startCommunityLicenseClaim({
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T13:00:00.000Z'),
  });
  await assert.rejects(
    () => pollCommunityLicenseClaim(expiringClaim.claimId, {
      fetchImpl: mockFetch,
      now: new Date('2026-08-01T13:00:03.000Z'),
    }),
    (error: unknown) => (
      error instanceof LicenseControlPlaneError
      && error.code === 'TEAM_SEAT_CLAIM_EXPIRED'
      && error.status === 410
    ),
  );
  assert.equal(await loadCommunityClaimSession('self_claim_client_test'), null);

  const terminalDeviceCode = `dc_${'f'.repeat(64)}`;
  fetchSteps.push(jsonResponse(pendingClaim(
    terminalDeviceCode,
    '2026-08-01T14:10:00.000Z',
  ), 201));
  const terminalClaim = await startCommunityLicenseClaim({
    fetchImpl: mockFetch,
    now: new Date('2026-08-01T14:00:00.000Z'),
  });
  fetchSteps.push(jsonResponse({
    error: 'The claim session was already consumed',
    code: 'TEAM_SEAT_CLAIM_REPLAY',
    retryable: false,
  }, 409));
  await assert.rejects(
    () => pollCommunityLicenseClaim(terminalClaim.claimId, {
      fetchImpl: mockFetch,
      now: new Date('2026-08-01T14:00:01.000Z'),
    }),
    (error: unknown) => (
      error instanceof LicenseControlPlaneError
      && error.code === 'TEAM_SEAT_CLAIM_REPLAY'
      && !error.retryable
    ),
  );
  assert.equal(await loadCommunityClaimSession('self_claim_client_test'), null);
  assert.equal(fetchSteps.length, 0);

  await chmod(path.join(dataRoot, 'secrets'), 0o700);
  const routeSources = await Promise.all([
    'start',
    'poll',
    'status',
    'cancel',
  ].map((route) => readFile(
    path.join(process.cwd(), 'app', 'api', 'license', 'claim', route, 'route.ts'),
    'utf8',
  )));
  assert.equal(routeSources.some((source) => source.includes('deviceCode')), false);
  assert.equal(routeSources.some((source) => source.includes('instanceToken')), false);
  registerTeamMembershipSyncSignal(null);

  console.log('community license claim client tests passed');
  } finally {
    restoreEnvironment();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

void main();
