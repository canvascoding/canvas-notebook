import 'server-only';

import { openDb } from '@/app/lib/db';
import {
  setAgentDirectEditGrantForOperation,
  type AgentDirectEditGrant,
  type AgentDirectEditGrantScope,
} from '@/app/lib/collaboration/agent-direct-edit-grants';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import type { FileReviewPolicyV1 } from './contracts/v1';
import {
  fileReviewPolicyService,
  type FileReviewPolicyAccess,
} from './review-policy-service';

export type AgentReviewPolicySnapshot = {
  access: FileReviewPolicyAccess;
  lineageId: string;
  policy: FileReviewPolicyV1;
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
    return { access, lineageId, policy };
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
