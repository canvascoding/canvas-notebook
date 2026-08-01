import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  TEAM_SEAT_ROLLOUT_ENV,
  TeamSeatRolloutError,
  type TeamSeatRolloutEnvironment,
  requireTeamSeatCommunityClaimRollout,
  requireTeamSeatUpgradeRollout,
  resolveTeamSeatRolloutStatus,
} from '../app/lib/license/team-seat-rollout';
import {
  TEAM_SEAT_ERROR_CODES,
  TEAM_SEAT_PROTOCOL_VERSION,
} from '../app/lib/license/team-seat-contract';

const projectRoot = path.resolve(__dirname, '..');
const rolloutEnvNames = Object.values(TEAM_SEAT_ROLLOUT_ENV);

function rolloutEnvironment(input: {
  client?: boolean;
  claim?: boolean;
  mutations?: boolean;
} = {}): TeamSeatRolloutEnvironment {
  return {
    [TEAM_SEAT_ROLLOUT_ENV.client]: String(input.client ?? false),
    [TEAM_SEAT_ROLLOUT_ENV.communityClaim]: String(input.claim ?? false),
    [TEAM_SEAT_ROLLOUT_ENV.membershipMutations]: String(input.mutations ?? false),
  };
}

function withProcessRolloutEnvironment(
  environment: TeamSeatRolloutEnvironment,
  action: () => void,
): void {
  const previous = Object.fromEntries(
    rolloutEnvNames.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of rolloutEnvNames) {
      const value = environment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    action();
  } finally {
    for (const name of rolloutEnvNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectRolloutError(
  action: () => unknown,
  code: TeamSeatRolloutError['code'],
): TeamSeatRolloutError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof TeamSeatRolloutError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('Expected TeamSeatRolloutError.');
}

async function main() {
  const defaults = resolveTeamSeatRolloutStatus({ environment: {} });
  assert.equal(defaults.serverDetermined, true);
  assert.equal(defaults.coreUnaffected, true);
  assert.equal(defaults.client.effective, false);
  assert.equal(defaults.communityClaim.effective, false);
  assert.equal(defaults.membershipMutations.effective, false);
  assert.equal(defaults.protocol.compatibility, 'unchecked');

  const claimWithoutClient = resolveTeamSeatRolloutStatus({
    environment: rolloutEnvironment({ claim: true }),
  });
  assert.equal(claimWithoutClient.communityClaim.requested, true);
  assert.equal(claimWithoutClient.communityClaim.effective, false);
  assert.equal(claimWithoutClient.communityClaim.blocker, 'client_disabled');

  const clientOnly = resolveTeamSeatRolloutStatus({
    environment: rolloutEnvironment({ client: true }),
  });
  assert.equal(clientOnly.client.effective, true);
  assert.equal(clientOnly.communityClaim.effective, false);
  assert.equal(clientOnly.membershipMutations.effective, false);
  assert.equal(clientOnly.coreUnaffected, true);

  const unchecked = resolveTeamSeatRolloutStatus({
    environment: rolloutEnvironment({ client: true, claim: true, mutations: true }),
  });
  assert.equal(unchecked.client.effective, true);
  assert.equal(unchecked.communityClaim.effective, true);
  assert.equal(unchecked.membershipMutations.effective, false);
  assert.equal(unchecked.membershipMutations.blocker, 'protocol_unchecked');

  const compatible = resolveTeamSeatRolloutStatus({
    environment: rolloutEnvironment({ client: true, claim: true, mutations: true }),
    observedProtocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
  });
  assert.equal(compatible.protocol.compatibility, 'compatible');
  assert.equal(compatible.membershipMutations.effective, true);

  const unsupported = resolveTeamSeatRolloutStatus({
    environment: rolloutEnvironment({ client: true, claim: true, mutations: true }),
    observedProtocolVersion: 'canvas-team-seat-protocol-v2',
  });
  assert.equal(unsupported.protocol.compatibility, 'unsupported');
  assert.equal(unsupported.membershipMutations.effective, false);
  assert.equal(unsupported.membershipMutations.blocker, 'protocol_unsupported');
  assert.equal(unsupported.client.effective, true);
  assert.equal(unsupported.communityClaim.effective, true);
  assert.equal(unsupported.coreUnaffected, true);

  const permissiveLookingValues = resolveTeamSeatRolloutStatus({
    environment: {
      [TEAM_SEAT_ROLLOUT_ENV.client]: '1',
      [TEAM_SEAT_ROLLOUT_ENV.communityClaim]: 'yes',
      [TEAM_SEAT_ROLLOUT_ENV.membershipMutations]: 'TRUE ',
    },
    observedProtocolVersion: TEAM_SEAT_PROTOCOL_VERSION,
  });
  assert.equal(permissiveLookingValues.client.effective, false);
  assert.equal(permissiveLookingValues.communityClaim.effective, false);
  assert.equal(permissiveLookingValues.membershipMutations.effective, false);

  withProcessRolloutEnvironment(rolloutEnvironment(), () => {
    const error = expectRolloutError(
      () => requireTeamSeatCommunityClaimRollout(),
      TEAM_SEAT_ERROR_CODES.featureDisabled,
    );
    assert.equal(error.statusCode, 503);
    assert.equal(error.flow, 'community_claim');
  });

  withProcessRolloutEnvironment(
    rolloutEnvironment({ client: true, claim: true, mutations: true }),
    () => {
      const error = expectRolloutError(
        () => requireTeamSeatUpgradeRollout('canvas-team-seat-protocol-v2'),
        TEAM_SEAT_ERROR_CODES.protocolUnsupported,
      );
      assert.equal(error.statusCode, 409);
      assert.equal(error.flow, 'team_upgrade');

      const allowed = requireTeamSeatUpgradeRollout(TEAM_SEAT_PROTOCOL_VERSION);
      assert.equal(allowed.membershipMutations.effective, true);
    },
  );

  const rolloutSource = await readFile(
    path.join(projectRoot, 'app/lib/license/team-seat-rollout.ts'),
    'utf8',
  );
  assert.match(
    rolloutSource,
    /const license = await requireTeamRuntimeLicense\(\)/u,
    'Licensed membership mutations must retain the independent signed-license check.',
  );
  assert.doesNotMatch(
    rolloutSource,
    /licensed:\s*true/u,
    'Rollout configuration must never synthesize a licensed state.',
  );

  const statusRouteSource = await readFile(
    path.join(projectRoot, 'app/api/license/status/route.ts'),
    'utf8',
  );
  assert.match(statusRouteSource, /resolveTeamSeatRolloutStatus\(\)/u);
  assert.match(statusRouteSource, /teamSeatRollout/u);

  console.log('team-seat-rollout-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
