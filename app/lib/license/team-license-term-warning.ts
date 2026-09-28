import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { enqueueTeamLicenseEmail, type TeamLicenseEmailKind } from './team-license-email-outbox';

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
  database: Pick<SqlConnection, 'get' | 'run'>;
  instanceId: string;
  organizationId: string;
  grantId: string;
  termEndsAt: string;
  seatLimit: number;
  now?: number;
}): Promise<{ stage: TermWarningStage | null; created: boolean }> {
  const now = input.now ?? Date.now();
  const stage = termWarningStage(input.termEndsAt, now);
  if (!stage) return { stage: null, created: false };
  const owner = await input.database.get(`
    SELECT owner_user_id FROM canvas_organization_settings WHERE organization_id = $1
  `, [input.organizationId]) as { owner_user_id: string | null } | undefined;
  if (!owner?.owner_user_id) return { stage, created: false };
  const eventId = `license-term:${createHash('sha256').update(JSON.stringify([
    input.instanceId, input.organizationId, input.grantId, input.termEndsAt, stage,
  ])).digest('hex')}`;
  await input.database.run('BEGIN');
  try {
    const inserted = await input.database.get(`
      INSERT INTO audit_events
        (id, organization_id, user_id, source, event_type, entity_type, entity_id,
         action, status, summary, metadata_json, created_at)
      VALUES ($1, $2, $3, 'license', 'license_term_warning', 'organization', $2,
        $4, 'success', $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `, [
      eventId, input.organizationId, owner.owner_user_id, `team.grant_expiring_${stage}d`,
      `Manual Team grant ends in at most ${stage} day${stage === 1 ? '' : 's'}.`,
      JSON.stringify({ instanceId: input.instanceId, grantId: input.grantId,
        termEndsAt: input.termEndsAt, stage, seatLimit: input.seatLimit }), now,
    ]) as { id: string } | undefined;
    if (inserted) {
      await enqueueTeamLicenseEmail(input.database, {
        auditEventId: eventId,
        organizationId: input.organizationId,
        userId: owner.owner_user_id,
        kind: `owner_term_${stage}d` as TeamLicenseEmailKind,
        reason: input.termEndsAt,
        seatLimit: input.seatLimit,
        now,
      });
    }
    await input.database.run('COMMIT');
    return { stage, created: Boolean(inserted) };
  } catch (error) {
    try {
      await input.database.run('ROLLBACK');
    } catch {}
    throw error;
  }
}
