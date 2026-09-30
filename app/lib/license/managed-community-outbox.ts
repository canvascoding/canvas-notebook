import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import { getDeploymentMode } from '@/app/lib/organization/config';

export async function retireManagedCommunitySnapshotOperations(
  database: Pick<SqlConnection, 'get'>,
  input: {
    organizationId: string;
    adoptionApproved: boolean;
    acknowledgedAt: number | null;
    now?: number;
  },
): Promise<number> {
  const now = input.now ?? Date.now();
  if (getDeploymentMode() !== 'managed-team' || !input.adoptionApproved
    || !Number.isSafeInteger(input.acknowledgedAt) || input.acknowledgedAt! <= 0
    || input.acknowledgedAt! > now || !input.organizationId.trim()) return 0;
  const result = await database.get(`
    WITH retired AS (
      UPDATE team_seat_outbox
      SET status = 'canceled', completed_at = $1, updated_at = $1,
        next_attempt_at = NULL
      WHERE organization_id = $2
        AND operation_kind IN ('membership_snapshot', 'license_refresh')
        AND status IN ('pending', 'retry_wait')
        AND created_at <= $3
      RETURNING operation_id, operation_kind
    ), audited AS (
      INSERT INTO audit_events (
        id, organization_id, user_id, source, event_type, entity_type,
        entity_id, action, status, summary, metadata_json, created_at
      )
      SELECT 'managed-community-retired-' || operation_id, $2, NULL, 'license',
        'managed_community_outbox_retirement', 'team_seat_outbox', operation_id,
        'team.managed_retire_community_operation', 'completed',
        'An obsolete Community synchronization operation was retired after Managed Team acknowledgement.',
        json_build_object('operationKind', operation_kind, 'acknowledgedAt', $3::bigint)::text, $1
      FROM retired
      ON CONFLICT(id) DO NOTHING
      RETURNING id
    )
    SELECT COUNT(*)::int AS retired_count FROM retired
  `, [now, input.organizationId, input.acknowledgedAt]) as { retired_count: number } | undefined;
  return Number(result?.retired_count ?? 0);
}
