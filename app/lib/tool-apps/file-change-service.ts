import 'server-only';

import type { FileChangeGroupV1 } from '@/app/lib/file-version-center/contracts/v1';
import type { ProposalEntryPointV1 } from '@/app/lib/file-version-center/contracts/proposal-entrypoint-v1';
import { readProposalEntryPoint, type ProposalEntryPointReadInput } from '@/app/lib/file-version-center/proposal-entrypoint-service';
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
  proposal_id: string | null;
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
  review?: Pick<ProposalEntryPointReadInput, 'access' | 'workspace'> & {
    readEntryPoint?: typeof readProposalEntryPoint;
  },
): Promise<FileChangeAppData> {
  const rows = await database.transaction((transaction) => transaction.query<CurrentEntryRow>(`
    SELECT entry.entry_id,
      operation.status AS operation_status,
      proposal.proposal_id,
      latest_revision.id AS latest_revision_id,
      latest_content.source AS latest_revision_source
    FROM file_change_group_entries entry
    LEFT JOIN collaboration_agent_operations operation
      ON operation.operation_id = entry.operation_id
      AND operation.workspace_id = entry.workspace_id
    LEFT JOIN file_change_proposals proposal ON proposal.operation_id=operation.operation_id
    LEFT JOIN LATERAL (
      SELECT revision.id
      FROM file_revisions revision
      WHERE revision.workspace_id = entry.workspace_id
        AND revision.lineage_id = entry.lineage_id
        AND revision.history_only = false
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
  const annotations = new Map<string, ProposalEntryPointV1>();
  for (const entry of group.entries) {
    if (!currentById.get(entry.id)?.proposal_id || !entry.operationId || !entry.lineageId || !review) continue;
    try {
      const annotation = await (review.readEntryPoint ?? readProposalEntryPoint)({
        workspace: review.workspace, access: review.access, lineageId: entry.lineageId, operationId: entry.operationId,
      }, { database });
      if (annotation) annotations.set(entry.id, annotation);
    } catch {
      // A revoked permission or changed proof must not become a stale active
      // review prompt. The exact historical reference remains unchanged.
    }
  }
  const entries = group.entries.map((entry) => {
    const proposal = annotations.get(entry.id);
    let state = currentState(entry, currentById.get(entry.id));
    if (currentById.get(entry.id)?.proposal_id) {
      state = !proposal ? 'unavailable' : proposal.lifecycle !== 'open' ? proposal.lifecycle
        : ['blocked_by_parent', 'prerequisite_lost'].includes(proposal.status) ? 'blocked_by_parent'
          : proposal.status === 'conflicted' ? 'conflict'
            : ['clean', 'clean_rebased', 'empty_effect', 'satisfied_elsewhere'].includes(proposal.status)
              ? 'review_required' : 'unavailable';
    }
    return {
      id: entry.id,
      ordinal: entry.ordinal,
      pathHint: entry.pathHint,
      state,
      operationId: entry.operationId ?? null,
      revisionId: entry.revisionId ?? null,
      additions: entry.additions ?? null,
      deletions: entry.deletions ?? null,
      ...(proposal ? { proposal } : {}),
    };
  });
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
