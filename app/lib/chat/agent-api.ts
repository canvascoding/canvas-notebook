import { safeFetchJson } from '@/app/lib/chat/fetch-json';
import type { AgentProfile } from '@/app/lib/chat/types';

export async function fetchChatAgents(): Promise<AgentProfile[]> {
  const res = await fetch('/api/agents', { cache: 'no-store' });
  const data = await safeFetchJson<{ success: boolean; data?: { agents?: AgentProfile[] } }>(res);
  return data?.success ? data.data?.agents || [] : [];
}
