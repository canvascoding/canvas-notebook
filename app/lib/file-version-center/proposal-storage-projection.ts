import 'server-only';

import type { FileVersionCenterTransaction } from './database';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_GRAPH_LIMITS as Limits,
  ProposalGraphContractError,
  parseProposalNodeV1,
  type ProposalChoiceGroupV1,
  type ProposalDocumentScopeV1,
  type ProposalGraphSnapshotV1,
  type ProposalLifecycleV1,
  type ProposalNodeV1,
} from './contracts/proposal-graph-v1';

export type StoredProposalGraphProjection = ProposalGraphSnapshotV1 & {
  archivedReplacementProposalIds: string[];
  choiceGroups: Array<ProposalChoiceGroupV1 & { archivedMemberCount: number }>;
};

type NodeMetadata = {
  proposal_id: string;
  lifecycle: ProposalLifecycleV1;
  dependency_proposal_id: string | null;
  replaces_proposal_id: string | null;
  choice_group_id: string | null;
  node_bytes: number | string;
};
type GroupRow = {
  group_id: string;
  group_revision: number | string;
  dependency_proposal_id: string | null;
  chosen_proposal_id: string | null;
  member_count: number | string;
  invalid_members: number | string;
};
type NodeRow = NodeMetadata & { node_json: ProposalNodeV1 | string; cas_version: number | string };

const metadataColumns = `proposal_id,lifecycle,dependency_proposal_id,replaces_proposal_id,choice_group_id,
  octet_length(node_json::text) AS node_bytes`;

function fail(code: typeof Codes[keyof typeof Codes], message: string): never {
  throw new ProposalGraphContractError(code, message);
}

/**
 * Bounded active context, not an audit export. Call inside the graph's locked
 * transaction and validate the resulting snapshot before domain evaluation.
 * Historical nodes remain accessible by exact ID through the storage audit API.
 * Metadata is bounded before reading any node JSON; omitted terminal replacement
 * references and membership counts are established from authoritative SQL rows.
 */
export async function loadStoredProposalGraph(
  db: FileVersionCenterTransaction,
  graphId: string,
  scope: ProposalDocumentScopeV1,
  graphRevision: number,
  options: { includeProposalIds?: readonly string[] } = {},
): Promise<StoredProposalGraphProjection> {
  const selected = new Set(options.includeProposalIds ?? []);
  if (selected.size > Limits.nodesPerSnapshot || [...selected].some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
    fail(Codes.limitExceeded, 'Requested proposal context exceeds its identity bounds.');
  }
  const identity = (await db.query<{ graph_revision: number | string }>(`SELECT graph_revision
    FROM file_proposal_graphs WHERE graph_id=$1 AND workspace_id=$2 AND lineage_id=$3 AND document_id=$4
      AND lifecycle_generation=$5 AND schema_version=$6 LIMIT 1`,
  [graphId, scope.workspaceId, scope.lineageId, scope.documentId, scope.lifecycleGeneration, scope.schemaVersion])).rows[0];
  if (!identity) fail(Codes.scopeMismatch, 'Proposal graph belongs to another document scope.');
  if (Number(identity.graph_revision) !== graphRevision) fail(Codes.graphChanged, 'Proposal graph revision changed.');

  const nodes = new Map<string, NodeMetadata>();
  const groups = new Map<string, GroupRow>();
  let nodeBytes = 0;
  const addNodes = (rows: NodeMetadata[]) => {
    for (const row of rows) {
      if (nodes.has(row.proposal_id)) continue;
      const bytes = Number(row.node_bytes);
      if (nodes.size === Limits.nodesPerSnapshot || !Number.isSafeInteger(bytes) || bytes < 0
        || nodeBytes + bytes > Limits.payloadBytes) {
        fail(Codes.limitExceeded, 'Active proposal context exceeds its node or payload limit.');
      }
      nodes.set(row.proposal_id, row);
      nodeBytes += bytes;
    }
  };
  addNodes((await db.query<NodeMetadata>(`SELECT ${metadataColumns} FROM file_change_proposals
    WHERE graph_id=$1 AND (lifecycle='open' OR proposal_id=ANY($2::text[]))
    ORDER BY created_at,proposal_id LIMIT $3`, [graphId, [...selected], Limits.nodesPerSnapshot + 1])).rows);
  if ([...selected].some((id) => !nodes.has(id))) fail(Codes.sourceInvalid, 'Selected proposal is unavailable in this graph.');

  for (;;) {
    const wantedGroups = [...new Set([...nodes.values()].flatMap((node) => node.choice_group_id ? [node.choice_group_id] : []))]
      .filter((id) => !groups.has(id));
    if (groups.size + wantedGroups.length > Limits.choiceGroups) fail(Codes.limitExceeded, 'Too many choice groups in proposal context.');
    if (wantedGroups.length) {
      const found = (await db.query<GroupRow>(`SELECT g.group_id,g.group_revision,g.dependency_proposal_id,g.chosen_proposal_id,
        (SELECT COUNT(*) FROM file_proposal_choice_memberships m WHERE m.graph_id=g.graph_id AND m.group_id=g.group_id) AS member_count,
        (SELECT COUNT(*) FROM file_proposal_choice_memberships m LEFT JOIN file_change_proposals n
          ON n.graph_id=m.graph_id AND n.proposal_id=m.proposal_id
          WHERE m.graph_id=g.graph_id AND m.group_id=g.group_id AND
            (n.proposal_id IS NULL OR n.choice_group_id IS DISTINCT FROM g.group_id
              OR n.dependency_proposal_id IS DISTINCT FROM g.dependency_proposal_id)) AS invalid_members
        FROM file_proposal_choice_groups g WHERE g.graph_id=$1 AND g.group_id=ANY($2::text[])
        ORDER BY g.group_id LIMIT $3`, [graphId, wantedGroups, Limits.choiceGroups - groups.size + 1])).rows;
      for (const group of found) {
        if (Number(group.invalid_members) !== 0 || Number(group.member_count) < 2) {
          fail(Codes.choiceConflict, 'Stored alternative membership is incomplete or inconsistent.');
        }
        groups.set(group.group_id, group);
      }
      if (wantedGroups.some((id) => !groups.has(id))) fail(Codes.choiceConflict, 'Proposal choice group is unavailable.');
    }
    const wanted = new Set<string>();
    for (const node of nodes.values()) {
      if (node.dependency_proposal_id) wanted.add(node.dependency_proposal_id);
      // Show the immediate predecessor of a live replacement or explicit audit
      // selection; do not traverse its entire historical replacement chain.
      if ((node.lifecycle === 'open' || selected.has(node.proposal_id)) && node.replaces_proposal_id) wanted.add(node.replaces_proposal_id);
    }
    for (const group of groups.values()) {
      if (group.chosen_proposal_id) wanted.add(group.chosen_proposal_id);
    }
    const missing = [...wanted].filter((id) => !nodes.has(id));
    if (!missing.length) break;
    if (nodes.size + missing.length > Limits.nodesPerSnapshot) fail(Codes.limitExceeded, 'Proposal closure exceeds its node limit.');
    addNodes((await db.query<NodeMetadata>(`SELECT ${metadataColumns} FROM file_change_proposals
      WHERE graph_id=$1 AND proposal_id=ANY($2::text[]) ORDER BY created_at,proposal_id LIMIT $3`,
    [graphId, missing, Limits.nodesPerSnapshot - nodes.size + 1])).rows);
    if (missing.some((id) => !nodes.has(id))) fail(Codes.sourceInvalid, 'Required proposal context is unavailable.');
  }

  const omittedReplacementIds = [...new Set([...nodes.values()].flatMap((node) =>
    node.replaces_proposal_id && !nodes.has(node.replaces_proposal_id) ? [node.replaces_proposal_id] : []))].sort();
  if (omittedReplacementIds.length) {
    const archived = new Map((await db.query<NodeMetadata>(`SELECT ${metadataColumns} FROM file_change_proposals
      WHERE graph_id=$1 AND proposal_id=ANY($2::text[]) ORDER BY proposal_id LIMIT $3`,
    [graphId, omittedReplacementIds, Limits.nodesPerSnapshot + 1])).rows.map((node) => [node.proposal_id, node]));
    for (const node of nodes.values()) {
      if (!node.replaces_proposal_id || nodes.has(node.replaces_proposal_id)) continue;
      const replaced = archived.get(node.replaces_proposal_id);
      if (node.lifecycle === 'open' || !replaced || replaced.lifecycle === 'open'
        || replaced.dependency_proposal_id !== node.dependency_proposal_id || replaced.choice_group_id !== node.choice_group_id) {
        fail(Codes.sourceInvalid, 'Archived replacement reference is absent, active or outside its original relationship scope.');
      }
    }
  }

  const ids = [...nodes.keys()];
  const memberships = (await db.query<{ group_id: string; proposal_id: string }>(`SELECT group_id,proposal_id
    FROM file_proposal_choice_memberships WHERE graph_id=$1 AND proposal_id=ANY($2::text[])
    ORDER BY group_id,proposal_id LIMIT $3`, [graphId, ids, Limits.nodesPerSnapshot + 1])).rows;
  if (memberships.length > Limits.nodesPerSnapshot) fail(Codes.limitExceeded, 'Proposal choice membership exceeds its limit.');
  const memberByProposal = new Map<string, string>();
  for (const member of memberships) {
    if (memberByProposal.has(member.proposal_id)) fail(Codes.choiceConflict, 'Proposal belongs to multiple choice groups.');
    memberByProposal.set(member.proposal_id, member.group_id);
  }
  for (const node of nodes.values()) {
    if ((memberByProposal.get(node.proposal_id) ?? null) !== node.choice_group_id) fail(Codes.choiceConflict, 'Proposal choice membership is missing or inconsistent.');
  }
  const choiceGroups = [...groups.values()].map((group) => {
    const memberProposalIds = memberships.filter((member) => member.group_id === group.group_id).map((member) => member.proposal_id);
    const archivedMemberCount = Number(group.member_count) - memberProposalIds.length;
    if (archivedMemberCount < 0 || (group.chosen_proposal_id && !memberProposalIds.includes(group.chosen_proposal_id))) {
      fail(Codes.choiceConflict, 'Selected alternative is not in the visible authorized context.');
    }
    return { groupId: group.group_id, groupRevision: Number(group.group_revision), dependencyProposalId: group.dependency_proposal_id,
      chosenProposalId: group.chosen_proposal_id, memberProposalIds, archivedMemberCount };
  });
  const hydrated = (await db.query<NodeRow>(`SELECT ${metadataColumns},node_json,cas_version FROM file_change_proposals
    WHERE graph_id=$1 AND proposal_id=ANY($2::text[]) ORDER BY created_at,proposal_id LIMIT $3`,
  [graphId, ids, Limits.nodesPerSnapshot + 1])).rows;
  if (hydrated.length !== nodes.size) fail(Codes.graphChanged, 'Proposal context changed during its locked read.');
  const projectedNodes = hydrated.map((row) => {
    const authored = typeof row.node_json === 'string' ? JSON.parse(row.node_json) as ProposalNodeV1 : row.node_json;
    return parseProposalNodeV1({ ...authored, lifecycle: row.lifecycle, casVersion: Number(row.cas_version),
      relationships: { ...authored.relationships, choiceGroupId: row.choice_group_id } });
  });
  return { contractVersion: 1, scope, graphRevision, nodes: projectedNodes, choiceGroups,
    archivedReplacementProposalIds: omittedReplacementIds };
}
