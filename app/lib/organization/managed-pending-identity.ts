import 'server-only';

import { ensurePendingTeamMembershipIdentity } from '@/app/lib/auth';
import { openDb } from '@/app/lib/db';
import { runManagedTeamSyncCycle } from '@/app/lib/license/managed-team-sync';
import { getTeamMembershipById } from './team-membership';

export class ManagedPendingIdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = 'ManagedPendingIdentityError';
  }
}

export async function bindManagedPendingIdentity(input: {
  organizationId: string;
  membershipId: string;
  password: string;
}): Promise<{ localIdentityKey: string; localUserId: string; status: 'pending' }> {
  if (input.password.length < 8 || input.password.length > 128) {
    throw new ManagedPendingIdentityError(
      'MANAGED_TEAM_PASSWORD_INVALID',
      'The initial password must contain between 8 and 128 characters.',
      400,
    );
  }
  const database = await openDb();
  try {
    const membership = await getTeamMembershipById(database, input.organizationId, input.membershipId);
    if (!membership || !['approval_required', 'billing_pending'].includes(membership.status)
      || membership.userId !== null) {
      throw new ManagedPendingIdentityError(
        'MANAGED_TEAM_MEMBERSHIP_NOT_PENDING',
        'The managed Team invitation is no longer waiting for identity approval.',
      );
    }
    const priorBinding = await database.get(`
      SELECT pending_user_id
      FROM managed_team_pending_identities
      WHERE local_identity_key = $1
    `, [membership.id]) as { pending_user_id: string } | undefined;
    const otherBinding = await database.get(`
      SELECT pending.local_identity_key
      FROM managed_team_pending_identities pending
      JOIN "user" identity ON identity.id = pending.pending_user_id
      WHERE lower(identity.email) = $1 AND pending.local_identity_key <> $2
    `, [membership.candidateEmail, membership.id]) as { local_identity_key: string } | undefined;
    if (otherBinding) {
      throw new ManagedPendingIdentityError(
        'MANAGED_TEAM_IDENTITY_CONFLICT',
        'This identity is already bound to another managed Team membership.',
      );
    }
    const identity = await ensurePendingTeamMembershipIdentity({
      name: membership.displayName || membership.candidateEmail,
      email: membership.candidateEmail,
      password: input.password,
      role: membership.role === 'admin' ? 'admin' : 'user',
    });
    if (identity.email.toLowerCase() !== membership.candidateEmail) {
      throw new ManagedPendingIdentityError(
        'MANAGED_TEAM_IDENTITY_MISMATCH',
        'The pending identity does not match the accepted invitation.',
      );
    }
    if (priorBinding && priorBinding.pending_user_id !== identity.id) {
      throw new ManagedPendingIdentityError(
        'MANAGED_TEAM_IDENTITY_CONFLICT',
        'The managed invitation is already bound to another local identity.',
      );
    }
    await database.run(`
      INSERT INTO managed_team_pending_identities (
        local_identity_key, organization_id, pending_user_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (local_identity_key) DO NOTHING
    `, [membership.id, membership.organizationId, identity.id, Date.now()]);
    const persisted = await database.get(`
      SELECT pending_user_id FROM managed_team_pending_identities WHERE local_identity_key = $1
    `, [membership.id]) as { pending_user_id: string } | undefined;
    if (persisted?.pending_user_id !== identity.id) {
      throw new ManagedPendingIdentityError(
        'MANAGED_TEAM_IDENTITY_CONFLICT',
        'The managed identity binding changed concurrently.',
      );
    }
    void runManagedTeamSyncCycle().catch(() => undefined);
    return { localIdentityKey: membership.id, localUserId: identity.id, status: 'pending' };
  } finally {
    await database.close();
  }
}
