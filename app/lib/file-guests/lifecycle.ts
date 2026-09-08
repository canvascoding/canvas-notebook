import 'server-only';

import type { SqlConnection } from '@/app/lib/db';

/** Runs in the same PostgreSQL transaction as the file identity transition. */
export async function revokeFileGuestPathScope(transaction: SqlConnection, input: { workspaceId: string; path: string; nowMs: number }) {
  await transaction.run(`
    UPDATE file_guest_invitations
    SET status = 'revoked', policy_revision = policy_revision + 1,
        challenge_hash = NULL, updated_at = $1
    WHERE workspace_id = $2 AND status = 'active'
      AND (path = $3 OR left(path, char_length($3) + 1) = $3 || '/')
  `, [Math.floor(input.nowMs / 1000), input.workspaceId, input.path]);
}
