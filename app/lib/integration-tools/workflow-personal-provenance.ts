import type { IntegrationExecutionContext, IntegrationProviderDescriptor } from './contracts';

type Prepared = { kind: string; source: string; boundProviderRef: string };
type HostState = {
  contexts: WeakMap<object, { namespace: string; prepared: ReadonlyMap<string, Prepared> }>;
  prepared: WeakMap<object, { expiresAt: number; target: { boundProviderRef: string; binding: { source: string } };
    resolved: { provider: IntegrationProviderDescriptor } }>;
};

/** Reads server-issued provenance without importing credentials, storage or provider clients. */
export function getAttachedPersonalWorkflowProviderDescriptor(context: IntegrationExecutionContext,
  providerRef: string): IntegrationProviderDescriptor | null {
  if (!/^(mcp|composio):v1:personal:[a-f0-9]{64}$/u.test(providerRef)) return null;
  const state = (globalThis as typeof globalThis & { __canvasPersonalWorkflowProvidersV1?: HostState }).__canvasPersonalWorkflowProvidersV1;
  const contextProof = state?.contexts.get(context);
  if (!contextProof || contextProof.namespace !== JSON.stringify([context.actorUserId, context.organizationId ?? null,
    context.workspaceId ?? null, context.agentId ?? null, context.sessionId ?? null, context.policyRevision])) return null;
  const prepared = contextProof.prepared.get(providerRef);
  const record = prepared && state?.prepared.get(prepared);
  if (!prepared || !record || record.expiresAt <= Date.now() || prepared.kind !== 'prepared_personal_workflow_provider_target'
    || prepared.boundProviderRef !== providerRef || record.target.boundProviderRef !== providerRef
    || prepared.source !== record.target.binding.source || record.resolved.provider.providerRef !== providerRef) return null;
  return structuredClone(record.resolved.provider);
}
