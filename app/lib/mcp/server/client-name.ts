export const DIRECT_MCP_CLIENT_FALLBACK_NAME = 'MCP client';

export function normalizeDirectMcpClientName(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  return normalized || null;
}

export function directMcpClientDisplayName(value: unknown): string {
  return normalizeDirectMcpClientName(value) || DIRECT_MCP_CLIENT_FALLBACK_NAME;
}
