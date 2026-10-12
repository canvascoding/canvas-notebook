import { Buffer } from 'node:buffer';

import type { McpAppDescriptor } from '@/app/lib/mcp/apps-types';
import { readToolAppInvocation } from '@/app/lib/tool-apps/types';

export const MAX_MOBILE_CHAT_DISPLAY_BYTES = 128 * 1024;

/** Public reference only. Authority, HTML, tool input/results stay on the server. */
export type MobileChatDisplay = { version: 1; mcpApp: McpAppDescriptor };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Bind the current canonical app descriptor to the exact transmitted receipt. */
export function projectMobileChatDisplay(message: unknown, toolCallId: string | null): MobileChatDisplay | undefined {
  if (!record(message) || message.role !== 'toolResult' || !toolCallId || message.toolCallId !== toolCallId
    || message.isError || message.error || !record(message.details)) return undefined;
  const details = message.details;
  if (details.error || details.isError || record(details.result) && details.result.isError) return undefined;
  const invocation = readToolAppInvocation(message);
  if (invocation?.kind !== 'mcp') return undefined;
  // The canonical parser returns fresh, allowlisted v1/v2 fields; never spread
  // raw details or use a personal connection as fallback for a shared target.
  const display: MobileChatDisplay = { version: 1, mcpApp: { ...invocation.descriptor } };
  return Buffer.byteLength(JSON.stringify(display), 'utf8') <= MAX_MOBILE_CHAT_DISPLAY_BYTES ? display : undefined;
}
