import type { IntegrationPolicy } from './contracts';
import { IntegrationContractError } from './contracts';
import type { IntegrationAdapterToolSchema } from './runtime-contracts';
import { cloneIntegrationArguments } from './schema';

export const MAX_DELEGATED_INTEGRATION_BINDINGS = 8;
export type IntegrationBindingSelection = { toolRef: string; schemaRef: string };
export type DelegatedComposioToolBinding = {
  providerRef: string;
  toolName: string;
  bindingRevision: string;
  tool: IntegrationAdapterToolSchema;
};

/** Private persisted metadata. SDK bindings, credentials, provider user IDs and clients are excluded. */
export type PrivateDelegatedIntegrationSnapshot = {
  version: 1;
  parent: {
    actorUserId: string;
    organizationId: string | null;
    workspaceId: string;
    sessionId: string;
    agentId: string;
    policyRevision: string;
    policy: IntegrationPolicy;
    agentTurnId: string | null;
  };
  bindings: DelegatedComposioToolBinding[];
};

/** Returned only to server orchestration after checking persisted ownership and the unique active task. */
export type IntegrationDelegationTaskBinding = {
  id: string;
  userId: string;
  sourceSessionId: string;
  sourceAgentId: string;
  sourceAgentTurnId: string | null;
  workerSessionId: string;
  targetAgentId: string | null;
  workerType: 'managed' | 'ephemeral';
  toolsetsJson: string;
  integrationBindingsJson: string | null;
};

function denied(): never {
  throw new IntegrationContractError('provider_denied', 'The approved integration binding is unavailable. Ask the delegating agent to refresh it.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return denied();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) denied();
}

function nonempty(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseIntegrationBindingSelections(value: unknown): IntegrationBindingSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DELEGATED_INTEGRATION_BINDINGS) return denied();
  return value.map(item => {
    const entry = record(item);
    keys(entry, ['toolRef', 'schemaRef']);
    if (!nonempty(entry.toolRef) || !entry.toolRef.startsWith('tool:v1:')
      || !nonempty(entry.schemaRef) || !entry.schemaRef.startsWith('schema:v1:')) return denied();
    return { toolRef: entry.toolRef, schemaRef: entry.schemaRef };
  });
}

export function readPrivateDelegatedIntegrationSnapshot(value: unknown): PrivateDelegatedIntegrationSnapshot {
  let captured: Record<string, unknown>;
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) return denied();
      value = JSON.parse(value);
    }
    captured = cloneIntegrationArguments(record(value));
  } catch { return denied(); }
  keys(captured, ['version', 'parent', 'bindings']);
  if (captured.version !== 1 || !Array.isArray(captured.bindings)
    || captured.bindings.length < 1 || captured.bindings.length > MAX_DELEGATED_INTEGRATION_BINDINGS) return denied();
  const parent = record(captured.parent);
  keys(parent, ['actorUserId', 'organizationId', 'workspaceId', 'sessionId', 'agentId', 'policyRevision', 'policy', 'agentTurnId']);
  for (const field of ['actorUserId', 'workspaceId', 'sessionId', 'agentId', 'policyRevision']) if (!nonempty(parent[field])) denied();
  if (parent.organizationId !== null && !nonempty(parent.organizationId)) return denied();
  if (parent.agentTurnId !== null && !nonempty(parent.agentTurnId)) return denied();
  const policy = record(parent.policy);
  const policyKeys = ['allowedSources', 'allowedProviderRefs', 'allowedApplications', 'allowedToolNames', 'allowedOperations'];
  keys(policy, policyKeys);
  for (const field of policyKeys) {
    const entry = policy[field];
    if (entry !== null && (!Array.isArray(entry) || entry.length > 2048 || entry.some(item => !nonempty(item)))) denied();
  }
  for (const item of captured.bindings) {
    const binding = record(item);
    keys(binding, ['providerRef', 'toolName', 'bindingRevision', 'tool']);
    if (!nonempty(binding.providerRef) || !binding.providerRef.startsWith('composio:v1:')
      || !nonempty(binding.toolName) || !nonempty(binding.bindingRevision)) return denied();
    const tool = record(binding.tool);
    keys(tool, ['name', 'description', 'effect', 'inputSchema', 'outputSchema', 'toolVersion', 'providerSchemaRevision']);
    if (tool.name !== binding.toolName || typeof tool.description !== 'string' || tool.description.length > 100_000
      || !nonempty(tool.toolVersion) || (tool.effect !== undefined && !['read', 'write', 'unknown'].includes(tool.effect as string))
      || (tool.providerSchemaRevision !== undefined && !nonempty(tool.providerSchemaRevision))) return denied();
    for (const field of ['inputSchema', 'outputSchema']) {
      const schema = tool[field];
      if (field === 'outputSchema' && schema === undefined) continue;
      if (typeof schema !== 'boolean') record(schema);
    }
  }
  return captured as unknown as PrivateDelegatedIntegrationSnapshot;
}

export function serializeDelegatedIntegrationSnapshot(value: PrivateDelegatedIntegrationSnapshot): string {
  return JSON.stringify(readPrivateDelegatedIntegrationSnapshot(value));
}
