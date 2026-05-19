const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'COLORTERM',
  'HOSTNAME',
  'NODE_ENV',
  'NEXT_RUNTIME',
  'DATA',
  'CANVAS_DATA_ROOT',
  'WORKSPACE_DIR',
  'LOG_LEVEL',
  'NEXT_TELEMETRY_DISABLED',
  'OLLAMA_API_BASE_URL',
  'OLLAMA_BASE_URL',
]);

const BLOCKED_ENV_KEY_PATTERNS = [
  /(?:^|_)KEY$/i,
  /(?:^|_)TOKEN$/i,
  /(?:^|_)SECRET$/i,
  /(?:^|_)PASSWORD$/i,
  /API_KEY/i,
  /OPENROUTER/i,
  /OPENAI/i,
  /ANTHROPIC/i,
  /GOOGLE/i,
  /GEMINI/i,
  /GROQ/i,
  /MISTRAL/i,
  /COMPOSIO/i,
  /KIE/i,
  /BRAVE/i,
  /BOOTSTRAP_ADMIN/i,
  /CANVAS_TERMINAL_TOKEN/i,
  /DATABASE/i,
  /POSTGRES/i,
  /SQLITE/i,
];

export function isSafeEnvKey(key: string): boolean {
  if (SAFE_ENV_KEYS.has(key)) return true;
  return !BLOCKED_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function filterSafeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && isSafeEnvKey(key)) {
      safe[key] = value;
    }
  }
  return safe;
}
