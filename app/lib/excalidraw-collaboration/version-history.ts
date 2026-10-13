import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import {
  appendFileRevision,
  getActiveFileLineage,
  getLatestFileRevisionForLineage,
  withFileCollaborationTransaction,
} from '@/app/lib/files/collaboration-repository';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { createFileVersionContentStore, type FileVersionContentSource } from '@/app/lib/file-version-center/version-content-store';
import { FILE_VERSION_CENTER_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import type { FileVersionCenterDatabase } from '@/app/lib/file-version-center/database';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';

export const MAX_PORTABLE_EXCALIDRAW_BYTES = EXCALIDRAW_PORTABLE_MAX_BYTES;

/** The portable scene budget also applies when decompressing retained versions. */
export function createExcalidrawVersionContentStore(transaction?: SqlConnection, database?: FileVersionCenterDatabase) {
  return createFileVersionContentStore({
    database: transaction ? { transaction: action => action({ query: async <Row>(sql: string, params?: unknown[]) => ({
      rows: await transaction.all(sql, params) as Row[],
    }) }) } : database,
    limits: {
      maxRawVersionBytes: MAX_PORTABLE_EXCALIDRAW_BYTES,
      maxStoredBlobBytes: MAX_PORTABLE_EXCALIDRAW_BYTES + 64 * 1024,
      maxCompressedBytesPerLineage: FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerLineage,
      maxCompressedBytesPerWorkspace: FILE_VERSION_CENTER_LIMITS_V1.maxCompressedBytesPerWorkspace,
      maxVersionsPerLineage: FILE_VERSION_CENTER_LIMITS_V1.maxVersionsPerLineage,
    },
  });
}

/** Scene versions are required durable recovery data, independent of the history UI rollout. */
export async function captureExcalidrawVersion(input: {
  workspace: WorkspaceContext;
  path: string;
  content: Buffer | string;
  source: FileVersionContentSource;
  actorUserId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  sourceSessionId?: string | null;
  revisionId?: string;
  historyOnly?: boolean;
  forceNewRevision?: boolean;
  transaction?: SqlConnection;
}): Promise<{ revisionId: string; lineageId: string; contentHash: string }> {
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const capture = async (transaction: SqlConnection) => {
    const lineage = await getActiveFileLineage(transaction, input.workspace.workspaceId, input.path);
    if (!lineage) throw new Error('The Excalidraw version has no active document lineage.');
    await transaction.get('SELECT id FROM file_collaboration_lineages WHERE id = $1 FOR UPDATE', [lineage.id]);
    let revisionId = input.revisionId;
    const latest = await getLatestFileRevisionForLineage(transaction, lineage.id);
    if (!revisionId && input.historyOnly) {
      const prior = await transaction.get(`SELECT revision.id FROM file_revisions revision
        JOIN file_revision_contents content ON content.revision_id = revision.id
        WHERE revision.lineage_id = $1 AND revision.content_hash = $2
          AND revision.history_only = true AND content.source = $3 LIMIT 1`,
      [lineage.id, contentHash, input.source]) as { id: string } | undefined;
      revisionId = prior?.id;
    }
    if (!revisionId && !input.historyOnly && !input.forceNewRevision
      && latest?.contentHash === contentHash && latest.sizeBytes === content.byteLength) {
      revisionId = latest.id;
    }
    if (!revisionId) {
      const revision = await appendFileRevision(transaction, {
        id: `file-rev-${randomUUID()}`, lineageId: lineage.id, workspace: input.workspace,
        path: input.path, contentHash, sizeBytes: content.byteLength,
        createdByUserId: input.actorUserId ?? null, createdByActorType: input.actorType ?? 'system',
        sourceSessionId: input.sourceSessionId ?? null, baseRevisionId: latest?.id ?? null, nowMs: Date.now(),
      });
      revisionId = revision.id;
      if (input.historyOnly) await transaction.run('UPDATE file_revisions SET history_only = true WHERE id = $1', [revisionId]);
    }
    const store = createExcalidrawVersionContentStore(transaction);
    const binding = await transaction.get(`SELECT content_format, source, state_vector_hash
      FROM file_revision_contents WHERE revision_id = $1`, [revisionId]) as {
      content_format: 'text'; source: FileVersionContentSource; state_vector_hash: string | null;
    } | undefined;
    await store.bindRevisionContent({ revisionId, workspaceId: input.workspace.workspaceId, lineageId: lineage.id,
      content, format: binding?.content_format ?? 'text', source: binding?.source ?? input.source,
      stateVectorHash: binding?.state_vector_hash ?? null });
    return { revisionId, lineageId: lineage.id, contentHash };
  };
  return input.transaction ? capture(input.transaction)
    : withWorkspaceMutationLock(input.workspace.workspaceId, () => withFileCollaborationTransaction(capture));
}
