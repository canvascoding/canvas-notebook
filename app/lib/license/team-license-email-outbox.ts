import 'server-only';

import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { getUserPreferences } from '@/app/lib/user-preferences';
import { getSystemSmtpConfigurationStatus } from '@/app/lib/email/system-smtp-config';
import { getManagedSystemEmailAvailability, ManagedSystemEmailDeliveryUnknownError, sendManagedSystemEmail } from '@/app/lib/email/managed-system-email-client';
import { sendSystemSmtpEmail, SystemSmtpDeliveryUnknownError } from '@/app/lib/email/system-smtp-service';
import { renderTeamLicenseNotificationEmail } from '@/app/lib/email/templates/team-license-notification';
import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import { getServerPreferredTimeZone } from '@/app/lib/server-settings';
import { normalizePublicOrigin } from '@/app/lib/utils/request-origin';

type EmailDatabase = Pick<SqlConnection, 'get' | 'run' | 'close'>;
export type TeamLicenseEmailKind = 'owner_restricted' | 'owner_restored' | 'owner_mixed' | 'member_paused' | 'member_restored'
  | 'owner_term_14d' | 'owner_term_3d' | 'owner_term_1d'
  | 'member_term_14d' | 'member_term_3d' | 'member_term_1d' | 'owner_grace' | 'member_grace';

type EmailJob = {
  id: string;
  user_id: string;
  event_kind: TeamLicenseEmailKind;
  reason: string;
  seat_limit: number | string;
  attempts: number | string;
  email: string | null;
  recipient_name: string | null;
  owner_email: string | null;
  created_at: number | string;
  audit_metadata_json: string | null;
};

type EmailMessage = { to: string; subject: string; body: string; isHtml: true; idempotencyKey: string };
type Delivery = (message: EmailMessage) => Promise<{ messageId: string | null }>;

export async function readTeamLicenseEmailOutboxDiagnostics(
  database: Pick<SqlConnection, 'get'>,
  organizationId: string,
): Promise<{ manualReview: number; retryPending: number }> {
  const row = await database.get(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'manual_review') AS manual_review,
      COUNT(*) FILTER (WHERE status IN ('pending', 'failed', 'sending')) AS retry_pending
    FROM team_license_email_outbox
    WHERE organization_id = $1
  `, [organizationId]) as { manual_review?: number | string; retry_pending?: number | string } | undefined;
  return {
    manualReview: Number(row?.manual_review || 0),
    retryPending: Number(row?.retry_pending || 0),
  };
}

export async function enqueueTeamLicenseEmail(
  database: Pick<SqlConnection, 'run'>,
  input: { auditEventId: string; organizationId: string; userId: string; kind: TeamLicenseEmailKind; reason: string; seatLimit: number; now: number },
): Promise<void> {
  await database.run(`
    UPDATE team_license_email_outbox
    SET status = 'superseded', lease_until = NULL, updated_at = $3
    WHERE organization_id = $1 AND user_id = $2
      AND status IN ('pending', 'failed')
      AND ($4 = 0 OR event_kind LIKE 'owner_term_%' OR event_kind LIKE 'member_term_%'
        OR event_kind IN ('owner_grace', 'member_grace'))
  `, [input.organizationId, input.userId, input.now,
    Number(input.kind.startsWith('owner_term_') || input.kind.startsWith('member_term_')
      || input.kind === 'owner_grace' || input.kind === 'member_grace')]);
  await database.run(`
    INSERT INTO team_license_email_outbox
      (id, audit_event_id, organization_id, user_id, event_kind, reason, seat_limit,
       status, attempts, next_attempt_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $8, $8)
    ON CONFLICT (audit_event_id, user_id) DO NOTHING
  `, [
    `team-license-email:${input.auditEventId}:${input.userId}`,
    input.auditEventId,
    input.organizationId,
    input.userId,
    input.kind,
    input.reason,
    input.seatLimit,
    input.now,
  ]);
}

export async function supersedeObsoleteTeamLicenseWarnings(
  database: Pick<SqlConnection, 'run'>,
  input: { organizationId: string; grantId: string; termEndsAt: string | null; grace: boolean; restricted: boolean; now: number },
): Promise<void> {
  await database.run(`
    UPDATE team_license_email_outbox outbox
    SET status = 'superseded', lease_until = NULL, updated_at = $5
    WHERE outbox.organization_id = $1 AND outbox.status IN ('pending', 'failed')
      AND (outbox.event_kind LIKE 'owner_term_%' OR outbox.event_kind LIKE 'member_term_%'
        OR outbox.event_kind IN ('owner_grace', 'member_grace'))
      AND EXISTS (SELECT 1 FROM audit_events event WHERE event.id = outbox.audit_event_id
        AND ($6 = true OR (event.metadata_json::jsonb ->> 'grantId') IS DISTINCT FROM $2
          OR (event.metadata_json::jsonb ->> 'termEndsAt') IS DISTINCT FROM $3
          OR (event.action IN ('team.owner_grace', 'team.member_grace')) IS DISTINCT FROM $4))
  `, [input.organizationId, input.grantId, input.termEndsAt, input.grace, input.now, input.restricted]);
}

async function messageFor(job: EmailJob, to: string, locale: string): Promise<EmailMessage> {
  const rendered = renderTeamLicenseNotificationEmail({
    kind: job.event_kind, reason: job.reason, seatLimit: Number(job.seat_limit),
    recipientName: job.recipient_name, ownerEmail: job.owner_email,
    occurredAt: Number(job.created_at), metadataJson: job.audit_metadata_json,
    appUrl: normalizePublicOrigin(process.env.BASE_URL)
      || normalizePublicOrigin(process.env.APP_BASE_URL)
      || normalizePublicOrigin(process.env.BETTER_AUTH_BASE_URL),
    timeZone: await getServerPreferredTimeZone(),
  }, locale);
  return { to, subject: rendered.subject, body: rendered.html, isHtml: true, idempotencyKey: job.id };
}

async function sendSystemEmail(message: EmailMessage): Promise<{ messageId: string | null }> {
  const status = await getSystemSmtpConfigurationStatus();
  if (status.deliveryMode === 'managed') {
    const availability = await getManagedSystemEmailAvailability();
    if (!availability.available) throw new Error('Managed system email is unavailable.');
    return sendManagedSystemEmail({
      purpose: 'automation_alert', to: [message.to], subject: message.subject,
      body: message.body, isHtml: message.isHtml, idempotencyKey: message.idempotencyKey,
    });
  }
  if (status.deliveryMode === 'local' && status.complete) {
    const domain = status.fromAddress?.split('@')[1] || 'canvas-notebook.local';
    const messageId = `<${createHash('sha256').update(message.idempotencyKey).digest('hex')}@${domain}>`;
    return sendSystemSmtpEmail({ to: [message.to], subject: message.subject,
      body: message.body, isHtml: message.isHtml, messageId });
  }
  throw new Error('System email delivery is unavailable.');
}

export async function processTeamLicenseEmailOutbox(options: {
  database?: EmailDatabase;
  deliver?: Delivery;
  now?: number;
  limit?: number;
} = {}): Promise<{ delivered: number; failed: number; skipped: number; manualReview: number }> {
  const database = options.database ?? await openDb();
  const ownsDatabase = !options.database;
  const now = options.now ?? Date.now();
  const counts = { delivered: 0, failed: 0, skipped: 0, manualReview: 0 };
  try {
    for (let index = 0; index < Math.min(Math.max(options.limit ?? 20, 0), 100); index += 1) {
      const interrupted = await database.get(`
        UPDATE team_license_email_outbox outbox
        SET status = 'manual_review', lease_until = NULL,
          error = 'Delivery state unknown after worker interruption.', updated_at = $1
        WHERE outbox.id = (
          SELECT id FROM team_license_email_outbox
          WHERE status = 'sending' AND lease_until <= $1
          ORDER BY lease_until ASC, id ASC LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING outbox.id
      `, [now]) as { id: string } | undefined;
      if (interrupted) {
        counts.manualReview += 1;
        console.warn('[license/email-outbox] Interrupted delivery requires manual review', { jobId: interrupted.id });
        continue;
      }
      const job = await database.get(`
        UPDATE team_license_email_outbox outbox
        SET status = 'sending', lease_until = $2, attempts = attempts + 1, updated_at = $1
        WHERE outbox.id = (
          SELECT id FROM team_license_email_outbox
          WHERE status IN ('pending', 'failed') AND next_attempt_at <= $1
          ORDER BY next_attempt_at ASC, id ASC LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING outbox.id, outbox.user_id, outbox.event_kind, outbox.reason,
          outbox.seat_limit, outbox.attempts, outbox.created_at,
          (SELECT email FROM "user" WHERE id = outbox.user_id) AS email,
          (SELECT name FROM "user" WHERE id = outbox.user_id) AS recipient_name,
          (SELECT owner.email FROM canvas_organization_settings organization
            JOIN "user" owner ON owner.id = organization.owner_user_id
            WHERE organization.organization_id = outbox.organization_id) AS owner_email,
          (SELECT event.metadata_json FROM audit_events event
            WHERE event.id = outbox.audit_event_id AND event.organization_id = outbox.organization_id
              AND event.source = 'license' AND event.status = 'success') AS audit_metadata_json
      `, [now, now + 120_000]) as EmailJob | undefined;
      if (!job) break;
      try {
        const preferences = await getUserPreferences(job.user_id);
        if (preferences.teamLicenseEmailNotificationsEnabled === false) {
          await database.run(`
            UPDATE team_license_email_outbox SET status = 'skipped', lease_until = NULL,
              error = 'User disabled license email notifications.', updated_at = $2
            WHERE id = $1 AND status = 'sending'
          `, [job.id, now]);
          counts.skipped += 1;
          continue;
        }
        const email = job.email?.trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
          await database.run(`
            UPDATE team_license_email_outbox SET status = 'skipped', lease_until = NULL,
              error = 'Recipient email is unavailable.', updated_at = $2
            WHERE id = $1 AND status = 'sending'
          `, [job.id, now]);
          counts.skipped += 1;
          continue;
        }
        const response = await (options.deliver ?? sendSystemEmail)(await messageFor(job, email, preferences.locale ?? 'en'));
        await database.run(`
          UPDATE team_license_email_outbox SET status = 'delivered', lease_until = NULL,
            message_id = $2, error = NULL, delivered_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'sending'
        `, [job.id, response.messageId, now]);
        counts.delivered += 1;
      } catch (error) {
        if (error instanceof ManagedSystemEmailDeliveryUnknownError || error instanceof SystemSmtpDeliveryUnknownError) {
          await database.run(`
            UPDATE team_license_email_outbox SET status = 'manual_review', lease_until = NULL,
              error = $2, updated_at = $3
            WHERE id = $1 AND status = 'sending'
          `, [job.id, redactTeamControlPlaneLogText(error.message).slice(0, 500), now]);
          counts.manualReview += 1;
          console.warn('[license/email-outbox] Delivery requires manual review', { jobId: job.id });
          continue;
        }
        const attempt = Number(job.attempts);
        const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempt - 1, 7));
        await database.run(`
          UPDATE team_license_email_outbox SET status = 'failed', lease_until = NULL,
            next_attempt_at = $2, error = $3, updated_at = $4
          WHERE id = $1 AND status = 'sending'
        `, [job.id, now + delay, redactTeamControlPlaneLogText(error instanceof Error ? error.message : 'System email failed.').slice(0, 500), now]);
        counts.failed += 1;
      }
    }
    return counts;
  } finally {
    if (ownsDatabase) await database.close();
  }
}
