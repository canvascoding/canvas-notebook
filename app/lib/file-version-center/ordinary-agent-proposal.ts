import 'server-only';

import type { AgentTextTarget } from '@/app/lib/collaboration/agent-operations';
import type { PersistedCollaborationState } from '@/app/lib/collaboration/persistence';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';

import { readAgentReviewPolicySnapshot } from './agent-review-policy-adapter';
import type { ProposalNodeV1 } from './contracts/proposal-graph-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from './contracts/proposal-graph-v1';
import type { ProposalToolCreationResultV1 } from './contracts/proposal-tools-v1';
import {
  createRuntimeProposalAgentService,
  hasPotentialProposalAgentRetryKey,
} from './proposal-agent-runtime';
import type {
  ProposalAuthoringPreview,
  ProposalProvenanceView,
} from './proposal-provenance-service';
import { proposalReviewWritesEnabled } from './proposal-review-capability';
import type { ProposalYjsRepresentation } from './proposal-yjs-candidate';

export type OrdinaryAgentProposalResult = {
  node: ProposalNodeV1;
  proposal: ProposalToolCreationResultV1;
  reused: boolean;
  authoringPreview: ProposalAuthoringPreview;
};

type OrdinaryAgentProposalSource = ProposalProvenanceView & {
  update: Uint8Array;
  representation: ProposalYjsRepresentation;
};

/**
 * Shared decision boundary for ordinary agent edits. Adapters provide a
 * server-verified mutation and target builder; this service owns the review
 * policy, durable retry lookup and proposal creation decision.
 */
export async function createOrdinaryAgentProposal(input: {
  workspace: WorkspaceContext;
  documentId: string;
  path: string;
  identity: {
    initiatedByUserId: string;
    actorId: string;
    actorSessionId?: string;
  };
  idempotencyKey: string;
  retryRequested: boolean;
  mutation: unknown;
  forceReview?: boolean;
  lookupOnly?: boolean;
  buildTargets(input: {
    state: PersistedCollaborationState;
    source: OrdinaryAgentProposalSource;
  }): AgentTextTarget[] | Promise<AgentTextTarget[]>;
}): Promise<OrdinaryAgentProposalResult | null> {
  if (!readDocumentReviewAvailability().documentReviewEnabled) {
    if (!input.retryRequested) return null;
    if (await hasPotentialProposalAgentRetryKey({
      documentId: input.documentId,
      initiatedByUserId: input.identity.initiatedByUserId,
      idempotencyKey: input.idempotencyKey,
    })) {
      throw new ProposalGraphContractError(Codes.upgradeRequired,
        'Document Review Center is disabled. The existing proposal was preserved and was not applied.');
    }
    return null;
  }
  const graphEnabled = proposalReviewWritesEnabled({
    workspaceId: input.workspace.workspaceId,
  });
  if (!graphEnabled && !input.retryRequested) return null;
  if (
    !graphEnabled
    && !await hasPotentialProposalAgentRetryKey({
      documentId: input.documentId,
      initiatedByUserId: input.identity.initiatedByUserId,
      idempotencyKey: input.idempotencyKey,
    })
  ) {
    return null;
  }

  const runtime = await createRuntimeProposalAgentService({
    workspace: input.workspace,
    documentId: input.documentId,
    path: input.path,
    identity: input.identity,
  });
  const policy = graphEnabled
    ? await readAgentReviewPolicySnapshot({
      documentId: input.documentId,
      workspace: input.workspace,
      initiatedByUserId: input.identity.initiatedByUserId,
    })
    : null;
  const allowCreate = graphEnabled
    && !input.lookupOnly
    && Boolean(
      input.forceReview
      || !policy
      || policy.policy.effectiveMode !== 'safe_direct'
      || policy.policy.locked,
    );

  return runtime.service.createIndependent({
    scope: runtime.scope,
    actorId: input.identity.actorId,
    idempotencyKey: input.idempotencyKey,
    mutation: input.mutation,
    allowCreate,
    buildTargets: (source) => input.buildTargets({ state: runtime.state, source }),
  });
}
