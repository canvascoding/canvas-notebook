import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AiRuntimeSelection } from '@/app/lib/agent-runtime-policy/types';
import type { CreateChatSessionPayload, CreateChatSessionResponse } from '@/app/lib/chat/session-api';
import type { Attachment, ChatRequestContext } from '@/app/lib/chat/types';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { parseChatBody, projectChatBodyText, assertChatBodySelection, assertChatBodyContent, type ChatBodyV1 } from './chat-body-contracts';
import { chatExtensionSelectionInputSchema, type ChatExtensionSelectionInput } from '@/app/lib/capabilities/extensions/contracts';
import { captureChatTransportJson } from './message-submission';

export type ChatSendOverride = { text: string; attachments: Attachment[]; body?: ChatBodyV1; handoffId?: string; workspaceId?: string };
export type ChatSendAction = 'send' | 'steer' | 'follow_up' | 'replace';
export type ChatUserMessage = Extract<AgentMessage, { role: 'user' }> & { clientMessageId: string };

/** Capture UI values before awaiting. This creates no admission/source authority. */
export function captureChatSendValue<T>(value: T): T {
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    Object.values(entry).forEach(freeze);
    Object.freeze(entry);
  };
  const captured = structuredClone(value); freeze(captured); return captured;
}

export type ChatSendSnapshot = {
  version: 1;
  handoffId?: string;
  workspaceId: string;
  agentId: string;
  action: ChatSendAction;
  text: string;
  body?: ChatBodyV1;
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
      || typeof value.message.timestamp !== 'number') throw new Error('Invalid saved send transaction.');
    if ('selection' in value || 'intakeSelection' in value) throw new Error('Invalid saved account data.');
    if (value.body !== undefined) {
      const body = parseChatBody(value.body);
      if (projectChatBodyText(body) !== value.text) throw new Error('Invalid saved inline projection.');
      assertChatBodyContent(body, value.message.content);
      value.body = body;
    }
    value.message = captureChatSendValue(value.message);
    value.context = captureChatSendValue(value.context);
    value.attachments = captureChatSendValue(value.attachments);
    value.runtimeSelection = captureChatSendValue(value.runtimeSelection);
    value.creationRequest = captureChatSendValue(value.creationRequest);
    return value as ChatSendSnapshot;
  } catch {
    // An existing but damaged retry record must not become a new logical send
    // with a new CID after an uncertain acknowledgement.
    throw new Error('The original saved send cannot be restored. Keep the prompt and refresh before retrying.');
  }
}

export function persistChatSendHandoff(snapshot: ChatSendSnapshot): void {
  if (!snapshot.handoffId || typeof window === 'undefined') return;
  const key = handoffTransactionKey(snapshot.handoffId);
  if (!key) return;
  if ('selection' in snapshot || 'intakeSelection' in snapshot) throw new Error('Account receipts cannot be persisted with a send.');
  if (snapshot.body !== undefined) {
    const body = parseChatBody(snapshot.body);
    if (projectChatBodyText(body) !== snapshot.text) throw new Error('The saved message text differs from its inline body.');
    assertChatBodyContent(body, snapshot.message.content);
  }
  // A handoff cannot claim reload-safe retry if its frozen receipt wasn't saved.
  window.sessionStorage.setItem(key, JSON.stringify(snapshot));
}

/** Validate a fresh intake envelope against its captured public intent. Never persist this return value. */
export function captureChatBodyIntakeSelection(body: ChatBodyV1, value: unknown): ChatExtensionSelectionInput | null {
  const selection = value === null ? null : chatExtensionSelectionInputSchema.parse(captureChatTransportJson(value));
  assertChatBodySelection(body, selection === null ? null : { ...selection,
    selections: selection.selections.map(({ accountSelectionRef: _receipt, ...entry }) => entry) });
  return selection;
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
