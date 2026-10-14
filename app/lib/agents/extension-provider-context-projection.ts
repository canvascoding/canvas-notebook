import 'server-only';

import type { IntegrationPolicy, IntegrationProviderDescriptor, IntegrationProviderToolRule } from '@/app/lib/integration-tools/contracts';
import type { AgentStandaloneRuntimeSelection } from '@/app/lib/capabilities/extensions/standalone-runtime';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { AgentWorkflowError } from './workflow-contracts';
import type { AgentWorkflowRuntimeProjection } from './workflow-runtime';

const OPERATIONS = ['list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call'] as const;
type RequiredProvider = Readonly<{ source: 'mcp' | 'composio'; providerRef: string }>;
export type AgentExtensionProviderContext = Readonly<{
  projection: AgentWorkflowRuntimeProjection;
  requiredProviders: readonly RequiredProvider[];
}>;
export type AgentExtensionProviderContextChoice = Readonly<{
  /** The caller must authorize its exact source; this callback issues no runtime authority. */
  resolve: () => Promise<{ descriptor: IntegrationProviderDescriptor; toolCap: readonly string[] | null }>;
}>;
export type AgentExtensionProviderContextProjectionInput = Readonly<{
  capabilities: readonly Readonly<{ required: boolean; choice: AgentExtensionProviderContextChoice | null }>[];
  standalone: readonly Readonly<{ summary: AgentStandaloneRuntimeSelection; choice: AgentExtensionProviderContextChoice | null }>[];
  revisionSeed: unknown;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/**
 * Shared metadata projection, with runtime-equivalent missing/optional selection
 * semantics. Only the supplied, freshly authorized callbacks can read a source.
 * No Agent, session, SQL frame, stored target or runtime issuer is constructed.
 */
export async function projectAgentExtensionProviderContext(input: AgentExtensionProviderContextProjectionInput): Promise<AgentExtensionProviderContext> {
  const descriptors = new Map<string, IntegrationProviderDescriptor>();
  const rules = new Map<string, IntegrationProviderToolRule>();
  const required = new Map<string, RequiredProvider>();
  const summaries = input.standalone.map(entry => structuredClone(entry.summary));
  let unavailable = input.capabilities.some(entry => entry.required && !entry.choice);
  const missingStandalone = input.standalone.some(entry => entry.summary.required && !entry.choice);
  const include = async (choice: AgentExtensionProviderContextChoice, isRequired: boolean): Promise<string> => {
    const resolved = await choice.resolve();
    // A presentation must not retain another object's provider authority or
    // accidentally turn cached readiness into a live health assertion.
    const descriptor: IntegrationProviderDescriptor = { ...structuredClone(resolved.descriptor), state: 'unknown', configured: true,
      requiresAuth: 'unknown', authorized: 'unknown', health: 'unknown', canExecute: false, checkedAt: null, statusSource: 'configuration' };
    const prior = rules.get(descriptor.providerRef), permitted = resolved.toolCap;
    if (prior && prior.source !== descriptor.source) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_BINDING_INVALID', 'One exact provider reference cannot identify different sources.', 409);
    }
    const names = prior ? prior.allowedToolNames === null || permitted === null ? null
      : [...new Set([...prior.allowedToolNames, ...permitted])].sort() : permitted === null ? null : [...permitted];
    rules.set(descriptor.providerRef, { source: descriptor.source, providerRef: descriptor.providerRef, allowedToolNames: names,
      allowedOperations: names?.length === 0 ? OPERATIONS.filter(operation => operation !== 'call') : [...OPERATIONS] });
    descriptors.set(descriptor.providerRef, descriptor);
    if (isRequired) required.set(descriptor.providerRef, { source: descriptor.source, providerRef: descriptor.providerRef });
    return descriptor.providerRef;
  };
  if (!unavailable) for (const entry of input.capabilities) {
    if (!entry.choice) continue;
    try { await include(entry.choice, entry.required); }
    catch { if (entry.required) { unavailable = true; break; } }
  }
  if (!missingStandalone && !unavailable) for (let index = 0; index < input.standalone.length; index++) {
    const entry = input.standalone[index];
    if (!entry.choice) continue;
    try { summaries[index] = { ...summaries[index], providerRef: await include(entry.choice, entry.summary.required) }; }
    catch { unavailable ||= entry.summary.required; summaries[index] = { ...summaries[index], state: 'unavailable' }; }
  }
  unavailable ||= missingStandalone;
  const policy: IntegrationPolicy = { allowedSources: null, allowedProviderRefs: null, allowedApplications: null,
    allowedToolNames: null, allowedOperations: null,
    providerToolRules: unavailable ? [] : [...rules.values()].sort((a, b) => a.providerRef.localeCompare(b.providerRef)) };
  const projection: AgentWorkflowRuntimeProjection = { policy,
    revision: schemaFingerprint([input.revisionSeed, summaries, policy, unavailable]),
    selectedProviders: unavailable ? [] : [...descriptors.values()], standaloneSelections: summaries, unavailable };
  return freeze({ projection, requiredProviders: unavailable ? [] : [...required.values()] });
}
