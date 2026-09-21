import {
  type ProposalGraphSnapshotV1,
  type ProposalNodeV1,
} from './contracts/proposal-graph-v1';
import {
  parseProposalReviewProjectionPageV1,
  type ProposalReviewActionabilityV1,
  type ProposalReviewDiagnosisV1,
  type ProposalReviewProjectionPageV1,
  type ProposalReviewProposalV1,
} from './contracts/proposal-review-projection-v1';

type Permission = {
  canRead: boolean;
  canWrite: boolean;
  canManage: boolean;
  ownedProposalIds?: readonly string[];
  readableProposalIds?: readonly string[];
};

export type ProposalReviewProjectionRequest = {
  graph: ProposalGraphSnapshotV1;
  permission: Permission;
  selectedProposalIds?: readonly string[];
  cursor?: string | null;
  limit?: number;
  rootProposalId?: string;
  now?: number;
  correlationId?: string;
  buildMarker?: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const encodeCursor = (revision: number, offset: number, root: string) => Buffer.from(JSON.stringify({ revision, offset, root }), 'utf8').toString('base64url');
function decodeCursor(value: string): { revision: number; offset: number; root: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<{ revision: number; offset: number; root: string }>;
    if (!Number.isSafeInteger(parsed.revision) || !Number.isSafeInteger(parsed.offset) || (parsed.offset ?? -1) < 0 || typeof parsed.root !== 'string' || !ID.test(parsed.root)) return null;
    return { revision: parsed.revision!, offset: parsed.offset!, root: parsed.root };
  } catch { return null; }
}

function diagnosis(available: boolean, reasonCode: ProposalReviewDiagnosisV1 extends { reasonCode: infer R } ? R : never, now: number, correlationId: string, buildMarker: string): ProposalReviewDiagnosisV1 {
  return available ? { availability: 'available', reasonCode: null, timestamp: now, correlationId, buildMarker } : { availability: 'unavailable', reasonCode: reasonCode as never, timestamp: now, correlationId, buildMarker };
}

function actionability(permission: Permission, available: boolean, proposalIds: readonly string[]): ProposalReviewActionabilityV1 {
  const read = permission.canRead && available ? 'available' : 'denied';
  const owned = new Set(permission.ownedProposalIds ?? []);
  const write = permission.canRead && permission.canWrite && proposalIds.length > 0
    && (permission.canManage || proposalIds.every((id) => owned.has(id))) ? 'available' : 'denied';
  const inspect = read;
  const compare = read;
  const accept = write;
  const reject = write;
  const restore = write;
  return { read, write, inspect, compare, accept, reject, restore, continueEditing: read };
}

function rootFor(nodes: Map<string, ProposalNodeV1>, id: string): string {
  const seen = new Set<string>();
  let current = id;
  while (nodes.get(current)?.relationships.dependency) {
    if (seen.has(current)) break;
    seen.add(current);
    current = nodes.get(current)!.relationships.dependency!.proposalId;
  }
  return current;
}

function relation(node: ProposalNodeV1, rootProposalId: string): ProposalReviewProposalV1['relation'] {
  if (node.proposalId === rootProposalId) return 'root';
  if (node.relationships.dependency) return 'dependency';
  if (node.relationships.replacesProposalId) return 'replacement';
  if (node.relationships.choiceGroupId) return 'alternative';
  return 'detached';
}

/**
 * Permission-aware, content-free graph projection. Dependency is the canonical
 * parent relation; replacement/choice are represented as typed relations and
 * do not invent a parent. Detached is the safe fallback for an independent root.
 */
export function projectProposalReviewPage(input: ProposalReviewProjectionRequest): ProposalReviewProjectionPageV1 {
  const now = input.now ?? Date.now();
  const correlationId = input.correlationId ?? `projection-${now}`;
  const buildMarker = input.buildMarker ?? 'fvrc-1005';
  const nodes = new Map(input.graph.nodes.map((node) => [node.proposalId, node]));
  const readable = input.permission.readableProposalIds ? new Set(input.permission.readableProposalIds) : null;
  const authorized = new Set(input.graph.nodes.filter((node) => input.permission.canRead && (!readable || readable.has(node.proposalId))).map((node) => node.proposalId));
  const selected = [...new Set(input.selectedProposalIds ?? [])];
  if (!input.permission.canRead) return makePage(input, [], [], null, null, 0, 'access_denied', now, correlationId, buildMarker, false);
  if (selected.some((id) => !authorized.has(id))) return makePage(input, [], [...authorized].sort(), null, null, 0, 'access_denied', now, correlationId, buildMarker, false);

  const requestedRoot = input.rootProposalId ?? (selected[0] ? rootFor(nodes, selected[0]) : (input.graph.nodes[0] ? rootFor(nodes, input.graph.nodes[0].proposalId) : undefined));
  if (!requestedRoot || !authorized.has(requestedRoot)) return makePage(input, [], [...authorized].sort(), [], null, 0, 'source_invalid', now, correlationId, buildMarker, false);
  if (selected.some((id) => rootFor(nodes, id) !== requestedRoot)) {
    return makePage(input, [], [...authorized].sort(), [], null, 0, 'scope_mismatch', now, correlationId, buildMarker, false);
  }
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && (!cursor || cursor.revision !== input.graph.graphRevision || cursor.root !== requestedRoot)) {
    return makePage(input, [], [...authorized].sort(), selected, null, 0, 'graph_changed', now, correlationId, buildMarker, false);
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 256)) return makePage(input, [], [...authorized].sort(), selected, null, 0, 'limit_exceeded', now, correlationId, buildMarker, false);
  const limit = input.limit ?? 32;
  const ancestors = new Set<string>();
  for (const id of selected) {
    let current = id;
    while (nodes.get(current)?.relationships.dependency) {
      const parent = nodes.get(current)!.relationships.dependency!.proposalId;
      if (!authorized.has(parent)) return makePage(input, [], [...authorized].sort(), selected, null, 0, 'access_denied', now, correlationId, buildMarker, false);
      ancestors.add(parent); current = parent;
    }
  }
  const scopedRoot = input.rootProposalId || (selected[0] ? requestedRoot : null);
  const ordered = [...authorized].map((id) => nodes.get(id)!).filter((node) => node && (!scopedRoot || rootFor(nodes, node.proposalId) === scopedRoot))
    .sort((a, b) => a.createdAt - b.createdAt || a.proposalId.localeCompare(b.proposalId));
  const deep = [...ancestors, ...selected]
    .map((id) => nodes.get(id)!)
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt || a.proposalId.localeCompare(b.proposalId));
  const rest = ordered.filter((node) => !selected.includes(node.proposalId) && !ancestors.has(node.proposalId));
  const all = [...new Map([...deep, ...rest].map((node) => [node.proposalId, node])).values()];
  const offset = cursor?.offset ?? 0;
  const pageNodes = all.slice(offset, offset + limit);
  const items = pageNodes.map((node) => toProjection(node, requestedRoot));
  const nextOffset = offset + pageNodes.length;
  return makePage(input, items, [...authorized].sort(), selected, nextOffset < all.length ? encodeCursor(input.graph.graphRevision, nextOffset, requestedRoot) : null, offset, null, now, correlationId, buildMarker, true, requestedRoot);
}

function toProjection(node: ProposalNodeV1, rootProposalId: string): ProposalReviewProposalV1 {
  return { proposalId: node.proposalId, operationId: node.operationId, rootProposalId, parentProposalId: node.relationships.dependency?.proposalId ?? null, relation: relation(node, rootProposalId), relationships: node.relationships, lifecycle: node.lifecycle, createdAt: node.createdAt, createdByActorId: node.createdByActorId };
}

function makePage(input: ProposalReviewProjectionRequest, items: ProposalReviewProposalV1[], authorizedProposalIds: string[], selectedProposalIds: readonly string[] | null, nextCursor: string | null, offset: number, reasonCode: ProposalReviewDiagnosisV1['reasonCode'], now: number, correlationId: string, buildMarker: string, available: boolean, rootProposalId = 'projection-root'): ProposalReviewProjectionPageV1 {
  const root = rootProposalId;
  const safeSelected = (selectedProposalIds ?? []).filter((id) => authorizedProposalIds.includes(id));
  const visibleIds = new Set(items.map((item) => item.proposalId));
  const visibleAuthorized = authorizedProposalIds.filter((id) => visibleIds.has(id) || safeSelected.includes(id));
  const page = { contractVersion: 1 as const, scope: { scope: input.graph.scope, graphRevision: input.graph.graphRevision, rootProposalId: root }, items, authorizedProposalIds: visibleAuthorized, selectedProposalIds: safeSelected, actionability: actionability(input.permission, available, safeSelected), page: { pageIndex: Math.floor(offset / Math.max(input.limit ?? 32, 1)), pageSize: Math.min(Math.max(input.limit ?? 32, 1), 256), nextCursor, previousCursor: null, cursorRevision: input.graph.graphRevision }, diagnosis: diagnosis(available, reasonCode, now, correlationId, buildMarker) };
  return parseProposalReviewProjectionPageV1(page);
}
