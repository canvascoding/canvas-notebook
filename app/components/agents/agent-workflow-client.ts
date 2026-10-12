import type { AgentWorkflowDescriptor } from '@/app/lib/agents/workflow-contracts';
import type { AgentWorkflowPersonalOptions } from '@/app/lib/agents/workflow-personal-options';

export type AgentWorkflowCapabilityView = AgentWorkflowDescriptor['packages'][number]['declarations'][number]['capabilities'][number];
export type AgentWorkflowChoiceContext = Readonly<{ workspaceId: string | null; organizationId?: string | null;
  projectId?: string | null; actorId?: string | null }>;
export class AgentWorkflowClientError extends Error {
  constructor(readonly status: number, readonly code: string) { super('Workflow request failed.'); }
}
export function agentWorkflowUrl(agentId: string, scope?: string | null | AgentWorkflowChoiceContext): string {
  const query = new URLSearchParams({ agentId });
  const context: Partial<AgentWorkflowChoiceContext> = typeof scope === 'object' && scope !== null ? scope : { workspaceId: scope };
  for (const key of ['workspaceId', 'organizationId', 'projectId'] as const) {
    if (context[key]) query.set(key, context[key]);
  }
  return `/api/agents/workflow?${query}`;
}
export function workflowSelectionValue(capability: AgentWorkflowCapabilityView): string {
  if (capability.selectionOrigin === 'stale') return 'unavailable';
  if (capability.selectionOrigin === 'default') return 'default';
  if (capability.selectedKind === 'personal') return 'personal';
  return capability.selectedChoiceId ? `choice:${encodeURIComponent(capability.selectedChoiceId)}` : 'default';
}
export function retainWorkflowDrafts(previous: Record<string, string>, descriptor: AgentWorkflowDescriptor): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pkg of descriptor.packages) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
    const draft = previous[capability.capabilityKey];
    result[capability.capabilityKey] = draft === 'default' || capability.choices.some(choice => choice.availability === 'available'
      && `choice:${encodeURIComponent(choice.choiceId)}` === draft) ? draft : workflowSelectionValue(capability);
  }
  return result;
}
export async function requestWorkflow<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; code?: string } | null;
  if (!response.ok || !payload?.success || !payload.data) throw new AgentWorkflowClientError(response.status, payload?.code || 'WORKFLOW_REQUEST_FAILED');
  return payload.data;
}
function validWorkflowReply(value: AgentWorkflowDescriptor, agentId: string): boolean {
  return Boolean(value && value.agentId === agentId && Number.isSafeInteger(value.revision) && value.revision > 0
    && Number.isSafeInteger(value.workflowRevision) && value.workflowRevision >= 0
    && Number.isSafeInteger(value.preferenceRevision) && value.preferenceRevision >= 0
    && (value.workflowVersion === null || value.workflowVersion === 1) && Array.isArray(value.packages));
}
export async function readAgentWorkflow(agentId: string, scope?: string | null | AgentWorkflowChoiceContext, signal?: AbortSignal): Promise<AgentWorkflowDescriptor> {
  const data = await requestWorkflow<AgentWorkflowDescriptor>(agentWorkflowUrl(agentId, scope), { signal });
  if (!validWorkflowReply(data, agentId)) throw new AgentWorkflowClientError(409, 'WORKFLOW_REPLY_INVALID');
  return data;
}
export type AgentWorkflowPersonalSelectionInput = { alternativeKey: string; target: { kind: 'personal'; source: 'mcp' | 'composio';
  providerRef: string; accountSelectionRef?: string } };
export async function saveAgentWorkflowChoice(input: { agentId: string; workspaceId?: string | null; context?: AgentWorkflowChoiceContext; capabilityKey: string;
  expectedWorkflowRevision: number; expectedPreferenceRevision: number } & ({ choiceId: string | null } | { personalSelection: AgentWorkflowPersonalSelectionInput }), signal?: AbortSignal): Promise<AgentWorkflowDescriptor> {
  const { workspaceId, context, ...body } = input;
  const data = await requestWorkflow<AgentWorkflowDescriptor>(agentWorkflowUrl(input.agentId, context === undefined ? workspaceId : context), { method: 'PATCH', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!validWorkflowReply(data, body.agentId) || data.workflowRevision !== body.expectedWorkflowRevision
    || data.preferenceRevision !== body.expectedPreferenceRevision + 1) throw new AgentWorkflowClientError(409, 'WORKFLOW_REPLY_INVALID');
  return data;
}
export async function readAgentWorkflowPersonalOptions(input: { agentId: string; workspaceId?: string | null; context?: AgentWorkflowChoiceContext; capabilityKey: string;
  expectedWorkflowRevision: number; alternativeKey?: string; providerRef?: string }, signal?: AbortSignal): Promise<AgentWorkflowPersonalOptions> {
  const url = new URL(agentWorkflowUrl(input.agentId, input.context === undefined ? input.workspaceId : input.context), 'http://canvas.invalid');
  url.searchParams.set('view', 'personal-options'); url.searchParams.set('capabilityKey', input.capabilityKey);
  url.searchParams.set('expectedWorkflowRevision', String(input.expectedWorkflowRevision));
  if (input.alternativeKey) url.searchParams.set('alternativeKey', input.alternativeKey);
  if (input.providerRef) url.searchParams.set('providerRef', input.providerRef);
  const data = await requestWorkflow<AgentWorkflowPersonalOptions>(`${url.pathname}${url.search}`, { signal });
  if (data.agentId !== input.agentId || data.capabilityKey !== input.capabilityKey || data.workflowRevision !== input.expectedWorkflowRevision
    || !Number.isSafeInteger(data.preferenceRevision) || data.preferenceRevision < 0 || !Array.isArray(data.alternatives)) {
    throw new AgentWorkflowClientError(409, 'WORKFLOW_REPLY_INVALID');
  }
  return data;
}
