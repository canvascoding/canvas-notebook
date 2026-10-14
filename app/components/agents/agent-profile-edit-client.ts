import type { AgentProfile } from '@/app/lib/chat/types';
import type { AgentExtensionEditorContext, AgentExtensionEditorDraft, AgentExtensionEditorProps } from './AgentExtensionEditor';
import { DISABLED_ALL_TOOLS_SENTINEL, getDefaultEnabledToolNames, isDefaultToolsConfig,
  resolveEnabledToolNames, serializeEnabledToolNames } from '@/app/lib/pi/enabled-tools';

export type AgentProfileModelPatch = NonNullable<AgentExtensionEditorProps['model']>;
const MODEL_FIELDS = ['defaultProviderInstallationId', 'defaultProvider', 'defaultModel', 'defaultThinking'] as const;

/** Form display/editing preserves explicit none separately from registry defaults. */
export function resolveAgentFormToolDraft(allNames: readonly string[], configuration: readonly string[] | null): Set<string> {
  if (configuration?.includes(DISABLED_ALL_TOOLS_SENTINEL)) return new Set();
  return isDefaultToolsConfig(configuration ? [...configuration] : null)
    ? getDefaultEnabledToolNames(allNames) : resolveEnabledToolNames(allNames, configuration ? [...configuration] : null);
}

export function toggleAgentFormToolDraft(name: string, enabled: boolean, configuration: readonly string[] | null,
  allNames: readonly string[]): string[] {
  return toggleAgentFormToolsDraft([name], enabled, configuration, allNames);
}

/** Apply one user action atomically; legacy expansion must not run between individual bulk removals. */
export function toggleAgentFormToolsDraft(names: readonly string[], enabled: boolean, configuration: readonly string[] | null,
  allNames: readonly string[]): string[] {
  if (names.length === 0) return configuration ? [...configuration] : [];
  const selected = resolveAgentFormToolDraft(allNames, configuration);
  for (const name of names) {
    if (enabled) selected.add(name); else selected.delete(name);
  }
  return serializeEnabledToolNames(selected, allNames);
}

export function agentProfileModelFields(agent: AgentProfile): AgentProfileModelPatch {
  return Object.fromEntries(MODEL_FIELDS.map(field => [field, agent[field] ?? null]));
}

export function sameAgentProfileModelFields(left: AgentProfileModelPatch, right: AgentProfileModelPatch): boolean {
  return MODEL_FIELDS.every(field => (left[field] ?? null) === (right[field] ?? null));
}

/** Actual context goes to every read/write; actor IDs are cache identities, never request authority. */
export function agentProfileEditUrl(endpoint: string, context: AgentExtensionEditorContext,
  values: Record<string, string> = {}): string {
  if (!['/api/agents', '/api/agents/tools', '/api/agents/files', '/api/agents/delete-preview'].includes(endpoint)) {
    throw new Error('An Agent API endpoint is required.');
  }
  const params = new URLSearchParams(values);
  for (const field of ['workspaceId', 'organizationId', 'projectId'] as const) {
    if (context[field]) params.set(field, context[field]);
  }
  return `${endpoint}${params.size ? `?${params.toString()}` : ''}`;
}

/** A keep draft never translates legacy lists or reserializes unchanged runtime defaults. */
export function buildAgentProfileEditPatch(input: {
  agent: AgentProfile;
  name: string;
  iconId: string;
  extensions: AgentExtensionEditorDraft;
  workflowRevision: number | null;
  enabledTools?: string[] | null;
  model?: AgentProfileModelPatch;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = { agentId: input.agent.agentId, expectedRevision: input.agent.revision ?? 1 };
  if (input.name !== input.agent.name) patch.name = input.name;
  if (input.iconId !== (input.agent.iconId || 'bot')) patch.iconId = input.iconId;
  if (input.enabledTools !== undefined) patch.enabledTools = input.enabledTools;
  if (input.model !== undefined) Object.assign(patch, input.model);
  if (input.extensions.intent === 'replace') {
    if (!input.extensions.configuration || input.workflowRevision === null
      || !Number.isSafeInteger(input.workflowRevision) || input.workflowRevision < 0) {
      throw new Error('Reload the actual extension configuration before replacing it.');
    }
    patch.extensions = input.extensions.configuration;
    patch.expectedWorkflowRevision = input.workflowRevision;
  }
  return patch;
}
