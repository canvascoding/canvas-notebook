import 'server-only';

import { openDb } from '@/app/lib/db';

import {
  inspectAutomationIntegrity,
  type AutomationIntegrityReport,
  type AutomationIntegrityRow,
} from './integrity-model';

export * from './integrity-model';

/** Reads current automation data only. Callers decide whether to quarantine. */
export async function getAutomationIntegrityReport(): Promise<AutomationIntegrityReport> {
  const connection = await openDb();
  try {
    const rows = await connection.all(`
      SELECT
        j.id,
        j.scope,
        j.organization_id AS "organizationId",
        j.workspace_id AS "workspaceId",
        j.workspace_type AS "workspaceType",
        j.owner_user_id AS "ownerUserId",
        j.responsible_user_id AS "responsibleUserId",
        j.service_actor_id AS "serviceActorId",
        j.approved_by_user_id AS "approvedByUserId",
        w.id AS "workspaceFound",
        w.type AS "actualWorkspaceType",
        w.organization_id AS "actualWorkspaceOrganizationId"
      FROM automation_jobs j
      LEFT JOIN canvas_workspaces w ON w.id = j.workspace_id
      ORDER BY j.created_at ASC, j.id ASC
    `) as AutomationIntegrityRow[];
    return inspectAutomationIntegrity(rows);
  } finally {
    await connection.close();
  }
}
