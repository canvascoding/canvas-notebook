import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-community-refresh-'));
const instanceId = 'self_community_refresh_test';
const previousEnvironment = {
  DATA: process.env.DATA,
  CANVAS_INSTANCE_ID: process.env.CANVAS_INSTANCE_ID,
  CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
  CANVAS_LICENSE_PUBLIC_KEY: process.env.CANVAS_LICENSE_PUBLIC_KEY,
  CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS:
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS,
  CANVAS_LICENSE_CONTROL_PLANE_URL: process.env.CANVAS_LICENSE_CONTROL_PLANE_URL,
};

process.env.DATA = dataRoot;
process.env.CANVAS_INSTANCE_ID = instanceId;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function keyFingerprint(publicKeyPem: string) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function signLicense(
  privateKey: crypto.KeyObject,
  payload: Record<string, unknown>,
  kid: string,
) {
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    privateKey,
  );
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function restoreEnvironment() {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = keyFingerprint(publicKeyPem);
  const kid = fingerprint.slice(0, 16);
  process.env.CANVAS_LICENSE_PUBLIC_KEY = publicKeyPem;
  process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;

  const baseSeconds = Math.floor(Date.now() / 1000);
  const token = `lit_${'r'.repeat(64)}`;
  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const responses: Array<Response | Error> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected Community refresh request.');
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;

  const certificatePayload = (
    entitlementsVersion: number,
    issuedAt: number,
    expiresAt: number,
  ) => ({
    sub: instanceId,
    iss: 'canvas-control-plane',
    aud: 'canvas-notebook',
    plan: 'community',
    status: 'active',
    protocolVersion: 'canvas-team-seat-protocol-v1',
    licenseId: 'license-community-refresh',
    instanceId,
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    seatLimit: 3,
    entitlementsVersion,
    nonBillable: false,
    deploymentMode: 'community',
    databaseProvider: 'postgres',
    vectorProvider: 'pgvector',
    postgresRequired: true,
    capabilities: {
      teamWorkspace: true,
      multiUser: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    features: {
      teamWorkspace: true,
      multiUser: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    quotas: { users: 3 },
    iat: issuedAt,
    exp: expiresAt,
  });
  const details = (entitlementsVersion: number, expiresAt: number) => ({
    id: 'license-community-refresh',
    plan: 'community',
    status: 'active',
    instanceId,
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'commercial',
    licenseEnvironment: 'production',
    billingOrganizationId: 'organization-refresh',
    entitlementsVersion,
    deploymentMode: 'community',
    features: {
      teamWorkspace: true,
      multiUser: true,
      vectorSearch: true,
      liveCollaboration: true,
    },
    quotas: { users: 3 },
    activatedAt: new Date((baseSeconds - 3600) * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });

  const policy = {
    initialDelaySeconds: 1,
    intervalSeconds: 60,
    refreshAheadSeconds: 30,
    minimumScheduleSeconds: 1,
    idlePollSeconds: 60,
    backoffInitialSeconds: 10,
    backoffMaximumSeconds: 40,
    backoffJitterRatio: 0,
    commercialGraceSeconds: 3600,
  };

  try {
    const { activateLicenseCert, getLicenseStatus } = await import('../app/lib/license');
    const { requireTeamRuntimeLicense } = await import('../app/lib/license/entitlements');
    const {
      communityLicenseRefreshBackoffSeconds,
      runCommunityLicenseRefreshCycle,
    } = await import('../app/lib/license/refresh');
    const {
      decodeLicenseJwt,
    } = await import('../app/lib/license/jwt');
    const {
      loadCommunityInstanceToken,
      loadCommunityLicenseRefreshState,
      loadStoredLicenseCert,
      resolveCommunityLicenseRefreshStatePath,
      saveCommunityInstanceToken,
      saveCommunityLicenseRefreshState,
      saveLicenseCert,
    } = await import('../app/lib/license/storage');

    const initialCertificate = signLicense(
      privateKey,
      certificatePayload(1, baseSeconds - 60, baseSeconds + 3600),
      kid,
    );
    await activateLicenseCert(initialCertificate);
    await saveCommunityInstanceToken({
      instanceId,
      instanceToken: token,
      tokenType: 'Bearer',
      scopes: ['license:refresh', 'seat:prepare', 'seat:execute', 'seat:snapshot', 'token:rotate'],
      expiresAt: new Date((baseSeconds + 86_400) * 1000).toISOString(),
    });

    const refreshedCertificate = signLicense(
      privateKey,
      certificatePayload(2, baseSeconds, baseSeconds + 7200),
      kid,
    );
    responses.push(jsonResponse({
      license: refreshedCertificate,
      details: details(2, baseSeconds + 7200),
    }));
    const successNow = new Date(baseSeconds * 1000);
    const success = await runCommunityLicenseRefreshCycle({
      fetchImpl: mockFetch,
      force: true,
      now: successNow,
      policy,
      random: () => 0.5,
    });
    assert.equal(success.attempted, true);
    assert.equal(success.error, null);
    assert.equal(success.status?.entitlementsVersion, 2);
    assert.equal(success.state.phase, 'active');
    assert.equal(success.state.entitlementsVersion, 2);
    assert.equal(success.state.lastSuccessAt, successNow.toISOString());
    assert.equal(requests[0]?.url, 'https://control.example.test/v1/license/community/v1/refresh');
    assert.equal(requests[0]?.authorization, `Bearer ${token}`);
    assert.deepEqual(requests[0]?.body, {
      protocolVersion: 'canvas-team-seat-protocol-v1',
    });
    assert.equal(await loadStoredLicenseCert(instanceId), refreshedCertificate);
    assert.equal((await getLicenseStatus()).entitlementsVersion, 2);
    assert.equal((await stat(resolveCommunityLicenseRefreshStatePath())).mode & 0o777, 0o600);

    responses.push(new Error('network offline'));
    const firstFailureNow = new Date((baseSeconds + 60) * 1000);
    const firstFailure = await runCommunityLicenseRefreshCycle({
      fetchImpl: mockFetch,
      force: true,
      now: firstFailureNow,
      policy,
      random: () => 0.5,
    });
    assert.equal(firstFailure.state.phase, 'backoff');
    assert.equal(firstFailure.state.consecutiveFailures, 1);
    assert.equal(firstFailure.state.retryable, true);
    assert.equal(
      Date.parse(firstFailure.state.nextAttemptAt!) - firstFailureNow.getTime(),
      10_000,
    );

    responses.push(new Error('network still offline'));
    const secondFailureNow = new Date((baseSeconds + 70) * 1000);
    const secondFailure = await runCommunityLicenseRefreshCycle({
      fetchImpl: mockFetch,
      force: true,
      now: secondFailureNow,
      policy,
      random: () => 0.5,
    });
    assert.equal(secondFailure.state.consecutiveFailures, 2);
    assert.equal(
      Date.parse(secondFailure.state.nextAttemptAt!) - secondFailureNow.getTime(),
      20_000,
    );
    assert.equal(communityLicenseRefreshBackoffSeconds(8, policy, () => 0.5), 40);

    const mismatchedCertificate = signLicense(
      privateKey,
      certificatePayload(3, baseSeconds + 80, baseSeconds + 10_800),
      kid,
    );
    responses.push(jsonResponse({
      license: mismatchedCertificate,
      details: details(4, baseSeconds + 10_800),
    }));
    const mismatch = await runCommunityLicenseRefreshCycle({
      fetchImpl: mockFetch,
      force: true,
      now: new Date((baseSeconds + 80) * 1000),
      policy,
      random: () => 0.5,
    });
    assert.equal(mismatch.state.phase, 'blocked');
    assert.equal(mismatch.error?.code, 'LICENSE_CERT_CLAIMS_INVALID');
    assert.equal(await loadStoredLicenseCert(instanceId), refreshedCertificate);

    const expiredCertificate = signLicense(
      privateKey,
      certificatePayload(3, baseSeconds - 3600, baseSeconds - 60),
      kid,
    );
    const expiredPayload = decodeLicenseJwt(expiredCertificate);
    assert.ok(expiredPayload);
    await saveLicenseCert(expiredCertificate, expiredPayload);
    const graceStartedAt = new Date((baseSeconds - 60) * 1000).toISOString();
    const graceExpiresAt = new Date((baseSeconds + 3540) * 1000).toISOString();
    const currentRefreshState = await loadCommunityLicenseRefreshState(instanceId);
    assert.ok(currentRefreshState);
    await saveCommunityLicenseRefreshState({
      ...currentRefreshState,
      phase: 'backoff',
      retryable: true,
      lastErrorCode: 'TEAM_SEAT_TEMPORARY_UNAVAILABLE',
      certificateExpiresAt: graceStartedAt,
      entitlementsVersion: 2,
      graceStartedAt,
      graceExpiresAt,
      updatedAt: new Date().toISOString(),
    });
    const staleGraceStatus = await getLicenseStatus();
    assert.equal(staleGraceStatus.licensed, false);
    assert.equal(staleGraceStatus.licenseState, 'grace_required');
    assert.equal(staleGraceStatus.refresh, null);

    await saveCommunityLicenseRefreshState({
      ...(await loadCommunityLicenseRefreshState(instanceId))!,
      entitlementsVersion: 3,
      updatedAt: new Date().toISOString(),
    });
    const graceStatus = await getLicenseStatus();
    assert.equal(graceStatus.licensed, true);
    assert.equal(graceStatus.licenseState, 'grace');
    assert.equal(graceStatus.code, 'LICENSE_REFRESH_GRACE_ACTIVE');
    assert.equal(graceStatus.graceExpiresAt, graceExpiresAt);
    assert.equal((await requireTeamRuntimeLicense()).licenseState, 'grace');

    await saveCommunityLicenseRefreshState({
      ...(await loadCommunityLicenseRefreshState(instanceId))!,
      graceExpiresAt: new Date((baseSeconds - 1) * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const graceExpiredStatus = await getLicenseStatus();
    assert.equal(graceExpiredStatus.licensed, false);
    assert.equal(graceExpiredStatus.licenseState, 'expired');
    assert.equal(graceExpiredStatus.code, 'LICENSE_REFRESH_GRACE_EXPIRED');

    responses.push(jsonResponse({
      error: 'Community instance token is revoked',
      code: 'TEAM_SEAT_TOKEN_INVALID',
      retryable: false,
    }, 401));
    const revoked = await runCommunityLicenseRefreshCycle({
      fetchImpl: mockFetch,
      force: true,
      now: new Date(),
      policy,
      random: () => 0.5,
    });
    assert.equal(revoked.state.phase, 'reconnect_required');
    assert.equal(revoked.state.retryable, false);
    assert.equal(revoked.state.graceExpiresAt, null);
    assert.equal(await loadCommunityInstanceToken(instanceId), null);

    const serverSource = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    const instrumentationSource = readFileSync(
      path.join(process.cwd(), 'instrumentation.ts'),
      'utf8',
    );
    assert.match(serverSource, /initializeCommunityLicenseRefreshRuntime/u);
    assert.match(instrumentationSource, /initializeCommunityLicenseRefreshRuntime/u);
  } finally {
    restoreEnvironment();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log('community-license-refresh-test: ok'));
