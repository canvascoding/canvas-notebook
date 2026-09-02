export const MAIN_AGENT_DISPLAY_NAME = 'Bradley';
export const MAIN_AGENT_ID = 'bradley';
export const LEGACY_MAIN_AGENT_ID = 'canvas-agent';

export function normalizeMainAgentIdAlias(agentId: string): string {
  return agentId === LEGACY_MAIN_AGENT_ID ? MAIN_AGENT_ID : agentId;
}

export function isMainAgentId(agentId?: string | null): boolean {
  const normalized = agentId?.trim().toLowerCase();
  return normalized === MAIN_AGENT_ID || normalized === LEGACY_MAIN_AGENT_ID;
}
