import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';

export function getAgentDisplayName(agentId: string | null | undefined): string {
  if (!agentId || agentId === DEFAULT_AGENT_ID) {
    return 'Canvas Agent';
  }

  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
