import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { expandMcpEnvValue } from './env-references';
import { normalizeMcpScope, type McpScope } from './scope';

/** The MCP owner cascade has no process, organization or other-user fallback. */
export async function readMcpAvailableEnv(scope?: McpScope | null): Promise<Record<string, string>> {
  const normalized = normalizeMcpScope(scope);
  const storageScope = normalized?.userId ? { userId: normalized.userId } : { secretScope: 'legacy' as const };
  const [integrations, agents] = await Promise.all([
    readScopedEnvState('integrations', storageScope), readScopedEnvState('agents', storageScope),
  ]);
  return Object.fromEntries([...integrations.entries, ...agents.entries].map(entry => [entry.key, entry.value]));
}

export async function resolveMcpTransportValues(config: { url?: string; args?: string[] }, scope?: McpScope | null): Promise<{ url?: string; args: string[] }> {
  const available = await readMcpAvailableEnv(scope);
  const missing = new Set<string>();
  const url = config.url === undefined ? undefined : expandMcpEnvValue(config.url, available, missing);
  const args = (config.args || []).map(value => expandMcpEnvValue(value, available, missing));
  if (missing.size) throw new Error(`Missing MCP environment variable(s): ${Array.from(missing).sort().join(', ')}. Configure them in /settings?tab=secrets.`);
  return { url, args };
}
