import { readIntegrationToolReceipt } from '../integration-tools/receipt';
import type { ToolDisplayInfo } from './tool-display';

export function getIntegrationToolDisplayInfo(locale: string, details: unknown, args?: Record<string, unknown>): ToolDisplayInfo {
  const receipt = readIntegrationToolReceipt(details);
  const action = receipt?.action ?? args?.action;
  const target = receipt?.target ?? args?.target;
  const german = locale.startsWith('de');
  const source = receipt?.source === 'mcp' ? 'MCP' : receipt?.source === 'composio' ? 'Composio' : undefined;
  const context = [...new Set([source, receipt?.providerName, receipt?.connectionName].filter(Boolean))].join(' · ');
  const labels = {
    list: target === 'tools' ? ['List tools', 'Tools auflisten'] : ['List integrations', 'Integrationen auflisten'],
    search: target === 'tools' ? ['Find tools', 'Tools suchen'] : ['Find integrations', 'Integrationen suchen'],
    describe: ['Inspect tool', 'Tool prüfen'],
    call: ['Run tool', 'Tool ausführen'],
  };
  const selected = typeof action === 'string' && Object.hasOwn(labels, action) ? labels[action as keyof typeof labels] : null;
  return { label: selected ? selected[german ? 1 : 0] : german ? 'Integrationen verwenden' : 'Use integrations',
    tone: action === 'search' ? 'composioSearch' : action === 'describe' ? 'composioSchema'
      : action === 'call' ? receipt?.source === 'mcp' ? 'mcp' : 'composioExecute' : 'composioConnections',
    ...(context ? { context } : {}), ...(receipt?.toolName ? { toolLabel: receipt.toolName } : {}) };
}
