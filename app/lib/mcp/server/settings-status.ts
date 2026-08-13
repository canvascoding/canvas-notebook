import 'server-only';

import {
  DIRECT_MCP_FEATURE_ENV,
  DIRECT_MCP_PROTOCOL_VERSION,
  DIRECT_MCP_SETTINGS_SOURCE_ENV,
  DIRECT_MCP_TOOL_IDS,
  DIRECT_MCP_TOOLS_ENV,
  DIRECT_MCP_TOOLS_SOURCE_ENV,
  getDirectMcpEnabledTools,
  isDirectMcpEnabled,
  resolveDirectMcpOrigin,
  type DirectMcpToolId,
} from '@/app/lib/mcp/server/config';
import {
  getDirectMcpServerPreferences,
  type DirectMcpServerPreferences,
} from '@/app/lib/server-settings';

type DirectMcpEnvironment = Record<string, string | undefined>;

export type DirectMcpSettingsSource = 'default' | 'settings' | 'environment';

export type DirectMcpCapabilityStatus = {
  id: string;
  available: boolean;
  enabled: boolean;
  scopes: string[];
};

export type DirectMcpServerSettingsStatus = {
  desiredEnabled: boolean;
  runtimeEnabled: boolean;
  restartRequired: boolean;
  activationManagedByEnvironment: boolean;
  capabilitiesManagedByEnvironment: boolean;
  settingsSource: DirectMcpSettingsSource;
  endpoint: string | null;
  issuer: string | null;
  protocolVersion: string;
  transport: 'streamable-http';
  authentication: 'oauth-2.1-pkce';
  configurationError: string | null;
  updatedAt: string | null;
  capabilities: DirectMcpCapabilityStatus[];
};

const PLANNED_CAPABILITIES: ReadonlyArray<Omit<DirectMcpCapabilityStatus, 'enabled'>> = [
  { id: 'list_workspaces', available: false, scopes: ['workspace:list'] },
  { id: 'get_workspace_overview', available: false, scopes: ['workspace:list'] },
  { id: 'list_knowledge_tree', available: false, scopes: ['knowledge:tree'] },
  { id: 'search_knowledge', available: false, scopes: ['knowledge:search'] },
  { id: 'read_knowledge_source', available: false, scopes: ['knowledge:read'] },
];

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function settingsSource(
  environment: DirectMcpEnvironment,
  valueEnvironmentKey: string,
  sourceEnvironmentKey: string,
): DirectMcpSettingsSource {
  if (environment[sourceEnvironmentKey] === 'settings') return 'settings';
  if (environment[valueEnvironmentKey] !== undefined) return 'environment';
  return 'default';
}

function enabledCapabilities(tools: readonly DirectMcpToolId[]): DirectMcpCapabilityStatus[] {
  return [
    {
      id: 'auth_probe',
      available: true,
      enabled: tools.includes('auth_probe'),
      scopes: ['workspace:list'],
    },
    ...PLANNED_CAPABILITIES.map((capability) => ({ ...capability, enabled: false })),
  ];
}

export function buildDirectMcpServerSettingsStatus(
  preferences: DirectMcpServerPreferences | null,
  environment: DirectMcpEnvironment = process.env,
): DirectMcpServerSettingsStatus {
  const source = settingsSource(
    environment,
    DIRECT_MCP_FEATURE_ENV,
    DIRECT_MCP_SETTINGS_SOURCE_ENV,
  );
  const toolsSource = settingsSource(
    environment,
    DIRECT_MCP_TOOLS_ENV,
    DIRECT_MCP_TOOLS_SOURCE_ENV,
  );
  let configurationError: string | null = null;
  let runtimeEnabled = false;
  let runtimeTools: DirectMcpToolId[] = [...DIRECT_MCP_TOOL_IDS];
  let origin: string | null = null;

  try {
    runtimeEnabled = isDirectMcpEnabled(environment);
    runtimeTools = getDirectMcpEnabledTools(environment);
  } catch (error) {
    configurationError = error instanceof Error ? error.message : 'Invalid Direct MCP runtime configuration.';
  }

  try {
    origin = resolveDirectMcpOrigin(environment);
  } catch (error) {
    configurationError ??= error instanceof Error ? error.message : 'Invalid public instance URL.';
  }

  const desiredEnabled = source === 'environment'
    ? runtimeEnabled
    : preferences?.enabled ?? runtimeEnabled;
  const desiredTools = toolsSource === 'environment'
    ? runtimeTools
    : preferences?.tools ?? runtimeTools;
  const runtimeDiffers = desiredEnabled !== runtimeEnabled
    || !arraysEqual(desiredTools, runtimeTools);

  return {
    desiredEnabled,
    runtimeEnabled,
    restartRequired: (desiredEnabled || runtimeEnabled) && runtimeDiffers,
    activationManagedByEnvironment: source === 'environment',
    capabilitiesManagedByEnvironment: toolsSource === 'environment',
    settingsSource: source,
    endpoint: origin ? `${origin}/mcp` : null,
    issuer: origin ? `${origin}/api/auth` : null,
    protocolVersion: DIRECT_MCP_PROTOCOL_VERSION,
    transport: 'streamable-http',
    authentication: 'oauth-2.1-pkce',
    configurationError,
    updatedAt: preferences?.updatedAt ?? null,
    capabilities: enabledCapabilities(desiredTools),
  };
}

export async function getDirectMcpServerSettingsStatus(): Promise<DirectMcpServerSettingsStatus> {
  return buildDirectMcpServerSettingsStatus(
    await getDirectMcpServerPreferences(),
  );
}
