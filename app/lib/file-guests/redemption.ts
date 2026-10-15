import 'server-only';

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import { executeLifecycleTransaction } from '@/app/lib/collaboration/lifecycle-transaction';

type InvitationTarget = Readonly<{
  id: string;
  workspaceId: string;
  path: string;
  documentId: string;
  policyRevision: number;
  createdByUserId: string;
}>;
type InvitationRow = {
  workspace_id: string;
  path: string;
  document_id: string;
  policy_revision: number | string;
  created_by_user_id: string;
  status: string;
  expires_at: number | string | null;
};
type AttemptRow = {
  challenge_id: string | null;
  challenge_hash: string | null;
};
type RedemptionOutcome =
  | { kind: 'invalid' }
  | { kind: 'changed' }
  | { kind: 'expired' }
  | { kind: 'verified'; token: string; expiresAt: Date };

/** No token is returned when COMMIT or connection release is unconfirmed. */
export class FileGuestRedemptionCommitError extends Error {
  readonly code = 'FILE_GUEST_REDEMPTION_COMMIT_UNCONFIRMED';
  readonly status = 503;

  constructor() {
    super('Die Bestätigung der Gastsitzung ist unklar. Bitte einen neuen Code anfordern.');
    this.name = 'FileGuestRedemptionCommitError';
  }
}

/**
 * Called only after the Guest service's entitlement, inviter and document
 * checks. This narrow transaction owns code consumption and session issuance;
 * it is not a lifecycle/admission or member-authentication capability.
 */
export async function redeemFileGuestCode(input: {
  invitation: InvitationTarget;
  displayName: string;
  hashCode: (challengeId: string) => string;
}): Promise<RedemptionOutcome> {
  const target = input.invitation;
  let prepared = false;
  try {
    return await executeLifecycleTransaction({
      openConnection: openDb,
      execute: async (database): Promise<RedemptionOutcome> => {
        await database.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
        await database.run("SET LOCAL statement_timeout = '5s'");
        await database.run("SET LOCAL lock_timeout = '4s'");
        const row = await database.get(`SELECT workspace_id,path,document_id,policy_revision,
          created_by_user_id,status,expires_at FROM file_guest_invitations WHERE id=$1 FOR UPDATE`,
        [target.id]) as InvitationRow | undefined;
        let outcome: RedemptionOutcome;
        if (!row || row.workspace_id !== target.workspaceId || row.path !== target.path
          || row.document_id !== target.documentId || Number(row.policy_revision) !== target.policyRevision
          || row.created_by_user_id !== target.createdByUserId) {
          outcome = { kind: 'changed' };
        } else {
          // Read the clock after any row-lock wait. A wait cannot extend either
          // the invitation or the OTP lifetime.
          const nowMs = Date.now();
          if (row.status !== 'active' || row.expires_at !== null && Number(row.expires_at) <= nowMs) {
            outcome = { kind: 'expired' };
          } else {
            const attempt = await database.get(`UPDATE file_guest_invitations
              SET challenge_attempts=challenge_attempts+1
              WHERE id=$1 AND status='active' AND policy_revision=$2
                AND (expires_at IS NULL OR expires_at>$3)
                AND challenge_expires_at>$3 AND challenge_attempts<5
              RETURNING challenge_id,challenge_hash`, [target.id,target.policyRevision,nowMs]) as AttemptRow | undefined;
            outcome = { kind: 'invalid' };
            if (attempt?.challenge_id && attempt.challenge_hash) {
              const expected = Buffer.from(input.hashCode(attempt.challenge_id), 'hex');
              const actual = Buffer.from(attempt.challenge_hash, 'hex');
              if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
                const consumed = await database.get(`UPDATE file_guest_invitations SET challenge_hash=NULL
                  WHERE id=$1 AND status='active' AND policy_revision=$2
                    AND challenge_id=$3 AND challenge_hash=$4 RETURNING id`,
                [target.id,target.policyRevision,attempt.challenge_id,attempt.challenge_hash]);
                if (consumed) {
                  const token = randomBytes(32).toString('base64url');
                  const expiresMs = Math.min(nowMs + 12 * 3_600_000, row.expires_at === null ? Infinity : Number(row.expires_at));
                  await database.run('DELETE FROM file_guest_sessions WHERE invitation_id=$1 AND expires_at<=$2', [target.id,nowMs]);
                  await database.run(`INSERT INTO file_guest_sessions
                    (id,invitation_id,token_hash,display_name,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
                  [randomUUID(),target.id,createHash('sha256').update(token).digest('hex'),input.displayName,expiresMs,nowMs]);
                  outcome = { kind: 'verified',token,expiresAt: new Date(expiresMs) };
                }
              }
            }
          }
        }
        // Invalid-code counters must commit too. The caller reports the 401
        // only after this transaction has confirmed its outcome.
        prepared = true;
        return outcome;
      },
      recoverCommitted: async () => { throw new FileGuestRedemptionCommitError(); },
    });
  } catch (error) {
    // Covers a lost COMMIT ACK, failed discard and post-COMMIT release error.
    // The existing transaction helper owns one-shot disposal; never retry.
    if (prepared) throw new FileGuestRedemptionCommitError();
    throw error;
  }
}
