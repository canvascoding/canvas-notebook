import 'server-only';

import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { readWorkspaceSceneCatalogue } from '../collaboration/workspace-scene-catalogue';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { WorkspaceOperationManagedCopyPlanV6Error } from './workspace-operation-managed-copy-plan-v6';

/** Current facts only on the caller's genuine B/principal phase. Scenes are a
 * distinct provider cohort and are never partitioned into a fake E5 snapshot. */
export async function readWorkspaceHtmlCopyObservationOnConnection(database: SqlConnection, workspace: WorkspaceContext) {
  if ((await readWorkspaceSceneCatalogue(database, workspace)).length) throw new WorkspaceOperationManagedCopyPlanV6Error('MANAGED_COPY_PLAN_UNSUPPORTED');
  const observed = await readWorkspaceLinkSourceAuthorityOnConnection(database, workspace, { physicalParserVersion: 3 });
  if ((await readWorkspaceSceneCatalogue(database, workspace)).length) throw new WorkspaceOperationManagedCopyPlanV6Error('MANAGED_COPY_PLAN_CHANGED');
  return observed;
}
