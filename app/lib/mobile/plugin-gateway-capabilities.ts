/** Additive server contracts. A capability advertises protocol support, never a grant or active binding. */
export const MOBILE_PLUGIN_GATEWAY_CAPABILITIES = [
  'chat.mcp_apps.v2',
  'extensions.resources.v2',
  'integrations.shared_connections.v2',
  'integrations.shared_oauth.v2',
  'agents.workflow.v2',
] as const;
