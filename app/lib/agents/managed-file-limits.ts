export const MANAGED_AGENT_FILE_LIMIT_BYTES = {
  'AGENTS.md': 8_192,
  'USER.md': 4_096,
  'MEMORY.md': 6_144,
  'SOUL.md': 4_096,
  'TOOLS.md': 8_192,
  'HEARTBEAT.md': 4_096,
} as const;

export const MAX_MANAGED_SYSTEM_PROMPT_BYTES = 16_384;

// This applies after fixed Canvas guidance, managed files, skills, and optional
// runtime guidance have been combined. Individual managed-file budgets alone
// cannot stop those other sources from exhausting a model's first-turn context.
export const MAX_COMPOSED_SYSTEM_PROMPT_BYTES = 24_576;

export const MANAGED_SYSTEM_PROMPT_FILE_BUDGET_BYTES = {
  'AGENTS.md': 4_096,
  'USER.md': 2_048,
  'MEMORY.md': 3_072,
  'SOUL.md': 1_536,
  'TOOLS.md': 4_096,
} as const;

export type LimitedManagedAgentFileName = keyof typeof MANAGED_AGENT_FILE_LIMIT_BYTES;

export function getManagedAgentFileLimitBytes(fileName: LimitedManagedAgentFileName): number {
  return MANAGED_AGENT_FILE_LIMIT_BYTES[fileName];
}

export function truncateUtf8ToBytes(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return content;
  }

  const suffix = '\n\n[Content truncated to keep the runtime context within its safety budget.]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (maxBytes <= suffixBytes) {
    return '';
  }
  let low = 0;
  let high = content.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), 'utf8') + suffixBytes <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return `${content.slice(0, low)}${suffix}`;
}
