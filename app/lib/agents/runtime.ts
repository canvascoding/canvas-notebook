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

export type AgentRuntime = CliAgentRuntime | OpenRouterRuntime;

const aliases: Record<string, AgentId> = {
  claude: 'claude',
  'claude-cli': 'claude',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  codex: 'codex',
  'codex-cli': 'codex',
  openrouter: 'openrouter',
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

function buildCliRuntime(agentId: Exclude<AgentId, 'openrouter'>, command: string): CliAgentRuntime {
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

  if (agentId === 'gemini') {
    return {
      kind: 'cli',
      command,
      parser: 'stream-json',
      buildArgs: ({ prompt, sessionId }) => {
        const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--yolo', '--approval-mode', 'yolo'];
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

  const commandByAgent: Record<Exclude<AgentId, 'openrouter'>, string> = {
    codex: config.providers['codex-cli'].command,
    claude: config.providers['claude-cli'].command,
    gemini: config.providers['gemini-cli'].command,
  };

  return buildCliRuntime(resolvedAgentId, commandByAgent[resolvedAgentId]);
}
