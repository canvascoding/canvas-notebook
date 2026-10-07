import { createHash } from 'node:crypto';
import { decisionProviderRegistry } from './registry.js';
import type { DecisionInput, DecisionProviderCapabilities, DecisionProviderConfiguration, DecisionResult } from './types.js';

export const MANAGED_DECISION_CONTRACT_VERSION = 1 as const;

export function decisionInferenceRevision(configuration: DecisionProviderConfiguration, modelRevision = '1'): string {
  const provider = decisionProviderRegistry.get(configuration.providerId);
  return `sha256:${createHash('sha256').update(JSON.stringify({
    providerId: configuration.providerId, model: configuration.model, endpoint: configuration.endpoint ?? null, modelRevision,
    adapterVersion: provider?.adapterVersion, capabilities: provider?.capabilities,
  })).digest('hex')}`;
}

export type ManagedDecisionModelStatus = 'ready' | 'missing_credentials' | 'configuration_unavailable' | 'missing_pricing';

export type ManagedDecisionModel = {
  ref: string;
  name: string;
  providerId: string;
  model: string;
  inferenceRevision: string;
  adapterVersion: string;
  capabilities: DecisionProviderCapabilities;
  status: ManagedDecisionModelStatus;
  available: boolean;
  timeoutMs: number;
};

export type ManagedDecisionCatalog = {
  contractVersion: typeof MANAGED_DECISION_CONTRACT_VERSION;
  catalogRevision: string;
  defaultModelRef: string | null;
  models: ManagedDecisionModel[];
};

export type ManagedDecisionRequest = {
  contractVersion: typeof MANAGED_DECISION_CONTRACT_VERSION;
  modelRef: string;
  inferenceRevision: string;
  schemaVersion: string;
  state: DecisionInput['state'];
  questions: DecisionInput['questions'];
  requestId: string;
};

export type ManagedDecisionResponse = {
  contractVersion: typeof MANAGED_DECISION_CONTRACT_VERSION;
  requestId: string;
  modelRef: string;
  inferenceRevision: string;
  result: DecisionResult;
};

export type ManagedDecisionFailureCode = 'missing_connection' | 'authentication_failed' | 'scope_denied' | 'entitlement_denied'
  | 'budget_exhausted' | 'model_changed' | 'missing_configuration' | 'invalid_request' | 'unsupported_capability'
  | 'invalid_response' | 'refused' | 'endpoint_rejected' | 'timeout' | 'aborted' | 'rate_limited' | 'provider_error'
  | 'in_progress' | 'outcome_unknown' | 'request_conflict' | 'provider_unavailable';

export type ManagedDecisionFailure = {
  error: string;
  code: ManagedDecisionFailureCode;
  retryable: boolean;
  retryAfterMs?: number;
  requestId?: string;
  canReissue?: boolean;
};
