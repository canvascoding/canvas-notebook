import 'server-only';

import type { FileChangeGroupV1 } from '@/app/lib/file-version-center/contracts/v1';
import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
} from '@/app/lib/file-version-center/database';
import {
  readFileChangeAppData,
  type FileChangeAppData,
  type FileChangeAppEntryState,
} from './file-change-data';

type CurrentEntryRow = {
  entry_id: string;
  operation_status: string | null;
  latest_revision_id: string | null;
  latest_revision_source: string | null;
};

function currentState(
  entry: FileChangeGroupV1['entries'][number],
  current: CurrentEntryRow | undefined,
): FileChangeAppEntryState {
  if (current?.operation_status) {
    if (['needs_review', 'partially_applied'].includes(current.operation_status)) return 'review_required';
    if (current.operation_status === 'semantic_conflict') return 'conflict';
    if (current.operation_status === 'rejected') return 'rejected';
    if (current.operation_status === 'reverted') return 'reverted';
    if (['cancelled', 'expired', 'failed'].includes(current.operation_status)) return 'failed';
    if (['applied_to_ydoc', 'persisted_yjs', 'checkpointed_file'].includes(current.operation_status)) return 'applied';
  }
  if (entry.revisionId && current?.latest_revision_id && current.latest_revision_id !== entry.revisionId) {
    return current.latest_revision_source === 'restore' ? 'restored' : 'superseded';
  }
  return entry.outcome;
}

/** Resolve current operation/revision state; stored chat messages remain references only. */
export async function presentFileChangeAppData(
  group: FileChangeGroupV1,
  database: FileVersionCenterDatabase = createRuntimeFileVersionCenterDatabase(),
): Promise<FileChangeAppData> {
  const rows = await database.transaction((transaction) => transaction.query<CurrentEntryRow>(`
    SELECT entry.entry_id,
      operation.status AS operation_status,
      latest_revision.id AS latest_revision_id,
      latest_content.source AS latest_revision_source
    FROM file_change_group_entries entry
    LEFT JOIN collaboration_agent_operations operation
      ON operation.operation_id = entry.operation_id
      AND operation.workspace_id = entry.workspace_id
    LEFT JOIN LATERAL (
      SELECT revision.id
      FROM file_revisions revision
      WHERE revision.workspace_id = entry.workspace_id
        AND revision.lineage_id = entry.lineage_id
      ORDER BY revision.revision_number DESC, revision.created_at DESC, revision.id DESC
      LIMIT 1
    ) latest_revision ON TRUE
    LEFT JOIN file_revision_contents latest_content
      ON latest_content.revision_id = latest_revision.id
      AND latest_content.workspace_id = entry.workspace_id
      AND latest_content.lineage_id = entry.lineage_id
    WHERE entry.change_group_id = $1 AND entry.workspace_id = $2
    ORDER BY entry.ordinal ASC
  `, [group.id, group.workspaceId]));
  const currentById = new Map(rows.rows.map((row) => [row.entry_id, row]));
  const entries = group.entries.map((entry) => ({
    id: entry.id,
    ordinal: entry.ordinal,
    pathHint: entry.pathHint,
    state: currentState(entry, currentById.get(entry.id)),
    operationId: entry.operationId ?? null,
    revisionId: entry.revisionId ?? null,
    additions: entry.additions ?? null,
    deletions: entry.deletions ?? null,
  }));
  const states = new Set(entries.map((entry) => entry.state));
  const data = readFileChangeAppData({
    contractVersion: 1,
    id: group.id,
    workspaceId: group.workspaceId,
    operation: group.operation,
    status: states.size === 1 ? entries[0]!.state : 'mixed',
    createdAt: group.createdAt,
    entries,
  });
  if (!data) throw new Error('File-change widget data is unavailable.');
  return data;
}
