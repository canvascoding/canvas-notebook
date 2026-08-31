import 'server-only';

import {
  DIRECT_MCP_FEATURE_ENV,
  DIRECT_MCP_DEFAULT_TOOL_IDS,
  DIRECT_MCP_PROTOCOL_VERSION,
  DIRECT_MCP_SETTINGS_SOURCE_ENV,
  DIRECT_MCP_TOOLS_ENV,
  DIRECT_MCP_TOOLS_SOURCE_ENV,
  getDirectMcpEnabledTools,
  isDirectMcpEnabled,
  resolveDirectMcpOrigin,
  type DirectMcpToolId,
} from '@/app/lib/mcp/server/config';
import { DIRECT_MCP_SERVER_VERSION } from '@/app/lib/mcp/server/version';
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
  serverVersion: string;
  transport: 'streamable-http';
  authentication: 'oauth-2.1-pkce';
  configurationError: string | null;
  updatedAt: string | null;
  capabilities: DirectMcpCapabilityStatus[];
};

const DIRECT_MCP_CAPABILITIES: ReadonlyArray<Omit<DirectMcpCapabilityStatus, 'enabled'>> = [
  { id: 'auth_probe', available: true, scopes: ['workspace:list'] },
  { id: 'list_workspaces', available: true, scopes: ['workspace:list'] },
  { id: 'get_workspace_overview', available: true, scopes: ['workspace:list'] },
  { id: 'list_knowledge_tree', available: true, scopes: ['knowledge:tree'] },
  { id: 'search_knowledge', available: true, scopes: ['knowledge:search'] },
  { id: 'read_knowledge_source', available: true, scopes: ['knowledge:read'] },
  { id: 'edit_knowledge_source', available: true, scopes: ['knowledge:write'] },
  { id: 'read_knowledge_asset', available: true, scopes: ['knowledge:assets'] },
  { id: 'upload_knowledge_asset', available: true, scopes: ['knowledge:write'] },
];

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
  return DIRECT_MCP_CAPABILITIES.map((capability) => ({
    ...capability,
    enabled: tools.includes(capability.id as DirectMcpToolId),
  }));
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
  let runtimeTools: DirectMcpToolId[] = [...DIRECT_MCP_DEFAULT_TOOL_IDS];
  let origin: string | null = null;

  try {
    // Environment variables intentionally take precedence for deployments.
    // Otherwise settings are the runtime source of truth: the OAuth provider
    // is initialized at startup regardless of this flag, so toggling needs no
    // process restart and must survive a settings-page reload.
    runtimeEnabled = source === 'environment'
      ? isDirectMcpEnabled(environment)
      : preferences?.enabled ?? isDirectMcpEnabled(environment);
    runtimeTools = toolsSource === 'environment'
      ? getDirectMcpEnabledTools(environment)
      : preferences?.tools ?? getDirectMcpEnabledTools(environment);
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
  return {
    desiredEnabled,
    runtimeEnabled,
    restartRequired: false,
    activationManagedByEnvironment: source === 'environment',
    capabilitiesManagedByEnvironment: toolsSource === 'environment',
    settingsSource: source,
    endpoint: origin ? `${origin}/mcp` : null,
    issuer: origin ? `${origin}/api/auth` : null,
    protocolVersion: DIRECT_MCP_PROTOCOL_VERSION,
    serverVersion: DIRECT_MCP_SERVER_VERSION,
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
