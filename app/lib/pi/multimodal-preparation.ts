import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model } from '@earendil-works/pi-ai';

import {
  createPiContextBudgetSnapshot,
  type PiContextBudgetPolicy,
  type PiContextBudgetSnapshot,
  type PiEffectiveInstruction,
} from './context-budget';

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

/**
 * Produces the provider-ready messages and the one immutable budget snapshot
 * from the exact same normalized payload. Callers must pass the output cap
 * that they also put on the associated provider request.
 */
export async function preparePiFinalPayload(
  input: {
    messages: AgentMessage[];
    model: Model<Api>;
    effectiveInstructions: readonly PiEffectiveInstruction[];
    effectiveTools: readonly AgentTool[];
    requestOutputTokenCap: number;
    runtimeProviderOverheadTokens?: number;
    runtimeContractRevision?: string;
    policy?: PiContextBudgetPolicy;
  },
  options: PiMessageNormalizationOptions = {},
): Promise<{ messages: Message[]; budgetSnapshot: PiContextBudgetSnapshot }> {
  const messages = await prepareMessagesForEffectiveModel(input.messages, input.model, options);
  const budgetSnapshot = createPiContextBudgetSnapshot({
    model: input.model,
    effectiveInstructions: input.effectiveInstructions,
    finalMessages: messages,
    effectiveTools: input.effectiveTools,
    requestOutputTokenCap: input.requestOutputTokenCap,
    runtimeProviderOverheadTokens: input.runtimeProviderOverheadTokens,
    runtimeContractRevision: input.runtimeContractRevision,
    policy: input.policy,
  });
  return { messages, budgetSnapshot };
}
