'use client';

import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { useTranslations } from 'next-intl';
import { deriveUploadAttachmentPreview } from '@/app/lib/chat/attachment-preview';
import { clearCanvasChatActiveSessionStorage } from '@/app/lib/chat/constants';
import { loadComposerDraft, removeComposerDraft, saveComposerDraft } from '@/app/lib/chat/draft-storage';
import { saveLastActiveAgentId } from '@/app/lib/chat/agent-preferences';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { createChatSession } from '@/app/lib/chat/session-api';
import type {
  AgentConfig,
  AISession,
  Attachment,
  ChatMessage,
  ChatRequestContext,
  QueuePreviewItem,
  UserPiContent,
} from '@/app/lib/chat/types';
import { toUploadMediaUrl } from '@/app/lib/utils/media-url';
import { isAutomaticSessionTitle } from '@/app/lib/pi/session-titles';
import type { PiThinkingLevel } from '@/app/lib/pi/config';
import {
  countPiMessageImageAttachments,
  getQueuedSignatureFromPiMessage,
} from '@/app/components/canvas-agent-chat/chatRuntimeMessageUtils';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_THINKING_LEVEL,
  isAgentConfigForAgent,
  resolveAgentModelState,
  resolveAgentProviderState,
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
};

type UseChatControlActionsParams = {
  activeModel: string;
  activeProvider: string;
  activeThinkingLevel: PiThinkingLevel;
  activeWorkspaceId?: string | null;
  addSessionToHistory: (session: AISession) => void;
  agentConfig: AgentConfig | null;
  appendCompactionBreak: (kind: 'manual' | 'automatic', timestamp: string, omittedMessageCount: number) => void;
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
  optimisticSessionTitlesRef: MutableRefObject<Record<string, string>>;
  resetHistoryState: () => void;
  resetInputHistoryNavigation: () => void;
  resetRuntimeMessageRefs: () => void;
  resetStreamConnection: () => void;
  runtimePhase: RuntimeStatus['phase'] | undefined;
  selectedAgentId: string;
  sessionAgentIdRef: MutableRefObject<string>;
  sessionIdRef: MutableRefObject<string | null>;
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
  setShowMobileDetails: Dispatch<SetStateAction<boolean>>;
  shouldShowHistoryAsOverlay: boolean;
  showHistory: boolean;
  skipNextSessionStatusRefreshRef: MutableRefObject<string | null>;
  t: ChatTranslator;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  userStartedNewChatRef: MutableRefObject<boolean>;
  wsRequest: WebSocketRequest;
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

function getOptimisticSessionTitle(candidate: string | null | undefined, fallbackTitle: string): string {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return fallbackTitle;
  }

  return trimmed.slice(0, 48);
}

export function useChatControlActions({
  activeModel,
  activeProvider,
  activeThinkingLevel,
  activeWorkspaceId,
  addSessionToHistory,
  agentConfig,
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
  optimisticSessionTitlesRef,
  resetHistoryState,
  resetInputHistoryNavigation,
  resetRuntimeMessageRefs,
  resetStreamConnection,
  runtimePhase,
  selectedAgentId,
  sessionAgentIdRef,
  sessionIdRef,
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
  setShowMobileDetails,
  shouldShowHistoryAsOverlay,
  showHistory,
  skipNextSessionStatusRefreshRef,
  t,
  textareaRef,
  userStartedNewChatRef,
  wsRequest,
}: UseChatControlActionsParams) {
  const ensureSession = useCallback(async (preferredTitle?: string) => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    const agentId = selectedAgentId;
    const sessionAgentConfig = isAgentConfigForAgent(agentConfig, agentId) ? agentConfig : null;
    const configuredModelState = resolveAgentModelState(sessionAgentConfig);
    const requestedModel = activeModel.trim() || configuredModelState?.model || '';
    const requestedThinkingLevel = activeModel.trim()
      ? activeThinkingLevel
      : configuredModelState?.thinkingLevel || activeThinkingLevel;
    const optimisticTitle = getOptimisticSessionTitle(preferredTitle ?? input, t('newChatTitle'));
    const requestedTitle = isAutomaticSessionTitle(optimisticTitle) ? undefined : optimisticTitle;
    const requestContext = buildRequestContext(currentFilePath);

    const createSessionPayload = await createChatSession({
      agentId,
      ...(requestedTitle ? { title: requestedTitle } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
      ...(requestContext.workspace ? {
        workspaceId: requestContext.workspace.workspaceId,
        workspace: requestContext.workspace,
      } : {}),
    });

    if (!createSessionPayload?.success || !createSessionPayload.session?.sessionId) {
      throw new Error(createSessionPayload?.error || 'Failed to create session');
    }

    const nextSessionId = createSessionPayload.session.sessionId as string;
    const createdProvider = createSessionPayload.session.provider || activeProvider;
    const createdModel = createSessionPayload.session.model || activeModel;
    const createdThinkingLevel = createSessionPayload.session.thinkingLevel || activeThinkingLevel;

    skipNextSessionStatusRefreshRef.current = nextSessionId;
    setSessionId(nextSessionId);
    setActiveProvider(createdProvider);
    setActiveModel(createdModel);
    setActiveThinkingLevel(createdThinkingLevel);
    sessionAgentIdRef.current = agentId;

    const tempTitle = requestedTitle || getOptimisticSessionTitle(preferredTitle ?? input, createSessionPayload.session.title || t('newChatTitle'));
    setSessionTitle(tempTitle);
    if (!isAutomaticSessionTitle(tempTitle)) {
      optimisticSessionTitlesRef.current[nextSessionId] = tempTitle;
    }

    sessionIdRef.current = nextSessionId;

    const newSession: AISession = {
      id: Date.now(),
      sessionId: nextSessionId,
      title: tempTitle,
      agentId: createSessionPayload.session.agentId || agentId,
      model: createdModel,
      provider: createdProvider,
      thinkingLevel: createdThinkingLevel,
      createdAt: new Date().toISOString(),
      engine: createSessionPayload.session.engine || 'pi',
      lastMessageAt: new Date().toISOString(),
      hasUnread: false,
      workspace: createSessionPayload.session.workspace ?? null,
      creator: createSessionPayload.session.creator,
    };

    addSessionToHistory(newSession);

    return nextSessionId;
  }, [activeModel, activeProvider, activeThinkingLevel, addSessionToHistory, agentConfig, buildRequestContext, currentFilePath, input, optimisticSessionTitlesRef, selectedAgentId, sessionAgentIdRef, sessionIdRef, setActiveModel, setActiveProvider, setActiveThinkingLevel, setSessionId, setSessionTitle, skipNextSessionStatusRefreshRef, t]);

  const postControl = useCallback(async (
    targetSessionId: string,
    action: ChatRuntimeControlAction,
    message?: Extract<AgentMessage, { role: 'user' }>,
    queueItemId?: string,
  ) => {
    const payload = await wsRequest<{ success: boolean; status?: RuntimeStatus; error?: string }>('control', {
      sessionId: targetSessionId,
      action,
      ...(message ? { message } : {}),
      ...(queueItemId ? { queueItemId } : {}),
    });

    if (payload.status) {
      setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      return payload.status as RuntimeStatus;
    }

    return null;
  }, [setRuntimeStatusWithReconciliation, wsRequest]);

  const scanForImageReferences = useCallback(async (): Promise<Attachment[]> => {
    return [];
  }, []);

  const handleControlAction = useCallback(async (
    action: ChatControlAction,
    override?: { text: string; attachments: Attachment[] },
  ) => {
    if (!override && isUploading) {
      return;
    }

    const sendShouldQueue = action === 'send' && runtimePhase !== undefined && runtimePhase !== 'idle';
    const effectiveAction = sendShouldQueue ? 'follow_up' : action;
    const rawText = override?.text ?? input.trim();
    const baseAttachments = override?.attachments ?? attachments;

    if (!rawText && baseAttachments.length === 0) {
      return;
    }

    const effectiveAgentConfig = isAgentConfigForAgent(agentConfig, selectedAgentId) ? agentConfig : null;
    const configuredModelState = resolveAgentModelState(effectiveAgentConfig);
    const effectiveModel = activeModel.trim() || configuredModelState?.model || '';

    if (!effectiveModel.trim()) {
      throw new Error(t('modelRequiredError'));
    }

    if (!activeModel.trim() && configuredModelState) {
      setActiveProvider(configuredModelState.provider);
      setActiveModel(configuredModelState.model);
      setActiveThinkingLevel(configuredModelState.thinkingLevel);
    }

    if (showHistory && (isMobile || shouldShowHistoryAsOverlay)) {
      setShowHistory(false);
    }

    const autoAttachments = override ? [] : await scanForImageReferences();
    const messageAttachments = [...baseAttachments, ...autoAttachments];
    const userMessage: Extract<AgentMessage, { role: 'user' }> = {
      role: 'user',
      content: buildPromptContent(rawText, messageAttachments),
      timestamp: Date.now(),
    };

    resetInputHistoryNavigation();
    setInput('');
    setAttachments([]);
    removeComposerDraft(sessionIdRef.current ?? '__new__');

    const optimisticStatus: ChatMessage['status'] = effectiveAction === 'follow_up'
      ? 'queued_follow_up'
      : effectiveAction === 'steer'
        ? 'queued_steering'
        : effectiveAction === 'replace'
          ? 'aborting'
          : 'pending';
    const optimisticQueueKind = effectiveAction === 'follow_up'
      ? 'follow_up'
      : effectiveAction === 'steer'
        ? 'steer'
        : undefined;
    const optimisticMessageId = effectiveAction === 'follow_up'
      ? null
      : appendOptimisticUserMessage(rawText, messageAttachments, optimisticStatus, optimisticQueueKind, userMessage);
    const optimisticAssistantId = effectiveAction === 'send' ? createAssistantBubble() : null;
    setIsResolvingInitialChatState(false);

    try {
      const targetSessionId = await ensureSession(rawText);
      setOptimisticRuntimePhase('streaming', targetSessionId);
      await ensureSessionSubscribed(targetSessionId);
      const payload = effectiveAction === 'send'
        ? await wsRequest<{ success: boolean; status?: RuntimeStatus; error?: string }>('send_message', {
          sessionId: targetSessionId,
          message: userMessage as unknown as Record<string, unknown>,
          context: buildRequestContext(currentFilePath),
        }, chatRequestTimeoutMs)
        : { status: await postControl(targetSessionId, effectiveAction, userMessage) };

      if (optimisticMessageId) {
        setMessages((prev) => prev.map((message) => (
          message.id === optimisticMessageId ? { ...message, status: 'sent' as const } : message
        )));
      }

      if (payload.status) {
        setRuntimeStatusWithReconciliation(payload.status as RuntimeStatus);
      }
    } catch (error) {
      if (optimisticMessageId) {
        setMessages((prev) => prev.map((message) => (
          message.id === optimisticMessageId ? { ...message, status: 'error' as const } : message
        )));
      }
      if (optimisticAssistantId) {
        setMessages((prev) => prev.filter((message) => message.id !== optimisticAssistantId));
        clearCurrentAssistant(optimisticAssistantId);
      }
      throw error;
    }
  }, [activeModel, agentConfig, appendOptimisticUserMessage, attachments, buildRequestContext, chatRequestTimeoutMs, clearCurrentAssistant, createAssistantBubble, currentFilePath, ensureSession, ensureSessionSubscribed, input, isMobile, isUploading, postControl, resetInputHistoryNavigation, runtimePhase, scanForImageReferences, selectedAgentId, sessionIdRef, setActiveModel, setActiveProvider, setActiveThinkingLevel, setAttachments, setInput, setIsResolvingInitialChatState, setMessages, setOptimisticRuntimePhase, setRuntimeStatusWithReconciliation, setShowHistory, shouldShowHistoryAsOverlay, showHistory, t, wsRequest]);

  const handleSend = useCallback(async () => {
    try {
      await handleControlAction('send');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, handleControlAction, t]);

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
    if (!sessionIdRef.current) return;
    try {
      await postControl(sessionIdRef.current, 'abort');
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendSystemMessage, postControl, sessionIdRef, t]);

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

  const handleCompact = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      const status = await postControl(sessionIdRef.current, 'compact');
      if (status?.lastCompactionAt && status.lastCompactionKind) {
        if (status.lastCompactionOmittedCount === 0) {
          appendSystemMessage(t('compactAlreadyOptimized'));
        } else {
          appendCompactionBreak(status.lastCompactionKind, status.lastCompactionAt, status.lastCompactionOmittedCount || 0);
        }
      }
    } catch (error) {
      appendSystemMessage(t('errorMessage', { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [appendCompactionBreak, appendSystemMessage, postControl, sessionIdRef, t]);

  const startNewChat = useCallback((agentIdOverride?: string, options?: StartNewChatOptions) => {
    const nextAgentId = agentIdOverride || selectedAgentId;
    resetStreamConnection();
    setRuntimeStatus(null);
    setSessionId(null);
    setSessionTitle(null);
    resetInputHistoryNavigation();
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId && input.trim()) {
      saveComposerDraft(currentSessionId, input);
    }
    const newChatDraft = loadComposerDraft('__new__');
    setInput(newChatDraft ?? '');
    setAttachments([]);
    sessionIdRef.current = null;
    sessionAgentIdRef.current = nextAgentId;
    resetRuntimeMessageRefs();
    userStartedNewChatRef.current = true;
    if (options?.clearActiveSessionStorage !== false) {
      clearCanvasChatActiveSessionStorage(activeWorkspaceId);
    }
    setMessages([]);
    setHasMoreBefore(false);
    setOldestTimestamp(null);
    setOldestSequence(null);
    setIsLoadingOlder(false);
    setExpandedRunKeys(new Set());
    if (isMobile || shouldShowHistoryAsOverlay) {
      setShowHistory(false);
    }
    setShowMobileDetails(false);
    const isCurrentAgentConfig = agentConfig?.effectiveConfig?.agentId
      ? agentConfig.effectiveConfig.agentId === nextAgentId
      : nextAgentId === selectedAgentId;
    const providerState = isCurrentAgentConfig
      ? resolveAgentProviderState(agentConfig)
      : { provider: DEFAULT_PROVIDER_ID, model: DEFAULT_MODEL_ID, thinkingLevel: DEFAULT_THINKING_LEVEL };
    setActiveProvider(providerState.provider);
    setActiveModel(providerState.model);
    setActiveThinkingLevel(providerState.thinkingLevel);
  }, [activeWorkspaceId, agentConfig, input, isMobile, resetInputHistoryNavigation, resetRuntimeMessageRefs, resetStreamConnection, selectedAgentId, sessionAgentIdRef, sessionIdRef, setActiveModel, setActiveProvider, setActiveThinkingLevel, setAttachments, setExpandedRunKeys, setHasMoreBefore, setInput, setIsLoadingOlder, setMessages, setOldestSequence, setOldestTimestamp, setRuntimeStatus, setSessionId, setSessionTitle, setShowHistory, setShowMobileDetails, shouldShowHistoryAsOverlay, userStartedNewChatRef]);

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
