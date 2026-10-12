import { createAuthorizedSharedOAuthLauncher } from './shared-oauth-launcher.mjs';

/** This channel is shared-only and cannot fall back to the personal MCP namespace. */
export function createSharedComposioOAuthLauncher(options) {
  return createAuthorizedSharedOAuthLauncher({ ...options, provider: 'composio' });
}
