import 'server-only';

import type { WorkspaceContext } from '../workspaces/types';
import type { SqlConnection } from '../db';
import { withFileCollaborationReadSnapshot } from '../files/collaboration-repository';
import { copyNativeWorkspaceOperationBackup } from '../files/workspace-operation-backup';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';
import { readNativeWorkspaceRecoveryRecords } from './workspace-native-recovery';
import { NativeDocumentRecoveryError } from './native-document-recovery';

export type NativeCopyInspection = { hasNativeSource: boolean; sourceIsDirectory: boolean;
  targetDocumentPaths: string[]; initializedTargetPaths: string[]; resumeTargetPath: string | null };
export type NativeCopyInspectionInput = { sourceWorkspace: WorkspaceContext; targetWorkspace: WorkspaceContext;
  sourcePath: string; targetDirectory: string; operationId: string; actorUserId?: string; actorSessionId?: string | null };

/** One read transaction inventories native-only names without importing filesystem projections. */
export function inspectNativeWorkspaceCopy(input: NativeCopyInspectionInput,
  openConnection?: () => Promise<SqlConnection>): Promise<NativeCopyInspection> {
  return withFileCollaborationReadSnapshot(async connection => {
    const source = await readNativeWorkspaceRecoveryRecords(connection, input.sourceWorkspace, input.sourcePath);
    const targets = await readWorkspaceDocumentCatalogue(connection, input.targetWorkspace, { paths: [input.targetDirectory] });
    const row = await connection.get(`SELECT version,kind,organization_id,actor_user_id,actor_session_id,scope_paths
      FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
    [input.targetWorkspace.workspaceId, input.operationId]) as { version: number; kind: string; organization_id: string | null;
      actor_user_id: string; actor_session_id: string | null; scope_paths: string[] } | undefined;
    if (row && (row.version !== 1 || row.kind !== 'native_clone' || row.organization_id !== (input.targetWorkspace.organizationId ?? null)
      || row.actor_user_id !== input.actorUserId || row.actor_session_id !== (input.actorSessionId ?? null)
      || !Array.isArray(row.scope_paths) || row.scope_paths.length !== 1 || typeof row.scope_paths[0] !== 'string')) {
      throw new NativeDocumentRecoveryError();
    }
    return { hasNativeSource: source.length > 0 || !!row, sourceIsDirectory: source.length > 0 && !source.some(record => record.state.path === input.sourcePath),
      targetDocumentPaths: targets.map(document => document.path), initializedTargetPaths: targets
        .filter(document => document.authority !== 'pristine').map(document => document.path), resumeTargetPath: row?.scope_paths[0] ?? null };
  }, openConnection);
}

export type WorkspaceNativeCopyDependencies = { inspect: typeof inspectNativeWorkspaceCopy; publish: typeof copyNativeWorkspaceOperationBackup };
export const workspaceNativeCopyDependencies: WorkspaceNativeCopyDependencies = {
  inspect: inspectNativeWorkspaceCopy, publish: copyNativeWorkspaceOperationBackup,
};
