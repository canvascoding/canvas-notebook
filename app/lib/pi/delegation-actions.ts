import 'server-only';

import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { requireAgentAccess } from '@/app/lib/agents/access';
import { DELEGATABLE_PI_TOOLSETS, type PiToolset } from '@/app/lib/pi/toolsets';
import { requireDelegationSource } from '@/app/lib/pi/delegation-policy';
import type { DelegateTaskRequest } from '@/app/lib/pi/delegate-task-tool';

const DEFAULT_TOOLSETS: PiToolset[] = ['file', 'terminal', 'web', 'session_search'];

function normalizeToolsets(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_TOOLSETS;
  const toolsets = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const toolset = item.trim() as PiToolset;
    if (!DELEGATABLE_PI_TOOLSETS.has(toolset)) {
      throw new Error(`Toolset "${item}" cannot be delegated.`);
    }
    toolsets.add(toolset);
  }
  return toolsets.size > 0 ? [...toolsets] : DEFAULT_TOOLSETS;
}

export async function prepareUserDelegation(input: {
  userId: string;
  sourceSessionId: string;
  targetAgentId: string;
  goal: unknown;
  context?: unknown;
  toolsets?: unknown;
}): Promise<Omit<DelegateTaskRequest, 'abortSignal' | 'delegationId' | 'workerSessionId' | 'onCompletion'>> {
  const source = await requireDelegationSource({
    userId: input.userId,
    sourceSessionId: input.sourceSessionId,
  });
  const goal = typeof input.goal === 'string' ? input.goal.trim().slice(0, 8_000) : '';
  if (!goal) throw new Error('A delegation goal is required.');
  const targetAgentId = normalizeManagedAgentId(input.targetAgentId);
  if (targetAgentId === source.sourceAgentId) {
    throw new Error('Choose a different agent for delegation.');
  }
  if (!await getAgentProfile(targetAgentId)) {
    throw new Error('Target agent not found.');
  }
  await requireAgentAccess(input.userId, targetAgentId, 'canUse', {
    organizationId: source.organizationId,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
  });
  return {
    userId: input.userId,
    sourceAgentId: source.sourceAgentId,
    sourceSessionId: input.sourceSessionId.trim(),
    targetAgentId,
    goal,
    context: typeof input.context === 'string' ? input.context.trim().slice(0, 12_000) || undefined : undefined,
    toolsets: normalizeToolsets(input.toolsets),
    waitForResult: false,
    timeoutSeconds: 0,
  };
}

export { DEFAULT_TOOLSETS };
