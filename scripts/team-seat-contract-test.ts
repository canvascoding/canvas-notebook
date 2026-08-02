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
  parseTeamSeatLicenseRefresh,
  parseTeamSeatMembershipSnapshot,
  parseTeamSeatPreflightResponse,
  parseTeamSeatPrepareResponse,
  parseTeamSeatQuote,
  parseTeamSeatSnapshotResponse,
  parseTeamSeatSubject,
  parseTeamSeatTokenRotation,
} from '../app/lib/license/team-seat-contract';

type ContractFixtures = {
  fixtureVersion: string;
  protocolVersion: string;
  positive: {
    preflight: unknown;
    claim: {
      start: unknown;
      pending: unknown;
      approved: unknown;
      rotation: unknown;
    };
    entitlements: unknown;
    quote: unknown;
    seatChange: {
      authorization: unknown;
      prepare: unknown;
      execute: unknown;
    };
    snapshot: unknown;
    snapshotResponse: unknown;
    licenseClaims: unknown;
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
  invalid: {
    subject: unknown;
    revision: unknown;
    seatLimit: unknown;
    entitlementsVersion: unknown;
    protocolVersion: string;
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
const EXPECTED_FIXTURE_VERSION = '1.0.0';
const EXPECTED_CONTROL_PLANE_FIXTURE_SHA256 = 'bb54a08a0ac80bd6987b4808b9ba2a9022ea50c0f3ad928dac8460654f86edc7';

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
  assert.equal(fixtures.fixtureVersion, EXPECTED_FIXTURE_VERSION);
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

  const claimStart = parseTeamSeatClaimStart(fixtures.positive.claim.start);
  assert.equal(claimStart.userCode, 'ABCD-EFGH');
  const pendingClaim = parseTeamSeatClaimPollResult(fixtures.positive.claim.pending);
  assert.equal(pendingClaim.status, 'authorization_pending');
  const approvedClaim = parseTeamSeatClaimPollResult(fixtures.positive.claim.approved);
  assert.equal(approvedClaim.status, 'approved');
  const rotatedToken = parseTeamSeatTokenRotation(fixtures.positive.claim.rotation);
  assert.equal(rotatedToken.tokenType, 'Bearer');

  const claims = parseTeamSeatLicenseClaims(fixtures.positive.licenseClaims);
  assert.equal(claims.seatLimit, 3);
  assert.equal(claims.entitlementsVersion, 8);

  const authorization = parseTeamSeatAuthorization(
    fixtures.positive.seatChange.authorization,
  );
  assert.equal(authorization.status, 'approved');
  const prepared = parseTeamSeatPrepareResponse(fixtures.positive.seatChange.prepare);
  assert.equal(prepared.snapshot.revision, 7);
  assert.equal(prepared.quote.nonBillable, true);
  const executed = parseTeamSeatExecuteResponse(fixtures.positive.seatChange.execute);
  assert.equal(executed.operation.status, 'applied');
  assert.equal(executed.operation.entitlementsVersion, 8);
  assert.ok(executed.license);
  const refresh = parseTeamSeatLicenseRefresh(executed.license);
  assert.equal(refresh.details.entitlementsVersion, 8);
  assert.equal(refresh.details.edition, 'team');

  const snapshot = parseTeamSeatMembershipSnapshot(fixtures.positive.snapshot);
  assert.equal(snapshot.observedQuantity, 3);
  assert.equal(snapshot.memberHashes.length, 3);
  const snapshotResponse = parseTeamSeatSnapshotResponse(
    fixtures.positive.snapshotResponse,
  );
  assert.equal(snapshotResponse.snapshot.driftStatus, 'in_sync');

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

  const unsupported = fixtures.invalid.protocolVersion;
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
  expectContractError(
    () => parseTeamSeatClaimStart(protocolMutation(fixtures.positive.claim.start, unsupported)),
    TEAM_SEAT_ERROR_CODES.protocolUnsupported,
  );
  expectContractError(
    () => parseTeamSeatLicenseClaims(protocolMutation(fixtures.positive.licenseClaims, unsupported)),
    TEAM_SEAT_ERROR_CODES.protocolUnsupported,
  );
  expectContractError(() => parseTeamSeatSubject(fixtures.invalid.subject));
  expectContractError(() => parseTeamSeatMembershipSnapshot({
    ...(fixtures.positive.snapshot as Record<string, unknown>),
    revision: fixtures.invalid.revision,
  }));
  expectContractError(() => parseTeamSeatLicenseClaims({
    ...(fixtures.positive.licenseClaims as Record<string, unknown>),
    seatLimit: fixtures.invalid.seatLimit,
  }));
  expectContractError(() => parseTeamSeatLicenseClaims({
    ...(fixtures.positive.licenseClaims as Record<string, unknown>),
    entitlementsVersion: fixtures.invalid.entitlementsVersion,
  }));

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
