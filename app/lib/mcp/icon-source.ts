import { createHash } from 'node:crypto';
import type { McpServerConfig } from './config';

/** Opaque source identity only. Never publish the underlying endpoint or configuration. */
export function mcpIconSourceBinding(selectionId: string, config: McpServerConfig, revisionStamp: string | number = ''): string {
  return createHash('sha256').update(JSON.stringify([
    'mcp-icon-v1', selectionId, revisionStamp, config.connectionId ?? null,
    config.ownerUserId ?? null, config.organizationId ?? null, config.serverDefinitionId ?? null,
    config.authVersion ?? null, config.url ?? null, config.iconUrl ?? null,
  ])).digest('hex');
}
