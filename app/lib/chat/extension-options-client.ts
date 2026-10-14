import { chatExtensionOptionsRequestSchema, type ChatExtensionOptionsRequest,
  type ChatExtensionOptionsResponse } from './extension-options-contracts';

export class ChatExtensionOptionsClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message); this.name = 'ChatExtensionOptionsClientError';
  }
}

/** Read-only metadata; choosing an account remains an explicit chooser action. */
export async function requestChatExtensionOptions<R extends ChatExtensionOptionsRequest>(input: R,
  signal?: AbortSignal): Promise<Extract<ChatExtensionOptionsResponse, { operation: R['operation'] }>> {
  const request = chatExtensionOptionsRequestSchema.parse(input);
  const response = await fetch('/api/chat/extension-options', { method: 'POST', credentials: 'same-origin',
    cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  const result = await response.json() as { success?: boolean; data?: ChatExtensionOptionsResponse; code?: string; error?: string };
  if (!response.ok || result.success !== true || !result.data) throw new ChatExtensionOptionsClientError(response.status,
    result.code ?? 'CHAT_EXTENSION_OPTIONS_UNAVAILABLE', result.error ?? `HTTP ${response.status}`);
  const data = result.data;
  if (data.schemaVersion !== 1 || data.operation !== request.operation || !data.contextKey
    || JSON.stringify(data.target) !== JSON.stringify(request.target) || !Array.isArray(data.coverage)) {
    throw new ChatExtensionOptionsClientError(409, 'CHAT_EXTENSION_OPTIONS_REPLY_INVALID', 'Invalid chat extension options response.');
  }
  return data as Extract<ChatExtensionOptionsResponse, { operation: R['operation'] }>;
}
