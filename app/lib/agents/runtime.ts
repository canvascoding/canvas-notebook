import 'server-only';

import { type AgentId, isAgentId } from './catalog';

export type AiAgentEngine = 'pi';

/**
 * Returns the currently active AI agent engine.
 * PI-first: always returns 'pi'.
 */
export function getActiveAiAgentEngine(): AiAgentEngine {
  return 'pi';
}

const aliases: Record<string, AgentId> = {
  gemini: 'codex',
  'gemini-cli': 'codex',
  codex: 'codex',
  'codex-cli': 'codex',
  openrouter: 'openrouter',
  ollama: 'ollama',
};

export function resolveAgentId(raw: unknown): AgentId {
  if (isAgentId(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return 'openrouter';
  }
  const normalized = raw.trim().toLowerCase();
  return aliases[normalized] || 'openrouter';
}
