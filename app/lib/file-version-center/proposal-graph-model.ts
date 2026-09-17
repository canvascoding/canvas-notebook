import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_GRAPH_LIMITS as Limits,
  PROPOSAL_PREREQUISITE_RULES_V1,
  ProposalGraphContractError,
  parseProposalGraphSnapshotV1,
  type ProposalActionFenceV1,
  type ProposalDocumentScopeV1,
  type ProposalGraphErrorCode,
  type ProposalGraphSnapshotV1,
  type ProposalNodeV1,
} from './contracts/proposal-graph-v1';

export type ProposalModelBlocked = {
  status: 'blocked';
  reasonCode: ProposalGraphErrorCode;
  proposalIds: string[];
  choiceGroupIds: string[];
};

export type ProposalGraphValidationResult =
  | { status: 'valid'; graph: ProposalGraphSnapshotV1 }
  | ProposalModelBlocked;

export type ProposalChoiceClosureReady = {
  status: 'ready';
  choiceResolutions: ProposalActionFenceV1['choiceResolutions'];
  closingProposalIds: string[];
  blockedDescendantProposalIds: string[];
};

/** Structural readiness only: these IDs do not prove current effects, rights or durable apply. */
export type ProposalClosureReady = {
  status: 'ready';
  scope: ProposalDocumentScopeV1;
  graphRevision: number;
  selectedProposalIds: string[];
  dependencyProposalIds: string[];
  applyProposalIds: string[];
  prerequisiteProposalIds: string[];
  closureProposalIds: string[];
  choiceResolutions: ProposalActionFenceV1['choiceResolutions'];
  blockedDescendantProposalIds: string[];
};

export type ProposalRejectionReady = {
  status: 'ready';
  scope: ProposalDocumentScopeV1;
  graphRevision: number;
  closureProposalIds: string[];
  rejectedProposalIds: string[];
  blockedDescendantProposalIds: string[];
};

function blocked(
  reasonCode: ProposalGraphErrorCode,
  proposalIds: string[] = [],
  choiceGroupIds: string[] = [],
): ProposalModelBlocked {
  return { status: 'blocked', reasonCode, proposalIds, choiceGroupIds };
}

/** Bound incoming collections before schema serialization and dependency traversal. */
function preflightLimits(value: unknown): ProposalModelBlocked | null {
  if (!value || typeof value !== 'object') return null;
  const graph = value as Partial<ProposalGraphSnapshotV1>;
  if ((Array.isArray(graph.nodes) && graph.nodes.length > Limits.nodesPerSnapshot)
    || (Array.isArray(graph.choiceGroups) && graph.choiceGroups.length > Limits.choiceGroups)
    || (Array.isArray(graph.archivedReplacementProposalIds) && graph.archivedReplacementProposalIds.length > Limits.nodesPerSnapshot)) {
    return blocked(Codes.limitExceeded);
  }
  if (Array.isArray(graph.choiceGroups)) {
    for (const group of graph.choiceGroups) {
      if (group && Array.isArray(group.memberProposalIds) && group.memberProposalIds.length > Limits.nodesPerRoot) {
        return blocked(Codes.limitExceeded);
      }
    }
  }
  return null;
}

export function validateProposalGraph(value: unknown): ProposalGraphValidationResult {
  const overLimit = preflightLimits(value);
  if (overLimit) return overLimit;
  try {
    const graph = parseProposalGraphSnapshotV1(value);
    const nodes = new Map(graph.nodes.map((node) => [node.proposalId, node]));
    const activeRoots = new Set<string>();
    for (const node of graph.nodes) {
      if (node.lifecycle !== 'open') continue;
      let root = node;
      while (root.relationships.dependency) root = nodes.get(root.relationships.dependency.proposalId)!;
      activeRoots.add(root.proposalId);
      if (activeRoots.size > Limits.openRootsPerDocument) return blocked(Codes.limitExceeded);
    }
    return { status: 'valid', graph };
  } catch (error) {
    return blocked(error instanceof ProposalGraphContractError ? error.code : Codes.invalidRequest);
  }
}

function indexNodes(graph: ProposalGraphSnapshotV1): Map<string, ProposalNodeV1> {
  return new Map(graph.nodes.map((node) => [node.proposalId, node]));
}

function indexChildren(graph: ProposalGraphSnapshotV1): Map<string, ProposalNodeV1[]> {
  const children = new Map<string, ProposalNodeV1[]>();
  for (const node of graph.nodes) {
    const parentId = node.relationships.dependency?.proposalId;
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => compareIds(left.proposalId, right.proposalId));
  return children;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Only dependency edges propagate blocking; replacement edges never transfer children. */
function openDescendants(graph: ProposalGraphSnapshotV1, parentIds: readonly string[]): string[] {
  const children = indexChildren(graph);
  const visited = new Set<string>();
  const open: string[] = [];
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (visited.has(child.proposalId)) continue;
      visited.add(child.proposalId);
      if (child.lifecycle === 'open') open.push(child.proposalId);
      visit(child.proposalId);
    }
  };
  for (const id of parentIds) visit(id);
  return open;
}

function validSelection(ids: readonly string[], maximum: number): ProposalModelBlocked | null {
  if (!Array.isArray(ids) || ids.length === 0) return blocked(Codes.invalidRequest);
  if (ids.length > maximum) return blocked(Codes.limitExceeded);
  if (ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) {
    return blocked(Codes.invalidRequest);
  }
  return null;
}

/** Does not choose or close anything: returns the effects that a later preview must expose. */
function choiceClosure(
  graph: ProposalGraphSnapshotV1,
  requiredProposalIds: readonly string[],
): ProposalChoiceClosureReady | ProposalModelBlocked {
  const nodes = indexNodes(graph);
  const groups = new Map(graph.choiceGroups.map((group) => [group.groupId, group]));
  const required = new Set(requiredProposalIds);
  const chosen = new Map<string, string>();
  for (const id of requiredProposalIds) {
    const node = nodes.get(id);
    if (!node) return blocked(Codes.sourceInvalid, [id]);
    const groupId = node.relationships.choiceGroupId;
    if (!groupId) continue;
    const previous = chosen.get(groupId);
    if (previous && previous !== id) return blocked(Codes.choiceConflict, [previous, id], [groupId]);
    chosen.set(groupId, id);
  }
  const choiceResolutions: ProposalActionFenceV1['choiceResolutions'] = [];
  const closing = new Set<string>();
  for (const [groupId, chosenProposalId] of chosen) {
    const group = groups.get(groupId)!;
    if (group.chosenProposalId !== null && group.chosenProposalId !== chosenProposalId) {
      return blocked(Codes.choiceConflict, [chosenProposalId, group.chosenProposalId], [groupId]);
    }
    const closingProposalIds = group.memberProposalIds
      .filter((id) => id !== chosenProposalId && nodes.get(id)!.lifecycle === 'open')
      .sort(compareIds);
    for (const id of closingProposalIds) closing.add(id);
    choiceResolutions.push({ groupId, groupRevision: group.groupRevision, chosenProposalId, closingProposalIds });
    if (required.size + closing.size > Limits.closureNodes) return blocked(Codes.limitExceeded);
  }
  const blockedDescendantProposalIds = openDescendants(graph, [...closing]);
  // A selected dependency cannot also descend from a losing alternative.
  const blockedRequired = blockedDescendantProposalIds.filter((id) => required.has(id));
  if (blockedRequired.length) return blocked(Codes.choiceConflict, blockedRequired, [...chosen.keys()]);
  return { status: 'ready', choiceResolutions, closingProposalIds: [...closing], blockedDescendantProposalIds };
}

/** Required IDs must already include their complete dependency closure. */
export function resolveProposalChoiceClosure(input: {
  graph: unknown;
  requiredProposalIds: readonly string[];
}): ProposalChoiceClosureReady | ProposalModelBlocked {
  const invalid = validSelection(input.requiredProposalIds, Limits.closureNodes);
  if (invalid) return invalid;
  const validation = validateProposalGraph(input.graph);
  if (validation.status === 'blocked') return validation;
  const required = new Set(input.requiredProposalIds);
  const nodes = indexNodes(validation.graph);
  for (const id of required) {
    const node = nodes.get(id);
    if (!node) return blocked(Codes.sourceInvalid, [id]);
    if (PROPOSAL_PREREQUISITE_RULES_V1[node.lifecycle] === 'blocked') return blocked(Codes.dependencyBlocked, [id]);
    const parentId = node.relationships.dependency?.proposalId;
    if (parentId && !required.has(parentId)) return blocked(Codes.dependencyBlocked, [parentId]);
  }
  return choiceClosure(validation.graph, [...required]);
}

/**
 * Explicit selection order orders independent branches. Each branch visits its
 * parent before itself; shared ancestors occur once. Ready describes a candidate
 * preview, never permission to apply: historical prerequisites still need current
 * effect proofs and all returned choice resolutions must be visibly approved.
 */
export function resolveProposalClosure(input: {
  graph: unknown;
  selectedProposalIds: readonly string[];
}): ProposalClosureReady | ProposalModelBlocked {
  const invalid = validSelection(input.selectedProposalIds, Limits.batchMembers);
  if (invalid) return invalid;
  const validation = validateProposalGraph(input.graph);
  if (validation.status === 'blocked') return validation;
  const { graph } = validation;
  const nodes = indexNodes(graph);
  const selectedProposalIds = [...new Set(input.selectedProposalIds)];
  for (const id of selectedProposalIds) {
    const node = nodes.get(id);
    if (!node) return blocked(Codes.sourceInvalid, [id]);
    if (node.lifecycle !== 'open') return blocked(Codes.invalidTransition, [id]);
  }
  const ordered: string[] = [];
  const visited = new Set<string>();
  let failure: ProposalModelBlocked | null = null;
  const visit = (id: string) => {
    if (visited.has(id) || failure) return;
    const node = nodes.get(id)!;
    if (PROPOSAL_PREREQUISITE_RULES_V1[node.lifecycle] === 'blocked') {
      failure = blocked(Codes.dependencyBlocked, [id]);
      return;
    }
    visited.add(id);
    if (visited.size > Limits.closureNodes) {
      failure = blocked(Codes.limitExceeded);
      return;
    }
    const parentId = node.relationships.dependency?.proposalId;
    if (parentId) visit(parentId);
    if (!failure) ordered.push(id);
  };
  for (const id of selectedProposalIds) visit(id);
  if (failure) return failure;
  const choices = choiceClosure(graph, ordered);
  if (choices.status === 'blocked') return choices;
  return {
    status: 'ready', scope: graph.scope, graphRevision: graph.graphRevision, selectedProposalIds,
    dependencyProposalIds: ordered,
    applyProposalIds: ordered.filter((id) => nodes.get(id)!.lifecycle === 'open'),
    prerequisiteProposalIds: ordered.filter((id) => nodes.get(id)!.lifecycle !== 'open'),
    closureProposalIds: [...ordered, ...choices.closingProposalIds],
    choiceResolutions: choices.choiceResolutions,
    blockedDescendantProposalIds: choices.blockedDescendantProposalIds,
  };
}

/** Rejecting a node changes only it; descendant blocking is a derived evaluation state. */
export function resolveProposalRejection(input: {
  graph: unknown;
  proposalId: string;
  mode: 'single' | 'branch';
}): ProposalRejectionReady | ProposalModelBlocked {
  const invalid = validSelection([input.proposalId], 1);
  if (invalid) return invalid;
  if (!['single', 'branch'].includes(input.mode)) return blocked(Codes.invalidRequest);
  const validation = validateProposalGraph(input.graph);
  if (validation.status === 'blocked') return validation;
  const { graph } = validation;
  const node = graph.nodes.find((candidate) => candidate.proposalId === input.proposalId);
  if (!node) return blocked(Codes.sourceInvalid, [input.proposalId]);
  if (node.lifecycle !== 'open') return blocked(Codes.invalidTransition, [input.proposalId]);
  const descendants = openDescendants(graph, [input.proposalId]);
  const rejectedProposalIds = input.mode === 'branch' ? [input.proposalId, ...descendants] : [input.proposalId];
  if (rejectedProposalIds.length > Limits.closureNodes) return blocked(Codes.limitExceeded);
  return {
    status: 'ready', scope: graph.scope, graphRevision: graph.graphRevision,
    closureProposalIds: [...rejectedProposalIds], rejectedProposalIds,
    blockedDescendantProposalIds: input.mode === 'branch' ? [] : descendants,
  };
}
