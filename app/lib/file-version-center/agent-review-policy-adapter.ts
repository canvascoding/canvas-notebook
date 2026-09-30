import 'server-only';

import { openDb } from '@/app/lib/db';
import {
  setAgentDirectEditGrantForOperation,
  type AgentDirectEditGrant,
  type AgentDirectEditGrantScope,
} from '@/app/lib/collaboration/agent-direct-edit-grants';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { DirectMcpEditAuthorityError, isDirectMcpEditAuthority,
  type DirectMcpEditAuthority } from '@/app/lib/mcp/server/direct-edit-authority';

import type { FileReviewPolicyV1 } from './contracts/v1';
import {
  fileReviewPolicyService,
  type FileReviewPolicyAccess,
} from './review-policy-service';

export type AgentReviewPolicySnapshot = {
  access: FileReviewPolicyAccess;
  lineageId: string;
  policy: FileReviewPolicyV1;
  /** Server clock captured before reading/queueing, never supplied by an agent tool. */
  observedAt: number;
};

type DocumentLineageRow = {
  lineage_id: string | null;
};

function accessFor(input: {
  userId: string;
  workspace: WorkspaceContext;
}): FileReviewPolicyAccess {
  return {
    userId: input.userId,
    authenticatedWorkspaceId: input.workspace.workspaceId,
    requestedWorkspaceId: input.workspace.workspaceId,
    membership: !input.workspace.status || input.workspace.status === 'active' ? 'active' : 'revoked',
    permissionsResolved: true,
    canRead: input.workspace.permissions.canRead,
    canWrite: input.workspace.permissions.canWrite,
    canRunAgent: input.workspace.permissions.canRunAgent,
  };
}

async function activeLineage(input: {
  documentId: string;
  workspaceId: string;
}): Promise<string | null> {
  const database = await openDb();
  try {
    const row = await database.get(`
      SELECT lineage_id
      FROM collaboration_documents
      WHERE id = $1 AND workspace_id = $2 AND status = 'active'
      LIMIT 1
    `, [input.documentId, input.workspaceId]) as DocumentLineageRow | undefined;
    return row?.lineage_id ?? null;
  } finally {
    await database.close();
  }
}

/** Captured before queueing; later preference changes must not silently authorize this operation. */
export async function readAgentReviewPolicySnapshot(input: {
  documentId: string;
  workspace: WorkspaceContext;
  initiatedByUserId: string;
}): Promise<AgentReviewPolicySnapshot | null> {
  const observedAt = Date.now();
  try {
    const access = accessFor({ userId: input.initiatedByUserId, workspace: input.workspace });
    const lineageId = await activeLineage({
      documentId: input.documentId,
      workspaceId: input.workspace.workspaceId,
    });
    if (!lineageId) return null;
    const policy = await fileReviewPolicyService.readAuthorized({
      access,
      lineageId,
      evaluation: {
        hardSafetyRequiresReview: false,
        workspacePolicy: 'allow_user_choice',
        operationExplicitlyRequiresReview: false,
      },
    });
    return { access, lineageId, policy, observedAt };
  } catch {
    return null;
  }
}

async function revokeGeneratedGrant(input: {
  operationId: string;
  workspace: WorkspaceContext;
  initiatedByUserId: string;
  revision: number;
}): Promise<void> {
  try {
    await setAgentDirectEditGrantForOperation({
      operationId: input.operationId,
      workspace: input.workspace,
      userId: input.initiatedByUserId,
      action: 'revoke',
      idempotencyKey: `policy-revoke:${input.operationId}:${input.revision}`,
    });
  } catch {
    // Authorization already failed closed. Revocation is defense in depth.
  }
}

/**
 * Mints migration-era authority only for the just-created operation, then re-resolves the
 * durable user policy and all ownership fences immediately before direct application.
 */
export async function authorizeNewAgentDirectApply(input: {
  operationId: string;
  workspace: WorkspaceContext;
  initiatedByUserId: string;
  snapshot: AgentReviewPolicySnapshot;
  grantScope: AgentDirectEditGrantScope;
  hardSafetyRequiresReview: boolean;
  operationExplicitlyRequiresReview: boolean;
  /** Trusted admission result; never inferred from a tool-provided idempotency key. */
  createdInThisCall: boolean;
}): Promise<{
  enforcementMode: 'review_required' | 'safe_direct';
  grant: AgentDirectEditGrant | null;
}> {
  if (input.snapshot.policy.effectiveMode !== 'safe_direct'
    || input.snapshot.policy.locked
    || input.hardSafetyRequiresReview
    || input.operationExplicitlyRequiresReview) {
    return { enforcementMode: 'review_required', grant: null };
  }
  try {
    const generated = await setAgentDirectEditGrantForOperation({
      operationId: input.operationId,
      workspace: input.workspace,
      userId: input.initiatedByUserId,
      action: 'grant',
      idempotencyKey: `policy-grant:${input.operationId}:${input.snapshot.policy.revision}`,
    });
    if (!generated?.active || generated.revokedAt !== null) {
      return { enforcementMode: 'review_required', grant: null };
    }
    const decision = await fileReviewPolicyService.resolveForOperation({
      access: input.snapshot.access,
      lineageId: input.snapshot.lineageId,
      evaluation: {
        hardSafetyRequiresReview: input.hardSafetyRequiresReview,
        workspacePolicy: 'allow_user_choice',
        operationExplicitlyRequiresReview: input.operationExplicitlyRequiresReview,
      },
      operation: {
        operationId: input.operationId,
        observedPolicyRevision: input.snapshot.policy.revision,
        observedPolicyAt: input.snapshot.observedAt,
        createdInThisCall: input.createdInThisCall,
        grantScope: input.grantScope,
      },
    });
    if (decision.enforcementMode === 'safe_direct'
      && decision.grant?.id === generated.id) {
      return { enforcementMode: 'safe_direct', grant: decision.grant };
    }
    await revokeGeneratedGrant({
      operationId: input.operationId,
      workspace: input.workspace,
      initiatedByUserId: input.initiatedByUserId,
      revision: input.snapshot.policy.revision,
    });
    return { enforcementMode: 'review_required', grant: null };
  } catch {
    await revokeGeneratedGrant({
      operationId: input.operationId,
      workspace: input.workspace,
      initiatedByUserId: input.initiatedByUserId,
      revision: input.snapshot.policy.revision,
    });
    return { enforcementMode: 'review_required', grant: null };
  }
}

/** OAuth-backed direct edits reuse the exact operation freshness and policy fences without minting a Pi grant. */
export async function authorizeNewMcpDirectApply(input: {
  operationId: string;
  snapshot: AgentReviewPolicySnapshot;
  grantScope: AgentDirectEditGrantScope;
  authority: DirectMcpEditAuthority;
  hardSafetyRequiresReview: boolean;
  operationExplicitlyRequiresReview: boolean;
  createdInThisCall: boolean;
}): Promise<boolean> {
  if (!isDirectMcpEditAuthority(input.authority)
    || input.authority.scope.userId !== input.grantScope.userId
    || input.authority.scope.workspaceId !== input.grantScope.workspaceId
    || input.authority.scope.documentId !== input.grantScope.documentId
    || input.authority.scope.actorId !== input.grantScope.agentId
    || input.authority.scope.sessionId !== input.grantScope.actorSessionId
    || input.authority.scope.lifecycleGeneration !== input.grantScope.lifecycleGeneration
    || input.snapshot.policy.effectiveMode !== 'safe_direct' || input.snapshot.policy.locked
    || input.hardSafetyRequiresReview || input.operationExplicitlyRequiresReview) return false;
  try {
    const workspace = await input.authority.verifyCurrent();
    const policy = await fileReviewPolicyService.resolveForOperationPolicy({
      access: accessFor({ userId: input.grantScope.userId, workspace }),
      lineageId: input.snapshot.lineageId,
      evaluation: {
        hardSafetyRequiresReview: input.hardSafetyRequiresReview,
        workspacePolicy: 'allow_user_choice',
        operationExplicitlyRequiresReview: input.operationExplicitlyRequiresReview,
      },
      operation: {
        operationId: input.operationId,
        observedPolicyRevision: input.snapshot.policy.revision,
        observedPolicyAt: input.snapshot.observedAt,
        createdInThisCall: input.createdInThisCall,
        grantScope: input.grantScope,
      },
    });
    return policy.effectiveMode === 'safe_direct' && !policy.locked;
  } catch {
    return false;
  }
}

/** Called again after the workspace and Yjs room mutation locks are owned. */
export async function assertCurrentMcpDirectPolicy(input: {
  snapshot: AgentReviewPolicySnapshot;
  workspace: WorkspaceContext;
  authority: DirectMcpEditAuthority;
}): Promise<void> {
  if (!isDirectMcpEditAuthority(input.authority)
    || input.workspace.workspaceId !== input.authority.scope.workspaceId
    || !input.workspace.permissions.canWrite || !input.workspace.permissions.canRunAgent) {
    throw new DirectMcpEditAuthorityError();
  }
  try {
    const policy = await fileReviewPolicyService.readAuthorized({
      access: accessFor({ userId: input.authority.scope.userId, workspace: input.workspace }),
      lineageId: input.snapshot.lineageId,
      evaluation: { hardSafetyRequiresReview: false, workspacePolicy: 'allow_user_choice',
        operationExplicitlyRequiresReview: false },
    });
    if (policy.effectiveMode !== 'safe_direct' || policy.locked
      || policy.revision !== input.snapshot.policy.revision) throw new DirectMcpEditAuthorityError();
  } catch {
    throw new DirectMcpEditAuthorityError();
  }
}
