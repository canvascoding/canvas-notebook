import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SqlConnection } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import {
  recordTeamMembershipProjectionChange,
} from '@/app/lib/license/team-seat-outbox';
import type { TeamSeatChangeType } from '@/app/lib/license/team-seat-contract';

export const TEAM_MEMBERSHIP_STATUSES = [
  'invited',
  'approval_required',
  'billing_pending',
  'active',
  'suspended',
  'removed',
] as const;

export type TeamMembershipStatus = typeof TEAM_MEMBERSHIP_STATUSES[number];

export const TEAM_MEMBERSHIP_ROLES = [
  'owner',
  'admin',
  'member',
  'external',
] as const;

export type TeamMembershipRole = typeof TEAM_MEMBERSHIP_ROLES[number];

export const TEAM_MEMBERSHIP_TRANSITION_SOURCES = [
  'first_owner',
  'invitation',
  'local_admin',
  'control_plane',
  'migration',
  'reconciliation',
  'system',
] as const;

export type TeamMembershipTransitionSource = typeof TEAM_MEMBERSHIP_TRANSITION_SOURCES[number];

/**
 * This predicate is the local side of the shared Team Seat contract:
 * only an accepted, active membership backed by a Better Auth user is billable.
 */
export const ACTIVE_TEAM_MEMBERSHIP_WHERE_SQL =
  "status = 'active' AND user_id IS NOT NULL AND accepted_at IS NOT NULL";

export type TeamMembership = {
  id: string;
  organizationId: string;
  candidateEmail: string;
  displayName: string | null;
  userId: string | null;
  role: TeamMembershipRole;
  status: TeamMembershipStatus;
  externalInvitationId: string | null;
  controlPlaneOperationId: string | null;
  invitedByUserId: string | null;
  invitedAt: number | null;
  acceptedAt: number | null;
  activatedAt: number | null;
  suspendedAt: number | null;
  removedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ActiveTeamMembershipProjection = {
  observedQuantity: number;
  roleSummary: Record<TeamMembershipRole, number>;
  members: Array<{
    membershipId: string;
    userId: string;
    email: string;
    role: TeamMembershipRole;
  }>;
};

type MembershipRow = {
  id: string;
  organization_id: string;
  candidate_email: string;
  display_name: string | null;
  user_id: string | null;
  role: string;
  status: string;
  external_invitation_id: string | null;
  control_plane_operation_id: string | null;
  invited_by_user_id: string | null;
  invited_at: number | null;
  accepted_at: number | null;
  activated_at: number | null;
  suspended_at: number | null;
  removed_at: number | null;
  created_at: number;
  updated_at: number;
};

type MembershipUserRow = {
  id: string;
  email: string;
};

const PENDING_TEAM_MEMBERSHIP_STATUSES = new Set<TeamMembershipStatus>([
  'invited',
  'approval_required',
  'billing_pending',
]);

const ALLOWED_TRANSITIONS: Record<TeamMembershipStatus, ReadonlySet<TeamMembershipStatus>> = {
  invited: new Set(['approval_required', 'billing_pending', 'active', 'removed']),
  approval_required: new Set(['billing_pending', 'active', 'removed']),
  billing_pending: new Set(['approval_required', 'active', 'removed']),
  active: new Set(['suspended', 'removed']),
  suspended: new Set(['approval_required', 'billing_pending', 'active', 'removed']),
  removed: new Set(['invited', 'approval_required']),
};

const MEMBERSHIP_SELECT = `
  SELECT
    id,
    organization_id,
    candidate_email,
    display_name,
    user_id,
    role,
    status,
    external_invitation_id,
    control_plane_operation_id,
    invited_by_user_id,
    invited_at,
    accepted_at,
    activated_at,
    suspended_at,
    removed_at,
    created_at,
    updated_at
  FROM team_memberships
`;

export class TeamMembershipError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CANDIDATE'
      | 'MEMBERSHIP_NOT_FOUND'
      | 'MEMBERSHIP_CONFLICT'
      | 'INVALID_TRANSITION'
      | 'ACTIVE_IDENTITY_REQUIRED'
      | 'ACTIVE_IDENTITY_MISMATCH',
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'TeamMembershipError';
  }
}

export function normalizeTeamMembershipCandidateEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    throw new TeamMembershipError('INVALID_CANDIDATE', 'A valid candidate email address is required.');
  }
  return normalized;
}

function optionalText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim() || null;
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function serializeMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length <= 4096) return serialized;
  return JSON.stringify({
    truncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, 3900),
  });
}

function isTeamMembershipStatus(value: string): value is TeamMembershipStatus {
  return (TEAM_MEMBERSHIP_STATUSES as readonly string[]).includes(value);
}

function isTeamMembershipRole(value: string): value is TeamMembershipRole {
  return (TEAM_MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

function mapMembership(row: MembershipRow): TeamMembership {
  if (!isTeamMembershipStatus(row.status) || !isTeamMembershipRole(row.role)) {
    throw new TeamMembershipError(
      'MEMBERSHIP_CONFLICT',
      `Membership ${row.id} contains an unsupported lifecycle value.`,
      409,
    );
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    candidateEmail: row.candidate_email,
    displayName: row.display_name,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    externalInvitationId: row.external_invitation_id,
    controlPlaneOperationId: row.control_plane_operation_id,
    invitedByUserId: row.invited_by_user_id,
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at,
    activatedAt: row.activated_at,
    suspendedAt: row.suspended_at,
    removedAt: row.removed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function changesFromRunResult(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    return Number((result as { changes?: unknown }).changes || 0);
  }
  return 0;
}

async function rollbackQuietly(database: Pick<SqlConnection, 'run'>): Promise<void> {
  try {
    await database.run('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

async function withMembershipTransaction<T>(
  database: Pick<SqlConnection, 'run'>,
  operation: () => Promise<T>,
  provider: DatabaseProvider,
): Promise<T> {
  await database.run(provider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = await operation();
    await database.run('COMMIT');
    return result;
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  }
}

async function readMembership(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
  membershipId: string,
): Promise<TeamMembership | null> {
  const row = await database.get(
    `${MEMBERSHIP_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1`,
    [organizationId, membershipId],
  ) as MembershipRow | undefined;
  return row ? mapMembership(row) : null;
}

async function appendTransition(
  database: Pick<SqlConnection, 'run'>,
  input: {
    membershipId: string;
    organizationId: string;
    fromStatus: TeamMembershipStatus | null;
    toStatus: TeamMembershipStatus;
    actorUserId?: string | null;
    source: TeamMembershipTransitionSource;
    reason?: string | null;
    externalOperationId?: string | null;
    membershipRevision?: number | null;
    metadata?: unknown;
    createdAt: number;
  },
): Promise<void> {
  await database.run(`
    INSERT INTO team_membership_transitions (
      id,
      membership_id,
      organization_id,
      from_status,
      to_status,
      actor_user_id,
      source,
      reason,
      external_operation_id,
      membership_revision,
      metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    `team-membership-transition-${randomUUID()}`,
    input.membershipId,
    input.organizationId,
    input.fromStatus,
    input.toStatus,
    optionalText(input.actorUserId, 200),
    input.source,
    optionalText(input.reason, 1000),
    optionalText(input.externalOperationId, 500),
    input.membershipRevision ?? null,
    serializeMetadata(input.metadata),
    input.createdAt,
  ]);
}

export function isActiveTeamMembership(
  membership: Pick<TeamMembership, 'status' | 'userId' | 'acceptedAt'>,
): boolean {
  return membership.status === 'active'
    && Boolean(membership.userId)
    && membership.acceptedAt !== null;
}

export async function createTeamMembershipCandidate(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    organizationId: string;
    email: string;
    displayName?: string | null;
    role?: TeamMembershipRole;
    status?: Extract<TeamMembershipStatus, 'invited' | 'approval_required' | 'billing_pending'>;
    externalInvitationId?: string | null;
    controlPlaneOperationId?: string | null;
    invitedByUserId?: string | null;
    source: TeamMembershipTransitionSource;
    reason?: string | null;
    metadata?: unknown;
    now?: number;
    databaseProvider?: DatabaseProvider;
  },
): Promise<TeamMembership> {
  const id = `team-membership-${randomUUID()}`;
  const status = input.status ?? 'invited';
  const role = input.role ?? 'member';
  const candidateEmail = normalizeTeamMembershipCandidateEmail(input.email);
  const now = input.now ?? Date.now();

  return withMembershipTransaction(database, async () => {
    await database.run(`
      INSERT INTO team_memberships (
        id,
        organization_id,
        candidate_email,
        display_name,
        user_id,
        role,
        status,
        external_invitation_id,
        control_plane_operation_id,
        invited_by_user_id,
        invited_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      input.organizationId,
      candidateEmail,
      optionalText(input.displayName, 200),
      role,
      status,
      optionalText(input.externalInvitationId, 500),
      optionalText(input.controlPlaneOperationId, 500),
      optionalText(input.invitedByUserId, 200),
      status === 'invited' ? now : null,
      now,
      now,
    ]);

    await appendTransition(database, {
      membershipId: id,
      organizationId: input.organizationId,
      fromStatus: null,
      toStatus: status,
      actorUserId: input.invitedByUserId,
      source: input.source,
      reason: input.reason,
      externalOperationId: input.controlPlaneOperationId,
      metadata: input.metadata,
      createdAt: now,
    });

    const membership = await readMembership(database, input.organizationId, id);
    if (!membership) {
      throw new TeamMembershipError('MEMBERSHIP_CONFLICT', 'Membership was not persisted.', 409);
    }
    return membership;
  }, input.databaseProvider ?? getDatabaseProvider());
}

export async function adoptActiveTeamMembership(
  database: Pick<SqlConnection, 'get' | 'run' | 'all'>,
  input: {
    organizationId: string;
    userId: string;
    role: TeamMembershipRole;
    source: Extract<TeamMembershipTransitionSource, 'first_owner' | 'migration' | 'reconciliation'>;
    actorUserId?: string | null;
    reason?: string | null;
    metadata?: unknown;
    seatOperationType?: TeamSeatChangeType;
    now?: number;
    databaseProvider?: DatabaseProvider;
  },
): Promise<TeamMembership> {
  const now = input.now ?? Date.now();
  const user = await database.get(
    'SELECT id, email FROM "user" WHERE id = ? LIMIT 1',
    [input.userId],
  ) as MembershipUserRow | undefined;
  if (!user) {
    throw new TeamMembershipError(
      'ACTIVE_IDENTITY_REQUIRED',
      'An active membership requires an existing Better Auth user.',
      409,
    );
  }

  const candidateEmail = normalizeTeamMembershipCandidateEmail(user.email);
  const id = `team-membership-${randomUUID()}`;
  return withMembershipTransaction(database, async () => {
    await database.run(`
      INSERT INTO team_memberships (
        id,
        organization_id,
        candidate_email,
        user_id,
        role,
        status,
        invited_by_user_id,
        invited_at,
        accepted_at,
        activated_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `, [
      id,
      input.organizationId,
      candidateEmail,
      input.userId,
      input.role,
      optionalText(input.actorUserId, 200),
      now,
      now,
      now,
      now,
      now,
    ]);

    const membership = await readMembership(database, input.organizationId, id);
    if (!membership) {
      throw new TeamMembershipError('MEMBERSHIP_CONFLICT', 'Membership was not persisted.', 409);
    }
    const revision = input.seatOperationType
      ? (await recordTeamMembershipProjectionChange(database, {
          organizationId: input.organizationId,
          membershipId: id,
          operationType: input.seatOperationType,
          projection: await getActiveTeamMembershipProjection(database, input.organizationId),
          now,
        })).revision
      : null;

    await appendTransition(database, {
      membershipId: id,
      organizationId: input.organizationId,
      fromStatus: null,
      toStatus: 'active',
      actorUserId: input.actorUserId,
      source: input.source,
      reason: input.reason,
      membershipRevision: revision,
      metadata: input.metadata,
      createdAt: now,
    });

    return membership;
  }, input.databaseProvider ?? getDatabaseProvider());
}

export async function transitionTeamMembership(
  database: Pick<SqlConnection, 'get' | 'run' | 'all'>,
  input: {
    organizationId: string;
    membershipId: string;
    expectedStatus: TeamMembershipStatus;
    toStatus: TeamMembershipStatus;
    actorUserId?: string | null;
    source: TeamMembershipTransitionSource;
    reason?: string | null;
    metadata?: unknown;
    externalInvitationId?: string | null;
    controlPlaneOperationId?: string | null;
    userId?: string | null;
    acceptedAt?: number | null;
    seatOperationType?: TeamSeatChangeType;
    role?: TeamMembershipRole;
    displayName?: string | null;
    now?: number;
    databaseProvider?: DatabaseProvider;
  },
): Promise<TeamMembership> {
  const now = input.now ?? Date.now();

  return withMembershipTransaction(database, async () => {
    const membership = await readMembership(database, input.organizationId, input.membershipId);
    if (!membership) {
      throw new TeamMembershipError('MEMBERSHIP_NOT_FOUND', 'Team membership not found.', 404);
    }
    if (membership.status !== input.expectedStatus) {
      throw new TeamMembershipError(
        'MEMBERSHIP_CONFLICT',
        `Expected membership status ${input.expectedStatus}, but found ${membership.status}.`,
        409,
      );
    }
    if (!ALLOWED_TRANSITIONS[membership.status].has(input.toStatus)) {
      throw new TeamMembershipError(
        'INVALID_TRANSITION',
        `Cannot transition a Team membership from ${membership.status} to ${input.toStatus}.`,
        409,
      );
    }

    let nextUserId = membership.userId;
    let nextAcceptedAt = input.acceptedAt === undefined ? membership.acceptedAt : input.acceptedAt;
    let nextInvitedAt = membership.invitedAt;
    let nextActivatedAt = membership.activatedAt;
    let nextSuspendedAt = membership.suspendedAt;
    let nextRemovedAt = membership.removedAt;

    if (PENDING_TEAM_MEMBERSHIP_STATUSES.has(input.toStatus)) {
      nextUserId = null;
      if (membership.status === 'removed') {
        nextAcceptedAt = input.acceptedAt ?? null;
        nextActivatedAt = null;
        nextSuspendedAt = null;
        nextRemovedAt = null;
      }
    }

    if (input.toStatus === 'invited') {
      nextInvitedAt = now;
      nextAcceptedAt = null;
    }

    if (input.toStatus === 'active') {
      nextUserId = input.userId ?? membership.userId;
      if (!nextUserId || nextAcceptedAt === null) {
        throw new TeamMembershipError(
          'ACTIVE_IDENTITY_REQUIRED',
          'An active membership requires an accepted invitation and an existing Better Auth user.',
          409,
        );
      }
      const user = await database.get(
        'SELECT id, email FROM "user" WHERE id = ? LIMIT 1',
        [nextUserId],
      ) as MembershipUserRow | undefined;
      if (!user) {
        throw new TeamMembershipError(
          'ACTIVE_IDENTITY_REQUIRED',
          'An active membership requires an existing Better Auth user.',
          409,
        );
      }
      if (normalizeTeamMembershipCandidateEmail(user.email) !== membership.candidateEmail) {
        throw new TeamMembershipError(
          'ACTIVE_IDENTITY_MISMATCH',
          'The Better Auth user email does not match the accepted Team membership candidate.',
          409,
        );
      }
      nextActivatedAt = now;
      nextSuspendedAt = null;
      nextRemovedAt = null;
    } else if (input.toStatus === 'suspended') {
      nextSuspendedAt = now;
    } else if (input.toStatus === 'removed') {
      nextRemovedAt = now;
    }

    const updateResult = await database.run(`
      UPDATE team_memberships
      SET
        display_name = ?,
        user_id = ?,
        role = ?,
        status = ?,
        external_invitation_id = ?,
        control_plane_operation_id = ?,
        invited_at = ?,
        accepted_at = ?,
        activated_at = ?,
        suspended_at = ?,
        removed_at = ?,
        updated_at = ?
      WHERE organization_id = ?
        AND id = ?
        AND status = ?
    `, [
      input.displayName === undefined
        ? membership.displayName
        : optionalText(input.displayName, 200),
      nextUserId,
      input.role ?? membership.role,
      input.toStatus,
      input.externalInvitationId === undefined
        ? membership.externalInvitationId
        : optionalText(input.externalInvitationId, 500),
      input.controlPlaneOperationId === undefined
        ? membership.controlPlaneOperationId
        : optionalText(input.controlPlaneOperationId, 500),
      nextInvitedAt,
      nextAcceptedAt,
      nextActivatedAt,
      nextSuspendedAt,
      nextRemovedAt,
      now,
      input.organizationId,
      input.membershipId,
      membership.status,
    ]);
    if (changesFromRunResult(updateResult) !== 1) {
      throw new TeamMembershipError(
        'MEMBERSHIP_CONFLICT',
        'The Team membership changed concurrently. Reload it before retrying.',
        409,
      );
    }

    const affectsActiveSeatProjection = membership.status === 'active' || input.toStatus === 'active';
    const revision = affectsActiveSeatProjection
      ? (await recordTeamMembershipProjectionChange(database, {
          organizationId: input.organizationId,
          membershipId: membership.id,
          operationType: input.seatOperationType
            ?? (input.toStatus === 'active' ? 'invitation_accept' : 'member_remove'),
          projection: await getActiveTeamMembershipProjection(database, input.organizationId),
          now,
        })).revision
      : null;

    await appendTransition(database, {
      membershipId: membership.id,
      organizationId: membership.organizationId,
      fromStatus: membership.status,
      toStatus: input.toStatus,
      actorUserId: input.actorUserId,
      source: input.source,
      reason: input.reason,
      externalOperationId: input.controlPlaneOperationId,
      membershipRevision: revision,
      metadata: input.metadata,
      createdAt: now,
    });

    const updated = await readMembership(database, input.organizationId, input.membershipId);
    if (!updated) {
      throw new TeamMembershipError('MEMBERSHIP_CONFLICT', 'Membership disappeared during transition.', 409);
    }
    return updated;
  }, input.databaseProvider ?? getDatabaseProvider());
}

export async function getActiveTeamMembershipProjection(
  database: Pick<SqlConnection, 'all'>,
  organizationId: string,
): Promise<ActiveTeamMembershipProjection> {
  const rows = await database.all(`
    SELECT id, user_id, candidate_email, role
    FROM team_memberships
    WHERE organization_id = ?
      AND ${ACTIVE_TEAM_MEMBERSHIP_WHERE_SQL}
    ORDER BY candidate_email ASC, id ASC
  `, [organizationId]) as Array<{
    id: string;
    user_id: string;
    candidate_email: string;
    role: string;
  }>;

  const roleSummary: Record<TeamMembershipRole, number> = {
    owner: 0,
    admin: 0,
    member: 0,
    external: 0,
  };
  const members = rows.map((row) => {
    if (!isTeamMembershipRole(row.role)) {
      throw new TeamMembershipError(
        'MEMBERSHIP_CONFLICT',
        `Membership ${row.id} contains an unsupported role.`,
        409,
      );
    }
    roleSummary[row.role] += 1;
    return {
      membershipId: row.id,
      userId: row.user_id,
      email: row.candidate_email,
      role: row.role,
    };
  });

  return {
    observedQuantity: members.length,
    roleSummary,
    members,
  };
}

export async function getTeamMembershipById(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
  membershipId: string,
): Promise<TeamMembership | null> {
  return readMembership(database, organizationId, membershipId);
}

export async function getTeamMembershipByCandidateEmail(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
  email: string,
): Promise<TeamMembership | null> {
  const candidateEmail = normalizeTeamMembershipCandidateEmail(email);
  const row = await database.get(
    `${MEMBERSHIP_SELECT} WHERE organization_id = ? AND candidate_email = ? LIMIT 1`,
    [organizationId, candidateEmail],
  ) as MembershipRow | undefined;
  return row ? mapMembership(row) : null;
}

export async function linkTeamMembershipControlPlaneOperation(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    organizationId: string;
    membershipId: string;
    controlPlaneOperationId: string;
    now?: number;
  },
): Promise<TeamMembership> {
  const operationId = optionalText(input.controlPlaneOperationId, 500);
  if (!operationId) {
    throw new TeamMembershipError(
      'MEMBERSHIP_CONFLICT',
      'A Control Plane operation ID is required.',
      400,
    );
  }
  const now = input.now ?? Date.now();
  const result = await database.run(`
    UPDATE team_memberships
    SET control_plane_operation_id = ?, updated_at = ?
    WHERE organization_id = ? AND id = ?
  `, [
    operationId,
    now,
    input.organizationId,
    input.membershipId,
  ]);
  if (changesFromRunResult(result) !== 1) {
    throw new TeamMembershipError('MEMBERSHIP_NOT_FOUND', 'Team membership not found.', 404);
  }
  const membership = await readMembership(database, input.organizationId, input.membershipId);
  if (!membership) {
    throw new TeamMembershipError('MEMBERSHIP_NOT_FOUND', 'Team membership not found.', 404);
  }
  return membership;
}
