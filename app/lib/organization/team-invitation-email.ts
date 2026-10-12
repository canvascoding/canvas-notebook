import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { getSystemSmtpConfigurationStatus } from '@/app/lib/email/system-smtp-config';
import { sendSystemSmtpEmail, SystemSmtpDeliveryUnknownError } from '@/app/lib/email/system-smtp-service';
import {
  getManagedSystemEmailAvailability,
  ManagedSystemEmailDeliveryUnknownError,
  ManagedSystemEmailHttpError,
  sendManagedSystemEmail,
} from '@/app/lib/email/managed-system-email-client';
import { renderTeamInvitationEmail } from '@/app/lib/email/templates/team-invitation';
import { normalizePublicOrigin } from '@/app/lib/utils/request-origin';
import type { TeamMembershipInvitation } from './team-invitations';

const RESEND_COOLDOWN_MS = 60_000;
const SEND_LEASE_MS = 120_000;
const SEND_RESPONSE_TIMEOUT_MS = 60_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TeamInvitationEmailDelivery = {
  status: 'not_sent' | 'unconfigured' | 'sending' | 'sent' | 'failed';
  errorCode: string | null;
  deliveryUnknown: boolean;
  lastAttemptAt: number | null;
  sentAt: number | null;
  resendAfter: number | null;
  canResend: boolean;
};

export class TeamInvitationEmailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'TeamInvitationEmailError';
  }
}

type EmailRoute = { kind: 'local' | 'managed'; fromAddress: string | null }
  | { kind: 'unconfigured'; errorCode: string };

type InvitationEmailMessage = {
  to: string;
  subject: string;
  html: string;
  attemptId: string;
};

type DeliveryOptions = {
  database?: SqlConnection;
  now?: number;
  locale?: string;
  /** Explicit service ports keep persistence tests independent of real providers. */
  resolveDelivery?: () => Promise<EmailRoute>;
  deliver?: (message: InvitationEmailMessage, route: Exclude<EmailRoute, { kind: 'unconfigured' }>) => Promise<{ messageId: string | null }>;
  publicOrigin?: string;
  preflightTimeoutMs?: number;
};

type InvitationRow = {
  id: string;
  organization_id: string;
  membership_id: string;
  token_hash: string;
  email_snapshot: string;
  role_snapshot: TeamMembershipInvitation['role'];
  status: TeamMembershipInvitation['status'];
  invited_by_user_id: string | null;
  expires_at: number | string;
  accepted_at: number | string | null;
  revoked_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
  display_name: string | null;
  membership_status: string;
};

type AttemptRow = {
  id: string;
  organization_id: string;
  invitation_id: string;
  attempt_number: number | string;
  token_hash: string;
  status: 'unconfigured' | 'sending' | 'sent' | 'failed';
  error_code: string | null;
  delivery_unknown: number | string;
  lease_until: number | string | null;
  sent_at: number | string | null;
  created_at: number | string;
};

type DeliveryRow = AttemptRow & {
  invitation_status: TeamMembershipInvitation['status'];
  invitation_expires_at: number | string;
  current_token_hash: string;
};

const INVITATION_SQL = `
  SELECT invitation.*, membership.display_name, membership.status AS membership_status
  FROM team_membership_invitations invitation
  JOIN team_memberships membership ON membership.id = invitation.membership_id
    AND membership.organization_id = invitation.organization_id
  WHERE invitation.organization_id = $1 AND invitation.id = $2
`;

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function invitationFromRow(row: InvitationRow): TeamMembershipInvitation {
  return {
    id: row.id, organizationId: row.organization_id, membershipId: row.membership_id,
    email: row.email_snapshot, role: row.role_snapshot, status: row.status,
    invitedByUserId: row.invited_by_user_id, expiresAt: Number(row.expires_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function deliveryFromRow(row: DeliveryRow, now: number): TeamInvitationEmailDelivery {
  const currentAttempt = row.id && row.token_hash === row.current_token_hash;
  const interrupted = row.status === 'sending' && Number(row.lease_until) <= now;
  const sending = row.status === 'sending' && !interrupted;
  const cooldownUntil = row.id ? Number(row.created_at) + RESEND_COOLDOWN_MS : null;
  const resendAfter = sending ? Math.max(cooldownUntil ?? 0, Number(row.lease_until)) : cooldownUntil;
  return {
    status: !currentAttempt ? 'not_sent' : interrupted ? 'failed' : row.status,
    errorCode: interrupted ? 'INVITATION_EMAIL_DELIVERY_UNKNOWN' : !currentAttempt && !Number(row.delivery_unknown) ? null : row.error_code,
    deliveryUnknown: Boolean(interrupted || Number(row.delivery_unknown)),
    lastAttemptAt: currentAttempt ? Number(row.created_at) : null,
    sentAt: currentAttempt && row.sent_at !== null ? Number(row.sent_at) : null,
    resendAfter,
    canResend: row.invitation_status === 'pending' && Number(row.invitation_expires_at) > now
      && !sending && (resendAfter === null || resendAfter <= now),
  };
}

export async function listTeamInvitationEmailDeliveries(input: {
  organizationId: string;
  database?: SqlConnection;
  now?: number;
}): Promise<Record<string, TeamInvitationEmailDelivery>> {
  const database = input.database ?? await openDb();
  try {
    const rows = await database.all(`
      SELECT invitation.id AS invitation_id, invitation.status AS invitation_status,
        invitation.expires_at AS invitation_expires_at, invitation.token_hash AS current_token_hash,
        attempt.id, attempt.organization_id, attempt.attempt_number, attempt.token_hash,
        attempt.status, attempt.error_code, attempt.delivery_unknown, attempt.lease_until,
        attempt.sent_at, attempt.created_at
      FROM team_membership_invitations invitation
      LEFT JOIN LATERAL (
        SELECT * FROM team_membership_invitation_email_attempts candidate
        WHERE candidate.organization_id = invitation.organization_id AND candidate.invitation_id = invitation.id
        ORDER BY candidate.attempt_number DESC LIMIT 1
      ) attempt ON true
      WHERE invitation.organization_id = $1
    `, [input.organizationId]) as DeliveryRow[];
    return Object.fromEntries(rows.map(row => [row.invitation_id, deliveryFromRow(row, input.now ?? Date.now())]));
  } finally {
    if (!input.database) await database.close();
  }
}

async function readDelivery(database: SqlConnection, organizationId: string, invitationId: string, now: number) {
  const deliveries = await listTeamInvitationEmailDeliveries({ organizationId, database, now });
  const delivery = deliveries[invitationId];
  if (!delivery) throw new TeamInvitationEmailError('INVITATION_NOT_FOUND', 'Invitation not found.', 404);
  return delivery;
}

async function resolveDelivery(): Promise<EmailRoute> {
  const status = await getSystemSmtpConfigurationStatus();
  if (status.deliveryMode === 'disabled') return { kind: 'unconfigured', errorCode: 'INVITATION_EMAIL_DISABLED' };
  if (status.deliveryMode === 'managed') {
    if (!status.managedAvailable) return { kind: 'unconfigured', errorCode: 'INVITATION_EMAIL_UNCONFIGURED' };
    const managed = await getManagedSystemEmailAvailability();
    return managed.available
      ? { kind: 'managed', fromAddress: managed.fromAddress }
      : { kind: 'unconfigured', errorCode: 'INVITATION_EMAIL_UNCONFIGURED' };
  }
  return status.complete
    ? { kind: 'local', fromAddress: status.fromAddress }
    : { kind: 'unconfigured', errorCode: 'INVITATION_EMAIL_UNCONFIGURED' };
}

async function sendMessage(message: InvitationEmailMessage, route: Exclude<EmailRoute, { kind: 'unconfigured' }>) {
  if (route.kind === 'managed') {
    return sendManagedSystemEmail({
      purpose: 'invite', to: [message.to], subject: message.subject, body: message.html, isHtml: true,
      idempotencyKey: `team-invitation:${message.attemptId}`,
    });
  }
  const domain = route.fromAddress?.split('@')[1] || 'canvas-notebook.local';
  return sendSystemSmtpEmail({
    to: [message.to], subject: message.subject, body: message.html, isHtml: true,
    messageId: `<${createHash('sha256').update(message.attemptId).digest('hex')}@${domain}>`,
  });
}

async function transaction<T>(database: SqlConnection, operation: () => Promise<T>): Promise<T> {
  await database.run('BEGIN');
  try {
    const result = await operation();
    await database.run('COMMIT');
    return result;
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch { /* Preserve the original transaction failure. */ }
    throw error;
  }
}

async function performDelivery(input: Omit<DeliveryOptions, 'publicOrigin'> & {
  database: SqlConnection;
  invitation: InvitationRow;
  attemptId: string;
  token: string;
  route: EmailRoute;
  preflightFailed: boolean;
  publicOrigin: string | null;
}): Promise<TeamInvitationEmailDelivery> {
  let errorCode: string | null = null;
  let status: AttemptRow['status'] = 'sending';
  let deliveryUnknown = false;
  let messageId: string | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (input.preflightFailed) {
    status = 'failed'; errorCode = 'INVITATION_EMAIL_SEND_FAILED';
  } else if (!input.publicOrigin) {
    status = 'unconfigured'; errorCode = 'INVITATION_EMAIL_URL_UNCONFIGURED';
  } else if (input.route.kind === 'unconfigured') {
    status = 'unconfigured'; errorCode = input.route.errorCode;
  } else {
    const rendered = renderTeamInvitationEmail({
      recipientName: input.invitation.display_name,
      acceptanceUrl: `${input.publicOrigin}/invite/team?token=${encodeURIComponent(input.token)}`,
      expiresAt: Number(input.invitation.expires_at), locale: input.locale,
    });
    try {
      const response = await Promise.race([
        (input.deliver ?? sendMessage)({ to: input.invitation.email_snapshot, subject: rendered.subject,
          html: rendered.html, attemptId: input.attemptId }, input.route),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new SystemSmtpDeliveryUnknownError()), SEND_RESPONSE_TIMEOUT_MS);
        }),
      ]);
      status = 'sent'; messageId = response.messageId;
    } catch (error) {
      status = 'failed';
      deliveryUnknown = error instanceof SystemSmtpDeliveryUnknownError || error instanceof ManagedSystemEmailDeliveryUnknownError
        || (input.route.kind === 'managed' && error instanceof ManagedSystemEmailHttpError && error.statusCode >= 500);
      errorCode = deliveryUnknown ? 'INVITATION_EMAIL_DELIVERY_UNKNOWN' : 'INVITATION_EMAIL_SEND_FAILED';
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  // A completion only settles its own persisted attempt. Never reuse a newer
  // attempt or retry SMTP if the database cannot record the provider response.
  const settledAt = input.now ?? Date.now();
  let settled: unknown;
  try {
    settled = await input.database.run(`
      UPDATE team_membership_invitation_email_attempts
      SET status = $1, error_code = $2, delivery_unknown = $3, message_id = $4,
        lease_until = NULL, sent_at = $5, updated_at = $6
      WHERE id = $7 AND organization_id = $8 AND invitation_id = $9 AND status = 'sending'
    `, [status, errorCode, Number(deliveryUnknown), messageId, status === 'sent' ? settledAt : null,
      settledAt, input.attemptId, input.invitation.organization_id, input.invitation.id]);
  } catch {
    throw new TeamInvitationEmailError('INVITATION_EMAIL_STATUS_UNAVAILABLE', 'Could not persist the invitation email result.', 503);
  }
  if (!settled || typeof settled !== 'object' || !('changes' in settled) || Number(settled.changes) !== 1) {
    throw new TeamInvitationEmailError('INVITATION_EMAIL_STATUS_UNAVAILABLE', 'Could not persist the invitation email result.', 503);
  }
  return readDelivery(input.database, input.invitation.organization_id, input.invitation.id, settledAt);
}

async function prepareDelivery(options: DeliveryOptions): Promise<{
  route: EmailRoute; preflightFailed: boolean; publicOrigin: string | null;
}> {
  const publicOrigin = normalizePublicOrigin(options.publicOrigin)
    || normalizePublicOrigin(process.env.BASE_URL)
    || normalizePublicOrigin(process.env.APP_BASE_URL)
    || normalizePublicOrigin(process.env.BETTER_AUTH_BASE_URL);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const route = await Promise.race([
      (options.resolveDelivery ?? resolveDelivery)(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Invitation email preflight timed out.')),
          Math.min(Math.max(options.preflightTimeoutMs ?? PREFLIGHT_TIMEOUT_MS, 1), PREFLIGHT_TIMEOUT_MS));
      }),
    ]);
    return { route, preflightFailed: false, publicOrigin };
  } catch {
    return { route: { kind: 'unconfigured', errorCode: 'INVITATION_EMAIL_UNCONFIGURED' }, preflightFailed: true, publicOrigin };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function insertAttempt(database: SqlConnection, row: InvitationRow, input: {
  attemptId: string; actorUserId: string; tokenHash: string; now: number; previous: AttemptRow | undefined;
}) {
  await database.run(`
    INSERT INTO team_membership_invitation_email_attempts
      (id, organization_id, invitation_id, attempt_number, token_hash, actor_user_id,
       status, delivery_unknown, lease_until, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'sending', 0, $7, $8, $8)
  `, [input.attemptId, row.organization_id, row.id, Number(input.previous?.attempt_number ?? 0) + 1,
    input.tokenHash, input.actorUserId, input.now + SEND_LEASE_MS, input.now]);
}

async function latestAttempt(database: SqlConnection, row: InvitationRow): Promise<AttemptRow | undefined> {
  return await database.get(`
    SELECT * FROM team_membership_invitation_email_attempts
    WHERE organization_id = $1 AND invitation_id = $2
    ORDER BY attempt_number DESC LIMIT 1
  `, [row.organization_id, row.id]) as AttemptRow | undefined;
}

function assertPending(row: InvitationRow | undefined, now: number): asserts row is InvitationRow {
  if (!row) throw new TeamInvitationEmailError('INVITATION_NOT_FOUND', 'Invitation not found.', 404);
  if (row.status !== 'pending' || row.membership_status !== 'invited') {
    throw new TeamInvitationEmailError('INVITATION_CONFLICT', 'Only a pending invitation can be emailed.');
  }
  if (Number(row.expires_at) <= now) throw new TeamInvitationEmailError('INVITATION_EXPIRED', 'Invitation has expired.', 410);
}

export async function sendCreatedTeamInvitationEmail(input: DeliveryOptions & {
  invitation: TeamMembershipInvitation; token: string; actorUserId: string;
}): Promise<TeamInvitationEmailDelivery> {
  const database = input.database ?? await openDb();
  const now = input.now ?? Date.now();
  try {
    const attemptId = randomUUID();
    const claimed = await transaction(database, async () => {
      const row = await database.get(`${INVITATION_SQL} FOR UPDATE OF invitation`,
        [input.invitation.organizationId, input.invitation.id]) as InvitationRow | undefined;
      assertPending(row, now);
      if (row.token_hash !== tokenHash(input.token)) {
        throw new TeamInvitationEmailError('INVITATION_CONFLICT', 'Invitation changed before email delivery.');
      }
      const previous = await latestAttempt(database, row);
      if (previous && (previous.token_hash === row.token_hash || previous.status === 'sending'
        || Number(previous.delivery_unknown) || Number(previous.created_at) + RESEND_COOLDOWN_MS > now)) {
        return { row, replayed: true };
      }
      await insertAttempt(database, row, { attemptId, actorUserId: input.actorUserId, tokenHash: row.token_hash, now, previous });
      return { row, replayed: false };
    });
    if (claimed.replayed) return readDelivery(database, input.invitation.organizationId, input.invitation.id, now);
    const prepared = await prepareDelivery(input);
    return await performDelivery({ ...input, ...prepared, database, invitation: claimed.row, attemptId });
  } finally {
    if (!input.database) await database.close();
  }
}

export async function resendTeamInvitationEmail(input: DeliveryOptions & {
  organizationId: string; invitationId: string; actorUserId: string; requestId: string;
  confirmDeliveryUnknown?: boolean;
}): Promise<{ invitation: TeamMembershipInvitation; token: string | null; emailDelivery: TeamInvitationEmailDelivery; replayed: boolean }> {
  if (!UUID_PATTERN.test(input.requestId)) throw new TeamInvitationEmailError('INVITATION_INVALID', 'A UUID resend request ID is required.', 400);
  const database = input.database ?? await openDb();
  const now = input.now ?? Date.now();
  try {
    const token = randomBytes(32).toString('base64url');
    const claimed = await transaction(database, async () => {
      const row = await database.get(`${INVITATION_SQL} FOR UPDATE OF invitation`,
        [input.organizationId, input.invitationId]) as InvitationRow | undefined;
      if (!row) throw new TeamInvitationEmailError('INVITATION_NOT_FOUND', 'Invitation not found.', 404);
      const replay = await database.get(`
        SELECT id FROM team_membership_invitation_email_attempts
        WHERE id = $1 AND organization_id = $2 AND invitation_id = $3
      `, [input.requestId, input.organizationId, input.invitationId]);
      if (replay) return { row, replayed: true };
      assertPending(row, now);
      const previous = await latestAttempt(database, row);
      if (previous?.status === 'sending' && Number(previous.lease_until) > now) {
        throw new TeamInvitationEmailError('INVITATION_EMAIL_SENDING', 'An invitation email is already being sent.', 409,
          Math.ceil((Number(previous.lease_until) - now) / 1000));
      }
      const unknown = previous && (Number(previous.delivery_unknown) || previous.status === 'sending');
      if (unknown && !input.confirmDeliveryUnknown) {
        throw new TeamInvitationEmailError('INVITATION_EMAIL_UNKNOWN_CONFIRMATION_REQUIRED',
          'The previous delivery is unknown. Confirm before sending another invitation email.');
      }
      const cooldownUntil = previous ? Number(previous.created_at) + RESEND_COOLDOWN_MS : 0;
      if (cooldownUntil > now) {
        throw new TeamInvitationEmailError('INVITATION_EMAIL_COOLDOWN', 'Wait before resending this invitation.', 409,
          Math.ceil((cooldownUntil - now) / 1000));
      }
      if (previous?.status === 'sending') {
        await database.run(`
          UPDATE team_membership_invitation_email_attempts
          SET status = 'failed', error_code = 'INVITATION_EMAIL_DELIVERY_UNKNOWN', delivery_unknown = 1,
            lease_until = NULL, updated_at = $1 WHERE id = $2 AND status = 'sending'
        `, [now, previous.id]);
      }
      const nextHash = tokenHash(token);
      const rotated = await database.run(`
        UPDATE team_membership_invitations SET token_hash = $1, updated_at = $2
        WHERE organization_id = $3 AND id = $4 AND token_hash = $5 AND status = 'pending' AND expires_at > $2
      `, [nextHash, now, input.organizationId, input.invitationId, row.token_hash]);
      if (!rotated || typeof rotated !== 'object' || !('changes' in rotated) || Number(rotated.changes) !== 1) {
        throw new TeamInvitationEmailError('INVITATION_CONFLICT', 'Invitation changed before resending.');
      }
      await insertAttempt(database, row, { attemptId: input.requestId, actorUserId: input.actorUserId, tokenHash: nextHash, now, previous });
      return { row: { ...row, token_hash: nextHash, updated_at: now }, replayed: false };
    });
    if (claimed.replayed) return {
      invitation: invitationFromRow(claimed.row), token: null,
      emailDelivery: await readDelivery(database, input.organizationId, input.invitationId, now), replayed: true,
    };
    const prepared = await prepareDelivery(input);
    return {
      invitation: invitationFromRow(claimed.row), token,
      emailDelivery: await performDelivery({ ...input, ...prepared, database, invitation: claimed.row, attemptId: input.requestId, token }),
      replayed: false,
    };
  } finally {
    if (!input.database) await database.close();
  }
}
