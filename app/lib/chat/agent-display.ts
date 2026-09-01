import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import { MAIN_AGENT_DISPLAY_NAME } from '@/app/lib/agents/main-agent';

export function getAgentDisplayName(agentId: string | null | undefined): string {
  if (!agentId || agentId === DEFAULT_AGENT_ID) {
    return MAIN_AGENT_DISPLAY_NAME;
  }

  return agentId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getAgentProfileDisplayName(
  agentId: string | null | undefined,
  profileName: string | null | undefined,
): string {
  if (!agentId || agentId === DEFAULT_AGENT_ID) {
    return MAIN_AGENT_DISPLAY_NAME;
  }

  return profileName?.trim() || getAgentDisplayName(agentId);
}
