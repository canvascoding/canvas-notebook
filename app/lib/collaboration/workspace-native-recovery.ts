import 'server-only';

import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { withFileCollaborationReadSnapshot } from '../files/collaboration-repository';
import { authoritativeNativeCollaborationSnapshot } from './document-snapshot';
import { loadCollaborationStateOnConnection } from './persistence';
import { NativeDocumentRecoveryError, type NativeRecoveryRecord } from './native-document-recovery';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';

/** Caller retains the lifecycle barrier through both native capture and physical capture/publication. */
export async function readNativeWorkspaceRecoveryRecords(
  connection: SqlConnection,
  workspace: WorkspaceContext,
  path: string,
): Promise<NativeRecoveryRecord[]> {
  const documents = await readWorkspaceDocumentCatalogue(connection, workspace, { paths: [path] });
  const records: NativeRecoveryRecord[] = [];
  for (const document of documents) {
    if (document.authority === 'missing-state') throw new NativeDocumentRecoveryError();
    if (document.authority === 'pristine') continue;
    if (!document.lineage_id) throw new NativeDocumentRecoveryError();
    const lineage = await connection.get(`SELECT id FROM file_collaboration_lineages
      WHERE id=$1 AND workspace_id=$2 AND path=$3 AND organization_id IS NOT DISTINCT FROM $4 AND status='active'`,
    [document.lineage_id, workspace.workspaceId, document.path, workspace.organizationId ?? null]);
    const state = await loadCollaborationStateOnConnection(connection, document.id);
    if (!lineage || !state || state.documentId !== document.id || state.workspaceId !== workspace.workspaceId
      || state.organizationId !== (workspace.organizationId ?? null) || state.path !== document.path
      || state.lifecycleGeneration !== document.lifecycle_generation || state.documentSequence < document.state_version) {
      throw new NativeDocumentRecoveryError();
    }
    // Uses native validation only; stale/missing Markdown projections are safe to capture.
    authoritativeNativeCollaborationSnapshot(state);
    records.push({ lineageId: document.lineage_id, state });
  }
  return records;
}

export function captureNativeWorkspaceRecoveryRecords(workspace: WorkspaceContext, path: string): Promise<NativeRecoveryRecord[]> {
  return withFileCollaborationReadSnapshot(connection => readNativeWorkspaceRecoveryRecords(connection, workspace, path));
}
