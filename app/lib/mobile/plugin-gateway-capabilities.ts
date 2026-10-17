/** Additive server contracts. A capability advertises protocol support, never a grant or active binding. */
export const MOBILE_PLUGIN_GATEWAY_CAPABILITIES = [
  'chat.mcp_apps.v2',
  'extensions.resources.v2',
  'extensions.authoring.v1',
  'integrations.shared_connections.v2',
  'integrations.shared_oauth.v2',
  'agents.workflow.v2',
  'chat.extension_references.v2',
  'agents.extension_configuration.v2',
] as const;
