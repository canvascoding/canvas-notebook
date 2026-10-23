import 'server-only';

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { requireFileGuestDocumentBinding } from './target';

type InvitationTarget = Readonly<{
  id: string;
  workspaceId: string;
  path: string;
  documentId: string;
  policyRevision: number;
  createdByUserId: string;
}>;
export type FileGuestRedemptionInput = Readonly<{
  invitation: InvitationTarget & Readonly<{ lineageId: string; lifecycleGeneration: number }>;
  displayName: string;
  hashCode: (challengeId: string) => string;
}>;
type InvitationRow = {
  workspace_id: string;
  path: string;
  document_id: string;
  lineage_id: string | null;
  lifecycle_generation: number | string | null;
  policy_revision: number | string;
  created_by_user_id: string;
  status: string;
  expires_at: number | string | null;
};
type AttemptRow = {
  challenge_id: string | null;
  challenge_hash: string | null;
};
export type FileGuestRedemptionOutcome =
  | { kind: 'invalid' }
  | { kind: 'changed' }
  | { kind: 'expired' }
  | { kind: 'verified'; token: string; expiresAt: Date };

/** Trusted narrow SQL only. The existing Guest writer owns current invitation
 * authority, the real transaction/Shared admission, relation binding, row lock,
 * final assertions and COMMIT. Never acquire another connection or boundary.
 * Invalid attempts return normally so the outer transaction can commit them. */
export async function redeemFileGuestCodeOnConnection(database: SqlConnection,
  input: FileGuestRedemptionInput): Promise<FileGuestRedemptionOutcome> {
  requireFileGuestDocumentBinding(input.invitation);
  // Snapshot primitive inputs before waiting for the existing invitation lock.
  const target = { ...input.invitation }, displayName = input.displayName, hashCode = input.hashCode;
  const row = await database.get(`SELECT workspace_id,path,document_id,lineage_id,lifecycle_generation,policy_revision,
    created_by_user_id,status,expires_at FROM file_guest_invitations WHERE id=$1 FOR UPDATE`,
  [target.id]) as InvitationRow | undefined;
  if (!row || row.workspace_id !== target.workspaceId || row.path !== target.path
    || row.document_id !== target.documentId || Number(row.policy_revision) !== target.policyRevision
    || row.created_by_user_id !== target.createdByUserId
    || row.lineage_id !== target.lineageId || Number(row.lifecycle_generation) !== target.lifecycleGeneration) {
    return { kind: 'changed' };
  }
  // Read the clock after any row-lock wait. A wait cannot extend either
  // the invitation or the OTP lifetime.
  const nowMs = Date.now();
  if (row.status !== 'active' || row.expires_at !== null && Number(row.expires_at) <= nowMs) return { kind: 'expired' };
  const attempt = await database.get(`UPDATE file_guest_invitations
    SET challenge_attempts=challenge_attempts+1
    WHERE id=$1 AND status='active' AND policy_revision=$2
      AND (expires_at IS NULL OR expires_at>$3)
      AND challenge_expires_at>$3 AND challenge_attempts<5
    RETURNING challenge_id,challenge_hash`, [target.id,target.policyRevision,nowMs]) as AttemptRow | undefined;
  if (!attempt?.challenge_id || !attempt.challenge_hash) return { kind: 'invalid' };
  const expected = Buffer.from(hashCode(attempt.challenge_id), 'hex');
  const actual = Buffer.from(attempt.challenge_hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { kind: 'invalid' };
  const consumed = await database.get(`UPDATE file_guest_invitations SET challenge_hash=NULL
    WHERE id=$1 AND status='active' AND policy_revision=$2
      AND challenge_id=$3 AND challenge_hash=$4 RETURNING id`,
  [target.id,target.policyRevision,attempt.challenge_id,attempt.challenge_hash]);
  if (!consumed) return { kind: 'invalid' };
  const token = randomBytes(32).toString('base64url');
  const expiresMs = Math.min(nowMs + 12 * 3_600_000, row.expires_at === null ? Infinity : Number(row.expires_at));
  await database.run('DELETE FROM file_guest_sessions WHERE invitation_id=$1 AND expires_at<=$2', [target.id,nowMs]);
  await database.run(`INSERT INTO file_guest_sessions
    (id,invitation_id,token_hash,display_name,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
  [randomUUID(),target.id,createHash('sha256').update(token).digest('hex'),displayName,expiresMs,nowMs]);
  return { kind: 'verified',token,expiresAt: new Date(expiresMs) };
}
