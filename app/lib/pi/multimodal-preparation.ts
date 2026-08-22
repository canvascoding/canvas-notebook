import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';

import {
  filterImagesForNonVisionModel,
  normalizePiMessagesForLlm,
  type PiMessageNormalizationOptions,
} from './message-normalization';

/**
 * The one boundary at which Canvas turns agent messages into provider payloads.
 * All execution modes use this helper so a model's effective input modalities
 * govern read-tool images consistently before PI's provider adapter encodes it.
 */
export async function prepareMessagesForEffectiveModel(
  messages: AgentMessage[],
  model: Model<Api>,
  options: PiMessageNormalizationOptions = {},
): Promise<Message[]> {
  const runnableMessages = messages.filter(
    (message) => message.role !== 'compact-break' && message.role !== 'composio_auth_required',
  );
  // `model` is the already materialized, policy-checked provider model. Its
  // input list is the effective capability contract for this request; do not
  // re-infer it from a model name at the delivery boundary.
  const capabilityScopedMessages = model.input.includes('image')
    ? runnableMessages
    : filterImagesForNonVisionModel(runnableMessages);

  return normalizePiMessagesForLlm(capabilityScopedMessages, options);
}
