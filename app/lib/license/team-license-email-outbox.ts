import 'server-only';

import { createHash } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { getUserPreferences } from '@/app/lib/user-preferences';
import { getSystemSmtpConfigurationStatus } from '@/app/lib/email/system-smtp-config';
import { getManagedSystemEmailAvailability, ManagedSystemEmailDeliveryUnknownError, sendManagedSystemEmail } from '@/app/lib/email/managed-system-email-client';
import { sendSystemSmtpEmail } from '@/app/lib/email/system-smtp-service';
import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';

type EmailDatabase = Pick<SqlConnection, 'get' | 'run' | 'close'>;
export type TeamLicenseEmailKind = 'owner_restricted' | 'owner_restored' | 'owner_mixed' | 'member_paused' | 'member_restored';

type EmailJob = {
  id: string;
  user_id: string;
  event_kind: TeamLicenseEmailKind;
  reason: string;
  seat_limit: number | string;
  attempts: number | string;
  email: string | null;
};

type EmailMessage = { to: string; subject: string; body: string; idempotencyKey: string };
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
  database: EmailDatabase,
  input: { auditEventId: string; organizationId: string; userId: string; kind: TeamLicenseEmailKind; reason: string; seatLimit: number; now: number },
): Promise<void> {
  await database.run(`
    UPDATE team_license_email_outbox
    SET status = 'superseded', lease_until = NULL, updated_at = $3
    WHERE organization_id = $1 AND user_id = $2
      AND status IN ('pending', 'failed')
  `, [input.organizationId, input.userId, input.now]);
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

function messageFor(job: EmailJob, to: string, locale: string): EmailMessage {
  const german = locale.toLowerCase().startsWith('de');
  const seats = Number(job.seat_limit);
  const member = job.event_kind.startsWith('member_');
  const restored = job.event_kind === 'member_restored' || job.event_kind === 'owner_restored';
  const subject = german
    ? restored ? 'Canvas Notebook: Team-Zugang wiederhergestellt' : 'Canvas Notebook: Team-Zugang geändert'
    : restored ? 'Canvas Notebook: Team access restored' : 'Canvas Notebook: Team access changed';
  let body: string;
  if (member) {
    body = restored
      ? german
        ? 'Dein Team-Zugang zu Canvas Notebook wurde wiederhergestellt. Du kannst dich erneut anmelden. Deine Daten sind erhalten geblieben.'
        : 'Your Canvas Notebook team access has been restored. You can sign in again. Your data was retained.'
      : german
        ? `Dein Team-Zugang zu Canvas Notebook ist derzeit pausiert, weil die Team-Lizenz oder das Seat-Limit (${seats}) geändert wurde. Du kannst dich vorerst nicht anmelden. Deine Daten bleiben erhalten. Bitte wende dich an den Organisations-Owner.`
        : `Your Canvas Notebook team access is paused because the team license or seat limit (${seats}) changed. You cannot sign in for now. Your data is retained. Please contact the organization owner.`;
  } else {
    body = restored
      ? german
        ? `Team-Zugänge wurden innerhalb des aktuellen Limits von ${seats} Plätzen wiederhergestellt. Betroffene Mitglieder können sich erneut anmelden.`
        : `Team access was restored within the current limit of ${seats} seats. Affected members can sign in again.`
      : german
        ? `Der Team-Zugang wurde geändert. Das aktuelle Limit beträgt ${seats} Plätze. Betroffene Mitglieder können sich vorerst nicht anmelden; ihre Daten bleiben erhalten. Prüfe die Team-Lizenz in Canvas Notebook.`
        : `Team access changed. The current limit is ${seats} seats. Affected members cannot sign in for now; their data remains intact. Review the team license in Canvas Notebook.`;
  }
  return { to, subject, body, idempotencyKey: job.id };
}

async function sendSystemEmail(message: EmailMessage): Promise<{ messageId: string | null }> {
  const status = await getSystemSmtpConfigurationStatus();
  if (status.deliveryMode === 'managed') {
    const availability = await getManagedSystemEmailAvailability();
    if (!availability.available) throw new Error('Managed system email is unavailable.');
    return sendManagedSystemEmail({
      purpose: 'automation_alert', to: [message.to], subject: message.subject,
      body: message.body, idempotencyKey: message.idempotencyKey,
    });
  }
  if (status.deliveryMode === 'local' && status.complete) {
    const domain = status.fromAddress?.split('@')[1] || 'canvas-notebook.local';
    const messageId = `<${createHash('sha256').update(message.idempotencyKey).digest('hex')}@${domain}>`;
    return sendSystemSmtpEmail({ to: [message.to], subject: message.subject, body: message.body, messageId });
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
      const job = await database.get(`
        UPDATE team_license_email_outbox outbox
        SET status = 'sending', lease_until = $2, attempts = attempts + 1, updated_at = $1
        WHERE outbox.id = (
          SELECT id FROM team_license_email_outbox
          WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= $1)
            OR (status = 'sending' AND lease_until <= $1))
          ORDER BY next_attempt_at ASC, id ASC LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING outbox.id, outbox.user_id, outbox.event_kind, outbox.reason,
          outbox.seat_limit, outbox.attempts,
          (SELECT email FROM "user" WHERE id = outbox.user_id) AS email
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
        const response = await (options.deliver ?? sendSystemEmail)(messageFor(job, email, preferences.locale ?? 'en'));
        await database.run(`
          UPDATE team_license_email_outbox SET status = 'delivered', lease_until = NULL,
            message_id = $2, error = NULL, delivered_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'sending'
        `, [job.id, response.messageId, now]);
        counts.delivered += 1;
      } catch (error) {
        if (error instanceof ManagedSystemEmailDeliveryUnknownError) {
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
