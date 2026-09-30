import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SqlConnection } from '@/app/lib/db';

export type TeamLicenseEmailReviewDecision = 'confirmed_delivered' | 'confirmed_not_delivered' | 'do_not_send';

type ReviewRow = {
  id: string;
  event_kind: string;
  email: string | null;
  attempts: number | string;
  created_at: number | string;
  updated_at: number | string;
  error: string | null;
};

function maskedEmail(email: string | null): string {
  if (!email) return 'Recipient unavailable';
  const [local, domain] = email.split('@');
  if (!local || !domain) return 'Recipient unavailable';
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function listTeamLicenseEmailReviews(
  database: Pick<SqlConnection, 'all'>,
  organizationId: string,
) {
  const rows = await database.all(`
    SELECT outbox.id, outbox.event_kind, outbox.attempts, outbox.created_at,
      outbox.updated_at, outbox.error, recipient.email
    FROM team_license_email_outbox outbox
    LEFT JOIN "user" recipient ON recipient.id = outbox.user_id
    WHERE outbox.organization_id = $1 AND outbox.status = 'manual_review'
    ORDER BY outbox.updated_at ASC, outbox.id ASC LIMIT 100
  `, [organizationId]) as ReviewRow[];
  return rows.map((row) => ({
    id: row.id,
    eventKind: row.event_kind,
    recipient: maskedEmail(row.email),
    attempts: Number(row.attempts),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    reviewAt: new Date(Number(row.updated_at)).toISOString(),
    issue: row.error || 'Delivery result unknown.',
  }));
}

export async function resolveTeamLicenseEmailReview(
  database: Pick<SqlConnection, 'get' | 'run'>,
  input: {
    organizationId: string;
    jobId: string;
    actorUserId: string;
    decision: TeamLicenseEmailReviewDecision;
    now?: number;
  },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const status = input.decision === 'confirmed_delivered' ? 'delivered'
    : input.decision === 'confirmed_not_delivered' ? 'pending' : 'skipped';
  await database.run('BEGIN');
  try {
    const job = await database.get(`
      UPDATE team_license_email_outbox
      SET status = $3, lease_until = NULL, next_attempt_at = $4,
        delivered_at = CASE WHEN $3 = 'delivered' THEN $4 ELSE delivered_at END,
        error = $5, updated_at = $4
      WHERE id = $1 AND organization_id = $2 AND status = 'manual_review'
      RETURNING id, audit_event_id, event_kind, attempts
    `, [input.jobId, input.organizationId, status, now,
      `Operator review: ${input.decision.replaceAll('_', ' ')}.`]) as {
        id: string; audit_event_id: string; event_kind: string; attempts: number | string;
      } | undefined;
    if (!job) {
      await database.run('ROLLBACK');
      return false;
    }
    await database.run(`
      INSERT INTO audit_events
        (id, organization_id, user_id, source, event_type, entity_type, entity_id,
          action, status, summary, metadata_json, created_at)
      VALUES ($1, $2, $3, 'license', 'license_email_review', 'team_license_email', $4,
        $5, 'success', $6, $7, $8)
    `, [`license-email-review:${randomUUID()}`, input.organizationId, input.actorUserId,
      job.id, `team.license_email.${input.decision}`,
      'A Team license email delivery outcome was reviewed by the organization owner.',
      JSON.stringify({ auditEventId: job.audit_event_id, eventKind: job.event_kind,
        attempts: Number(job.attempts), decision: input.decision }), now]);
    await database.run('COMMIT');
    return true;
  } catch (error) {
    await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined);
    throw error;
  }
}
