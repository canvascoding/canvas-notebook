import { fetchWorkspaceAgents } from '@/app/lib/queries/workspace-queries';
import type { AgentProfile } from '@/app/lib/chat/types';

export async function fetchChatAgents(workspaceId: string): Promise<AgentProfile[]> {
  return fetchWorkspaceAgents(workspaceId);
}
