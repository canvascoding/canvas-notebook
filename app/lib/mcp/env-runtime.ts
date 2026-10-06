import { readScopedEnvState } from '@/app/lib/integrations/env-config';
import { assertUnifiedEnvReadable, projectEnvView, readUnifiedEnvState } from '@/app/lib/secrets/unified-env-store';
import { expandMcpEnvValue } from './env-references';
import { normalizeMcpScope, type McpScope } from './scope';

export type McpEnvironmentSnapshot = { values: Record<string, string>; revision: string };

/** One physical revision supplies both MCP views; no mixed-account read is possible. */
export async function readMcpAvailableEnvSnapshot(scope?: McpScope | null): Promise<McpEnvironmentSnapshot> {
  const normalized = normalizeMcpScope(scope);
  const storageScope = normalized?.userId ? { userId: normalized.userId } : { secretScope: 'legacy' as const };
  const state = await readUnifiedEnvState(storageScope);
  assertUnifiedEnvReadable(state);
  const integrations = projectEnvView(state, 'integrations');
  const agents = projectEnvView(state, 'agents');
  return { values: Object.freeze(Object.fromEntries([...integrations.entries, ...agents.entries].map(entry => [entry.key, entry.value]))), revision: state.revision };
}

/** Resolve startup URL/arguments from the same immutable snapshot as credentials. */
export function resolveMcpSnapshotTransportValues(config: { url?: string; args?: string[] }, snapshot: McpEnvironmentSnapshot): { url?: string; args: string[] } {
  const missing = new Set<string>();
  const url = config.url === undefined ? undefined : expandMcpEnvValue(config.url, snapshot.values, missing);
  const args = (config.args || []).map(value => expandMcpEnvValue(value, snapshot.values, missing));
  if (missing.size) throw new Error(`Missing MCP environment variable(s): ${Array.from(missing).sort().join(', ')}. Configure them in /settings?tab=secrets.`);
  return { url, args };
}

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
