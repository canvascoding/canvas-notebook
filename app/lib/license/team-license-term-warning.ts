import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { enqueueTeamLicenseEmail, supersedeObsoleteTeamLicenseWarnings, type TeamLicenseEmailKind } from './team-license-email-outbox';

export type TermWarningStage = 14 | 3 | 1;

export function termWarningStage(termEndsAt: string, now: number): TermWarningStage | null {
  const term = Date.parse(termEndsAt);
  if (!Number.isFinite(term)) return null;
  const remaining = term - now;
  if (remaining <= 0 || remaining > 14 * 86_400_000) return null;
  if (remaining <= 86_400_000) return 1;
  if (remaining <= 3 * 86_400_000) return 3;
  return 14;
}

export async function recordTeamLicenseTermWarning(input: {
  database: Pick<SqlConnection, 'get' | 'all' | 'run'>;
  instanceId: string;
  organizationId: string;
  grantId: string;
  termEndsAt: string | null;
  graceEndsAt?: string | null;
  restricted?: boolean;
  seatLimit: number;
  now?: number;
}): Promise<{ stage: TermWarningStage | null; created: boolean }> {
  const now = input.now ?? Date.now();
  const graceEndsAt = input.graceEndsAt && Date.parse(input.graceEndsAt) > now
    ? input.graceEndsAt : null;
  const stage = graceEndsAt || input.restricted ? null
    : input.termEndsAt ? termWarningStage(input.termEndsAt, now) : null;
  await supersedeObsoleteTeamLicenseWarnings(input.database, {
    organizationId: input.organizationId, grantId: input.grantId,
    termEndsAt: input.termEndsAt, grace: Boolean(graceEndsAt), restricted: input.restricted === true, now,
  });
  if (!stage && !graceEndsAt) return { stage: null, created: false };
  const owner = await input.database.get(`
    SELECT owner_user_id FROM canvas_organization_settings WHERE organization_id = $1
  `, [input.organizationId]) as { owner_user_id: string | null } | undefined;
  if (!owner?.owner_user_id) return { stage, created: false };
  const members = await input.database.all(`
    SELECT DISTINCT membership.user_id
    FROM team_memberships membership
    WHERE membership.organization_id = $1 AND membership.status = 'active'
      AND membership.role <> 'owner' AND membership.user_id IS NOT NULL
      AND membership.user_id <> $2
  `, [input.organizationId, owner.owner_user_id]) as Array<{ user_id: string }>;
  const recipients = stage
    ? [{ userId: owner.owner_user_id, kind: `owner_term_${stage}d` as TeamLicenseEmailKind },
      ...members.map((member) => ({ userId: member.user_id, kind: `member_term_${stage}d` as TeamLicenseEmailKind }))]
    : members.map((member) => ({ userId: member.user_id, kind: 'member_grace' as TeamLicenseEmailKind }));
  await input.database.run('BEGIN');
  try {
    let created = false;
    for (const recipient of recipients) {
      const eventId = `license-term:${createHash('sha256').update(JSON.stringify([
        input.instanceId, input.organizationId, input.grantId,
        graceEndsAt ?? input.termEndsAt, stage ?? 'grace', recipient.userId,
      ])).digest('hex')}`;
      const action = graceEndsAt ? 'team.member_grace' : `team.grant_expiring_${stage}d`;
      const inserted = await input.database.get(`
        INSERT INTO audit_events
          (id, organization_id, user_id, source, event_type, entity_type, entity_id,
           action, status, summary, metadata_json, created_at)
        VALUES ($1, $2, $3, 'license', 'license_term_warning', 'organization', $2,
          $4, 'success', $5, $6, $7)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [
        eventId, input.organizationId, recipient.userId, action,
        graceEndsAt ? 'Manual Team grant expired; access continues temporarily during grace.'
          : `Manual Team grant ends in at most ${stage} day${stage === 1 ? '' : 's'}.`,
        JSON.stringify({ instanceId: input.instanceId, grantId: input.grantId,
          termEndsAt: input.termEndsAt, graceEndsAt, stage, seatLimit: input.seatLimit }), now,
      ]) as { id: string } | undefined;
      if (!inserted) continue;
      created = true;
      await enqueueTeamLicenseEmail(input.database, {
        auditEventId: eventId,
        organizationId: input.organizationId,
        userId: recipient.userId,
        kind: recipient.kind,
        reason: graceEndsAt ?? input.termEndsAt!,
        seatLimit: input.seatLimit,
        now,
      });
    }
    await input.database.run('COMMIT');
    return { stage, created };
  } catch (error) {
    try {
      await input.database.run('ROLLBACK');
    } catch {}
    throw error;
  }
}
