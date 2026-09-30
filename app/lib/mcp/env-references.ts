import { createHash } from 'node:crypto';

export const MCP_LITERAL_ENV_PREFIX = 'CANVAS_MCP_';
const GENERATED_ENV_KEY = /^CANVAS_MCP_[A-F0-9]{32}_(?:ENV|HEADER|URL|ARG)_[A-F0-9]{32}$/;
export function mcpLiteralEnvKey(connectionIdentity: string, field: 'env' | 'headers' | 'url' | 'args', name: string): string {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32).toUpperCase();
  const category = { env: 'ENV', headers: 'HEADER', url: 'URL', args: 'ARG' }[field];
  return `${MCP_LITERAL_ENV_PREFIX}${digest(connectionIdentity)}_${category}_${digest(name)}`;
}

/** Generated values contain the original config expression, so expand that expression once. */
export function expandMcpEnvValue(value: string, availableEnv: Record<string, string>, missing: Set<string>): string {
  const replace = (input: string, expandGenerated: boolean): string => input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const replacement = availableEnv[key];
    if (replacement === undefined) { missing.add(key); return ''; }
    return expandGenerated && GENERATED_ENV_KEY.test(key) ? replace(replacement, false) : replacement;
  });
  return replace(value, true);
}

/** Matches exactly the additional generated-expression layer used at runtime. */
export function mcpConfigUsesChangedEnv(
  config: import('./config').McpServerConfig,
  changedKeys: ReadonlySet<string>,
  availableEnv: Record<string, string> = {},
): boolean {
  const references = (value: unknown, generatedLayer: boolean): boolean => typeof value === 'string'
    && Array.from(value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu)).some((match) => changedKeys.has(match[1])
      || (generatedLayer && GENERATED_ENV_KEY.test(match[1]) && references(availableEnv[match[1]], false)));
  return (config.envPassthrough || []).some(key => changedKeys.has(key.trim()))
    || references(config.url, true)
    || (config.args || []).some(value => references(value, true))
    || Object.values(config.env || {}).some(value => references(value, true))
    || Object.values(config.headers || {}).some(value => references(value, true))
    || Object.values(config.headersFromEnv || {}).some(key => changedKeys.has(key.trim()))
    || Boolean(config.bearerTokenEnv && changedKeys.has(config.bearerTokenEnv));
}
