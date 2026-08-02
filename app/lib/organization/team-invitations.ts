import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import {
  createTeamMembershipCandidate,
  getTeamMembershipByCandidateEmail,
  getTeamMembershipById,
  normalizeTeamMembershipCandidateEmail,
  transitionTeamMembership,
  type TeamMembership,
  type TeamMembershipRole,
} from './team-membership';

export type TeamMembershipInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type TeamMembershipInvitation = {
  id: string;
  organizationId: string;
  membershipId: string;
  email: string;
  role: Extract<TeamMembershipRole, 'admin' | 'member' | 'external'>;
  status: TeamMembershipInvitationStatus;
  invitedByUserId: string | null;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type InvitationRow = {
  id: string;
  organization_id: string;
  membership_id: string;
  token_hash: string;
  email_snapshot: string;
  role_snapshot: string;
  status: string;
  invited_by_user_id: string | null;
  expires_at: number;
  accepted_request_id: string | null;
  accepted_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
};

type InvitationDatabase = Pick<SqlConnection, 'get' | 'run' | 'all' | 'close'>;

const INVITATION_SELECT = `
  SELECT
    id,
    organization_id,
    membership_id,
    token_hash,
    email_snapshot,
    role_snapshot,
    status,
    invited_by_user_id,
    expires_at,
    accepted_request_id,
    accepted_at,
    revoked_at,
    created_at,
    updated_at
  FROM team_membership_invitations
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_INVITATION_TTL_MS = 15 * 60 * 1000;
const MAX_INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class TeamInvitationError extends Error {
  constructor(
    public readonly code:
      | 'INVITATION_INVALID'
      | 'INVITATION_CONFLICT'
      | 'INVITATION_NOT_FOUND'
      | 'INVITATION_EXPIRED'
      | 'INVITATION_ALREADY_USED'
      | 'INVITATION_REVOKED',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'TeamInvitationError';
  }
}

function invitationTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isInvitationStatus(value: string): value is TeamMembershipInvitationStatus {
  return ['pending', 'accepted', 'revoked', 'expired'].includes(value);
}

function isInvitationRole(
  value: string,
): value is Extract<TeamMembershipRole, 'admin' | 'member' | 'external'> {
  return ['admin', 'member', 'external'].includes(value);
}

function mapInvitation(row: InvitationRow): TeamMembershipInvitation {
  if (!isInvitationStatus(row.status) || !isInvitationRole(row.role_snapshot)) {
    throw new TeamInvitationError(
      'INVITATION_CONFLICT',
      `Invitation ${row.id} contains an unsupported lifecycle value.`,
    );
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    email: row.email_snapshot,
    role: row.role_snapshot,
    status: row.status,
    invitedByUserId: row.invited_by_user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
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

async function readInvitationById(
  database: InvitationDatabase,
  organizationId: string,
  invitationId: string,
): Promise<(TeamMembershipInvitation & { acceptedRequestId: string | null }) | null> {
  const row = await database.get(
    `${INVITATION_SELECT} WHERE organization_id = ? AND id = ? LIMIT 1`,
    [organizationId, invitationId],
  ) as InvitationRow | undefined;
  return row
    ? { ...mapInvitation(row), acceptedRequestId: row.accepted_request_id }
    : null;
}

async function readInvitationByToken(
  database: InvitationDatabase,
  token: string,
): Promise<(TeamMembershipInvitation & { acceptedRequestId: string | null }) | null> {
  if (!/^[A-Za-z0-9_-]{40,128}$/u.test(token)) {
    throw new TeamInvitationError('INVITATION_INVALID', 'Invitation token is invalid.', 400);
  }
  const row = await database.get(
    `${INVITATION_SELECT} WHERE token_hash = ? LIMIT 1`,
    [invitationTokenHash(token)],
  ) as InvitationRow | undefined;
  return row
    ? { ...mapInvitation(row), acceptedRequestId: row.accepted_request_id }
    : null;
}

async function finishTerminalMembership(
  database: InvitationDatabase,
  invitation: TeamMembershipInvitation,
  input: {
    actorUserId?: string | null;
    reason: 'team_invitation_revoked' | 'team_invitation_expired';
    now: number;
    databaseProvider: DatabaseProvider;
  },
): Promise<void> {
  const membership = await getTeamMembershipById(
    database,
    invitation.organizationId,
    invitation.membershipId,
  );
  if (!membership || membership.status === 'removed') return;
  if (membership.status !== 'invited') {
    throw new TeamInvitationError(
      'INVITATION_CONFLICT',
      `Invitation cannot be finalized from membership status ${membership.status}.`,
    );
  }
  await transitionTeamMembership(database, {
    organizationId: invitation.organizationId,
    membershipId: invitation.membershipId,
    expectedStatus: 'invited',
    toStatus: 'removed',
    actorUserId: input.actorUserId,
    source: 'invitation',
    reason: input.reason,
    externalInvitationId: invitation.id,
    metadata: { billableOperation: false },
    now: input.now,
    databaseProvider: input.databaseProvider,
  });
}

export async function createTeamMembershipInvitation(input: {
  organizationId: string;
  actorUserId: string;
  email: string;
  displayName?: string | null;
  role: Extract<TeamMembershipRole, 'admin' | 'member' | 'external'>;
  ttlMs?: number;
  database?: InvitationDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<{
  invitation: TeamMembershipInvitation;
  membership: TeamMembership;
  token: string;
}> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const databaseProvider = input.databaseProvider ?? getDatabaseProvider();
  const now = input.now ?? Date.now();
  const email = normalizeTeamMembershipCandidateEmail(input.email);
  const ttlMs = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs)
    || ttlMs < MIN_INVITATION_TTL_MS
    || ttlMs > MAX_INVITATION_TTL_MS
  ) {
    throw new TeamInvitationError(
      'INVITATION_INVALID',
      'Invitation lifetime must be between 15 minutes and 30 days.',
      400,
    );
  }

  try {
    let membership = await getTeamMembershipByCandidateEmail(
      database,
      input.organizationId,
      email,
    );
    let invitationId = membership?.externalInvitationId ?? `team-invitation-${randomUUID()}`;
    let existing = invitationId
      ? await readInvitationById(database, input.organizationId, invitationId)
      : null;

    if (membership && !existing && membership.status !== 'invited') {
      throw new TeamInvitationError(
        'INVITATION_CONFLICT',
        'This email already belongs to another membership lifecycle.',
      );
    }
    if (existing?.status === 'pending') {
      throw new TeamInvitationError(
        'INVITATION_CONFLICT',
        'A pending invitation already exists for this email address.',
      );
    }
    if (existing?.status === 'accepted') {
      throw new TeamInvitationError(
        'INVITATION_ALREADY_USED',
        'An accepted invitation cannot be reissued.',
      );
    }
    if (membership?.status === 'invited' && existing) {
      await finishTerminalMembership(database, existing, {
        actorUserId: input.actorUserId,
        reason: existing.status === 'expired'
          ? 'team_invitation_expired'
          : 'team_invitation_revoked',
        now,
        databaseProvider,
      });
      membership = await getTeamMembershipById(database, input.organizationId, membership.id);
    }
    if (membership?.status === 'removed') {
      membership = await transitionTeamMembership(database, {
        organizationId: input.organizationId,
        membershipId: membership.id,
        expectedStatus: 'removed',
        toStatus: 'invited',
        actorUserId: input.actorUserId,
        source: 'invitation',
        reason: 'team_invitation_reissued',
        externalInvitationId: invitationId,
        role: input.role,
        displayName: input.displayName,
        metadata: { billableOperation: false },
        now,
        databaseProvider,
      });
    } else if (!membership) {
      membership = await createTeamMembershipCandidate(database, {
        organizationId: input.organizationId,
        email,
        displayName: input.displayName,
        role: input.role,
        status: 'invited',
        externalInvitationId: invitationId,
        invitedByUserId: input.actorUserId,
        source: 'invitation',
        reason: 'team_invitation_created',
        metadata: { billableOperation: false },
        now,
        databaseProvider,
      });
    }
    if (
      membership.status !== 'invited'
      || membership.candidateEmail !== email
      || membership.role !== input.role
    ) {
      throw new TeamInvitationError(
        'INVITATION_CONFLICT',
        'The pending membership no longer matches this invitation.',
      );
    }
    invitationId = membership.externalInvitationId || invitationId;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = invitationTokenHash(token);
    const expiresAt = now + ttlMs;
    if (existing) {
      const updated = await database.run(`
        UPDATE team_membership_invitations
        SET
          token_hash = ?,
          email_snapshot = ?,
          role_snapshot = ?,
          status = 'pending',
          invited_by_user_id = ?,
          expires_at = ?,
          accepted_request_id = NULL,
          accepted_at = NULL,
          revoked_at = NULL,
          updated_at = ?
        WHERE organization_id = ?
          AND id = ?
          AND status IN ('accepted', 'revoked', 'expired')
      `, [
        tokenHash,
        email,
        input.role,
        input.actorUserId,
        expiresAt,
        now,
        input.organizationId,
        invitationId,
      ]);
      if (changesFromRunResult(updated) !== 1) {
        throw new TeamInvitationError(
          'INVITATION_CONFLICT',
          'The invitation changed concurrently.',
        );
      }
    } else {
      await database.run(`
        INSERT INTO team_membership_invitations (
          id,
          organization_id,
          membership_id,
          token_hash,
          email_snapshot,
          role_snapshot,
          status,
          invited_by_user_id,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `, [
        invitationId,
        input.organizationId,
        membership.id,
        tokenHash,
        email,
        input.role,
        input.actorUserId,
        expiresAt,
        now,
        now,
      ]);
    }
    existing = await readInvitationById(database, input.organizationId, invitationId);
    if (!existing) {
      throw new TeamInvitationError(
        'INVITATION_CONFLICT',
        'The invitation was not persisted.',
      );
    }
    return {
      invitation: existing,
      membership,
      token,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function listTeamMembershipInvitations(input: {
  organizationId: string;
  database?: InvitationDatabase;
}): Promise<TeamMembershipInvitation[]> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  try {
    const rows = await database.all(`
      ${INVITATION_SELECT}
      WHERE organization_id = ?
      ORDER BY created_at DESC, id DESC
    `, [input.organizationId]) as InvitationRow[];
    return rows.map(mapInvitation);
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function revokeTeamMembershipInvitation(input: {
  organizationId: string;
  invitationId: string;
  actorUserId: string;
  database?: InvitationDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<TeamMembershipInvitation> {
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const databaseProvider = input.databaseProvider ?? getDatabaseProvider();
  const now = input.now ?? Date.now();
  try {
    const current = await readInvitationById(database, input.organizationId, input.invitationId);
    if (!current) {
      throw new TeamInvitationError('INVITATION_NOT_FOUND', 'Invitation not found.', 404);
    }
    if (current.status === 'accepted') {
      throw new TeamInvitationError(
        'INVITATION_ALREADY_USED',
        'An accepted invitation cannot be revoked.',
      );
    }
    if (current.status === 'pending') {
      await database.run(`
        UPDATE team_membership_invitations
        SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE organization_id = ? AND id = ? AND status = 'pending'
      `, [now, now, input.organizationId, input.invitationId]);
    }
    const revoked = await readInvitationById(database, input.organizationId, input.invitationId);
    if (!revoked) {
      throw new TeamInvitationError('INVITATION_NOT_FOUND', 'Invitation not found.', 404);
    }
    await finishTerminalMembership(database, revoked, {
      actorUserId: input.actorUserId,
      reason: revoked.status === 'expired'
        ? 'team_invitation_expired'
        : 'team_invitation_revoked',
      now,
      databaseProvider,
    });
    return revoked;
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function acceptTeamMembershipInvitation(input: {
  token: string;
  requestId: string;
  database?: InvitationDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<{
  invitation: TeamMembershipInvitation;
  membership: TeamMembership;
  replayed: boolean;
}> {
  if (!UUID_PATTERN.test(input.requestId)) {
    throw new TeamInvitationError(
      'INVITATION_INVALID',
      'A UUID acceptance request ID is required.',
      400,
    );
  }
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const databaseProvider = input.databaseProvider ?? getDatabaseProvider();
  const now = input.now ?? Date.now();
  try {
    let invitation = await readInvitationByToken(database, input.token);
    if (!invitation) {
      throw new TeamInvitationError('INVITATION_NOT_FOUND', 'Invitation not found.', 404);
    }
    if (invitation.status === 'revoked') {
      throw new TeamInvitationError('INVITATION_REVOKED', 'Invitation was revoked.', 410);
    }
    if (
      invitation.status === 'expired'
      || (invitation.status === 'pending' && invitation.expiresAt <= now)
    ) {
      if (invitation.status === 'pending') {
        await database.run(`
          UPDATE team_membership_invitations
          SET status = 'expired', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `, [now, invitation.id]);
        invitation = (await readInvitationByToken(database, input.token))!;
      }
      await finishTerminalMembership(database, invitation, {
        reason: 'team_invitation_expired',
        now,
        databaseProvider,
      });
      throw new TeamInvitationError('INVITATION_EXPIRED', 'Invitation has expired.', 410);
    }

    const replayed = invitation.status === 'accepted'
      && invitation.acceptedRequestId === input.requestId;
    if (invitation.status === 'accepted' && !replayed) {
      throw new TeamInvitationError(
        'INVITATION_ALREADY_USED',
        'Invitation was already accepted.',
      );
    }
    let membership = await getTeamMembershipById(
      database,
      invitation.organizationId,
      invitation.membershipId,
    );
    if (
      !membership
      || membership.candidateEmail !== invitation.email
      || membership.role !== invitation.role
      || !['invited', 'approval_required'].includes(membership.status)
      || membership.userId !== null
    ) {
      throw new TeamInvitationError(
        'INVITATION_CONFLICT',
        'Invitation email, role, or pending membership state no longer matches.',
      );
    }

    if (!replayed) {
      const accepted = await database.run(`
        UPDATE team_membership_invitations
        SET
          status = 'accepted',
          accepted_request_id = ?,
          accepted_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?
      `, [input.requestId, now, now, invitation.id, now]);
      if (changesFromRunResult(accepted) !== 1) {
        const concurrent = await readInvitationByToken(database, input.token);
        if (
          !concurrent
          || concurrent.status !== 'accepted'
          || concurrent.acceptedRequestId !== input.requestId
        ) {
          throw new TeamInvitationError(
            'INVITATION_ALREADY_USED',
            'Invitation was accepted or invalidated concurrently.',
          );
        }
      }
      invitation = (await readInvitationByToken(database, input.token))!;
    }
    if (membership.status === 'invited') {
      membership = await transitionTeamMembership(database, {
        organizationId: invitation.organizationId,
        membershipId: invitation.membershipId,
        expectedStatus: 'invited',
        toStatus: 'approval_required',
        acceptedAt: invitation.acceptedAt ?? now,
        source: 'invitation',
        reason: 'team_invitation_accepted',
        externalInvitationId: invitation.id,
        metadata: {
          acceptanceRequestId: input.requestId,
          billableOperation: false,
        },
        now,
        databaseProvider,
      });
    }
    return {
      invitation,
      membership,
      replayed,
    };
  } finally {
    if (closeDatabase) await database.close();
  }
}

export async function expireTeamMembershipInvitations(input?: {
  database?: InvitationDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
  limit?: number;
}): Promise<number> {
  const database = input?.database ?? await openDb();
  const closeDatabase = input?.database === undefined;
  const databaseProvider = input?.databaseProvider ?? getDatabaseProvider();
  const now = input?.now ?? Date.now();
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100));
  try {
    const rows = await database.all(`
      ${INVITATION_SELECT}
      WHERE status = 'pending' AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
      LIMIT ?
    `, [now, limit]) as InvitationRow[];
    let expired = 0;
    for (const row of rows) {
      const result = await database.run(`
        UPDATE team_membership_invitations
        SET status = 'expired', updated_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at <= ?
      `, [now, row.id, now]);
      if (changesFromRunResult(result) !== 1) continue;
      expired += 1;
      await finishTerminalMembership(database, mapInvitation({
        ...row,
        status: 'expired',
        updated_at: now,
      }), {
        reason: 'team_invitation_expired',
        now,
        databaseProvider,
      });
    }
    return expired;
  } finally {
    if (closeDatabase) await database.close();
  }
}
