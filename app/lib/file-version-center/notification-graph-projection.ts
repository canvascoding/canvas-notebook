import 'server-only';

import { createHash } from 'node:crypto';

import { FILE_CHANGE_REVIEW_BRANCH_NOTIFICATION_PREFIX } from './notification-contract';
import type { FileChangeReviewNotificationReason } from './notification-contract';

/** Content-free rows from one current, active collaborative-document scope. */
export type GraphNotificationMetadataRow = {
  graph_id: string;
  workspace_id: string;
  lineage_id: string;
  document_id: string;
  lifecycle_generation: number | string;
  schema_version: number | string;
  proposal_id: string;
  operation_id: string;
  initiated_by_user_id: string;
  lifecycle: string;
  cas_version: number | string;
  dependency_proposal_id: string | null;
  choice_group_id: string | null;
  choice_member_valid: boolean | number | string;
  status: string;
  requested_mode: string;
  created_at: number | string;
  updated_at: number | string;
};

export type GraphNotificationGroup = {
  id: string;
  revision: string;
  workspaceId: string;
  lineageId: string;
  rootProposalId: string;
  rootOperationId: string;
  occurredAt: number;
  reason: FileChangeReviewNotificationReason;
};

const BLOCKING_LIFECYCLES = new Set([
  'rejected', 'superseded', 'alternative_not_selected', 'expired',
]);
const MAX_DEPENDENCY_DEPTH = 16;
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

function safeInteger(value: number | string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function hash(parts: readonly (string | number | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function reasonFor(row: GraphNotificationMetadataRow): FileChangeReviewNotificationReason {
  if (row.status === 'semantic_conflict') return 'semantic_conflict';
  if (row.status === 'partially_applied') return 'partially_applied';
  if (row.status === 'failed' && row.requested_mode === 'direct_apply') return 'direct_apply_failed';
  return 'needs_review';
}

/**
 * A notification is a metadata projection, never an apply authorization or
 * evaluation. Missing/invalid ancestors, blocked parents and foreign owners
 * are excluded instead of guessing at an actionable branch.
 */
export function projectGraphNotificationGroups(input: {
  rows: readonly GraphNotificationMetadataRow[];
  userId: string;
  canManageWorkspace: boolean;
}): GraphNotificationGroup[] {
  const byGraph = new Map<string, Map<string, GraphNotificationMetadataRow>>();
  for (const row of input.rows) {
    if (![row.graph_id, row.workspace_id, row.lineage_id, row.document_id,
      row.proposal_id, row.operation_id, row.initiated_by_user_id].every(validId)
      || safeInteger(row.lifecycle_generation) === null || safeInteger(row.schema_version) === null
      || safeInteger(row.cas_version) === null || safeInteger(row.created_at) === null
      || safeInteger(row.updated_at) === null
      || ![true, 1, '1', 'true'].includes(row.choice_member_valid)) continue;
    const nodes = byGraph.get(row.graph_id) ?? new Map<string, GraphNotificationMetadataRow>();
    nodes.set(row.proposal_id, row);
    byGraph.set(row.graph_id, nodes);
  }

  type Member = { row: GraphNotificationMetadataRow; root: GraphNotificationMetadataRow };
  const buckets = new Map<string, { members: Member[]; workspaceId: string; lineageId: string;
    generation: number; schemaVersion: number }>();
  for (const nodes of byGraph.values()) {
    // Resolve each authorized historical alternative anchor once per graph.
    // The key keeps the same exact scope comparison as the per-row search.
    const anchorKey = (row: GraphNotificationMetadataRow): string => JSON.stringify([
      row.choice_group_id, row.workspace_id, row.lineage_id, row.document_id,
      row.lifecycle_generation, row.schema_version,
    ]);
    const choiceAnchors = new Map<string, GraphNotificationMetadataRow>();
    for (const candidate of nodes.values()) {
      if (!candidate.choice_group_id || candidate.dependency_proposal_id !== null
        || (!input.canManageWorkspace && candidate.initiated_by_user_id !== input.userId)) continue;
      const key = anchorKey(candidate);
      const previous = choiceAnchors.get(key);
      if (!previous || Number(candidate.created_at) < Number(previous.created_at)
        || (Number(candidate.created_at) === Number(previous.created_at)
          && candidate.proposal_id.localeCompare(previous.proposal_id) < 0)) {
        choiceAnchors.set(key, candidate);
      }
    }
    for (const row of nodes.values()) {
      if (row.lifecycle !== 'open') continue;
      const seen = new Set<string>();
      let cursor: GraphNotificationMetadataRow | undefined = row;
      let blocked = false;
      let depth = 0;
      while (cursor) {
        if (seen.has(cursor.proposal_id) || depth > MAX_DEPENDENCY_DEPTH
          || (!input.canManageWorkspace && cursor.initiated_by_user_id !== input.userId)
          || BLOCKING_LIFECYCLES.has(cursor.lifecycle)
          || cursor.workspace_id !== row.workspace_id || cursor.lineage_id !== row.lineage_id
          || cursor.document_id !== row.document_id
          || cursor.lifecycle_generation !== row.lifecycle_generation
          || cursor.schema_version !== row.schema_version) {
          blocked = true;
          break;
        }
        seen.add(cursor.proposal_id);
        if (!cursor.dependency_proposal_id) break;
        cursor = nodes.get(cursor.dependency_proposal_id);
        depth += 1;
        if (!cursor) blocked = true;
      }
      if (blocked || !cursor) continue;
      const root = cursor;
      // Choice members without a dependency are separate structural roots,
      // but they are one explicit alternative-review task. Pin its reference
      // to the oldest *authorized historical* member, not the newest open
      // one, so closing an alternative cannot silently retarget the link.
      const anchor = root.choice_group_id ? choiceAnchors.get(anchorKey(root)) ?? root : root;
      const groupKey = root.choice_group_id ? `choice:${root.choice_group_id}` : `root:${root.proposal_id}`;
      const generation = safeInteger(row.lifecycle_generation)!;
      const schemaVersion = safeInteger(row.schema_version)!;
      const key = hash([row.workspace_id, row.lineage_id, row.document_id,
        generation, schemaVersion, groupKey]);
      const bucket = buckets.get(key) ?? { members: [], workspaceId: row.workspace_id,
        lineageId: row.lineage_id, generation, schemaVersion };
      bucket.members.push({ row, root: anchor });
      buckets.set(key, bucket);
    }
  }

  const groups: GraphNotificationGroup[] = [];
  for (const [key, bucket] of buckets) {
    // A historical exact reference is the oldest authorized root. New leaves
    // cannot silently retarget a group to the newest proposal.
    const roots = [...new Map(bucket.members.map((member) => [member.root.proposal_id, member.root])).values()]
      .sort((a, b) => Number(a.created_at) - Number(b.created_at) || a.proposal_id.localeCompare(b.proposal_id));
    const root = roots[0]!;
    const members = bucket.members.map(({ row }) => row)
      .sort((a, b) => a.proposal_id.localeCompare(b.proposal_id));
    const revision = hash(members.map((row) => [row.proposal_id, row.operation_id,
      row.cas_version, row.lifecycle, row.dependency_proposal_id, row.choice_group_id] as const).flat());
    const occurredAt = Math.max(...members.map((row) => Number(row.updated_at)));
    const reason = members.map(reasonFor).find((value) => value !== 'needs_review') ?? 'needs_review';
    groups.push({ id: `${FILE_CHANGE_REVIEW_BRANCH_NOTIFICATION_PREFIX}${key}`,
      revision, workspaceId: bucket.workspaceId, lineageId: bucket.lineageId,
      rootProposalId: root.proposal_id, rootOperationId: root.operation_id,
      occurredAt, reason });
  }
  return groups.sort((a, b) => b.occurredAt - a.occurredAt || b.id.localeCompare(a.id));
}
