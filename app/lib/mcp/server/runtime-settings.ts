import 'server-only';

import {
  DIRECT_MCP_FEATURE_ENV,
  DIRECT_MCP_SETTINGS_SOURCE_ENV,
  DIRECT_MCP_TOOLS_ENV,
  DIRECT_MCP_TOOLS_SOURCE_ENV,
  type DirectMcpToolId,
} from '@/app/lib/mcp/server/config';

type DirectMcpRuntimeSettings = {
  enabled: boolean;
  tools: readonly DirectMcpToolId[];
};

type DirectMcpRuntimeSettingControls = {
  activation: boolean;
  capabilities: boolean;
};

/**
 * Applies Settings changes to the current Canvas Node process. The persisted
 * preferences still remain the source of truth on the next process start.
 */
export function applyDirectMcpSettingsToRuntime(
  settings: DirectMcpRuntimeSettings,
  controls: DirectMcpRuntimeSettingControls,
): void {
  if (controls.activation) {
    process.env[DIRECT_MCP_FEATURE_ENV] = String(settings.enabled);
    process.env[DIRECT_MCP_SETTINGS_SOURCE_ENV] = 'settings';
  }
  if (controls.capabilities) {
    process.env[DIRECT_MCP_TOOLS_ENV] = settings.tools.join(',');
    process.env[DIRECT_MCP_TOOLS_SOURCE_ENV] = 'settings';
  }
}
