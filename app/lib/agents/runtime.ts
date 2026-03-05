import 'server-only';

import { type AgentId, isAgentId } from './catalog';

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

function normalizeOpenRouterModel(model: string | undefined): string {
  const raw = (model || '').trim();
  if (!raw) {
    return 'anthropic/claude-sonnet-4.5';
  }
  if (raw.startsWith('openrouter/')) {
    return raw.slice('openrouter/'.length);
  }
  return raw;
}

const agentRuntimeById: Record<AgentId, AgentRuntime> = {
  claude: {
    kind: 'cli',
    command: process.env.CLAUDE_CLI_COMMAND?.trim() || 'claude',
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
  },
  gemini: {
    kind: 'cli',
    command: process.env.GEMINI_CLI_COMMAND?.trim() || 'gemini',
    parser: 'stream-json',
    buildArgs: ({ prompt, sessionId }) => {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--yolo',
        '--approval-mode',
        'yolo',
      ];
      if (sessionId) {
        args.push('--resume', sessionId);
      }
      return args;
    },
  },
  codex: {
    kind: 'cli',
    command: process.env.CODEX_CLI_COMMAND?.trim() || 'codex',
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
  },
  openrouter: {
    kind: 'openrouter',
    baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
    model: normalizeOpenRouterModel(process.env.OPENROUTER_MODEL),
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
};

const aliases: Record<string, AgentId> = {
  claude: 'claude',
  'claude-cli': 'claude',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  codex: 'codex',
  'codex-cli': 'codex',
  openrouter: 'openrouter',
};

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

export function getAgentRuntime(agentId: AgentId): AgentRuntime {
  return agentRuntimeById[agentId];
}
