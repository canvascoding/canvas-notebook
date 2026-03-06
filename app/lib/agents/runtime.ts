import 'server-only';

import { type AgentId, isAgentId } from './catalog';
import { providerIdToAgentId, readAgentRuntimeConfig } from './storage';

export type CliParserType = 'stream-json' | 'codex-jsonl';

export type CliAgentRuntime = {
  kind: 'cli';
  command: string;
  parser: CliParserType;
  buildArgs: (params: { prompt: string; sessionId?: string | null }) => string[];
};

export type OpenRouterRuntime = {
  kind: 'openrouter';
  baseUrl: string;
  model: string;
  apiKeyEnv: 'OPENROUTER_API_KEY';
};

export type OllamaRuntime = {
  kind: 'ollama';
  baseUrl: string;
  model: string;
  apiKeyEnv: 'OLLAMA_API_KEY';
};

export type AgentRuntime = CliAgentRuntime | OpenRouterRuntime | OllamaRuntime;

const aliases: Record<string, AgentId> = {
  claude: 'claude',
  'claude-cli': 'claude',
  gemini: 'codex',
  'gemini-cli': 'codex',
  codex: 'codex',
  'codex-cli': 'codex',
  openrouter: 'openrouter',
  ollama: 'ollama',
};

function normalizeOpenRouterModel(model: string): string {
  const raw = model.trim();
  if (!raw) {
    return 'anthropic/claude-sonnet-4.5';
  }
  if (raw.startsWith('openrouter/')) {
    return raw.slice('openrouter/'.length);
  }
  return raw;
}

function buildCliRuntime(agentId: Exclude<AgentId, 'openrouter' | 'ollama'>, command: string): CliAgentRuntime {
  if (agentId === 'claude') {
    return {
      kind: 'cli',
      command,
      parser: 'stream-json',
      buildArgs: ({ prompt, sessionId }) => {
        const args = [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          'bypassPermissions',
          '--allowedTools',
          'read',
          '--allowedTools',
          'ls',
          '--allowedTools',
          'bash',
          '--allowedTools',
          'write',
          '--allowedTools',
          'edit',
          '--allowedTools',
          'glob',
          '--allowedTools',
          'grep',
        ];
        if (sessionId) {
          args.push('--resume', sessionId);
        }
        return args;
      },
    };
  }

  return {
    kind: 'cli',
    command,
    parser: 'codex-jsonl',
    buildArgs: ({ prompt, sessionId }) => {
      const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
      if (sessionId) {
        args.push('resume', sessionId, prompt);
      } else {
        args.push(prompt);
      }
      return args;
    },
  };
}

export function resolveAgentId(raw: unknown): AgentId {
  if (isAgentId(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return 'claude';
  }
  const normalized = raw.trim().toLowerCase();
  return aliases[normalized] || 'claude';
}

export async function getAgentRuntime(agentId?: AgentId): Promise<AgentRuntime> {
  const config = await readAgentRuntimeConfig();
  const resolvedAgentId = agentId ?? providerIdToAgentId(config.provider.id);

  if (resolvedAgentId === 'openrouter') {
    return {
      kind: 'openrouter',
      baseUrl: config.providers.openrouter.baseUrl,
      model: normalizeOpenRouterModel(config.providers.openrouter.model),
      apiKeyEnv: 'OPENROUTER_API_KEY',
    };
  }

  if (resolvedAgentId === 'ollama') {
    return {
      kind: 'ollama',
      baseUrl: config.providers.ollama.baseUrl,
      model: config.providers.ollama.model,
      apiKeyEnv: 'OLLAMA_API_KEY',
    };
  }

  const commandByAgent: Record<Exclude<AgentId, 'openrouter' | 'ollama'>, string> = {
    codex: config.providers['codex-cli'].command,
    claude: config.providers['claude-cli'].command,
  };

  return buildCliRuntime(resolvedAgentId, commandByAgent[resolvedAgentId]);
}
