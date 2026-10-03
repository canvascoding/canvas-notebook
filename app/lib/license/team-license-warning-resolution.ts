import 'server-only';

import type { SqlConnection } from '@/app/lib/db';

/** Resolve historical warnings only after the current grant/policy was applied. */
export async function resolveObsoleteTeamLicenseInAppWarnings(input: {
  database: Pick<SqlConnection, 'all' | 'run'>;
  organizationId: string;
  instanceId: string;
  grantId: string | null;
  termEndsAt: string | null;
  grace: boolean;
  restricted: boolean;
  now: number;
}): Promise<void> {
  const rows = await input.database.all(`
    SELECT id, user_id, action, metadata_json FROM audit_events
    WHERE organization_id = $1 AND source = 'license'
      AND event_type = 'license_term_warning' AND status = 'success'
      AND created_at <= $2
      AND NOT EXISTS (SELECT 1 FROM audit_events resolution
        WHERE resolution.entity_id = audit_events.id
          AND resolution.organization_id = audit_events.organization_id
          AND resolution.user_id = audit_events.user_id
          AND resolution.source = 'license' AND resolution.status = 'success'
          AND resolution.event_type = 'license_term_warning_resolved')
  `, [input.organizationId, input.now]) as Array<{
    id: string; user_id: string; action: string; metadata_json: string | null;
  }>;
  for (const row of rows) {
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(row.metadata_json || '{}');
      if (!metadata || typeof metadata !== 'object') continue;
    } catch {
      continue;
    }
    if (metadata.instanceId !== input.instanceId || typeof metadata.grantId !== 'string') continue;
    const wasGrace = row.action === 'team.owner_grace' || row.action === 'team.member_grace';
    if (input.grantId !== null && !input.restricted
      && metadata.grantId === input.grantId && metadata.termEndsAt === input.termEndsAt
      && wasGrace === input.grace) continue;
    await input.database.run(`
      INSERT INTO audit_events
        (id, organization_id, user_id, source, event_type, entity_type, entity_id,
          action, status, summary, metadata_json, created_at)
      VALUES ($1, $2, $3, 'license', 'license_term_warning_resolved', 'audit_event', $4,
        'team.grant_warning_resolved', 'success', 'A previous Team grant warning is no longer current.', $5, $6)
      ON CONFLICT (id) DO NOTHING
    `, [
      `license-warning-resolved:${row.id}`, input.organizationId, row.user_id, row.id,
      JSON.stringify({ instanceId: input.instanceId, resolvedEventId: row.id,
        grantId: metadata.grantId, termEndsAt: metadata.termEndsAt,
        currentGrantId: input.grantId, currentTermEndsAt: input.termEndsAt,
        restricted: input.restricted, grace: input.grace }), input.now,
    ]);
  }
}
