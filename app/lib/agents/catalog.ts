export type AgentId = 'claude' | 'gemini' | 'codex' | 'openrouter';

export type AgentCatalogEntry = {
  id: AgentId;
  label: string;
  provider: string;
};

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  { id: 'claude', label: 'Claude CLI', provider: 'claude-cli' },
  { id: 'gemini', label: 'Gemini CLI', provider: 'gemini-cli' },
  { id: 'codex', label: 'Codex CLI', provider: 'codex-cli' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openrouter' },
];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_CATALOG.some((agent) => agent.id === value);
}
