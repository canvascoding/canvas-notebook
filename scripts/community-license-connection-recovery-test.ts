import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(tmpdir(), 'canvas-community-recovery-'));
const previousEnvironment = {
  DATA: process.env.DATA,
  CANVAS_INSTANCE_ID: process.env.CANVAS_INSTANCE_ID,
  CANVAS_DATABASE_PROVIDER: process.env.CANVAS_DATABASE_PROVIDER,
  CANVAS_LICENSE_CERT: process.env.CANVAS_LICENSE_CERT,
  CANVAS_LICENSE_CONTROL_PLANE_URL: process.env.CANVAS_LICENSE_CONTROL_PLANE_URL,
  CANVAS_TEAM_SEAT_CLIENT_ENABLED: process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED,
  CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: process.env.CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED,
};

process.env.DATA = dataRoot;
process.env.CANVAS_INSTANCE_ID = 'self_community_recovery_test';
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.CANVAS_LICENSE_CERT = 'certificate.'.padEnd(96, 'r');
process.env.CANVAS_LICENSE_CONTROL_PLANE_URL = 'https://control.example.test';
process.env.CANVAS_TEAM_SEAT_CLIENT_ENABLED = 'true';
process.env.CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED = 'true';

const oldToken = `lit_${'o'.repeat(64)}`;
const newToken = `lit_${'n'.repeat(64)}`;
const captured: Array<{ url: string; authorization: string | null }> = [];
const responses: Response[] = [];

const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  captured.push({
    url: String(input),
    authorization: new Headers(init?.headers).get('Authorization'),
  });
  const response = responses.shift();
  if (!response) throw new Error('Unexpected recovery fetch.');
  return response;
}) as typeof fetch;

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
  try {
    const {
      cancelCommunityLicenseClaim,
      getCommunityLicenseClaimStatus,
      getCommunityTeamUpgradePreflight,
      rotateCommunityLicenseConnection,
      startCommunityLicenseClaim,
    } = await import('../app/lib/license/control-plane');
    const {
      loadCommunityConnectionRecoveryState,
      loadCommunityInstanceToken,
      resolveCommunityConnectionRecoveryPath,
      saveCommunityInstanceToken,
    } = await import('../app/lib/license/storage');

    await saveCommunityInstanceToken({
      instanceId: 'self_community_recovery_test',
      instanceToken: oldToken,
      tokenType: 'Bearer',
      scopes: ['license:refresh', 'seat:prepare', 'seat:execute', 'seat:snapshot', 'token:rotate'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      now: new Date('2026-08-01T10:00:00.000Z'),
    });
    responses.push(jsonResponse({
      token: {
        protocolVersion: 'canvas-team-seat-protocol-v1',
        instanceToken: newToken,
        tokenType: 'Bearer',
        scopes: ['license:refresh', 'seat:prepare', 'seat:execute', 'seat:snapshot', 'token:rotate'],
        expiresAt: '2030-04-01T00:00:00.000Z',
        instanceId: 'self_community_recovery_test',
      },
    }));
    const rotated = await rotateCommunityLicenseConnection({
      fetchImpl: mockFetch,
      now: new Date('2026-08-01T10:05:00.000Z'),
    });
    assert.equal(rotated.state, 'connected');
    assert.equal(rotated.token.generation, 2);
    assert.equal(captured[0]?.authorization, `Bearer ${oldToken}`);
    assert.equal(
      (await loadCommunityInstanceToken('self_community_recovery_test'))?.instanceToken,
      newToken,
    );
    assert.equal(
      (await loadCommunityInstanceToken('self_community_recovery_test'))?.instanceToken === oldToken,
      false,
    );

    responses.push(jsonResponse({
      error: 'Community instance token is revoked',
      code: 'TEAM_SEAT_TOKEN_INVALID',
      retryable: false,
    }, 401));
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
        && error.code === 'TEAM_SEAT_TOKEN_INVALID'
      ),
    );
    assert.equal(captured[1]?.authorization, `Bearer ${newToken}`);
    assert.equal(await loadCommunityInstanceToken('self_community_recovery_test'), null);
    assert.deepEqual(
      await getCommunityLicenseClaimStatus({ now: new Date('2026-08-01T10:06:00.000Z') }),
      {
        state: 'reconnect_required',
        claimId: null,
        reason: 'revoked',
        detectedAt: (await loadCommunityConnectionRecoveryState(
          'self_community_recovery_test',
        ))?.detectedAt,
        coreUnaffected: true,
        teamAccessPolicy: 'signed_certificate_until_expiry',
      },
    );
    assert.equal((await stat(resolveCommunityConnectionRecoveryPath())).mode & 0o777, 0o600);

    responses.push(jsonResponse({
      claim: {
        protocolVersion: 'canvas-team-seat-protocol-v1',
        deviceCode: `dc_${'d'.repeat(64)}`,
        userCode: 'RCVR-2345',
        verificationUrl: 'https://control.example.test/claim-license?code=RCVR-2345',
        expiresAt: '2026-08-01T10:20:00.000Z',
        pollIntervalSeconds: 5,
      },
    }, 201));
    const recoveryClaim = await startCommunityLicenseClaim({
      fetchImpl: mockFetch,
      now: new Date('2026-08-01T10:07:00.000Z'),
    });
    assert.equal(recoveryClaim.state, 'authorization_pending');
    assert.equal(recoveryClaim.userCode, 'RCVR-2345');
    await cancelCommunityLicenseClaim(recoveryClaim.claimId);
    const afterCancel = await getCommunityLicenseClaimStatus({
      now: new Date('2026-08-01T10:08:00.000Z'),
    });
    assert.equal(afterCancel.state, 'reconnect_required');
    assert.equal(afterCancel.state === 'reconnect_required' && afterCancel.reason, 'revoked');
    assert.equal(
      afterCancel.state === 'reconnect_required' && afterCancel.teamAccessPolicy,
      'signed_certificate_until_expiry',
    );
  } finally {
    restoreEnvironment();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log('community-license-connection-recovery-test: ok'));
