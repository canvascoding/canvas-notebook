import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { openDb } from '@/app/lib/db';
import {
  getDatabaseProvider,
  type DatabaseProvider,
} from '@/app/lib/db/provider';
import {
  getTeamMembershipByUserId,
  transitionTeamMembership,
  type TeamMembership,
} from './team-membership';

type MembershipSuspensionDatabase = Pick<SqlConnection, 'get' | 'run' | 'all' | 'close'>;

type OrganizationUserState = {
  owner_user_id: string;
  role: string | null;
  status: string | null;
  banned: number | boolean | null;
};

export class MembershipSuspensionError extends Error {
  constructor(
    public readonly code:
      | 'MEMBERSHIP_SUSPENSION_NOT_FOUND'
      | 'MEMBERSHIP_SUSPENSION_CONFLICT'
      | 'MEMBERSHIP_LAST_OWNER'
      | 'MEMBERSHIP_SELF_SUSPENSION',
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'MembershipSuspensionError';
  }
}

export type MembershipSuspensionResult = {
  membership: TeamMembership;
  sessionsRevoked: number;
  replayed: boolean;
};

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
    return;
  }
}

async function readOrganizationUserState(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
  userId: string,
): Promise<OrganizationUserState | null> {
  const row = await database.get(`
    SELECT
      settings.owner_user_id,
      permissions.role,
      permissions.status,
      users.banned
    FROM canvas_organization_settings settings
    INNER JOIN organization_user_permissions permissions
      ON permissions.organization_id = settings.organization_id
      AND permissions.user_id = ?
    INNER JOIN "user" users ON users.id = permissions.user_id
    WHERE settings.organization_id = ?
    LIMIT 1
  `, [userId, organizationId]) as OrganizationUserState | undefined;
  return row ?? null;
}

async function activeAdminLikeUsersExcluding(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
  userId: string,
): Promise<number> {
  const row = await database.get(`
    SELECT COUNT(*) AS count
    FROM organization_user_permissions permissions
    INNER JOIN "user" users ON users.id = permissions.user_id
    WHERE permissions.organization_id = ?
      AND permissions.user_id != ?
      AND permissions.role IN ('owner', 'admin')
      AND COALESCE(permissions.status, 'active') = 'active'
      AND COALESCE(users.banned, 0) != 1
  `, [organizationId, userId]) as { count: number | string } | undefined;
  return Number(row?.count || 0);
}

export async function suspendTeamMembershipUser(input: {
  organizationId: string;
  targetUserId: string;
  actorUserId: string;
  reason?: string | null;
  database?: MembershipSuspensionDatabase;
  databaseProvider?: DatabaseProvider;
  now?: number;
}): Promise<MembershipSuspensionResult> {
  if (input.targetUserId === input.actorUserId) {
    throw new MembershipSuspensionError(
      'MEMBERSHIP_SELF_SUSPENSION',
      'Users cannot suspend their own account.',
    );
  }
  const database = input.database ?? await openDb();
  const closeDatabase = input.database === undefined;
  const databaseProvider = input.databaseProvider ?? getDatabaseProvider();
  const now = input.now ?? Date.now();
  await database.run(databaseProvider === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const state = await readOrganizationUserState(
      database,
      input.organizationId,
      input.targetUserId,
    );
    const membership = await getTeamMembershipByUserId(
      database,
      input.organizationId,
      input.targetUserId,
    );
    if (!state || !membership) {
      throw new MembershipSuspensionError(
        'MEMBERSHIP_SUSPENSION_NOT_FOUND',
        'The active organization membership was not found.',
        404,
      );
    }
    if (
      state.owner_user_id === input.targetUserId
      || state.role === 'owner'
      || (
        state.role === 'admin'
        && await activeAdminLikeUsersExcluding(
          database,
          input.organizationId,
          input.targetUserId,
        ) < 1
      )
    ) {
      throw new MembershipSuspensionError(
        'MEMBERSHIP_LAST_OWNER',
        'Transfer ownership or appoint another active administrator before suspending this user.',
      );
    }
    if (state.status !== 'active') {
      throw new MembershipSuspensionError(
        'MEMBERSHIP_SUSPENSION_CONFLICT',
        `Organization permission is already ${state.status || 'inactive'}.`,
      );
    }
    if (membership.status === 'suspended' && Boolean(state.banned)) {
      await database.run('COMMIT');
      return {
        membership,
        sessionsRevoked: 0,
        replayed: true,
      };
    }
    if (membership.status !== 'active') {
      throw new MembershipSuspensionError(
        'MEMBERSHIP_SUSPENSION_CONFLICT',
        `Membership cannot be suspended from status ${membership.status}.`,
      );
    }
    const reason = (input.reason || '').trim().slice(0, 1000) || 'Suspended by administrator';
    const banned = await database.run(`
      UPDATE "user"
      SET banned = 1, ban_reason = ?, ban_expires = NULL, updated_at = ?
      WHERE id = ?
    `, [reason, now, input.targetUserId]);
    if (changesFromRunResult(banned) !== 1) {
      throw new MembershipSuspensionError(
        'MEMBERSHIP_SUSPENSION_CONFLICT',
        'The Better Auth user changed before suspension.',
      );
    }
    const sessionsRevoked = changesFromRunResult(await database.run(
      'DELETE FROM "session" WHERE user_id = ?',
      [input.targetUserId],
    ));
    const suspended = await transitionTeamMembership(database, {
      organizationId: input.organizationId,
      membershipId: membership.id,
      expectedStatus: 'active',
      toStatus: 'suspended',
      actorUserId: input.actorUserId,
      source: 'local_admin',
      reason,
      seatOperationType: 'member_remove',
      enqueueSeatReduction: true,
      transactionMode: 'existing',
      now,
      databaseProvider,
    });
    await database.run('COMMIT');
    return {
      membership: suspended,
      sessionsRevoked,
      replayed: false,
    };
  } catch (error) {
    await rollbackQuietly(database);
    throw error;
  } finally {
    if (closeDatabase) await database.close();
  }
}
