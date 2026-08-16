import 'server-only';

import {
  DIRECT_MCP_FEATURE_ENV,
  DIRECT_MCP_SETTINGS_SOURCE_ENV,
  DIRECT_MCP_TOOLS_ENV,
  DIRECT_MCP_TOOLS_SOURCE_ENV,
  getDirectMcpEnabledTools,
  isDirectMcpEnabled,
  type DirectMcpToolId,
} from '@/app/lib/mcp/server/config';
import { getDirectMcpServerPreferences } from '@/app/lib/server-settings';

type DirectMcpRuntimeSettings = {
  enabled: boolean;
  tools: readonly DirectMcpToolId[];
};

type DirectMcpRuntimeSettingControls = {
  activation: boolean;
  capabilities: boolean;
};

function isManagedByEnvironment(valueKey: string, sourceKey: string): boolean {
  return process.env[sourceKey] === 'environment'
    || (process.env[valueKey] !== undefined && process.env[sourceKey] !== 'settings');
}

/**
 * Reads the activation state for a request. Settings-backed values deliberately
 * come from durable storage so every Next.js worker observes a toggle change
 * without requiring a process restart.
 */
export async function getDirectMcpRuntimeSettings(): Promise<DirectMcpRuntimeSettings> {
  const preferences = await getDirectMcpServerPreferences();
  const activationManagedByEnvironment = isManagedByEnvironment(
    DIRECT_MCP_FEATURE_ENV,
    DIRECT_MCP_SETTINGS_SOURCE_ENV,
  );
  const capabilitiesManagedByEnvironment = isManagedByEnvironment(
    DIRECT_MCP_TOOLS_ENV,
    DIRECT_MCP_TOOLS_SOURCE_ENV,
  );

  return {
    enabled: activationManagedByEnvironment
      ? isDirectMcpEnabled()
      : preferences?.enabled ?? isDirectMcpEnabled(),
    tools: capabilitiesManagedByEnvironment
      ? getDirectMcpEnabledTools()
      : preferences?.tools ?? getDirectMcpEnabledTools(),
  };
}

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
