import 'server-only';

import { getDirectMcpRuntimeSettings } from '../mcp/server/runtime-settings';
import type { DirectMcpToolId } from '../mcp/server/config';
import { ApiKeyAccessError } from './contracts';

/** Read the same durable switches as OAuth at every actual key tool phase. */
export async function assertApiKeyMcpToolEnabled(tool: DirectMcpToolId): Promise<void> {
  const settings = await getDirectMcpRuntimeSettings();
  if (!settings.enabled || !settings.tools.includes(tool)) {
    throw new ApiKeyAccessError('API_KEY_TOOL_DISABLED', 'The requested MCP tool is disabled.', 403);
  }
}
