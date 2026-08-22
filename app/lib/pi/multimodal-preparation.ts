import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';

import {
  normalizePiMessagesForLlm,
  type PiMessageNormalizationOptions,
} from './message-normalization';

/**
 * The one boundary at which Canvas turns agent messages into provider payloads.
 * All execution modes use this helper so read-tool images reach the provider
 * boundary consistently. Provider capability metadata is advisory: the runtime
 * makes one optimistic multimodal attempt and performs a safe text fallback if
 * the provider explicitly rejects image input.
 */
export async function prepareMessagesForEffectiveModel(
  messages: AgentMessage[],
  _model: Model<Api>,
  options: PiMessageNormalizationOptions = {},
): Promise<Message[]> {
  const runnableMessages = messages.filter(
    (message) => message.role !== 'compact-break' && message.role !== 'composio_auth_required',
  );
  return normalizePiMessagesForLlm(runnableMessages, options);
}
