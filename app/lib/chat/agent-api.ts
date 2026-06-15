import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import type { AgentConfig, AgentProfile } from '@/app/lib/chat/types';

export async function fetchChatAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const params = new URLSearchParams({ agentId, readiness: 'false' });
  const res = await fetch(`/api/agents/config?${params.toString()}`);
  const data = await safeFetchJson<{ success: boolean; data?: AgentConfig }>(res);
  return data?.success ? data.data ?? null : null;
}

export async function fetchChatAgents(): Promise<AgentProfile[]> {
  const res = await fetch('/api/agents', { cache: 'no-store' });
  const data = await safeFetchJson<{ success: boolean; data?: { agents?: AgentProfile[] } }>(res);
  return data?.success ? data.data?.agents || [] : [];
}
