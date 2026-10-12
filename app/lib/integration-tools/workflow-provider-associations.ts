import type { IntegrationExecutionContext, IntegrationSourceSnapshot } from './contracts';
import { transferIntegrationProviderAuthorization } from './connections/provider-authorization';

export type WorkflowProviderAssociation = Readonly<{ providerRef: string; aliases: readonly string[];
  pluginRefs: readonly string[]; skillRefs: readonly string[]; capabilityRefs: readonly string[] }>;
type Associations = { namespace: string; entries: ReadonlyMap<string, WorkflowProviderAssociation> };
const host = globalThis as typeof globalThis & { __canvasWorkflowProviderAssociationsV1?: WeakMap<object, Associations> };
const associations = host.__canvasWorkflowProviderAssociationsV1 ??= new WeakMap<object, Associations>();
function namespace(context: IntegrationExecutionContext): string {
  return JSON.stringify([context.actorUserId, context.organizationId ?? null, context.workspaceId ?? null,
    context.agentId ?? null, context.sessionId ?? null, context.policyRevision]);
}

/** Descriptive links from verified instance bindings. They never set application, scope, health or permissions. */
export function attachWorkflowProviderAssociations(context: IntegrationExecutionContext, entries: readonly WorkflowProviderAssociation[]): void {
  associations.set(context, { namespace: namespace(context), entries: new Map(entries.map(entry => [entry.providerRef,
    Object.freeze({ ...entry, aliases: Object.freeze([...entry.aliases]), pluginRefs: Object.freeze([...entry.pluginRefs]),
      skillRefs: Object.freeze([...entry.skillRefs]), capabilityRefs: Object.freeze([...entry.capabilityRefs]) })])) });
}
export function transferWorkflowProviderAssociations(original: IntegrationExecutionContext, copied: IntegrationExecutionContext): void {
  const proof = associations.get(original);
  if (proof && proof.namespace === namespace(original) && proof.namespace === namespace(copied)) associations.set(copied, proof);
}
export function projectWorkflowProviderAssociations(context: IntegrationExecutionContext, snapshot: IntegrationSourceSnapshot): IntegrationSourceSnapshot {
  const proof = associations.get(context);
  if (!proof || proof.namespace !== namespace(context)) return snapshot;
  return { ...snapshot, providers: snapshot.providers.map(provider => {
    const entry = proof.entries.get(provider.providerRef);
    if (!entry) return provider;
    return transferIntegrationProviderAuthorization(context, provider, { ...provider,
      aliases: [...new Set([...(provider.aliases ?? []), ...entry.aliases])],
      pluginRefs: [...new Set([...provider.pluginRefs, ...entry.pluginRefs])],
      skillRefs: [...new Set([...provider.skillRefs, ...entry.skillRefs])],
      capabilityRefs: [...new Set([...(provider.capabilityRefs ?? []), ...entry.capabilityRefs])] });
  }) };
}
