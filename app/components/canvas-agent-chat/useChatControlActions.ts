'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { useTranslations } from 'next-intl';
import { deriveUploadAttachmentPreview } from '@/app/lib/chat/attachment-preview';
import {
  clearCanvasChatActiveSessionStorage,
  writeCanvasChatActiveSessionStorage,
} from '@/app/lib/chat/constants';
import { composerDraftScope, loadComposerDraft, removeComposerDraft, saveComposerDraft } from '@/app/lib/chat/draft-storage';
import { saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { createChatSession } from '@/app/lib/chat/session-api';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { persistChatSendHandoff, readChatSendHandoff, removeChatSendHandoff, resolveChatCreation,
  type ChatCreationDraft, type ChatSendOverride, type ChatSendSnapshot } from '@/app/lib/chat/send-transaction';
import type { AiRuntimeSelection } from '@/app/lib/agent-runtime-policy/types';
import type {
  AISession,
  Attachment,
  ChatMessage,
  ChatRequestContext,
  QueuePreviewItem,
  UserPiContent,
} from '@/app/lib/chat/types';
import { toUploadMediaUrl } from '@/app/lib/utils/media-url';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import {
  countPiMessageImageAttachments,
  getQueuedSignatureFromPiMessage,
} from '@/app/components/canvas-agent-chat/chatRuntimeMessageUtils';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_THINKING_LEVEL,
} from '@/app/components/canvas-agent-chat/useChatAgentConfig';

type ChatTranslator = ReturnType<typeof useTranslations<'chat'>>;

type WebSocketRequest = <T extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>;

type ChatControlAction = 'send' | 'steer' | 'follow_up' | 'replace';
type ChatRuntimeControlAction =
  | 'follow_up'
  | 'steer'
  | 'promote_queued_to_steer'
  | 'remove_queued_item'
  | 'abort'
  | 'replace'
  | 'compact';

type StartNewChatOptions = {
  clearActiveSessionStorage?: boolean;
  keepHistoryOpen?: boolean;
};

type UseChatControlActionsParams = {
  activeModel: string;
  activeProvider: string;
  activeThinkingLevel: PiThinkingLevel;
  runtimeSelection: AiRuntimeSelection | null;
  hasLocalRuntimeSelection: boolean;
  runtimeCatalogRevision: number | null;
  runtimePolicyRevision: number | null;
  refreshRuntimeSelection: () => Promise<void> | void;
  activeWorkspaceId?: string | null;
  addSessionToHistory: (session: AISession) => void;
  appendCompactionBreak: (
    kind: 'manual' | 'automatic',
    timestamp: string,
    omittedMessageCount: number,
    attemptId?: string,
  ) => void;
  appendOptimisticUserMessage: (
    content: string,
    attachments: Attachment[],
    status: ChatMessage['status'],
    queueKind: ChatMessage['queueKind'],
    piMessage: Extract<AgentMessage, { role: 'user' }>,
  ) => string;
  appendSystemMessage: (content: string) => void;
  attachments: Attachment[];
  buildRequestContext: (activeFilePath: string | null) => ChatRequestContext;
  chatRequestTimeoutMs: number;
  clearCurrentAssistant: (messageId?: string | null) => void;
  createAssistantBubble: () => string;
  currentFilePath: string | null;
  ensureSessionSubscribed: (targetSessionId: string) => Promise<void>;
  fetchHistory: () => Promise<void>;
  input: string;
  isMobile: boolean;
  isUploading: boolean;
  messages: ChatMessage[];
  resetHistoryState: () => void;
  resetInputHistoryNavigation: () => void;
  resetRuntimeMessageRefs: () => void;
  resetStreamConnection: () => void;
  runtimePhase: RuntimeStatus['phase'] | undefined;
  selectedAgentId: string;
  sessionId: string | null;
  sessionAgentIdRef: MutableRefObject<string>;
  sessionIdRef: MutableRefObject<string | null>;
  sessionWorkspaceIdRef: MutableRefObject<string | null>;
  setActiveModel: Dispatch<SetStateAction<string>>;
  setActiveProvider: Dispatch<SetStateAction<string>>;
  setActiveThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel>>;
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  setExpandedRunKeys: Dispatch<SetStateAction<Set<string>>>;
  setHasMoreBefore: Dispatch<SetStateAction<boolean>>;
  setHistoryAgentFilter: (agentId: string) => void;
  setInput: Dispatch<SetStateAction<string>>;
  setIsLoadingOlder: Dispatch<SetStateAction<boolean>>;
  setIsResolvingInitialChatState: Dispatch<SetStateAction<boolean>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setOldestSequence: Dispatch<SetStateAction<number | null>>;
  setOldestTimestamp: Dispatch<SetStateAction<number | null>>;
  setOpenQueueItemPopoverId: Dispatch<SetStateAction<string | null>>;
  setOptimisticRuntimePhase: (phase: RuntimeStatus['phase'], sessionId: string) => void;
  setRuntimeStatus: Dispatch<SetStateAction<RuntimeStatus | null>>;
  setRuntimeStatusWithReconciliation: (status: RuntimeStatus) => void;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  setSessionId: Dispatch<SetStateAction<string | null>>;
  setSessionTitle: Dispatch<SetStateAction<string | null>>;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  touchSessionActivity: (sessionId: string, activityAt?: string) => void;
  setShowMobileDetails: Dispatch<SetStateAction<boolean>>;
  shouldShowHistoryAsOverlay: boolean;
  showHistory: boolean;
  skipNextSessionStatusRefreshRef: MutableRefObject<string | null>;
  t: ChatTranslator;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  userStartedNewChatRef: MutableRefObject<boolean>;
  wsRequest: WebSocketRequest;
};

type SendTransaction = {
  snapshot: ChatSendSnapshot;
  draft: ChatCreationDraft;
  auth: ReturnType<typeof openedDocumentAuthScope>;
  isCurrent: () => boolean;
  optimisticMessageId: string | null;
  optimisticAssistantId: string | null;
  queued: boolean;
  pending?: Promise<void>;
  completed: boolean;
};

function resolveAttachmentCategory(attachment: Attachment): string {
  const category = attachment.category || (attachment.contentKind === 'image' ? 'image' : 'document');
  return category;
}

function buildAttachmentContainerPath(attachment: Attachment): string {
  const category = resolveAttachmentCategory(attachment);
  return `/data/user-uploads/${category}/${attachment.id}`;
}

function buildPromptContent(text: string, attachments: Attachment[]): UserPiContent {
  if (attachments.length === 0) {
    return text;
  }

  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  if (text) {
    content.push({ type: 'text', text });
  }

  for (const attachment of attachments) {
    const displayAttachment = deriveUploadAttachmentPreview(attachment);
    const category = resolveAttachmentCategory(displayAttachment);
    const containerFilePath = displayAttachment.filePath || buildAttachmentContainerPath(displayAttachment);
    const metadataLines = [
      `containerFilePath: ${containerFilePath}`,
      `fileId: ${displayAttachment.id}`,
      `mimeType: ${displayAttachment.mimeType || 'application/octet-stream'}`,
      `category: ${category}`,
      `contentKind: ${displayAttachment.contentKind}`,
    ];

    if (displayAttachment.previewUrl) {
      metadataLines.push(`previewUrl: ${displayAttachment.previewUrl}`);
    }

    if (displayAttachment.mediaUrl) {
      metadataLines.push(`mediaUrl: ${displayAttachment.mediaUrl}`);
    }

    content.push({
      type: 'text',
      text: `--- Attachment: ${displayAttachment.name} ---
${metadataLines.join('\n')}

[Agent-Hinweis: Verwende containerFilePath, wenn du die Datei per Tool lesen, kopieren, verschieben oder im Workspace organisieren sollst.]
--- Ende Attachment: ${displayAttachment.name} ---`,
    });

    if (displayAttachment.contentKind === 'image') {
      // Images use the upload API URL and are converted to Base64 by message normalization.
      content.push({
        type: 'image',
        data: toUploadMediaUrl(displayAttachment.id),
        mimeType: displayAttachment.mimeType!,
      });
    }
  }

  return content;
}

export function useChatControlActions({
  activeModel: _activeModel,
  activeProvider: _activeProvider,
  activeThinkingLevel: _activeThinkingLevel,
  runtimeSelection,
  hasLocalRuntimeSelection,
  runtimeCatalogRevision,
  runtimePolicyRevision,
  refreshRuntimeSelection,
  activeWorkspaceId,
  addSessionToHistory,
  appendCompactionBreak,
  appendOptimisticUserMessage,
  appendSystemMessage,
  attachments,
  buildRequestContext,
  chatRequestTimeoutMs,
  clearCurrentAssistant,
  createAssistantBubble,
  currentFilePath,
  ensureSessionSubscribed,
  fetchHistory,
  input,
  isMobile,
  isUploading,
  messages,
  resetHistoryState,
  resetInputHistoryNavigation,
  resetRuntimeMessageRefs,
  resetStreamConnection,
  runtimePhase,
  selectedAgentId,
  sessionId,
  sessionAgentIdRef,
  sessionIdRef,
  sessionWorkspaceIdRef,
  setActiveModel,
  setActiveProvider,
  setActiveThinkingLevel,
  setAttachments,
  setExpandedRunKeys,
  setHasMoreBefore,
  setHistoryAgentFilter,
  setInput,
  setIsLoadingOlder,
  setIsResolvingInitialChatState,
  setMessages,
  setOldestSequence,
  setOldestTimestamp,
  setOpenQueueItemPopoverId,
  setOptimisticRuntimePhase,
  setRuntimeStatus,
  setRuntimeStatusWithReconciliation,
  setSelectedAgentId,
  setSessionId,
  setSessionTitle,
  setShowHistory,
  touchSessionActivity,
  setShowMobileDetails,
  shouldShowHistoryAsOverlay,
  showHistory,
  skipNextSessionStatusRefreshRef,
  t,
  textareaRef,
  userStartedNewChatRef,
  wsRequest,
}: UseChatControlActionsParams) {
  const contextKey = JSON.stringify([activeWorkspaceId ?? null, selectedAgentId, sessionId]);
  const navigationContextRef = useRef(contextKey);
  const navigationGenerationRef = useRef(0);
  const activeWorkspaceRef = useRef(activeWorkspaceId ?? null);
  const draftRef = useRef<ChatCreationDraft>({ id: '' });
  const transactionsRef = useRef(new Map<string, SendTransaction>());
  const [sendState, setSendState] = useState<{ contextKey: string; pending: boolean; error: string | null; transaction: SendTransaction } | null>(null);
  useLayoutEffect(() => {
    activeWorkspaceRef.current = activeWorkspaceId ?? null;
    if (navigationContextRef.current !== contextKey) {
      navigationGenerationRef.current += 1;
      transactionsRef.current.clear();
      navigationContextRef.current = contextKey;
      draftRef.current = { id: crypto.randomUUID() };
    }
  }, [activeWorkspaceId, contextKey]);
  useEffect(() => () => { navigationGenerationRef.current += 1; }, []);

  const startNewChat = useCallback((agentIdOverride?: string, options?: StartNewChatOptions) => {
    const nextAgentId = agentIdOverride || selectedAgentId;
    navigationGenerationRef.current += 1;
    transactionsRef.current.clear();
    draftRef.current = { id: crypto.randomUUID() };
    navigationContextRef.current = JSON.stringify([activeWorkspaceId ?? null, nextAgentId, null]);
    setSendState(null);
    const currentSessionId = sessionIdRef.current;
    const currentSessionWorkspaceId = sessionWorkspaceIdRef.current;
    if (currentSessionId) {
      writeCanvasChatActiveSessionStorage(currentSessionWorkspaceId ?? activeWorkspaceId, currentSessionId);
    }
    resetStreamConnection();
    setRuntimeStatus(null);
    setSessionId(null);
    setSessionTitle(null);
    resetInputHistoryNavigation();
    if (currentSessionId && input.trim()) {
      saveComposerDraft(currentSessionId, input, composerDraftScope(currentSessionWorkspaceId ?? activeWorkspaceId));
    }
    const newChatDraft = loadComposerDraft('__new__');
    setInput(newChatDraft ?? '');
    setAttachments([]);
    sessionIdRef.current = null;
    sessionWorkspaceIdRef.current = null;
    sessionAgentIdRef.current = nextAgentId;
    resetRuntimeMessageRefs();
    userStartedNewChatRef.current = true;
    setIsResolvingInitialChatState(false);
    if (options?.clearActiveSessionStorage !== false) {
      clearCanvasChatActiveSessionStorage(activeWorkspaceId);
    }
    setMessages([]);
    setHasMoreBefore(false);
    setOldestTimestamp(null);
    setOldestSequence(null);
    setIsLoadingOlder(false);
    setExpandedRunKeys(new Set());
    if (!options?.keepHistoryOpen && (isMobile || shouldShowHistoryAsOverlay)) {
      setShowHistory(false);
    }
    setShowMobileDetails(false);
    setActiveProvider(DEFAULT_PROVIDER_ID);
    setActiveModel(DEFAULT_MODEL_ID);
    setActiveThinkingLevel(DEFAULT_THINKING_LEVEL);
  }, [activeWorkspaceId, input, isMobile, resetInputHistoryNavigation, resetRuntimeMessageRefs, resetStreamConnection, selectedAgentId, sessionAgentIdRef, sessionIdRef, sessionWorkspaceIdRef, setActiveModel, setActiveProvider, setActiveThinkingLevel, setAttachments, setExpandedRunKeys, setHasMoreBefore, setInput, setIsLoadingOlder, setIsResolvingInitialChatState, setMessages, setOldestSequence, setOldestTimestamp, setRuntimeStatus, setSessionId, setSessionTitle, setShowHistory, setShowMobileDetails, shouldShowHistoryAsOverlay, userStartedNewChatRef]);

  const ensureSession = useCallback(async (transaction: SendTransaction) => {
    const snapshot = transaction.snapshot;
    if (!snapshot.targetSessionId) {
      try {
        snapshot.createdSession = await resolveChatCreation(transaction.draft, snapshot.creationRequest, createChatSession);
      } catch (error) {
        if (transaction.isCurrent()) await refreshRuntimeSelection();
        throw error;
      }
      snapshot.targetSessionId = snapshot.createdSession.session!.sessionId!;
      if (openedDocumentAuthScope() === transaction.auth) persistChatSendHandoff(snapshot);
    }
    if (!transaction.isCurrent()) throw new DOMException('The chat changed before the message could be sent.', 'AbortError');
    const targetSessionId = snapshot.targetSessionId;
    // Creation changes the composer identity from draft to session. Keep the
    // in-flight send reachable under both identities until acknowledgement.
    transactionsRef.current.set(JSON.stringify([snapshot.workspaceId, targetSessionId, snapshot.agentId,
      snapshot.action, snapshot.text, snapshot.attachments]), transaction);
    const created = snapshot.createdSession;
    if (!created?.session || sessionIdRef.current === targetSessionId) return targetSessionId;
    const pinnedSelection = created.runtime?.selection ?? snapshot.runtimeSelection;
    const model = created.session.model || pinnedSelection.modelId;
    const provider = created.session.provider || pinnedSelection.providerId;
    const thinkingLevel = created.session.thinkingLevel || pinnedSelection.thinkingLevel;
    const title = created.session.title || t('newChatTitle');
    sessionWorkspaceIdRef.current = snapshot.workspaceId;
    sessionAgentIdRef.current = snapshot.agentId;
    sessionIdRef.current = targetSessionId;
    skipNextSessionStatusRefreshRef.current = targetSessionId;
    const attachedContextKey = JSON.stringify([snapshot.workspaceId, snapshot.agentId, targetSessionId]);
    navigationContextRef.current = attachedContextKey;
    setSessionId(targetSessionId);
    setSessionTitle(title);
    setActiveProvider(provider);
    setActiveModel(model);
    setActiveThinkingLevel(thinkingLevel);
    setSendState((current) => current?.transaction === transaction && transaction.isCurrent()
      ? { ...current, contextKey: attachedContextKey } : current);
    addSessionToHistory({
      id: created.session.id ?? Date.now(), sessionId: targetSessionId, title,
      titleGenerationState: created.session.titleGenerationState ?? 'pending',
      agentId: snapshot.agentId, model, provider, thinkingLevel,
      createdAt: created.session.createdAt ?? new Date().toISOString(), engine: created.session.engine || 'pi',
      lastMessageAt: created.session.lastMessageAt ?? null, hasUnread: false,
      workspace: created.session.workspace ?? null, creator: created.session.creator,
    });
    return targetSessionId;
  }, [addSessionToHistory, refreshRuntimeSelection, sessionAgentIdRef, sessionIdRef, sessionWorkspaceIdRef,
    setActiveModel, setActiveProvider, setActiveThinkingLevel, setSessionId, setSessionTitle, skipNextSessionStatusRefreshRef, t]);

  const postControl = useCallback(async (
    targetSessionId: string,
    action: ChatRuntimeControlAction,
    message?: Extract<AgentMessage, { role: 'user' }>,
    queueItemId?: string,
    context?: ChatRequestContext,
    focusTopic?: string,
  ) => {
    const requestWorkspaceId = activeWorkspaceRef.current;
    const generation = navigationGenerationRef.current;
    const requestAuth = openedDocumentAuthScope();
    const payload = await wsRequest<{ success: boolean; status?: RuntimeStatus; error?: string }>('control', {
      sessionId: targetSessionId,
      action,
      ...(message ? { message, ...('clientMessageId' in message ? { clientMessageId: message.clientMessageId } : {}) } : {}),
      ...(queueItemId ? { queueItemId } : {}),
      ...(context ? { context } : {}),
      ...(focusTopic?.trim() ? { focusTopic: focusTopic.trim() } : {}),
    });

    if (payload.success === false) throw new Error(payload.error || 'Chat action failed.');
    if (payload.status) {
      if (generation === navigationGenerationRef.current && openedDocumentAuthScope() === requestAuth
        && activeWorkspaceRef.current === requestWorkspaceId
        && sessionIdRef.current === targetSessionId) {
        setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      }
      return payload.status as RuntimeStatus;
    }

    return null;
  }, [sessionIdRef, setRuntimeStatusWithReconciliation, wsRequest]);

  const executeTransaction = useCallback((transaction: SendTransaction): Promise<void> => {
    if (transaction.pending) return transaction.pending;
    if (transaction.completed) return Promise.resolve();
    if (!transaction.isCurrent()) return Promise.reject(new DOMException('The original chat is no longer active.', 'AbortError'));
    const { snapshot } = transaction;
    setSendState({ contextKey: navigationContextRef.current, pending: true, error: null, transaction });
    const run = async () => {
      try {
        const targetSessionId = await ensureSession(transaction);
        if (!transaction.isCurrent()) throw new DOMException('The chat changed before sending.', 'AbortError');
        if (!transaction.queued) setOptimisticRuntimePhase('streaming', targetSessionId);
        await ensureSessionSubscribed(targetSessionId);
        if (!transaction.isCurrent()) throw new DOMException('The chat changed before sending.', 'AbortError');
        const payload: { success: boolean; status?: RuntimeStatus | null; error?: string } = snapshot.action === 'send'
          ? await wsRequest<{ success: boolean; status?: RuntimeStatus; error?: string }>('send_message', {
            sessionId: targetSessionId,
            agentId: snapshot.agentId,
            clientMessageId: snapshot.message.clientMessageId,
            message: snapshot.message as unknown as Record<string, unknown>,
            context: snapshot.context,
          }, chatRequestTimeoutMs)
          : { success: true, status: await postControl(targetSessionId, snapshot.action, snapshot.message, undefined, snapshot.context) };
        if (payload.success === false) throw new Error(payload.error || 'Message could not be sent.');
        transaction.completed = true;
        for (const [key, candidate] of transactionsRef.current) {
          if (candidate === transaction) transactionsRef.current.delete(key);
        }
        if (openedDocumentAuthScope() === transaction.auth) {
          try { removeChatSendHandoff(snapshot); } catch { /* The source handoff is also consumed after acknowledgement. */ }
        }
        if (!transaction.isCurrent()) return;
        touchSessionActivity(targetSessionId, new Date(snapshot.message.timestamp).toISOString());
        if (transaction.optimisticMessageId) {
          setMessages((current) => !transaction.isCurrent() ? current : current.map((message) => (
            message.id === transaction.optimisticMessageId ? { ...message, status: 'sent' as const } : message
          )));
        }
        if (payload.status) setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
        setSendState((current) => current?.transaction === transaction ? null : current);
      } catch (error) {
        if (!transaction.isCurrent()) {
          throw new DOMException('The chat changed before sending completed.', 'AbortError');
        }
        if (transaction.isCurrent()) {
          if (transaction.optimisticMessageId) {
            setMessages((current) => !transaction.isCurrent() ? current : current.map((message) => (
              message.id === transaction.optimisticMessageId ? { ...message, status: 'error' as const } : message
            )));
          }
          if (transaction.optimisticAssistantId) {
            setMessages((current) => !transaction.isCurrent() ? current : current.filter((message) => message.id !== transaction.optimisticAssistantId));
            clearCurrentAssistant(transaction.optimisticAssistantId);
            transaction.optimisticAssistantId = null;
          }
          setSendState({ contextKey: navigationContextRef.current, pending: false,
            error: error instanceof Error ? error.message : String(error), transaction });
        }
        throw error;
      } finally {
        transaction.pending = undefined;
      }
    };
    transaction.pending = run();
    return transaction.pending;
  }, [chatRequestTimeoutMs, clearCurrentAssistant, ensureSession, ensureSessionSubscribed, postControl, setMessages,
    setOptimisticRuntimePhase, setRuntimeStatusWithReconciliation, touchSessionActivity, wsRequest]);

  const handleControlAction = useCallback(async (
    action: ChatControlAction,
    override?: ChatSendOverride,
  ) => {
    if (!override && isUploading) return;
    const rawText = override?.text ?? input.trim();
    const messageAttachments = structuredClone(override?.attachments ?? attachments);
    if (!rawText && messageAttachments.length === 0) {
      if (override) throw new Error('The message is empty.');
      return;
    }
    const workspaceId = activeWorkspaceRef.current;
    if (!workspaceId || (override?.workspaceId && override.workspaceId !== workspaceId)) {
      throw new DOMException('The message belongs to another workspace.', 'AbortError');
    }
    if (!runtimeSelection || runtimeCatalogRevision === null || runtimePolicyRevision === null) {
      throw new Error(t('runtimeSelectionUnavailableError'));
    }
    const handoffKey = override?.handoffId ? `handoff:${override.handoffId}` : null;
    const existingHandoff = handoffKey ? transactionsRef.current.get(handoffKey) : undefined;
    if (existingHandoff) return executeTransaction(existingHandoff);
    if (handoffKey) startNewChat(selectedAgentId);
    if (!draftRef.current.id) draftRef.current.id = crypto.randomUUID();
    const draft = draftRef.current;
    const sourceSessionId = sessionIdRef.current;
    const agentId = sourceSessionId ? sessionAgentIdRef.current || selectedAgentId : selectedAgentId;
    const key = handoffKey || JSON.stringify([workspaceId, sourceSessionId ?? draft.id, agentId, action, rawText, messageAttachments]);
    const existing = transactionsRef.current.get(key);
    if (existing && !existing.completed) return executeTransaction(existing);
    const generation = navigationGenerationRef.current;
    const auth = openedDocumentAuthScope();
    // Every value is captured before session creation or transport awaits.
    const context = structuredClone(buildRequestContext(currentFilePath));
    if (context.workspace?.workspaceId !== workspaceId) {
      throw new DOMException('The document workspace is still changing.', 'AbortError');
    }
    const restored = override?.handoffId ? readChatSendHandoff(override.handoffId, workspaceId) : null;
    const snapshot: ChatSendSnapshot = restored ?? {
      version: 1, ...(override?.handoffId ? { handoffId: override.handoffId } : {}),
      workspaceId, agentId, action, text: rawText, attachments: messageAttachments, context,
      message: { role: 'user', content: buildPromptContent(rawText, messageAttachments), timestamp: Date.now(), clientMessageId: crypto.randomUUID() },
      runtimeSelection: structuredClone(runtimeSelection), targetSessionId: sourceSessionId,
      creationRequest: {
        clientRequestId: draft.id, agentId, workspaceId, workspace: context.workspace,
        ...(hasLocalRuntimeSelection ? { runtimeSelection: structuredClone(runtimeSelection),
          expectedCatalogRevision: runtimeCatalogRevision, expectedPolicyRevision: runtimePolicyRevision } : {}),
      },
    };
    if (restored) draft.id = snapshot.creationRequest.clientRequestId!;
    persistChatSendHandoff(snapshot);
    const transaction: SendTransaction = {
      snapshot, draft, auth,
      isCurrent: () => generation === navigationGenerationRef.current
        && openedDocumentAuthScope() === auth && activeWorkspaceRef.current === workspaceId
        && (sessionIdRef.current === sourceSessionId || sessionIdRef.current === snapshot.targetSessionId)
        && sessionAgentIdRef.current === snapshot.agentId,
      optimisticMessageId: null, optimisticAssistantId: null,
      queued: action === 'follow_up' || (action === 'send' && runtimePhase !== undefined && runtimePhase !== 'idle'),
      completed: false,
    };
    transactionsRef.current.set(key, transaction);
    if (showHistory && (isMobile || shouldShowHistoryAsOverlay)) setShowHistory(false);
    resetInputHistoryNavigation();
    setInput('');
    setAttachments([]);
    removeComposerDraft(sourceSessionId ?? '__new__');
    const optimisticStatus: ChatMessage['status'] = transaction.queued ? 'queued_follow_up'
      : action === 'steer' ? 'queued_steering' : action === 'replace' ? 'aborting' : 'pending';
    if (!transaction.queued) {
      transaction.optimisticMessageId = appendOptimisticUserMessage(snapshot.text, snapshot.attachments,
        optimisticStatus, action === 'steer' ? 'steer' : undefined, snapshot.message);
    }
    if (action === 'send' && !transaction.queued) transaction.optimisticAssistantId = createAssistantBubble();
    setIsResolvingInitialChatState(false);
    return executeTransaction(transaction);
  }, [appendOptimisticUserMessage, attachments, buildRequestContext, createAssistantBubble, currentFilePath,
    executeTransaction, hasLocalRuntimeSelection, input, isMobile, isUploading, resetInputHistoryNavigation,
    runtimeCatalogRevision, runtimePhase, runtimePolicyRevision, runtimeSelection, selectedAgentId, sessionAgentIdRef,
    sessionIdRef, setAttachments, setInput, setIsResolvingInitialChatState, setShowHistory, shouldShowHistoryAsOverlay,
    showHistory, startNewChat, t]);

  const handleSend = useCallback(async () => {
    const generation = navigationGenerationRef.current;
    try {
      await handleControlAction('send');
    } catch (error) {
      if (generation === navigationGenerationRef.current && !(error instanceof DOMException && error.name === 'AbortError')) {
        appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
      }
    }
  }, [appendSystemMessage, handleControlAction, t]);

  const retryFailedSend = useCallback(async () => {
    if (!sendState?.transaction || sendState.transaction.snapshot.action !== 'send') return;
    try { await executeTransaction(sendState.transaction); } catch { /* executeTransaction retains the actionable error. */ }
  }, [executeTransaction, sendState]);
  const visibleSendState = sendState?.contextKey === contextKey ? sendState : null;

  const handlePromoteQueuedMessage = useCallback(async (queueItemId: string) => {
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'promote_queued_to_steer', undefined, queueItemId);
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, sessionIdRef, t]);

  const handleRemoveQueuedMessage = useCallback(async (queueItemId: string) => {
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'remove_queued_item', undefined, queueItemId);
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, sessionIdRef, t]);

  const handleStop = useCallback(async () => {
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId) return;
    setOptimisticRuntimePhase('aborting', targetSessionId);
    try {
      await postControl(targetSessionId, 'abort');
    } catch (error) {
      setOptimisticRuntimePhase(runtimePhase ?? 'idle', targetSessionId);
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, runtimePhase, sessionIdRef, setOptimisticRuntimePhase, t]);

  const handleEditQueuedMessage = useCallback(async (entry: QueuePreviewItem) => {
    if (!sessionIdRef.current) return;
    try {
      let messageAttachments: Attachment[] = [];
      if (entry.signature) {
        const matchingMessage = messages.find(
          (msg) =>
            msg.role === 'user' &&
            getQueuedSignatureFromPiMessage(msg.piMessage) === entry.signature,
        );
        if (matchingMessage?.attachments) {
          messageAttachments = matchingMessage.attachments;
        }
      } else {
        const matchingMessage = messages.find(
          (msg) =>
            msg.role === 'user' &&
            msg.content === entry.text &&
            countPiMessageImageAttachments(msg.piMessage) === entry.attachmentCount,
        );
        if (matchingMessage?.attachments) {
          messageAttachments = matchingMessage.attachments;
        }
      }

      await postControl(sessionIdRef.current, 'remove_queued_item', undefined, entry.id);
      setInput(entry.text);
      setAttachments(messageAttachments);
      setOpenQueueItemPopoverId(null);
      textareaRef.current?.focus();
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, messages, postControl, sessionIdRef, setAttachments, setInput, setOpenQueueItemPopoverId, t, textareaRef]);

  const handleCompact = useCallback(async (focusTopic?: string) => {
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId) return;
    const applyCompactionStatus = (status: RuntimeStatus | null) => {
      if (status?.compactionStatus?.state === 'no_op') {
        appendSystemMessage(t('compactAlreadyOptimized'));
      } else if (
        status?.compactionStatus?.state === 'succeeded'
        && status.lastCompactionAt
        && status.lastCompactionKind
      ) {
        appendCompactionBreak(
          status.lastCompactionKind,
          status.lastCompactionAt,
          status.lastCompactionOmittedCount || 0,
          status.compactionStatus.attemptId || undefined,
        );
      }
    };
    try {
      const status = await postControl(
        targetSessionId,
        'compact',
        undefined,
        undefined,
        undefined,
        focusTopic,
      );
      applyCompactionStatus(status);
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'REQUEST_TIMEOUT'
      ) {
        try {
          const recovered = await wsRequest<{ success: boolean; status?: RuntimeStatus }>('get_status', {
            sessionId: targetSessionId,
          });
          if (recovered.status) {
            setRuntimeStatusWithReconciliation(recovered.status);
            applyCompactionStatus(recovered.status);
            return;
          }
        } catch {
          // Fall through to the original transport error when status recovery also fails.
        }
      }
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendCompactionBreak, appendSystemMessage, postControl, sessionIdRef, setRuntimeStatusWithReconciliation, t, wsRequest]);


  const selectChatAgent = useCallback((agentId: string) => {
    if (agentId === selectedAgentId && !sessionIdRef.current) {
      return;
    }
    setSelectedAgentId(agentId);
    setHistoryAgentFilter(agentId);
    void saveLastActiveAgentId(agentId);
    resetHistoryState();
    startNewChat(agentId);
    void fetchHistory();
  }, [fetchHistory, resetHistoryState, selectedAgentId, sessionIdRef, setHistoryAgentFilter, setSelectedAgentId, startNewChat]);

  return {
    isSending: Boolean(visibleSendState?.pending),
    sendError: visibleSendState?.error ?? null,
    canRetrySend: Boolean(visibleSendState?.error && visibleSendState.transaction.snapshot.action === 'send'
      && !visibleSendState.transaction.snapshot.handoffId),
    retryFailedSend,
    handleCompact,
    handleControlAction,
    handleEditQueuedMessage,
    handlePromoteQueuedMessage,
    handleRemoveQueuedMessage,
    handleSend,
    handleStop,
    selectChatAgent,
    startNewChat,
  };
}
