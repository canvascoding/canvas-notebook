import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AiRuntimeSelection } from '@/app/lib/agent-runtime-policy/types';
import type { CreateChatSessionPayload, CreateChatSessionResponse } from '@/app/lib/chat/session-api';
import type { Attachment, ChatRequestContext } from '@/app/lib/chat/types';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

export type ChatSendOverride = { text: string; attachments: Attachment[]; handoffId?: string; workspaceId?: string };
export type ChatSendAction = 'send' | 'steer' | 'follow_up' | 'replace';
export type ChatUserMessage = Extract<AgentMessage, { role: 'user' }> & { clientMessageId: string };

export type ChatSendSnapshot = {
  version: 1;
  handoffId?: string;
  workspaceId: string;
  agentId: string;
  action: ChatSendAction;
  text: string;
  attachments: Attachment[];
  context: ChatRequestContext;
  message: ChatUserMessage;
  creationRequest: CreateChatSessionPayload;
  runtimeSelection: AiRuntimeSelection;
  targetSessionId: string | null;
  createdSession?: CreateChatSessionResponse;
};

/** The source handoff is input; this separate record is the exact retry receipt. */
function handoffTransactionKey(handoffId: string): string | null {
  const auth = openedDocumentAuthScope();
  return auth ? `canvas.chat.sendTransaction.v1:${JSON.stringify([auth.userId, auth.sessionId, handoffId])}` : null;
}

export function readChatSendHandoff(handoffId: string, workspaceId: string): ChatSendSnapshot | null {
  const key = handoffTransactionKey(handoffId);
  if (!key || typeof window === 'undefined') return null;
  try {
    const serialized = window.sessionStorage.getItem(key);
    if (!serialized) return null;
    const value = JSON.parse(serialized) as Partial<ChatSendSnapshot>;
    if (value.version !== 1 || value.handoffId !== handoffId || value.workspaceId !== workspaceId
      || typeof value.agentId !== 'string' || typeof value.text !== 'string'
      || !Array.isArray(value.attachments) || !value.context || !value.runtimeSelection
      || !value.creationRequest?.clientRequestId || !value.message?.clientMessageId
      || typeof value.message.timestamp !== 'number') return null;
    return value as ChatSendSnapshot;
  } catch {
    return null;
  }
}

export function persistChatSendHandoff(snapshot: ChatSendSnapshot): void {
  if (!snapshot.handoffId || typeof window === 'undefined') return;
  const key = handoffTransactionKey(snapshot.handoffId);
  if (!key) return;
  // A handoff cannot claim reload-safe retry if its frozen receipt wasn't saved.
  window.sessionStorage.setItem(key, JSON.stringify(snapshot));
}

export function removeChatSendHandoff(snapshot: ChatSendSnapshot): void {
  if (!snapshot.handoffId || typeof window === 'undefined') return;
  const key = handoffTransactionKey(snapshot.handoffId);
  if (key) window.sessionStorage.removeItem(key);
}

export type ChatCreationDraft = {
  id: string;
  request?: CreateChatSessionPayload;
  response?: CreateChatSessionResponse;
  pending?: Promise<CreateChatSessionResponse>;
};

/** Different sends from the same new draft share its first session creation. */
export function resolveChatCreation(
  draft: ChatCreationDraft,
  request: CreateChatSessionPayload,
  create: (request: CreateChatSessionPayload) => Promise<CreateChatSessionResponse | null>,
): Promise<CreateChatSessionResponse> {
  if (draft.response) return Promise.resolve(draft.response);
  if (draft.pending) return draft.pending;
  draft.request ??= request;
  const pending = create(draft.request).then((response) => {
    if (!response?.success || !response.session?.sessionId) {
      throw new Error(response?.error || 'Failed to create session');
    }
    draft.response = response;
    return response;
  }).finally(() => {
    if (draft.pending === pending) draft.pending = undefined;
  });
  draft.pending = pending;
  return pending;
}
