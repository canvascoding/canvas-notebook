export type IntegrationToolReceipt = {
  version: 1;
  action: 'list' | 'search' | 'describe' | 'call';
  target?: 'providers' | 'tools';
  source?: 'mcp' | 'composio';
  providerName?: string;
  connectionName?: string;
  toolName?: string;
};

const RECEIPT_KEYS = new Set(['version', 'action', 'target', 'source', 'providerName', 'connectionName', 'toolName']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function label(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)
    || /(?:mcp|composio|tool|schema|cursor|policy):v\d+:/iu.test(value)) return undefined;
  return value.trim() || undefined;
}

export function readIntegrationToolReceipt(details: unknown): IntegrationToolReceipt | null {
  const value = record(record(details)?.integrationReceipt);
  if (!value || value.version !== 1 || typeof value.action !== 'string' || !['list', 'search', 'describe', 'call'].includes(value.action)
    || Object.keys(value).some(key => !RECEIPT_KEYS.has(key))
    || value.target !== undefined && value.target !== 'providers' && value.target !== 'tools'
    || value.source !== undefined && value.source !== 'mcp' && value.source !== 'composio') return null;
  const providerName = label(value.providerName);
  const connectionName = label(value.connectionName);
  const toolName = label(value.toolName);
  if (['providerName', 'connectionName', 'toolName'].some(key => value[key] !== undefined && !label(value[key]))) return null;
  return { version: 1, action: value.action as IntegrationToolReceipt['action'],
    ...(value.target === undefined ? {} : { target: value.target as IntegrationToolReceipt['target'] }),
    ...(value.source === undefined ? {} : { source: value.source as IntegrationToolReceipt['source'] }),
    ...(providerName ? { providerName } : {}), ...(connectionName ? { connectionName } : {}), ...(toolName ? { toolName } : {}) };
}
