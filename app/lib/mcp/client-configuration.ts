export type DirectMcpClientCapability = {
  id: string;
  available: boolean;
  enabled: boolean;
  scopes: string[];
};

export function buildCodexMcpServerConfiguration(input: {
  endpoint: string;
  enabledTools: readonly string[];
}): string {
  const tools = [...new Set(input.enabledTools)].sort();
  return [
    '[mcp_servers.canvas]',
    `url = ${JSON.stringify(input.endpoint)}`,
    'enabled_tools = [',
    ...tools.map((tool) => `  ${JSON.stringify(tool)},`),
    ']',
  ].join('\n');
}

export function missingScopesForEnabledCapabilities(input: {
  grantedScopes: readonly string[];
  capabilities: readonly DirectMcpClientCapability[];
}): string[] {
  const granted = new Set(input.grantedScopes);
  return [...new Set(
    input.capabilities
      .filter((capability) => capability.available && capability.enabled)
      .flatMap((capability) => capability.scopes)
      .filter((scope) => !granted.has(scope)),
  )].sort();
}
