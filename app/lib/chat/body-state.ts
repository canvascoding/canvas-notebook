import { parseChatBody, type ChatBodyV1 } from './chat-body-contracts';

/** Plain text never acquires references by matching a current resource name. */
export function createTextChatBody(text: string): ChatBodyV1 {
  return parseChatBody({ version: 1, parts: text ? [{ type: 'text', text }] : [], bundles: [] });
}

export function readMessageChatBody(message: unknown): ChatBodyV1 | null {
  if (!message || typeof message !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(message, 'body');
  if (!descriptor || !('value' in descriptor)) return null;
  try { return parseChatBody(descriptor.value); } catch { return null; }
}
