import type { ChatRequestContext } from '@/app/lib/chat/types';
import { sendMessage } from '@/app/lib/pi/runtime-service';
import type { InboundMessage } from './types';
import { resolveChannelSession } from './session-resolver';
import { buildUserAgentMessageFromInbound } from './message-normalization';
import { buildChannelChatContext } from './chat-context';
import { requestedWorkspaceIdFromChatContext } from '@/app/lib/pi/session-workspace-context';
import { captureChatTransportJson } from '@/app/lib/chat/message-submission';
import { AgentWorkflowError } from '@/app/lib/agents/workflow-public-contracts';

export type RoutedChannelMessageResult = {
  sessionId: string;
  status: Record<string, unknown> | null;
};

export async function handleInboundChannelMessage(
  message: InboundMessage,
  context?: ChatRequestContext,
): Promise<RoutedChannelMessageResult> {
  // Capture the original message/intent before session resolution can await.
  const inbound = captureChatTransportJson(message);
  const requestContext = context === undefined ? undefined : captureChatTransportJson(context);
  const userMessage = buildUserAgentMessageFromInbound(inbound);
  // Provider event IDs are stable across active-session changes. Find their
  // actual original SQL admission before asking the channel resolver to write.
  const sourceModule = inbound.channelId === 'telegram' ? await import('@/app/lib/pi/durable-message-admission') : null;
  const sourceReceipt = sourceModule ? await sourceModule.readOwnedAcceptedChatMessageForChannelSource({
    userId: inbound.userId, clientMessageId: inbound.clientMessageId!, channelId: 'telegram',
    channelSessionKey: inbound.channelSessionKey,
    ...(inbound.channelThreadKey === undefined ? {} : { channelThreadKey: inbound.channelThreadKey }),
  }) : null;
  const sourceIdentity = sourceReceipt ? sourceModule!.readOwnedChatMessageExecutionSnapshot(sourceReceipt).payload.identity : null;
  if (sourceIdentity && inbound.requestedSessionId !== undefined && inbound.requestedSessionId !== sourceIdentity.sessionId) {
    throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_DENIED', 'The provider message belongs to a different original session.', 409);
  }
  const sessionId = sourceIdentity?.sessionId ?? await resolveChannelSession({
    userId: inbound.userId,
    channelId: inbound.channelId,
    channelSessionKey: inbound.channelSessionKey,
    channelThreadKey: inbound.channelThreadKey,
    requestedSessionId: inbound.requestedSessionId,
    agentId: inbound.agentId,
    displayName: typeof inbound.metadata?.displayName === 'string' ? inbound.metadata.displayName : null,
    workspaceId: requestedWorkspaceIdFromChatContext(requestContext),
  });

  const status = await sendMessage(
    sessionId,
    inbound.userId,
    userMessage,
    buildChannelChatContext(inbound, requestContext),
    { ...(inbound.body === undefined ? {} : { body: inbound.body }),
      ...(inbound.selection === undefined ? {} : { selection: inbound.selection }),
      ...((inbound.expectedAgentId ?? inbound.agentId ?? sourceIdentity?.agentId) === undefined ? {}
        : { expectedAgentId: inbound.expectedAgentId ?? inbound.agentId ?? sourceIdentity?.agentId }),
      ...((inbound.expectedWorkspaceId ?? sourceIdentity?.workspaceId) === undefined ? {}
        : { expectedWorkspaceId: inbound.expectedWorkspaceId ?? sourceIdentity?.workspaceId }) },
  );
  return { sessionId, status };
}
