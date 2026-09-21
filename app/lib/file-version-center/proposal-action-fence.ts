import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  PROPOSAL_GRAPH_LIMITS,
  ProposalGraphContractError,
  parseProposalActionFenceV1,
  parseProposalPreparedActionV1,
  type ProposalActionFenceV1,
  type ProposalCreateRequestV1,
} from './contracts/proposal-graph-v1';

export type ProposalFenceState = Pick<ProposalActionFenceV1,
  'scope' | 'actor' | 'actionType' | 'current' | 'graphRevision' | 'evaluationId'
  | 'effectiveCandidateHash' | 'closure' | 'selectedProposalIds' | 'applyProposalIds' | 'choiceResolutions'>;

function fail(code: typeof Codes[keyof typeof Codes], message: string): never {
  throw new ProposalGraphContractError(code, message);
}

/** Canonical JSON for bounded proof metadata; never accepts executable/prototype data. */
export function canonicalProposalJson(value: unknown): string {
  let visited = 0;
  let stringBytes = 0;
  const ancestors = new Set<object>();
  const text = (value: string) => {
    stringBytes += Buffer.byteLength(value, 'utf8');
    if (stringBytes > PROPOSAL_GRAPH_LIMITS.payloadBytes) fail(Codes.limitExceeded, 'Proposal proof exceeds its byte budget.');
    return value;
  };
  const normalize = (value: unknown, depth: number): unknown => {
    if (++visited > 100_000 || depth > 32) fail(Codes.limitExceeded, 'Proposal proof exceeds its structure budget.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) fail(Codes.invalidRequest, 'Proposal proof must be acyclic JSON.');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail(Codes.invalidRequest, 'Proposal proof must contain only plain JSON objects.');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 100_000) fail(Codes.limitExceeded, 'Proposal proof array exceeds its budget.');
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, index);
          if (!descriptor || !('value' in descriptor)) fail(Codes.invalidRequest, 'Proposal proof cannot contain holes or getters.');
          return normalize(descriptor.value, depth + 1);
        });
      }
      const keys = Object.keys(value).sort();
      if (keys.length > 100_000) fail(Codes.limitExceeded, 'Proposal proof object exceeds its budget.');
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) fail(Codes.invalidRequest, 'Proposal proof cannot contain getters.');
        result[text(key)] = normalize(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  const result = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(result, 'utf8') > PROPOSAL_GRAPH_LIMITS.payloadBytes) fail(Codes.limitExceeded, 'Encoded proposal proof exceeds its byte budget.');
  return result;
}

export function hashProposalValue(value: unknown): string {
  return createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
}

/**
 * Binds an evaluated candidate to the exact graph selection it previewed. The
 * arrays are intentionally ordered: their order is part of the approved work.
 */
export function hashProposalEvaluationSelectionV1(input: {
  selectedProposalIds: readonly string[];
  closureProposalIds: readonly string[];
  applyProposalIds: readonly string[];
  graphRevision: number;
}): string {
  return hashProposalValue({
    purpose: 'proposal-evaluation-selection-v1',
    selectedProposalIds: input.selectedProposalIds,
    closureProposalIds: input.closureProposalIds,
    applyProposalIds: input.applyProposalIds,
    graphRevision: input.graphRevision,
  });
}

function batchHash(state: ProposalFenceState, creation: ProposalCreateRequestV1 | null): string {
  return hashProposalValue({ purpose: 'proposal-batch-v1', scope: state.scope, actionType: state.actionType,
    selectedProposalIds: state.selectedProposalIds, applyProposalIds: state.applyProposalIds,
    choiceResolutions: state.choiceResolutions, effectiveCandidateHash: state.effectiveCandidateHash, creation });
}

function requestDigest(fence: Omit<ProposalActionFenceV1, 'requestDigest'>, creation: ProposalCreateRequestV1 | null): string {
  return hashProposalValue({ purpose: 'proposal-action-request-v1', fence, creation });
}

/** Pure issuance: the orchestrator supplies identity, time, authorization and evaluated closure. */
export function buildProposalActionFence(input: {
  state: ProposalFenceState;
  fenceId: string;
  now: number;
  expiresAt?: number;
  creation?: ProposalCreateRequestV1 | null;
}): ProposalActionFenceV1 {
  const creation = input.creation ?? null;
  // Round-trip through canonical JSON also detaches caller-owned mutable objects.
  const state = JSON.parse(canonicalProposalJson(input.state)) as ProposalFenceState;
  const expiresAt = Math.min(input.expiresAt ?? input.now + PROPOSAL_GRAPH_LIMITS.fenceLifetimeMs,
    input.now + PROPOSAL_GRAPH_LIMITS.fenceLifetimeMs);
  if (expiresAt <= input.now) fail(Codes.fenceExpired, 'The evaluated proposal is no longer current.');
  const fields = { contractVersion: 1 as const, fenceId: input.fenceId, ...state,
    closureHash: hashProposalValue(state.closure), batchHash: batchHash(state, creation),
    issuedAt: input.now, expiresAt };
  const fence = parseProposalActionFenceV1({ ...fields, requestDigest: requestDigest(fields, creation) });
  parseProposalPreparedActionV1({ fence, creation });
  return fence;
}

function key(secret: string | Uint8Array): Buffer {
  const value = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (value.byteLength < 32) fail(Codes.accessDenied, 'Proposal approval signing is unavailable.');
  return value;
}

/** The runtime supplies its existing protected signing secret; no secret appears in the fence. */
export function signProposalActionFence(fence: ProposalActionFenceV1, secret: string | Uint8Array): string {
  parseProposalActionFenceV1(fence);
  const signature = createHmac('sha256', key(secret)).update('canvas.proposal.approval.v1\n')
    .update(canonicalProposalJson(fence)).digest('base64url');
  return `pg1.${signature}`;
}

/**
 * A valid signature is not permission to mutate. Reauthorize first and supply the
 * freshly read state. This rejects stale approval; it never refreshes and applies.
 * Completed retries must be answered from their durable receipt before this gate.
 */
export function verifyProposalActionFence(input: {
  fence: unknown;
  token: string;
  expected: ProposalFenceState;
  creation?: ProposalCreateRequestV1 | null;
  secret: string | Uint8Array;
  now: number;
}): ProposalActionFenceV1 {
  const fence = parseProposalActionFenceV1(input.fence);
  const signed = signProposalActionFence(fence, input.secret);
  if (typeof input.token !== 'string' || !/^pg1\.[A-Za-z0-9_-]{43}$/.test(input.token)
    || !timingSafeEqual(Buffer.from(signed, 'utf8'), Buffer.from(input.token, 'utf8'))) {
    fail(Codes.accessDenied, 'Proposal approval is invalid.');
  }
  const creation = input.creation ?? null;
  parseProposalPreparedActionV1({ fence, creation });
  const { requestDigest: digest, ...fields } = fence;
  if (digest !== requestDigest(fields, creation) || fence.closureHash !== hashProposalValue(fence.closure)
    || fence.batchHash !== batchHash(fence, creation)) fail(Codes.invalidRequest, 'Approved request identity does not match its content.');
  if (!Number.isSafeInteger(input.now) || input.now < fence.issuedAt || input.now >= fence.expiresAt) fail(Codes.fenceExpired, 'Proposal approval expired.');
  const expected = input.expected;
  if (hashProposalValue(fence.actor) !== hashProposalValue(expected.actor)) fail(Codes.accessDenied, 'Proposal authorization changed.');
  if (fence.scope.workspaceId !== expected.scope.workspaceId || fence.scope.lineageId !== expected.scope.lineageId
    || fence.scope.documentId !== expected.scope.documentId) fail(Codes.scopeMismatch, 'Proposal approval belongs to another document.');
  if (fence.scope.lifecycleGeneration !== expected.scope.lifecycleGeneration || fence.scope.schemaVersion !== expected.scope.schemaVersion) {
    fail(Codes.staleLifecycle, 'Proposal belongs to a different document lifecycle.');
  }
  if (fence.graphRevision !== expected.graphRevision || fence.closureHash !== hashProposalValue(expected.closure)) {
    fail(Codes.graphChanged, 'Proposal graph changed; review a fresh comparison.');
  }
  if (hashProposalValue(fence.current) !== hashProposalValue(expected.current)) fail(Codes.currentChanged, 'Document changed; review a fresh comparison.');
  if (fence.evaluationId !== expected.evaluationId || fence.effectiveCandidateHash !== expected.effectiveCandidateHash) {
    fail(Codes.candidateChanged, 'The reviewed candidate changed.');
  }
  if (fence.batchHash !== batchHash(expected, creation)) fail(Codes.invalidRequest, 'The action or its displayed effects changed.');
  return fence;
}
