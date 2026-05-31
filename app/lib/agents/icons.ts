export const AGENT_ICON_IDS = [
  'bot',
  'sparkles',
  'search',
  'code',
  'palette',
  'briefcase',
  'calendar',
  'messages',
  'brain',
  'wrench',
  'rocket',
  'shield',
] as const;

export type AgentIconId = (typeof AGENT_ICON_IDS)[number];

export const DEFAULT_AGENT_ICON_ID: AgentIconId = 'bot';

export function isAgentIconId(value: unknown): value is AgentIconId {
  return typeof value === 'string' && (AGENT_ICON_IDS as readonly string[]).includes(value);
}

export function normalizeAgentIconId(value: unknown): AgentIconId {
  return isAgentIconId(value) ? value : DEFAULT_AGENT_ICON_ID;
}
