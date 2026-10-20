import { agentExtensionOptionsRequestSchema, type AgentExtensionOptionsRequest,
  type AgentExtensionOptionsResponse, type AgentExtensionOptionsTarget } from '@/app/lib/agents/extension-options-contracts';
import type { AgentExtensionEditorContext } from './AgentExtensionEditor';

export class AgentExtensionOptionsClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'AgentExtensionOptionsClientError'; }
}

export function agentExtensionEditorContextKey(context: AgentExtensionEditorContext, target: AgentExtensionOptionsTarget): string {
  return JSON.stringify([context.actorId ?? null, context.workspaceId, context.organizationId ?? null, context.projectId ?? null, target]);
}
export function agentExtensionOptionsContextUrl(path: string, context: AgentExtensionEditorContext): string {
  const query = new URLSearchParams();
  for (const key of ['workspaceId', 'organizationId', 'projectId'] as const) {
    if (context[key] != null) query.set(key, context[key]);
  }
  return `${path}${query.size ? `?${query}` : ''}`;
}
export async function requestAgentExtensionOptions<R extends AgentExtensionOptionsRequest>(context: AgentExtensionEditorContext,
  input: R, signal?: AbortSignal): Promise<Extract<AgentExtensionOptionsResponse, { operation: R['operation'] }>> {
  const request = agentExtensionOptionsRequestSchema.parse(input);
  const response = await fetch(agentExtensionOptionsContextUrl('/api/agents/extension-options', context), {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const body = await response.json() as { success?: boolean; code?: string; error?: string; data?: AgentExtensionOptionsResponse };
  if (!response.ok || body.success !== true || !body.data) throw new AgentExtensionOptionsClientError(response.status,
    body.code || 'AGENT_EXTENSION_OPTIONS_UNAVAILABLE', body.error || body.code || `HTTP ${response.status}`);
  const data = body.data;
  if (data.schemaVersion !== 1 || data.operation !== request.operation || !data.contextKey
    || JSON.stringify(data.target) !== JSON.stringify(request.target) || !Array.isArray(data.coverage)
    || data.operation === 'search' && (!Array.isArray(data.items) || !data.scopes || !data.pagination)
    || data.operation === 'connection_choices' && (!Array.isArray(data.connections) || !Array.isArray(data.profiles) || !Array.isArray(data.accounts)
      || !data.pagination || request.operation !== 'connection_choices' || JSON.stringify(data.selector) !== JSON.stringify(request.selector))
    || data.operation === 'package_version' && (!data.package || request.operation !== 'package_version'
      || data.package.pin.resourceRef !== request.resourceRef || data.package.pin.publishedRevisionRef !== request.publishedRevisionRef
      || request.checksum !== undefined && data.package.pin.checksum !== request.checksum)
    || data.operation === 'preview' && (!data.preview || !Array.isArray(data.preview.issues))) {
    throw new AgentExtensionOptionsClientError(409, 'AGENT_EXTENSION_OPTIONS_REPLY_INVALID', 'Invalid extension options response.');
  }
  return data as Extract<AgentExtensionOptionsResponse, { operation: R['operation'] }>;
}
