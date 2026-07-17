import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import type { AgentProfile } from '@/app/lib/chat/types';

export async function fetchChatAgents(workspaceId: string): Promise<AgentProfile[]> {
  const query = new URLSearchParams({ workspaceId });
  const res = await fetch(`/api/agents?${query.toString()}`, { cache: 'no-store' });
  const data = await safeFetchJson<{ success: boolean; data?: { agents?: AgentProfile[] } }>(res);
  if (!data?.success || !Array.isArray(data.data?.agents)) {
    throw new Error('Failed to load chat agents.');
  }
  return data.data.agents;
}
