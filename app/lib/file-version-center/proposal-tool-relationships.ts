import 'server-only';

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError,
  type ProposalChoiceGroupV1, type ProposalGraphErrorCode, type ProposalNodeV1,
} from './contracts/proposal-graph-v1';
import { validateProposalGraph } from './proposal-graph-model';
import type { ProposalProvenanceDependencies, ProposalRelationshipPolicy } from './proposal-provenance-service';

function fail(code: ProposalGraphErrorCode, message: string): never {
  throw new ProposalGraphContractError(code, message);
}

/** Relationship decisions share the provenance transaction; they never apply document content. */
export function createProposalToolRelationshipPolicy(input: {
  authorize: ProposalProvenanceDependencies['authorize']; createId?: () => string;
}): ProposalRelationshipPolicy {
  const createId = input.createId ?? randomUUID;
  return async ({ transaction, scope, proposalId, request, dependency }) => {
    const references = [request.replaces, request.choice?.kind === 'alternative_to' ? request.choice : null]
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const graph = await transaction.graph.loadGraph({ includeProposalIds: references.map(value => value.proposalId) });
    if (!isDeepStrictEqual(graph.scope, scope)) fail(Codes.scopeMismatch, 'Relationship belongs to another document.');
    const nodes = new Map(graph.nodes.map(node => [node.proposalId, node]));
    const target = (reference: NonNullable<typeof request.replaces>): ProposalNodeV1 => {
      const node = nodes.get(reference.proposalId);
      if (!node || node.lifecycle !== 'open' || node.casVersion !== reference.expectedCasVersion
        || node.authoredCandidate.cumulativeCandidate.sha256 !== reference.expectedCandidateHash) {
        fail(Codes.parentChanged, 'The explicit relationship target changed.');
      }
      if (!isDeepStrictEqual(node.relationships.dependency, dependency)) {
        fail(Codes.sourceInvalid, 'A replacement or alternative must retain its exact prerequisite.');
      }
      return node;
    };
    const replaced = request.replaces ? target(request.replaces) : null;
    let group: ProposalChoiceGroupV1 | null = null;
    let newGroup = false;
    if (replaced) {
      if (request.choice?.kind === 'alternative_to') {
        fail(Codes.choiceConflict, 'A replacement cannot create or change its alternative group.');
      }
      const groupId = replaced.relationships.choiceGroupId;
      if (request.choice && request.choice.groupId !== groupId) {
        fail(Codes.choiceConflict, 'A replacement must retain its alternative group.');
      }
      group = groupId ? graph.choiceGroups.find(candidate => candidate.groupId === groupId) ?? null : null;
      if (groupId && !group) fail(Codes.choiceConflict, 'The original alternative group is unavailable.');
    } else if (request.choice?.kind === 'alternative_to') {
      const alternative = target(request.choice);
      if (alternative.relationships.choiceGroupId !== null) {
        fail(Codes.choiceConflict, 'Use the exact existing alternative group and its current revision.');
      }
      group = { groupId: createId(), groupRevision: 0, dependencyProposalId: dependency?.proposalId ?? null,
        memberProposalIds: [alternative.proposalId], chosenProposalId: null };
      if (graph.choiceGroups.some(candidate => candidate.groupId === group!.groupId)) {
        fail(Codes.choiceConflict, 'The new alternative group identity is already in use.');
      }
      newGroup = true;
    } else if (request.choice?.kind === 'existing') {
      const choice = request.choice;
      group = graph.choiceGroups.find(candidate => candidate.groupId === choice.groupId) ?? null;
      if (!group) fail(Codes.choiceConflict, 'The explicit alternative group is unavailable.');
    }
    if (group && (group.chosenProposalId !== null || group.dependencyProposalId !== (dependency?.proposalId ?? null)
      || request.choice?.kind === 'existing' && group.groupRevision !== request.choice.expectedGroupRevision)) {
      fail(Codes.choiceConflict, 'The alternative group changed or has a different prerequisite.');
    }
    const managedIds = [...new Set([...references.map(value => value.proposalId), ...group?.memberProposalIds ?? []])];
    const authorize = () => input.authorize({ scope, action: 'manage_relationship', proposalIds: managedIds });
    await authorize();
    const relationships = { dependency, replacesProposalId: replaced?.proposalId ?? null, choiceGroupId: group?.groupId ?? null };
    let groupPrepared = false;
    const checkTargets = async () => {
      for (const reference of references) {
        const original = nodes.get(reference.proposalId)!;
        const expected = groupPrepared ? { ...original, casVersion: original.casVersion + 1,
          relationships: { ...original.relationships, choiceGroupId: group!.groupId } } : original;
        if (!isDeepStrictEqual(await transaction.graph.getProposal(reference.proposalId), expected)) {
          fail(Codes.parentChanged, 'The relationship target changed during preparation.');
        }
      }
    };
    return {
      relationships,
      beforeInsert: async () => {
        if (!newGroup || !group) return;
        await authorize();
        await checkTargets();
        // The node's immediate FK needs this row first. The temporary singleton
        // is never committed: apply adds the new member and validates the graph.
        await transaction.graph.putChoiceGroup(group, null);
        groupPrepared = true;
      },
      apply: async (node) => {
        if (node.proposalId !== proposalId || node.lifecycle !== 'open' || !isDeepStrictEqual(node.scope, scope)
          || !isDeepStrictEqual(node.relationships, relationships) || newGroup && !groupPrepared) {
          fail(Codes.sourceInvalid, 'The prepared proposal changed its relationship plan.');
        }
        await authorize();
        await checkTargets();
        if (group) await transaction.graph.putChoiceGroup({ ...group,
          groupRevision: group.groupRevision + 1,
          memberProposalIds: [...group.memberProposalIds, proposalId] }, group.groupRevision);
        if (replaced) await transaction.graph.transitionProposal(replaced.proposalId, replaced.casVersion, 'superseded');
        const checked = validateProposalGraph(await transaction.graph.loadGraph({ includeProposalIds: [proposalId] }));
        if (checked.status !== 'valid') fail(checked.reasonCode, 'The resulting proposal graph is invalid.');
      },
    };
  };
}
