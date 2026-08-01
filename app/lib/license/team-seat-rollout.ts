import 'server-only';

import { requireTeamRuntimeLicense } from './entitlements';
import {
  TEAM_SEAT_ERROR_CODES,
  TEAM_SEAT_PROTOCOL_VERSION,
} from './team-seat-contract';
import type { LicenseStatus } from './types';

export const TEAM_SEAT_ROLLOUT_ENV = {
  client: 'CANVAS_TEAM_SEAT_CLIENT_ENABLED',
  communityClaim: 'CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED',
  membershipMutations: 'CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED',
} as const;

export type TeamSeatProtocolCompatibility = 'unchecked' | 'compatible' | 'unsupported';
export type TeamSeatRolloutEnvironment = {
  [key: string]: string | undefined;
};

export type TeamSeatRolloutGate = {
  requested: boolean;
  effective: boolean;
  blocker:
    | 'disabled'
    | 'client_disabled'
    | 'protocol_unchecked'
    | 'protocol_unsupported'
    | null;
};

export type TeamSeatRolloutStatus = {
  serverDetermined: true;
  coreUnaffected: true;
  protocol: {
    supported: typeof TEAM_SEAT_PROTOCOL_VERSION;
    observed: string | null;
    compatibility: TeamSeatProtocolCompatibility;
  };
  client: TeamSeatRolloutGate;
  communityClaim: TeamSeatRolloutGate;
  membershipMutations: TeamSeatRolloutGate;
};

export class TeamSeatRolloutError extends Error {
  constructor(
    message: string,
    public readonly code:
      | typeof TEAM_SEAT_ERROR_CODES.featureDisabled
      | typeof TEAM_SEAT_ERROR_CODES.protocolUnsupported,
    public readonly statusCode: 409 | 503,
    public readonly flow: 'client' | 'community_claim' | 'team_upgrade' | 'membership_mutation',
    public readonly rollout: TeamSeatRolloutStatus,
  ) {
    super(message);
    this.name = 'TeamSeatRolloutError';
  }
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function protocolCompatibility(observed: string | null): TeamSeatProtocolCompatibility {
  if (!observed) return 'unchecked';
  return observed === TEAM_SEAT_PROTOCOL_VERSION ? 'compatible' : 'unsupported';
}

function disabledGate(requested: boolean): TeamSeatRolloutGate {
  return {
    requested,
    effective: false,
    blocker: requested ? 'client_disabled' : 'disabled',
  };
}

export function resolveTeamSeatRolloutStatus(input?: {
  environment?: TeamSeatRolloutEnvironment;
  observedProtocolVersion?: string | null;
}): TeamSeatRolloutStatus {
  const environment = input?.environment ?? process.env;
  const observed = input?.observedProtocolVersion?.trim() || null;
  const compatibility = protocolCompatibility(observed);
  const clientRequested = enabled(environment[TEAM_SEAT_ROLLOUT_ENV.client]);
  const claimRequested = enabled(environment[TEAM_SEAT_ROLLOUT_ENV.communityClaim]);
  const mutationsRequested = enabled(environment[TEAM_SEAT_ROLLOUT_ENV.membershipMutations]);

  const client: TeamSeatRolloutGate = {
    requested: clientRequested,
    effective: clientRequested,
    blocker: clientRequested ? null : 'disabled',
  };
  const communityClaim = !client.effective
    ? disabledGate(claimRequested)
    : {
        requested: claimRequested,
        effective: claimRequested,
        blocker: claimRequested ? null : 'disabled',
      } satisfies TeamSeatRolloutGate;

  let membershipMutations: TeamSeatRolloutGate;
  if (!client.effective) {
    membershipMutations = disabledGate(mutationsRequested);
  } else if (!mutationsRequested) {
    membershipMutations = {
      requested: false,
      effective: false,
      blocker: 'disabled',
    };
  } else if (compatibility === 'unchecked') {
    membershipMutations = {
      requested: true,
      effective: false,
      blocker: 'protocol_unchecked',
    };
  } else if (compatibility === 'unsupported') {
    membershipMutations = {
      requested: true,
      effective: false,
      blocker: 'protocol_unsupported',
    };
  } else {
    membershipMutations = {
      requested: true,
      effective: true,
      blocker: null,
    };
  }

  return {
    serverDetermined: true,
    coreUnaffected: true,
    protocol: {
      supported: TEAM_SEAT_PROTOCOL_VERSION,
      observed,
      compatibility,
    },
    client,
    communityClaim,
    membershipMutations,
  };
}

function rolloutError(
  status: TeamSeatRolloutStatus,
  flow: TeamSeatRolloutError['flow'],
  gate: TeamSeatRolloutGate,
): TeamSeatRolloutError {
  if (gate.blocker === 'protocol_unsupported' || gate.blocker === 'protocol_unchecked') {
    return new TeamSeatRolloutError(
      gate.blocker === 'protocol_unchecked'
        ? 'Control Plane protocol compatibility must be verified before this Team operation.'
        : `Control Plane protocol ${status.protocol.observed} is not supported by this Notebook version.`,
      TEAM_SEAT_ERROR_CODES.protocolUnsupported,
      409,
      flow,
      status,
    );
  }
  return new TeamSeatRolloutError(
    'This Team Seat flow is disabled by the server rollout configuration.',
    TEAM_SEAT_ERROR_CODES.featureDisabled,
    503,
    flow,
    status,
  );
}

export function requireTeamSeatClientRollout(): TeamSeatRolloutStatus {
  const status = resolveTeamSeatRolloutStatus();
  if (!status.client.effective) throw rolloutError(status, 'client', status.client);
  return status;
}

export function requireTeamSeatCommunityClaimRollout(): TeamSeatRolloutStatus {
  const status = resolveTeamSeatRolloutStatus();
  if (!status.communityClaim.effective) {
    throw rolloutError(status, 'community_claim', status.communityClaim);
  }
  return status;
}

export function requireTeamSeatUpgradeRollout(
  observedProtocolVersion: string | null,
): TeamSeatRolloutStatus {
  const status = resolveTeamSeatRolloutStatus({ observedProtocolVersion });
  if (!status.membershipMutations.effective) {
    throw rolloutError(status, 'team_upgrade', status.membershipMutations);
  }
  return status;
}

export async function requireTeamSeatLicensedMembershipMutation(
  observedProtocolVersion: string | null,
): Promise<{ rollout: TeamSeatRolloutStatus; license: LicenseStatus }> {
  const rollout = resolveTeamSeatRolloutStatus({ observedProtocolVersion });
  if (!rollout.membershipMutations.effective) {
    throw rolloutError(rollout, 'membership_mutation', rollout.membershipMutations);
  }

  // Rollout flags only permit the code path to execute. Entitlements remain
  // cryptographically authoritative and are checked independently.
  const license = await requireTeamRuntimeLicense();
  return { rollout, license };
}

export function teamSeatRolloutErrorPayload(error: TeamSeatRolloutError) {
  return {
    success: false,
    error: error.message,
    code: error.code,
    flow: error.flow,
    rollout: error.rollout,
  };
}
