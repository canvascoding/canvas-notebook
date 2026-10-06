import type { AgentWorkflowDescriptor } from '@/app/lib/agents/workflow-contracts';
import type { AgentWorkflowPersonalOptions } from '@/app/lib/agents/workflow-personal-options';

export type AgentWorkflowCapabilityView = AgentWorkflowDescriptor['packages'][number]['declarations'][number]['capabilities'][number];
export class AgentWorkflowClientError extends Error {
  constructor(readonly status: number, readonly code: string) { super('Workflow request failed.'); }
}
export function agentWorkflowUrl(agentId: string, workspaceId?: string | null): string {
  const query = new URLSearchParams({ agentId });
  if (workspaceId) query.set('workspaceId', workspaceId);
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
async function requestWorkflow<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; code?: string } | null;
  if (!response.ok || !payload?.success || !payload.data) throw new AgentWorkflowClientError(response.status, payload?.code || 'WORKFLOW_REQUEST_FAILED');
  return payload.data;
}
export function readAgentWorkflow(agentId: string, workspaceId?: string | null, signal?: AbortSignal): Promise<AgentWorkflowDescriptor> {
  return requestWorkflow(agentWorkflowUrl(agentId, workspaceId), { signal });
}
export type AgentWorkflowPersonalSelectionInput = { alternativeKey: string; target: { kind: 'personal'; source: 'mcp' | 'composio';
  providerRef: string; accountSelectionRef?: string } };
export function saveAgentWorkflowChoice(input: { agentId: string; workspaceId?: string | null; capabilityKey: string;
  expectedWorkflowRevision: number; expectedPreferenceRevision: number } & ({ choiceId: string | null } | { personalSelection: AgentWorkflowPersonalSelectionInput }), signal?: AbortSignal): Promise<AgentWorkflowDescriptor> {
  const { workspaceId, ...body } = input;
  return requestWorkflow(agentWorkflowUrl(input.agentId, workspaceId), { method: 'PATCH', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
export function readAgentWorkflowPersonalOptions(input: { agentId: string; workspaceId?: string | null; capabilityKey: string;
  expectedWorkflowRevision: number; alternativeKey?: string; providerRef?: string }, signal?: AbortSignal): Promise<AgentWorkflowPersonalOptions> {
  const url = new URL(agentWorkflowUrl(input.agentId, input.workspaceId), 'http://canvas.invalid');
  url.searchParams.set('view', 'personal-options'); url.searchParams.set('capabilityKey', input.capabilityKey);
  url.searchParams.set('expectedWorkflowRevision', String(input.expectedWorkflowRevision));
  if (input.alternativeKey) url.searchParams.set('alternativeKey', input.alternativeKey);
  if (input.providerRef) url.searchParams.set('providerRef', input.providerRef);
  return requestWorkflow(`${url.pathname}${url.search}`, { signal });
}
