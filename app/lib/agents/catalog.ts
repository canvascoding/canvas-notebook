export type AgentId = 'claude' | 'codex' | 'openrouter' | 'ollama';

export type AgentCatalogEntry = {
  id: AgentId;
  label: string;
  provider: string;
};

export const AGENT_CATALOG: AgentCatalogEntry[] = [
  { id: 'claude', label: 'Claude CLI', provider: 'claude-cli' },
  { id: 'codex', label: 'Codex CLI', provider: 'codex-cli' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openrouter' },
  { id: 'ollama', label: 'Ollama', provider: 'ollama' },
];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_CATALOG.some((agent) => agent.id === value);
}
