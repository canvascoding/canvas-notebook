import type { Tool } from '@modelcontextprotocol/client';

export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export type McpAppVisibility = 'app' | 'model';

export type McpAppToolMetadata = {
  resourceUri: string;
};

type VisibilityState =
  | { kind: 'default' }
  | { kind: 'valid'; values: readonly McpAppVisibility[] }
  | { kind: 'invalid' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isUiResourceUri(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && /^ui:\/\/[^\s]+$/u.test(value);
}

function readVisibility(value: unknown, present: boolean): VisibilityState {
  if (!present) return { kind: 'default' };
  if (!Array.isArray(value)) return { kind: 'invalid' };
  const visibility = value.filter((entry): entry is McpAppVisibility => entry === 'app' || entry === 'model');
  return visibility.length === value.length ? { kind: 'valid', values: visibility } : { kind: 'invalid' };
}

function readToolVisibility(tool: Tool): VisibilityState {
  const metadata = isPlainObject(tool._meta) ? tool._meta : null;
  if (!metadata) return { kind: 'default' };
  const ui = isPlainObject(metadata.ui) ? metadata.ui : null;
  return readVisibility(ui?.visibility, Boolean(ui && Object.hasOwn(ui, 'visibility')));
}

/**
 * Reads both the current nested MCP Apps linkage and its legacy flat alias.
 * Only a `ui://` URI is accepted as an app binding; arbitrary resource reads
 * must never become a host-side escape hatch.
 */
export function readMcpAppToolMetadata(tool: Tool): McpAppToolMetadata | null {
  const metadata = isPlainObject(tool._meta) ? tool._meta : null;
  if (!metadata) return null;
  const ui = isPlainObject(metadata.ui) ? metadata.ui : null;
  const resourceUri = ui?.resourceUri ?? metadata['ui/resourceUri'];
  if (!isUiResourceUri(resourceUri)) return null;
  return {
    resourceUri,
  };
}

export function isMcpAppToolVisibleToModel(tool: Tool): boolean {
  const visibility = readToolVisibility(tool);
  return visibility.kind === 'default' || (visibility.kind === 'valid' && visibility.values.includes('model'));
}

export function isMcpAppToolVisibleToApp(tool: Tool): boolean {
  const visibility = readToolVisibility(tool);
  return visibility.kind === 'default' || (visibility.kind === 'valid' && visibility.values.includes('app'));
}

export function filterMcpToolsForModel(tools: readonly Tool[]): Tool[] {
  return tools.filter(isMcpAppToolVisibleToModel);
}

export function isMcpAppResourceMimeType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const [type, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase());
  return type === 'text/html' && parameters.includes('profile=mcp-app');
}
