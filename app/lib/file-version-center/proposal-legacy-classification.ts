import {
  PROPOSAL_GRAPH_LIMITS,
  PROPOSAL_GRAPH_ERROR_CODES,
  type ProposalGraphErrorCode,
} from './contracts/proposal-graph-v1';

/**
 * The legacy adapter is deliberately evidence-only.  It never reads or writes
 * document content and it never turns off the authoritative snapshot guard.
 */
export type LegacyTargetRepresentation = 'anchored' | 'rich_markdown';

export type LegacyImmutableProof = Readonly<{
  ref: string;
  sha256: string;
}>;

export type LegacyTargetEvidence = Readonly<{
  id: string;
  representation: LegacyTargetRepresentation;
  sourceProof?: LegacyImmutableProof | null;
  effectProof?: LegacyImmutableProof | null;
}>;

export type PendingLegacyOperation = Readonly<{
  operationId: string;
  originalTargetIds: readonly string[];
  appliedTargetIds: readonly string[];
  /** Durable receipt proving the already-applied subset, never inferred from UI state. */
  appliedEffectProof?: LegacyImmutableProof | null;
  targets: readonly LegacyTargetEvidence[];
}>;

export type LegacyClassificationStatus =
  | 'eligible_independent'
  | 'eligible_partial_remainder'
  | 'satisfied_elsewhere'
  | 'upgrade_required';

export type LegacyClassification = Readonly<{
  operationId: string;
  status: LegacyClassificationStatus;
  reasonCode: ProposalGraphErrorCode | null;
  remainingTargetIds: readonly string[];
}>;

const SHA256 = /^[a-f0-9]{64}$/;

function validProof(proof: LegacyImmutableProof | null | undefined): boolean {
  return Boolean(proof?.ref && SHA256.test(proof.sha256));
}

function result(
  operation: PendingLegacyOperation,
  status: LegacyClassificationStatus,
  reasonCode: ProposalGraphErrorCode | null,
  remainingTargetIds: readonly string[],
): LegacyClassification {
  return Object.freeze({ operationId: operation.operationId, status, reasonCode, remainingTargetIds: Object.freeze([...remainingTargetIds]) });
}

/** Classify a legacy operation without making it applicable or mutating state. */
export function classifyPendingLegacyOperation(operation: PendingLegacyOperation): LegacyClassification {
  const original = [...operation.originalTargetIds];
  const originalSet = new Set(original);
  const applied = [...operation.appliedTargetIds];
  const appliedSet = new Set(applied);
  const targetById = new Map(operation.targets.map((target) => [target.id, target]));

  if (!operation.operationId || original.length === 0 || original.length > PROPOSAL_GRAPH_LIMITS.legacyTargets
    || new Set(original).size !== original.length || appliedSet.size !== applied.length
    || operation.targets.length > PROPOSAL_GRAPH_LIMITS.legacyTargets
    || operation.targets.some((target) => !target.id || targetById.get(target.id) !== target)
    || applied.some((id) => !originalSet.has(id))) {
    return result(operation, 'upgrade_required', PROPOSAL_GRAPH_ERROR_CODES.upgradeRequired, []);
  }

  const remaining = original.filter((id) => !appliedSet.has(id));
  const declaredTargetIds = new Set(operation.targets.map((target) => target.id));
  if (declaredTargetIds.size !== operation.targets.length || original.some((id) => !declaredTargetIds.has(id))) {
    return result(operation, 'upgrade_required', PROPOSAL_GRAPH_ERROR_CODES.upgradeRequired, remaining);
  }

  if (remaining.length === 0) {
    if (!validProof(operation.appliedEffectProof)) {
      return result(operation, 'upgrade_required', PROPOSAL_GRAPH_ERROR_CODES.upgradeRequired, []);
    }
    return result(operation, 'satisfied_elsewhere', PROPOSAL_GRAPH_ERROR_CODES.noEffect, []);
  }

  if (applied.length > 0 && !validProof(operation.appliedEffectProof)) {
    return result(operation, 'upgrade_required', PROPOSAL_GRAPH_ERROR_CODES.upgradeRequired, remaining);
  }

  const hasUnsafeTarget = remaining.some((id) => {
    const target = targetById.get(id);
    // Rich markdown has no stable target identity. A whole-document snapshot
    // is never treated as an independently applicable legacy edit.
    return !target || target.representation !== 'anchored'
      || !validProof(target.sourceProof) || !validProof(target.effectProof);
  });
  if (hasUnsafeTarget) {
    return result(operation, 'upgrade_required', PROPOSAL_GRAPH_ERROR_CODES.upgradeRequired, remaining);
  }

  return result(
    operation,
    applied.length === 0 ? 'eligible_independent' : 'eligible_partial_remainder',
    null,
    remaining,
  );
}
