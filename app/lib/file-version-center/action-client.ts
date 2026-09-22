'use client';

import {
  collaborationAgentAcceptanceOutcome,
  prepareCollaborationAgentAction,
  type CollaborationAgentOperation,
} from '@/app/lib/collaboration/agent-operations-client';
import { invalidateReviewQueries } from '@/app/lib/queries/review-queries';
import { notebookQueryKey } from '@/app/lib/queries/client';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

import {
  FILE_VERSION_CENTER_API_V1,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  parseFileVersionCenterErrorResponseV1,
  parseFileVersionRestoreResponseV1,
  type FileVersionCenterTargetV1,
  type FileVersionCurrentFenceV1,
  type FileVersionRestoreResponseV1,
} from './contracts/v1';

export type FileVersionMutation = 'accept' | 'reject' | 'restore';
export type FileVersionAgentMutationResult = {
  action: 'accept' | 'reject';
  outcome: 'accepted' | 'rejected' | 'review' | 'pending';
  operation: CollaborationAgentOperation;
};
export type FileVersionRestoreMutationResult = {
  action: 'restore';
  outcome: FileVersionRestoreResponseV1['outcome'];
  response: FileVersionRestoreResponseV1;
};
export type FileVersionMutationResult = FileVersionAgentMutationResult | FileVersionRestoreMutationResult;

type AgentActionInput = {
  operationId: string;
  workspaceId: string;
  reviewedProposalVersion?: string | null;
};

export class FileVersionActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FileVersionActionError';
  }
}

function isCollaborationOperation(value: unknown): value is CollaborationAgentOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as Partial<CollaborationAgentOperation>;
  return typeof operation.operationId === 'string'
    && typeof operation.operationStatus === 'string'
    && typeof operation.status === 'string'
    && typeof operation.durability === 'string'
    && typeof operation.actionsAllowed === 'boolean'
    && Array.isArray(operation.appliedTargetIds)
    && Array.isArray(operation.conflicts)
    && Array.isArray(operation.targetAnchors);
}

function isCollaborationActionReceipt(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = value as Partial<CollaborationAgentOperation>;
  return operation.operationId === operationId
    && typeof operation.operationStatus === 'string'
    && typeof operation.status === 'string'
    && typeof operation.durability === 'string'
    && Array.isArray(operation.appliedTargetIds)
    && Array.isArray(operation.conflicts);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FileVersionActionError(
      'FVRC_TRANSPORT_ERROR',
      'The action returned an unreadable response.',
      response.status,
      response.status >= 500,
    );
  }
}

function failureFrom(response: Response, payload: unknown): FileVersionActionError {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const failure = payload as { code?: unknown; error?: unknown };
    if (typeof failure.code === 'string' && typeof failure.error === 'string') {
      return new FileVersionActionError(
        failure.code,
        failure.error,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      const parsed = parseFileVersionCenterErrorResponseV1(payload);
      return new FileVersionActionError(
        parsed.error.code,
        parsed.error.message,
        response.status,
        parsed.error.retryable,
      );
    } catch {
      if (typeof failure.error === 'string') {
        return new FileVersionActionError(
          response.status === 401 || response.status === 403
            ? FILE_VERSION_CENTER_ERROR_CODES.accessDenied
            : response.status === 409
              ? FILE_VERSION_CENTER_ERROR_CODES.conflict
              : 'FVRC_ACTION_FAILED',
          failure.error,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
    }
  }
  return new FileVersionActionError(
    response.status === 401 || response.status === 403
      ? FILE_VERSION_CENTER_ERROR_CODES.accessDenied
      : response.status === 409
        ? FILE_VERSION_CENTER_ERROR_CODES.conflict
        : 'FVRC_ACTION_FAILED',
    'The document action could not be completed.',
    response.status,
    response.status === 429 || response.status >= 500,
  );
}

export class FileVersionActionController {
  private readonly actionKeys = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<FileVersionMutationResult>>();

  constructor(
    private readonly fetchImpl: typeof fetch | undefined = undefined,
    private readonly createKey: () => string = () => crypto.randomUUID(),
  ) {}

  private once<T extends FileVersionMutationResult>(identity: string, run: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(identity);
    if (active) return active as Promise<T>;
    const promise = run().finally(() => {
      if (this.inFlight.get(identity) === promise) this.inFlight.delete(identity);
    });
    this.inFlight.set(identity, promise);
    return promise;
  }

  private keyFor(identity: string): string {
    const existing = this.actionKeys.get(identity);
    if (existing) return existing;
    const created = this.createKey();
    this.actionKeys.set(identity, created);
    return created;
  }

  private async loadOperation(input: AgentActionInput): Promise<CollaborationAgentOperation> {
    let response: Response;
    try {
      response = await (this.fetchImpl ?? fetch)(
        `/api/files/collaboration/operations/${encodeURIComponent(input.operationId)}`,
        {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { [WORKSPACE_ID_HEADER]: input.workspaceId },
        },
      );
    } catch {
      throw new FileVersionActionError(
        'FVRC_TRANSPORT_ERROR',
        'The current proposal could not be reached.',
        0,
        true,
      );
    }
    const payload = await readJson(response);
    if (!response.ok) throw failureFrom(response, payload);
    const operation = (payload as { operation?: unknown }).operation;
    if (!isCollaborationOperation(operation) || operation.operationId !== input.operationId) {
      throw new FileVersionActionError(
        'FVRC_TRANSPORT_ERROR',
        'The current proposal response is invalid.',
        response.status,
        false,
      );
    }
    return operation;
  }

  private agentAction(
    action: 'accept' | 'reject',
    input: AgentActionInput,
  ): Promise<FileVersionAgentMutationResult> {
    const authScope = notebookQueryKey(input.workspaceId)[1];
    const identity = `agent:${input.workspaceId}:${input.operationId}:${action}:${input.reviewedProposalVersion ?? ''}`;
    return this.once(identity, async () => {
      const operation = await this.loadOperation(input);
      if (action === 'accept' && operation.proposalVersion !== input.reviewedProposalVersion) {
        throw new FileVersionActionError(
          'AGENT_PROPOSAL_CHANGED',
          'This proposal changed after it was reviewed. Reload it before accepting.',
          409,
          false,
        );
      }
      const prepared = prepareCollaborationAgentAction(
        action === 'reject' ? { ...operation, proposalVersion: null } : operation,
        action,
        this.actionKeys,
        this.createKey,
      );
      if (!prepared) {
        throw new FileVersionActionError(
          FILE_VERSION_CENTER_ERROR_CODES.conflict,
          'This proposal can no longer be changed. Reload the timeline.',
          409,
          false,
        );
      }
      let response: Response;
      try {
        response = await (this.fetchImpl ?? fetch)(
          `/api/files/collaboration/operations/${encodeURIComponent(input.operationId)}/${action}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              [WORKSPACE_ID_HEADER]: input.workspaceId,
            },
            body: JSON.stringify(prepared.body),
          },
        );
      } catch {
        throw new FileVersionActionError(
          'FVRC_TRANSPORT_ERROR',
          'The proposal action could not be reached.',
          0,
          true,
        );
      }
      const payload = await readJson(response);
      if (!response.ok || (payload as { success?: unknown }).success === false) {
        throw failureFrom(response, payload);
      }
      const receipt = (payload as { operation?: unknown }).operation;
      if (!isCollaborationActionReceipt(receipt, input.operationId)) {
        throw new FileVersionActionError(
          'FVRC_TRANSPORT_ERROR',
          'The proposal action response is invalid.',
          response.status,
          false,
        );
      }
      await invalidateReviewQueries(input.workspaceId, authScope);
      // Mutation routes return the persisted action receipt, while the GET route
      // owns the complete permission-aware operation projection used by the UI.
      const updated = await this.loadOperation(input);
      if (action === 'reject') {
        this.actionKeys.delete(prepared.key);
        return { action, outcome: 'rejected', operation: updated };
      }
      const outcome = collaborationAgentAcceptanceOutcome(updated);
      if (outcome === 'failed') {
        throw new FileVersionActionError(
          'FVRC_ACTION_FAILED',
          'The accepted proposal did not reach a valid persisted state.',
          409,
          false,
        );
      }
      this.actionKeys.delete(prepared.key);
      return { action, outcome, operation: updated };
    });
  }

  accept(input: AgentActionInput & { reviewedProposalVersion: string }): Promise<FileVersionAgentMutationResult> {
    return this.agentAction('accept', input);
  }

  reject(input: AgentActionInput): Promise<FileVersionAgentMutationResult> {
    return this.agentAction('reject', input);
  }

  restore(input: {
    target: FileVersionCenterTargetV1;
    revisionId: string;
    expectedCurrent: FileVersionCurrentFenceV1;
  }): Promise<FileVersionRestoreMutationResult> {
    const authScope = notebookQueryKey(input.target.workspaceId)[1];
    const fence = `${input.expectedCurrent.revisionId ?? ''}:${input.expectedCurrent.sha256}:${input.expectedCurrent.stateVectorHash ?? ''}`;
    const identity = `restore:${input.target.workspaceId}:${input.revisionId}:${fence}`;
    return this.once(identity, async () => {
      let response: Response;
      try {
        response = await (this.fetchImpl ?? fetch)(FILE_VERSION_CENTER_API_V1.restore, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            [WORKSPACE_ID_HEADER]: input.target.workspaceId,
          },
          body: JSON.stringify({
            contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
            target: input.target,
            revisionId: input.revisionId,
            expectedCurrent: input.expectedCurrent,
            idempotencyKey: this.keyFor(identity),
          }),
        });
      } catch {
        throw new FileVersionActionError(
          'FVRC_TRANSPORT_ERROR',
          'The restore action could not be reached.',
          0,
          true,
        );
      }
      const payload = await readJson(response);
      if (!response.ok) throw failureFrom(response, payload);
      try {
        const restored = parseFileVersionRestoreResponseV1(payload);
        await invalidateReviewQueries(input.target.workspaceId, authScope);
        this.actionKeys.delete(identity);
        return { action: 'restore', outcome: restored.outcome, response: restored };
      } catch {
        throw new FileVersionActionError(
          'FVRC_TRANSPORT_ERROR',
          'The restore response is invalid.',
          response.status,
          false,
        );
      }
    });
  }
}

export function buildContinueFileVersionHref(input: { workspaceId: string; path: string; locale?: string }): string {
  const parameters = new URLSearchParams({ workspaceId: input.workspaceId, path: input.path, chat: 'open' });
  const notebookPath = input.locale ? `/${encodeURIComponent(input.locale)}/notebook` : '/notebook';
  return `${notebookPath}?${parameters.toString()}`;
}

export const fileVersionActionController = new FileVersionActionController();
