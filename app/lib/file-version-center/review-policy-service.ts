import 'server-only';

import { recordAuditEvent, type AuditEventInput } from '@/app/lib/audit/audit-service';
import type {
  AgentDirectEditGrant,
  AgentDirectEditGrantScope,
} from '@/app/lib/collaboration/agent-direct-edit-grants';

import type { FileReviewPolicyV1 } from './contracts/v1';
import {
  createRuntimeFileVersionCenterDatabase,
  type FileVersionCenterDatabase,
  type FileVersionCenterTransaction,
} from './database';
import {
  resolveEffectiveFileReviewPolicyV1,
  type ResolveFileReviewPolicyInputV1,
} from './policy-v1';

export type FileReviewPolicyAccess = {
  userId: string;
  authenticatedWorkspaceId: string;
  requestedWorkspaceId: string;
  membership: 'active' | 'revoked' | 'unknown';
  permissionsResolved: boolean;
  canRead: boolean;
  canWrite?: boolean;
  canRunAgent?: boolean;
};

export type FileReviewPolicyEvaluation = Pick<
  ResolveFileReviewPolicyInputV1,
  'hardSafetyRequiresReview' | 'workspacePolicy' | 'operationExplicitlyRequiresReview'
>;

export type FileReviewPolicyOperationDecision = {
  policy: FileReviewPolicyV1;
  enforcementMode: 'review_required' | 'safe_direct';
  grant: AgentDirectEditGrant | null;
};

export class FileReviewPolicyServiceError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'access_denied' | 'target_invalid' | 'policy_conflict' | 'policy_inconsistent',
    message: string,
  ) {
    super(message);
    this.name = 'FileReviewPolicyServiceError';
  }
}

type PolicyRow = {
  resolved_lineage_id: string;
  lineage_status: string;
  user_id: string | null;
  workspace_id: string | null;
  lineage_id: string | null;
  requested_mode: string | null;
  revision: number | string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type StoredPolicy = {
  requestedMode: FileReviewPolicyV1['requestedMode'];
  revision: number;
  createdAt: number;
  updatedAt: number;
};

type OperationRow = {
  created_at: number | string;
};

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function assertAccess(access: FileReviewPolicyAccess, mutation: boolean): void {
  if (
    !validId(access.userId)
    || !validId(access.authenticatedWorkspaceId)
    || !validId(access.requestedWorkspaceId)
    || access.authenticatedWorkspaceId !== access.requestedWorkspaceId
    || access.membership !== 'active'
    || !access.permissionsResolved
    || !access.canRead
    || (mutation && (!access.canWrite || !access.canRunAgent))
  ) {
    throw new FileReviewPolicyServiceError(
      'access_denied',
      'The review policy is not available in the active workspace.',
    );
  }
}

function assertLineageId(lineageId: string): void {
  if (!validId(lineageId)) {
    throw new FileReviewPolicyServiceError('invalid_input', 'The policy lineage is invalid.');
  }
}

function assertEvaluation(evaluation: FileReviewPolicyEvaluation): void {
  if (
    typeof evaluation.hardSafetyRequiresReview !== 'boolean'
    || typeof evaluation.operationExplicitlyRequiresReview !== 'boolean'
    || !['allow_user_choice', 'force_review', 'unknown'].includes(evaluation.workspacePolicy)
  ) {
    throw new FileReviewPolicyServiceError('policy_inconsistent', 'The effective policy input is inconsistent.');
  }
}

function checkedTimestamp(value: number | string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function policyFromRecord(
  record: StoredPolicy | null,
  evaluation: FileReviewPolicyEvaluation,
): FileReviewPolicyV1 {
  return resolveEffectiveFileReviewPolicyV1({
    requestedMode: record?.requestedMode ?? null,
    policyRevision: record?.revision ?? null,
    preferenceState: record ? 'loaded' : 'missing',
    persistenceState: 'ready',
    ...evaluation,
  });
}

function failClosedPolicy(): FileReviewPolicyV1 {
  return resolveEffectiveFileReviewPolicyV1({
    requestedMode: null,
    policyRevision: null,
    preferenceState: 'error',
    persistenceState: 'unavailable',
    hardSafetyRequiresReview: false,
    workspacePolicy: 'unknown',
    operationExplicitlyRequiresReview: false,
  });
}

function recordFromRow(row: PolicyRow, expected: {
  userId: string;
  workspaceId: string;
  lineageId: string;
}): StoredPolicy | null {
  if (row.resolved_lineage_id !== expected.lineageId || row.lineage_status !== 'active') {
    throw new FileReviewPolicyServiceError('target_invalid', 'The policy lineage is not active.');
  }
  const absent = row.user_id === null
    && row.workspace_id === null
    && row.lineage_id === null
    && row.requested_mode === null
    && row.revision === null
    && row.created_at === null
    && row.updated_at === null;
  if (absent) return null;
  const revision = row.revision === null ? null : Number(row.revision);
  const createdAt = checkedTimestamp(row.created_at);
  const updatedAt = checkedTimestamp(row.updated_at);
  if (
    row.user_id !== expected.userId
    || row.workspace_id !== expected.workspaceId
    || row.lineage_id !== expected.lineageId
    || (row.requested_mode !== 'review_required' && row.requested_mode !== 'safe_direct')
    || !Number.isSafeInteger(revision)
    || revision === null
    || revision < 1
    || createdAt === null
    || updatedAt === null
    || updatedAt < createdAt
  ) {
    throw new FileReviewPolicyServiceError('policy_inconsistent', 'The stored review policy is inconsistent.');
  }
  return { requestedMode: row.requested_mode, revision, createdAt, updatedAt };
}

async function loadPolicy(
  transaction: FileVersionCenterTransaction,
  input: { userId: string; workspaceId: string; lineageId: string },
): Promise<StoredPolicy | null> {
  const result = await transaction.query<PolicyRow>(`
    SELECT
      lineage.id AS resolved_lineage_id,
      lineage.status AS lineage_status,
      policy.user_id,
      policy.workspace_id,
      policy.lineage_id,
      policy.requested_mode,
      policy.revision,
      policy.created_at,
      policy.updated_at
    FROM file_collaboration_lineages lineage
    LEFT JOIN file_agent_review_policies policy
      ON policy.user_id = $1
      AND policy.workspace_id = lineage.workspace_id
      AND policy.lineage_id = lineage.id
    WHERE lineage.id = $2 AND lineage.workspace_id = $3
  `, [input.userId, input.lineageId, input.workspaceId]);
  const row = result.rows[0];
  if (!row) throw new FileReviewPolicyServiceError('target_invalid', 'The policy lineage is not active.');
  return recordFromRow(row, input);
}

function validGrantScope(scope: AgentDirectEditGrantScope): boolean {
  return [scope.userId, scope.workspaceId, scope.agentId, scope.actorSessionId, scope.documentId].every(validId)
    && Number.isSafeInteger(scope.lifecycleGeneration)
    && scope.lifecycleGeneration > 0;
}

async function loadMatchingOperation(
  transaction: FileVersionCenterTransaction,
  input: {
    operationId: string;
    userId: string;
    workspaceId: string;
    lineageId: string;
    grantScope: AgentDirectEditGrantScope;
  },
): Promise<{ createdAt: number } | null> {
  if (!validId(input.operationId) || !validGrantScope(input.grantScope)) return null;
  const result = await transaction.query<OperationRow>(`
    SELECT operation.created_at
    FROM collaboration_agent_operations operation
    INNER JOIN collaboration_documents document
      ON document.id = operation.document_id
      AND document.workspace_id = operation.workspace_id
      AND document.lineage_id = $4
      AND document.status = 'active'
    WHERE operation.operation_id = $1
      AND operation.initiated_by_user_id = $2
      AND operation.workspace_id = $3
      AND operation.document_id = $5
      AND operation.actor_id = $6
      AND operation.actor_session_id = $7
      AND operation.document_lifecycle_generation = $8
      AND operation.operation_type = 'apply'
  `, [input.operationId, input.userId, input.workspaceId, input.lineageId,
    input.grantScope.documentId, input.grantScope.agentId, input.grantScope.actorSessionId,
    input.grantScope.lifecycleGeneration]);
  const createdAt = checkedTimestamp(result.rows[0]?.created_at ?? null);
  return createdAt === null ? null : { createdAt };
}

function operationIsFutureAndOwned(input: {
  access: FileReviewPolicyAccess;
  stored: StoredPolicy;
  operation: {
    observedPolicyRevision: number | null;
    grantScope: AgentDirectEditGrantScope;
  };
  storedOperation: { createdAt: number } | null;
}): boolean {
  const { access, stored, operation } = input;
  return input.storedOperation !== null
    && operation.grantScope.userId === access.userId
    && operation.grantScope.workspaceId === access.requestedWorkspaceId
    && input.storedOperation.createdAt > stored.updatedAt
    && operation.observedPolicyRevision === stored.revision;
}

async function resolveExistingDirectEditGrant(
  scope: AgentDirectEditGrantScope,
): Promise<AgentDirectEditGrant | null> {
  const { resolveAgentDirectEditGrant } = await import(
    '@/app/lib/collaboration/agent-direct-edit-grants'
  );
  return resolveAgentDirectEditGrant(scope);
}

export function createFileReviewPolicyService(options: {
  database?: FileVersionCenterDatabase;
  now?: () => number;
  audit?: (event: AuditEventInput) => Promise<unknown>;
  resolveDirectEditGrant?: (scope: AgentDirectEditGrantScope) => Promise<AgentDirectEditGrant | null>;
} = {}) {
  const database = options.database ?? createRuntimeFileVersionCenterDatabase();
  const now = options.now ?? Date.now;
  const audit = options.audit ?? recordAuditEvent;
  const resolveDirectEditGrant = options.resolveDirectEditGrant ?? resolveExistingDirectEditGrant;

  return {
    async readAuthorized(input: {
      access: FileReviewPolicyAccess;
      lineageId: string;
      evaluation: FileReviewPolicyEvaluation;
    }): Promise<FileReviewPolicyV1> {
      assertAccess(input.access, false);
      assertLineageId(input.lineageId);
      assertEvaluation(input.evaluation);
      const record = await database.transaction((transaction) => loadPolicy(transaction, {
        userId: input.access.userId,
        workspaceId: input.access.requestedWorkspaceId,
        lineageId: input.lineageId,
      }));
      return policyFromRecord(record, input.evaluation);
    },

    async writeAuthorized(input: {
      access: FileReviewPolicyAccess;
      lineageId: string;
      requestedMode: FileReviewPolicyV1['requestedMode'];
      expectedRevision: number;
      workspacePolicy: FileReviewPolicyEvaluation['workspacePolicy'];
    }): Promise<FileReviewPolicyV1> {
      assertAccess(input.access, true);
      assertLineageId(input.lineageId);
      assertEvaluation({
        hardSafetyRequiresReview: false,
        workspacePolicy: input.workspacePolicy,
        operationExplicitlyRequiresReview: false,
      });
      if (
        (input.requestedMode !== 'review_required' && input.requestedMode !== 'safe_direct')
        || !Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 0
        || input.expectedRevision >= Number.MAX_SAFE_INTEGER
      ) {
        throw new FileReviewPolicyServiceError('invalid_input', 'The policy update is invalid.');
      }
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new FileReviewPolicyServiceError('policy_inconsistent', 'The policy clock is invalid.');
      }
      const stored = await database.transaction(async (transaction): Promise<StoredPolicy> => {
        const current = await loadPolicy(transaction, {
          userId: input.access.userId,
          workspaceId: input.access.requestedWorkspaceId,
          lineageId: input.lineageId,
        });
        if ((current?.revision ?? 0) !== input.expectedRevision) {
          throw new FileReviewPolicyServiceError('policy_conflict', 'The review policy changed in another tab.');
        }
        const result = input.expectedRevision === 0
          ? await transaction.query<PolicyRow>(`
              INSERT INTO file_agent_review_policies (
                user_id, workspace_id, lineage_id, requested_mode, revision, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, 1, $5, $5)
              ON CONFLICT (user_id, workspace_id, lineage_id) DO NOTHING
              RETURNING
                lineage_id AS resolved_lineage_id,
                'active'::text AS lineage_status,
                user_id, workspace_id, lineage_id, requested_mode, revision, created_at, updated_at
            `, [input.access.userId, input.access.requestedWorkspaceId, input.lineageId,
              input.requestedMode, timestamp])
          : await transaction.query<PolicyRow>(`
              UPDATE file_agent_review_policies
              SET requested_mode = $1,
                  revision = revision + 1,
                  updated_at = GREATEST(updated_at + 1, $2)
              WHERE user_id = $3 AND workspace_id = $4 AND lineage_id = $5 AND revision = $6
              RETURNING
                lineage_id AS resolved_lineage_id,
                'active'::text AS lineage_status,
                user_id, workspace_id, lineage_id, requested_mode, revision, created_at, updated_at
            `, [input.requestedMode, timestamp, input.access.userId, input.access.requestedWorkspaceId,
              input.lineageId, input.expectedRevision]);
        const row = result.rows[0];
        if (!row) {
          throw new FileReviewPolicyServiceError('policy_conflict', 'The review policy changed in another tab.');
        }
        const updated = recordFromRow(row, {
          userId: input.access.userId,
          workspaceId: input.access.requestedWorkspaceId,
          lineageId: input.lineageId,
        });
        if (!updated || updated.revision !== input.expectedRevision + 1) {
          throw new FileReviewPolicyServiceError('policy_inconsistent', 'The policy update was not stored consistently.');
        }
        return updated;
      });
      try {
        await audit({
          workspaceId: input.access.requestedWorkspaceId,
          userId: input.access.userId,
          source: 'file_version_center',
          eventType: 'review_policy_changed',
          entityType: 'file_agent_review_policy',
          entityId: input.lineageId,
          action: 'update',
          status: 'success',
          summary: 'Agent file review preference changed.',
          metadata: {
            lineageId: input.lineageId,
            expectedRevision: input.expectedRevision,
            revision: stored.revision,
            requestedMode: stored.requestedMode,
          },
        });
      } catch {
        // Audit is best effort and must not make a committed CAS update appear to fail.
      }
      return policyFromRecord(stored, {
        hardSafetyRequiresReview: false,
        workspacePolicy: input.workspacePolicy,
        operationExplicitlyRequiresReview: false,
      });
    },

    async resolveForOperation(input: {
      access: FileReviewPolicyAccess;
      lineageId: string;
      evaluation: FileReviewPolicyEvaluation;
      operation: {
        operationId: string;
        observedPolicyRevision: number | null;
        grantScope: AgentDirectEditGrantScope;
      };
    }): Promise<FileReviewPolicyOperationDecision> {
      try {
        assertAccess(input.access, true);
        assertLineageId(input.lineageId);
        assertEvaluation(input.evaluation);
        const loaded = await database.transaction(async (transaction) => {
          const stored = await loadPolicy(transaction, {
            userId: input.access.userId,
            workspaceId: input.access.requestedWorkspaceId,
            lineageId: input.lineageId,
          });
          const storedOperation = stored
            ? await loadMatchingOperation(transaction, {
                operationId: input.operation.operationId,
                userId: input.access.userId,
                workspaceId: input.access.requestedWorkspaceId,
                lineageId: input.lineageId,
                grantScope: input.operation.grantScope,
              })
            : null;
          return { stored, storedOperation };
        });
        const futureAndOwned = loaded.stored !== null && operationIsFutureAndOwned({
          access: input.access,
          stored: loaded.stored,
          operation: input.operation,
          storedOperation: loaded.storedOperation,
        });
        const policy = policyFromRecord(loaded.stored, {
          ...input.evaluation,
          hardSafetyRequiresReview: input.evaluation.hardSafetyRequiresReview || !futureAndOwned,
        });
        if (policy.effectiveMode !== 'safe_direct') {
          return { policy, enforcementMode: 'review_required', grant: null };
        }
        const grant = await resolveDirectEditGrant(input.operation.grantScope);
        return {
          policy,
          enforcementMode: grant ? 'safe_direct' : 'review_required',
          grant,
        };
      } catch {
        return { policy: failClosedPolicy(), enforcementMode: 'review_required', grant: null };
      }
    },
  };
}

export const fileReviewPolicyService = createFileReviewPolicyService();
