import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  TEAM_SEAT_ERROR_CODES,
  TEAM_SEAT_LICENSE_CLASSES,
  TEAM_SEAT_LICENSE_ENVIRONMENTS,
  TEAM_SEAT_PROTOCOL_VERSION,
  TeamSeatContractError,
  assertTeamSeatProtocolVersion,
  createTeamSeatClaimPollRequest,
  createTeamSeatClaimStartRequest,
  createTeamSeatExecuteRequest,
  createTeamSeatPreflightRequest,
  createTeamSeatPrepareRequest,
  createTeamSeatSnapshotRequest,
  createTeamSeatTokenLifecycleRequest,
  parseTeamSeatAuthorization,
  parseTeamSeatClaimPollResult,
  parseTeamSeatClaimStart,
  parseTeamSeatDriftStatus,
  parseTeamSeatEntitlements,
  parseTeamSeatErrorPayload,
  parseTeamSeatExecuteResponse,
  parseTeamSeatLicenseClaims,
  parseTeamSeatLicenseClass,
  parseTeamSeatLicenseEnvironment,
  parseTeamSeatMembershipSnapshot,
  parseTeamSeatPreflightResponse,
  parseTeamSeatPrepareResponse,
  parseTeamSeatQuote,
  parseTeamSeatSnapshotResponse,
  parseTeamSeatTokenRotation,
} from '../app/lib/license/team-seat-contract';

type ContractFixtures = {
  protocolVersion: string;
  positive: {
    preflight: unknown;
    entitlements: unknown;
    quote: unknown;
    snapshot: unknown;
    transitions: Record<string, {
      trigger: string;
      before: unknown;
      after: unknown;
      expectedInvariants: {
        sameSubject: boolean;
        entitlementsVersionIncreased: boolean;
        licensedSeatsDidNotIncrease: boolean;
        localDataDeleted: boolean;
      };
    }>;
  };
  negative: Record<string, unknown>;
};

const projectRoot = path.resolve(__dirname, '..');
const localFixturePath = path.join(
  projectRoot,
  'app/lib/license/fixtures/team-seat-protocol-v1.json',
);
const controlPlaneFixturePath = path.resolve(
  projectRoot,
  '../canvas-control-plane/packages/shared/fixtures/team-seat-protocol-v1.json',
);
const contractSourcePath = path.join(
  projectRoot,
  'app/lib/license/team-seat-contract.ts',
);
const EXPECTED_CONTROL_PLANE_FIXTURE_SHA256 = 'c4c630a8b03ab14cda84795982617c200ac0e2d09edf0d19ce57b045e56e8d41';

function expectContractError(
  action: () => unknown,
  code: TeamSeatContractError['code'] = TEAM_SEAT_ERROR_CODES.invalidRequest,
): TeamSeatContractError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof TeamSeatContractError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('Expected TeamSeatContractError.');
}

function protocolMutation(value: unknown, protocolVersion: string): unknown {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return { ...(value as Record<string, unknown>), protocolVersion };
}

async function loadFixtures(): Promise<{ raw: string; fixtures: ContractFixtures }> {
  const raw = await readFile(localFixturePath, 'utf8');
  return {
    raw,
    fixtures: JSON.parse(raw) as ContractFixtures,
  };
}

async function main() {
  const { raw, fixtures } = await loadFixtures();

  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    EXPECTED_CONTROL_PLANE_FIXTURE_SHA256,
    'Vendored fixture must stay byte-identical to the frozen Control Plane fixture.',
  );
  assert.equal(fixtures.protocolVersion, TEAM_SEAT_PROTOCOL_VERSION);
  assertTeamSeatProtocolVersion(fixtures.protocolVersion);

  try {
    await access(controlPlaneFixturePath);
    const controlPlaneRaw = await readFile(controlPlaneFixturePath, 'utf8');
    assert.equal(
      raw,
      controlPlaneRaw,
      'When both repositories are present, Notebook must consume the exact Control Plane fixture.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const preflight = parseTeamSeatPreflightResponse(fixtures.positive.preflight);
  assert.equal(preflight.ready, true);
  assert.equal(preflight.license.licenseClass, 'test');
  assert.equal(preflight.license.licenseEnvironment, 'development');

  const entitlements = parseTeamSeatEntitlements(fixtures.positive.entitlements);
  assert.equal(entitlements.provider, 'test');
  assert.equal(entitlements.nonBillable, true);

  const quote = parseTeamSeatQuote(fixtures.positive.quote);
  assert.equal(quote.quantityAfter - quote.quantityBefore, quote.quantityDelta);
  assert.equal(quote.currency, 'eur');

  const snapshot = parseTeamSeatMembershipSnapshot(fixtures.positive.snapshot);
  assert.equal(snapshot.observedQuantity, 3);
  assert.equal(snapshot.memberHashes.length, 3);

  for (const [name, transition] of Object.entries(fixtures.positive.transitions)) {
    const before = parseTeamSeatEntitlements(transition.before, `transitions.${name}.before`);
    const after = parseTeamSeatEntitlements(transition.after, `transitions.${name}.after`);
    if (transition.expectedInvariants.sameSubject) {
      assert.deepEqual(before.subject, after.subject);
    }
    if (transition.expectedInvariants.entitlementsVersionIncreased) {
      assert.ok(after.entitlementsVersion > before.entitlementsVersion);
    }
    if (transition.expectedInvariants.licensedSeatsDidNotIncrease) {
      assert.ok(after.licensedSeats <= before.licensedSeats);
    }
    assert.equal(transition.expectedInvariants.localDataDeleted, false);
  }

  for (const [name, fixture] of Object.entries(fixtures.negative)) {
    const parsed = parseTeamSeatErrorPayload(fixture, `negative.${name}`);
    assert.ok(parsed.code.startsWith('TEAM_SEAT_'));
  }

  const unsupported = 'canvas-team-seat-protocol-v2';
  expectContractError(
    () => assertTeamSeatProtocolVersion(unsupported),
    TEAM_SEAT_ERROR_CODES.protocolUnsupported,
  );
  expectContractError(
    () => parseTeamSeatEntitlements(protocolMutation(fixtures.positive.entitlements, unsupported)),
    TEAM_SEAT_ERROR_CODES.protocolUnsupported,
  );
  expectContractError(
    () => parseTeamSeatQuote(protocolMutation(fixtures.positive.quote, unsupported)),
    TEAM_SEAT_ERROR_CODES.protocolUnsupported,
  );
  expectContractError(
    () => parseTeamSeatMembershipSnapshot(protocolMutation(fixtures.positive.snapshot, unsupported)),
    TEAM_SEAT_ERROR_CODES.protocolUnsupported,
  );

  for (const licenseClass of TEAM_SEAT_LICENSE_CLASSES) {
    assert.equal(parseTeamSeatLicenseClass(licenseClass), licenseClass);
  }
  for (const environment of TEAM_SEAT_LICENSE_ENVIRONMENTS) {
    assert.equal(parseTeamSeatLicenseEnvironment(environment), environment);
  }
  expectContractError(() => parseTeamSeatLicenseClass('enterprise'));
  expectContractError(() => parseTeamSeatLicenseEnvironment('local'));
  expectContractError(() => parseTeamSeatDriftStatus('unknown'));

  expectContractError(() => parseTeamSeatEntitlements({
    ...(fixtures.positive.entitlements as Record<string, unknown>),
    licenseEnvironment: 'production',
  }));
  expectContractError(() => parseTeamSeatLicenseClaims({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    licenseId: 'license-fixture',
    instanceId: 'instance-fixture',
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'test',
    licenseEnvironment: 'production',
    provider: 'test',
    seatLimit: 3,
    entitlementsVersion: 1,
    nonBillable: true,
  }));

  const claims = parseTeamSeatLicenseClaims({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    licenseId: 'license-fixture',
    instanceId: 'instance-fixture',
    hostingMode: 'community',
    edition: 'team',
    licenseClass: 'manual',
    licenseEnvironment: 'production',
    provider: 'manual',
    seatLimit: 3,
    entitlementsVersion: 2,
    grantId: 'grant-fixture',
    nonBillable: true,
  });
  assert.equal(claims.seatLimit, 3);

  const startRequest = createTeamSeatClaimStartRequest({
    licenseCertificate: 'certificate.'.padEnd(64, 'x'),
    instanceId: 'instance-fixture',
  });
  const pollRequest = createTeamSeatClaimPollRequest('dc_'.padEnd(32, 'x'));
  const tokenRequest = createTeamSeatTokenLifecycleRequest();
  const preflightRequest = createTeamSeatPreflightRequest({
    notebookVersion: '2026.8.1.2',
    databaseEngine: 'postgres',
    teamReady: true,
  });
  const prepareRequest = createTeamSeatPrepareRequest({
    desiredQuantity: 3,
    triggerType: 'member_create',
    externalReference: 'member-operation-fixture',
  });
  const executeRequest = createTeamSeatExecuteRequest({
    authorizationId: 'authorization-fixture',
    operationKey: 'operation-key-fixture',
    operationType: 'member_create',
  });
  for (const request of [
    startRequest,
    pollRequest,
    tokenRequest,
    preflightRequest,
    prepareRequest,
    executeRequest,
  ]) {
    assert.equal(request.protocolVersion, TEAM_SEAT_PROTOCOL_VERSION);
  }

  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const snapshotRequest = createTeamSeatSnapshotRequest({
    revision: 8,
    snapshotHash: 'c'.repeat(64),
    observedQuantity: 2,
    roleSummary: { owner: 1, member: 1 },
    memberHashes: [hashA, hashB],
    generatedAt: '2030-01-01T00:00:00.000Z',
    notebookVersion: '2026.8.1.2',
  });
  assert.equal(snapshotRequest.protocolVersion, TEAM_SEAT_PROTOCOL_VERSION);
  expectContractError(() => createTeamSeatSnapshotRequest({
    ...snapshotRequest,
    snapshotHash: 'invalid',
  }));

  const claimStart = parseTeamSeatClaimStart({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    deviceCode: 'dc_'.padEnd(32, 'x'),
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://control.example/claim-license?code=ABCD-EFGH',
    expiresAt: '2030-01-01T00:10:00.000Z',
    pollIntervalSeconds: 5,
  });
  assert.equal(claimStart.userCode, 'ABCD-EFGH');

  const pendingClaim = parseTeamSeatClaimPollResult({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    status: 'authorization_pending',
    pollIntervalSeconds: 5,
    expiresAt: '2030-01-01T00:10:00.000Z',
  });
  assert.equal(pendingClaim.status, 'authorization_pending');

  const approvedClaim = parseTeamSeatClaimPollResult({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    status: 'approved',
    instanceToken: 'lit_'.padEnd(64, 'x'),
    tokenType: 'Bearer',
    scopes: ['license:refresh', 'seat:prepare', 'seat:execute', 'seat:snapshot', 'token:rotate'],
    expiresAt: '2030-04-01T00:00:00.000Z',
    organizationId: 'org-fixture',
    instanceId: 'instance-fixture',
  });
  assert.equal(approvedClaim.status, 'approved');

  const rotatedToken = parseTeamSeatTokenRotation({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    instanceToken: 'lit_'.padEnd(64, 'y'),
    tokenType: 'Bearer',
    scopes: ['license:refresh', 'seat:prepare', 'seat:execute', 'seat:snapshot', 'token:rotate'],
    expiresAt: '2030-04-01T00:00:00.000Z',
    instanceId: 'instance-fixture',
  });
  assert.equal(rotatedToken.tokenType, 'Bearer');

  const authorization = parseTeamSeatAuthorization({
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    authorizationId: 'authorization-fixture',
    quoteId: quote.quoteId,
    quoteHash: quote.quoteHash,
    quantityBefore: 2,
    quantityAfter: 3,
    status: 'approved',
    expiresAt: '2030-01-01T00:05:00.000Z',
    approvedAt: '2030-01-01T00:00:01.000Z',
    consumedAt: null,
  });
  const prepared = parseTeamSeatPrepareResponse({
    quote: {
      ...fixtures.positive.quote as Record<string, unknown>,
      provider: 'manual',
      environment: 'production',
      status: 'active',
      nonBillable: true,
    },
    authorization,
    requiresBillingApproval: false,
    snapshot: {
      revision: 7,
      observedQuantity: 2,
      licensedQuantity: 2,
      approvedQuantity: 3,
      billedQuantity: 0,
      billingStatus: 'active',
    },
  });
  assert.equal(prepared.snapshot.revision, 7);

  const operation = {
    protocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
    operationId: 'operation-fixture',
    operationKey: 'operation-key-fixture',
    operationType: 'member_create',
    provider: 'manual',
    environment: 'production',
    status: 'applied',
    paymentStatus: 'manual',
    previousQuantity: 2,
    requestedQuantity: 3,
    effectiveQuantity: 3,
    retryCount: 0,
    lastError: null,
    effectiveAt: '2030-01-01T00:00:01.000Z',
    entitlementsVersion: 8,
    certificateReissueStatus: 'issued',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:02.000Z',
  };
  const executed = parseTeamSeatExecuteResponse({
    operation,
    replayed: false,
    license: null,
  });
  assert.equal(executed.operation.status, 'applied');

  const snapshotResponse = parseTeamSeatSnapshotResponse({
    snapshot: {
      ...snapshotRequest,
      snapshotId: 'snapshot-fixture',
      receivedAt: '2030-01-01T00:00:01.000Z',
      reconciledAt: '2030-01-01T00:00:01.000Z',
      driftStatus: 'in_sync',
    },
    observedQuantity: 2,
    billedQuantity: 0,
    licensedQuantity: 2,
    expectedLicensedQuantity: 2,
    approvedQuantity: 3,
    billingStatus: 'active',
    nextReportAt: '2030-01-01T00:05:01.000Z',
    replayed: false,
  });
  assert.equal(snapshotResponse.snapshot.driftStatus, 'in_sync');

  const contractSource = await readFile(contractSourcePath, 'utf8');
  for (const forbiddenStripeField of [
    'stripePriceId',
    'stripeProductId',
    'stripeSubscriptionId',
    'paymentIntentId',
    'checkoutSessionId',
  ]) {
    assert.equal(
      contractSource.includes(forbiddenStripeField),
      false,
      `Notebook contract must not expose Stripe-specific field ${forbiddenStripeField}.`,
    );
  }

  console.log('team-seat-contract-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
