'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  composeRecipientText,
  forwardSubjectForCompose,
  normalizeAgentUsedContext,
  pruneUnreferencedInlineEmailAttachments,
  replySubjectForCompose,
  splitRecipientInput,
} from '@/app/apps/email/components/email-compose-utils';
import { emailReplyRecipients } from '@/app/lib/email/addresses';
import { isFetchNetworkError } from '@/app/apps/email/components/email-client-network';
import type {
  EmailAccount,
  EmailComposeAgentToolEvent,
  EmailComposeDraft,
  EmailComposeMode,
  EmailMessageDetail,
} from '@/app/apps/email/components/email-client-types';
import {
  readEmailAiDraftStream,
  readEmailComposeAgentStream,
  type EmailAiStreamStage,
  type EmailComposeAgentStreamEvent,
} from '@/app/lib/email/client-ai-stream';
import { plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import {
  composeEmailEditorBodyValues,
  composeEmailEditorBodyValuesFromAiResult,
  sanitizeEmailEditorHtml,
} from '@/app/lib/email/html-editor-content';
import { openEmailReview } from '@/app/store/email-review-store';
import type { NotebookEmailContextIntent } from '@/app/lib/notebook/context-surface';

type ComposeDraftUpdates = Partial<Pick<
  EmailComposeDraft,
  | 'aiMode'
  | 'aiPrompt'
  | 'aiTone'
  | 'attachments'
  | 'body'
  | 'bodyHtml'
  | 'ccText'
  | 'contextFiles'
  | 'subject'
  | 'toText'
  | 'usedContext'
>>;

type UseEmailComposeControllerOptions = {
  ownerUserId: string | null;
  accounts: EmailAccount[];
  activeAccount: EmailAccount | null;
  activeFolder: string;
  activeWorkspaceId: string | null;
  mailboxWorkspaceId: string | null;
  onAccessChanged(): Promise<void>;
  contextIntent: NotebookEmailContextIntent | null;
  onError: (error: string | null) => void;
  onMessageActionNotice: (notice: string | null) => void;
  onMessageDialogOpenChange: (open: boolean) => void;
};

type DraftSource = { ownerUserId: string; account: EmailAccount; mailboxWorkspaceId: string | null; attachmentWorkspaceId: string | null };

function accountScope(account: EmailAccount) { return account.accountScope ?? (account.workspaceId ? 'workspace' : 'personal'); }
function currentDraftAccount(source: DraftSource | null, ownerUserId: string | null, accounts: EmailAccount[]): EmailAccount | null {
  if (!source || source.ownerUserId !== ownerUserId) return null;
  return accounts.find(account => account.id === source.account.id && (account.workspaceId || null) === source.mailboxWorkspaceId
    && (account.mailboxId || null) === (source.account.mailboxId || null)
    && accountScope(account) === accountScope(source.account) && account.emailAddress === source.account.emailAddress
    && account.provider === source.account.provider && account.authType === source.account.authType && account.imapHost === source.account.imapHost
    && account.status === 'active' && account.connectionState !== 'reconnect_required') ?? null;
}

export function useEmailComposeController({
  ownerUserId,
  accounts,
  activeAccount,
  activeFolder,
  activeWorkspaceId,
  onAccessChanged,
  contextIntent,
  onError,
  onMessageActionNotice,
  onMessageDialogOpenChange,
}: UseEmailComposeControllerOptions) {
  const t = useTranslations('emails');
  const tm = useTranslations('emailMailboxes');
  const [sendUncertain, setSendUncertain] = useState(false);
  const sendUncertainRef = useRef(false);
  const attachmentWorkspaceRef = useRef<string | null>(null);
  const [draftSource, setDraftSource] = useState<DraftSource | null>(null);
  const [composeMinimized, setComposeMinimized] = useState(false);
  const sourceRef = useRef<DraftSource | null>(null);
  const currentRef = useRef({ ownerUserId, accounts, activeWorkspaceId });
  const draftRef = useRef<EmailComposeDraft | null>(null);
  const draftGenerationRef = useRef(0);
  const activeRequestRef = useRef<{ controller: AbortController; kind: 'ai' | 'send' } | null>(null);
  const openOutbox = useCallback(() => {
    const source = sourceRef.current;
    if (!source || source.ownerUserId !== currentRef.current.ownerUserId) return;
    void openEmailReview(undefined, { filter: 'failed' });
  }, []);
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState<EmailComposeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<EmailComposeAgentToolEvent[]>([]);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const handledReviewIntentRef = useRef<string | null>(null);
  useLayoutEffect(() => { currentRef.current = { ownerUserId, accounts, activeWorkspaceId }; draftRef.current = draft; }, [ownerUserId, accounts, activeWorkspaceId, draft]);
  const currentAccount = currentDraftAccount(draftSource, ownerUserId, accounts);
  const draftCanWrite = Boolean(currentAccount && currentAccount.capabilities?.canWrite !== false);
  const draftCanGenerateAi = draftCanWrite && currentAccount?.capabilities?.canRunAgent !== false;
  const visibleSource = draftSource?.ownerUserId === ownerUserId ? draftSource : null;
  const draftSourceUnavailable = Boolean(draft && draftOwner === ownerUserId && !draftCanWrite);
  const draftAccount = visibleSource ? { ...visibleSource.account, capabilities: currentAccount
    ? currentAccount.capabilities ?? { canRead: true, canWrite: true, canDelete: true, canManage: false, canRunAgent: true }
    : { canRead: false, canWrite: false, canDelete: false, canManage: false, canRunAgent: false } } : null;
  useLayoutEffect(() => {
    const request = activeRequestRef.current;
    if (request && (!currentAccount || !draftCanWrite || request.kind === 'ai' && !draftCanGenerateAi)) request.controller.abort();
  }, [currentAccount, draftCanWrite, draftCanGenerateAi]);
  useEffect(() => () => activeRequestRef.current?.controller.abort(), []);

  const resume = useCallback(() => { if (sourceRef.current?.ownerUserId === currentRef.current.ownerUserId && draftRef.current) setComposeMinimized(false); }, []);
  const minimize = useCallback(() => { if (sourceRef.current?.ownerUserId === currentRef.current.ownerUserId && draftRef.current) setComposeMinimized(true); }, []);
  const pinSource = useCallback(() => {
    if (ownerUserId !== currentRef.current.ownerUserId) return false;
    if (draftRef.current && sourceRef.current?.ownerUserId === ownerUserId) { resume(); return false; }
    if (!ownerUserId || !activeAccount || activeAccount.capabilities?.canWrite === false) return false;
    const source: DraftSource = { ownerUserId, account: structuredClone(activeAccount), mailboxWorkspaceId: activeAccount.workspaceId || null, attachmentWorkspaceId: currentRef.current.activeWorkspaceId };
    const current = currentDraftAccount(source, ownerUserId, currentRef.current.accounts);
    if (!current || current.capabilities?.canWrite === false) { setError(tm('senderChanged')); return false; }
    activeRequestRef.current?.controller.abort();
    draftGenerationRef.current++;
    setIsGeneratingAi(false);
    setIsSubmitting(false);
    sourceRef.current = source;
    setDraftSource(source);
    setDraftOwner(ownerUserId);
    attachmentWorkspaceRef.current = source.attachmentWorkspaceId;
    setComposeMinimized(false);
    return true;
  }, [activeAccount, ownerUserId, resume, tm]);

  const composeAiStageLabel = useCallback((stage: EmailAiStreamStage | undefined, fallback?: string) => {
    if (stage === 'reading_context') return t('composeAiReadingContext');
    if (stage === 'writing') return t('composeAiWritingDraft');
    if (stage === 'ready') return t('composeAiDraftReady');
    return fallback || t('composeGeneratingWithAi');
  }, [t]);

  const updateQuickAiProgress = useCallback((stage: EmailAiStreamStage | undefined, fallback?: string) => {
    const label = composeAiStageLabel(stage, fallback);
    setAgentStatus(label);
    setAgentEvents([{
      id: 'quick-ai-draft',
      label,
      resultPreview: label,
      status: stage === 'ready' ? 'done' : 'running',
      toolName: 'email_quick_ai',
    }]);
  }, [composeAiStageLabel]);

  const buildDraft = useCallback((
    mode: EmailComposeMode,
    message: EmailMessageDetail,
    body = '',
    aiGenerated = false,
  ): EmailComposeDraft => {
    const bodyValues = composeEmailEditorBodyValues(body);
    const senderAddress = sourceRef.current?.account.emailAddress || activeAccount?.emailAddress;
    const ownAddresses = new Set([
      senderAddress || '',
      ...accounts.filter(account => accountScope(account) === 'personal').map(account => account.emailAddress),
    ].map(address => address.trim().toLowerCase()).filter(Boolean));
    const { to, cc } = emailReplyRecipients(message, mode === 'compose' ? 'reply' : mode, ownAddresses);
    const subject = mode === 'forward'
      ? forwardSubjectForCompose(message.subject || '')
      : replySubjectForCompose(message.subject || '');

    return {
      aiGenerated,
      aiMode: 'workspace-agent',
      aiPrompt: '',
      aiTone: 'casual',
      attachments: [],
      ...bodyValues,
      ccText: composeRecipientText(cc),
      contextFiles: [],
      folder: message.folder || activeFolder,
      message,
      mode,
      subject,
      toText: composeRecipientText(to),
      usedContext: [],
    };
  }, [accounts, activeAccount, activeFolder]);

  const openDraft = useCallback((
    mode: EmailComposeMode,
    message: EmailMessageDetail,
    body = '',
    aiGenerated = false,
    initialUpdates: ComposeDraftUpdates = {},
  ) => {
    if (!pinSource()) return false;
    setError(null);
    onError(null);
    onMessageActionNotice(null);
    setAgentEvents([]);
    setAgentStatus(null);
    sendUncertainRef.current = false;
    setSendUncertain(false);
    const nextDraft = { ...buildDraft(mode, message, body, aiGenerated), ...initialUpdates };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    onMessageDialogOpenChange(false);
    return true;
  }, [pinSource, buildDraft, onError, onMessageActionNotice, onMessageDialogOpenChange]);

  const openNewDraft = useCallback(() => {
    if (!pinSource()) return;
    sendUncertainRef.current = false;
    setSendUncertain(false);
    setError(null);
    onError(null);
    onMessageActionNotice(null);
    setAgentEvents([]);
    setAgentStatus(null);
    const nextDraft: EmailComposeDraft = {
      aiGenerated: false,
      aiMode: 'workspace-agent',
      aiPrompt: '',
      aiTone: 'casual',
      attachments: [],
      body: '',
      bodyHtml: '',
      ccText: '',
      contextFiles: [],
      folder: activeFolder,
      mode: 'compose',
      subject: '',
      toText: '',
      usedContext: [],
    };
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    onMessageDialogOpenChange(false);
  }, [pinSource, activeFolder, onError, onMessageActionNotice, onMessageDialogOpenChange]);

  useEffect(() => {
    if (!contextIntent?.draftId || contextIntent.status !== 'complete' || contextIntent.view !== 'review-draft') return;
    const key = `${contextIntent.toolCallId || contextIntent.toolName}:${contextIntent.draftId}`;
    if (handledReviewIntentRef.current === key) return;
    handledReviewIntentRef.current = key;
    const scope = contextIntent.scope || (contextIntent.workspaceId ? 'workspace' : 'personal');
    void openEmailReview({
      draftId: contextIntent.draftId,
      scope,
      workspaceId: scope === 'workspace' ? contextIntent.workspaceId : undefined,
    });
  }, [contextIntent]);

  const updateDraft = useCallback((updates: ComposeDraftUpdates) => {
    if (sourceRef.current?.ownerUserId !== currentRef.current.ownerUserId) return;
    const currentDraft = draftRef.current;
    if (updates.attachments && attachmentWorkspaceRef.current !== currentRef.current.activeWorkspaceId) {
      const previousFiles = currentDraft?.attachments.filter(attachment => attachment.source === 'workspace') || [];
      const nextFiles = updates.attachments.filter(attachment => attachment.source === 'workspace');
      const removingFiles = nextFiles.length < previousFiles.length
        && nextFiles.every(attachment => previousFiles.some(previous => previous.id === attachment.id && previous.path === attachment.path));
      if (nextFiles.length && !removingFiles) {
        setError(tm('attachmentWorkspaceChanged'));
        return;
      }
    }
    if (updates.contextFiles && attachmentWorkspaceRef.current !== currentRef.current.activeWorkspaceId
      && updates.contextFiles.some(file => !currentDraft?.contextFiles.some(previous => previous.path === file.path))) {
      setError(tm('attachmentWorkspaceChanged')); return;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'aiMode') || Object.prototype.hasOwnProperty.call(updates, 'contextFiles')) {
      setAgentEvents([]);
      setAgentStatus(null);
    }
    if (currentDraft) { draftRef.current = { ...currentDraft, ...updates }; setDraft(draftRef.current); }
  }, [tm]);

  const close = useCallback(() => {
    if (isSubmitting || isGeneratingAi || activeRequestRef.current) return;
    setDraft(null);
    draftRef.current = null;
    sourceRef.current = null;
    setDraftSource(null);
    setComposeMinimized(false);
    sendUncertainRef.current = false;
    setSendUncertain(false);
    draftGenerationRef.current++;
    setError(null);
    setAgentEvents([]);
    setAgentStatus(null);
  }, [isGeneratingAi, isSubmitting]);

  const generateAiBody = useCallback(async () => {
    const source = sourceRef.current;
    const account = currentDraftAccount(source, currentRef.current.ownerUserId, currentRef.current.accounts);
    const draft = draftRef.current;
    if (!source || !account || !draft || !draft.aiPrompt.trim() || isGeneratingAi || isSubmitting || activeRequestRef.current || account.capabilities?.canWrite === false || account.capabilities?.canRunAgent === false) return;
    const generation = draftGenerationRef.current;
    const controller = new AbortController();
    activeRequestRef.current = { controller, kind: 'ai' };
    const current = () => generation === draftGenerationRef.current && source.ownerUserId === currentRef.current.ownerUserId && !controller.signal.aborted;
    setIsGeneratingAi(true);
    setError(null);
    onError(null);
    onMessageActionNotice(null);
    setAgentEvents([]);
    setAgentStatus(draft.aiMode === 'workspace-agent' ? t('composeAgentWorking') : null);

    try {
      const requestBody = {
        accountId: source.account.id,
        mailboxWorkspaceId: source.mailboxWorkspaceId,
        cc: splitRecipientInput(draft.ccText),
        contextFiles: draft.contextFiles.map((file) => ({ name: file.name, path: file.path })),
        currentBody: draft.body,
        currentBodyHtml: draft.bodyHtml,
        folder: draft.folder,
        instruction: draft.aiPrompt,
        messageId: draft.message?.id,
        mode: draft.mode,
        subject: draft.subject,
        to: splitRecipientInput(draft.toText),
        tone: draft.aiTone,
        workspaceId: source.attachmentWorkspaceId,
      };

      if (draft.aiMode === 'quick') {
        updateQuickAiProgress('reading_context');
        const response = await fetch('/api/email/compose/ai?stream=1', {
          method: 'POST',
          headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
          credentials: 'include',
          signal: controller.signal,
          body: JSON.stringify(requestBody),
        });
        const body = await readEmailAiDraftStream(response, {
          onDelta: (_delta, nextBody) => {
            if (!current()) return;
            const bodyValues = composeEmailEditorBodyValues(nextBody);
            setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
          },
          onStatus: (stage, label) => { if (current()) updateQuickAiProgress(stage, label); },
        });
        if (!current()) return;
        const bodyValues = composeEmailEditorBodyValues(body);
        if (!bodyValues.body && !bodyValues.bodyHtml) throw new Error(t('errors.generateCompose'));
        setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
        updateQuickAiProgress('ready');
        return;
      }

      const response = await fetch('/api/email/compose/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t('errors.generateCompose'));
      }
      if (!response.body) throw new Error(t('errors.generateCompose'));

      let receivedFinal = false;
      const applyAgentEvent = (event: EmailComposeAgentStreamEvent) => {
        if (!current()) return;
        if (event.type === 'status') {
          setAgentStatus(String(event.label || ''));
          return;
        }
        if (event.type === 'tool_start') {
          const id = String(event.id || '');
          const toolName = String(event.toolName || '');
          if (!id || !toolName) return;
          setAgentEvents((current) => [
            ...current.filter((entry) => entry.id !== id),
            { args: event.args, id, status: 'running', toolName },
          ]);
          return;
        }
        if (event.type === 'tool_end') {
          const id = String(event.id || '');
          const toolName = String(event.toolName || '');
          if (!id || !toolName) return;
          const nextEvent: EmailComposeAgentToolEvent = {
            contextPath: typeof event.contextPath === 'string' ? event.contextPath : undefined,
            id,
            resultPreview: typeof event.resultPreview === 'string' ? event.resultPreview : undefined,
            status: 'done',
            toolName,
          };
          setAgentEvents((current) => current.some((entry) => entry.id === id)
            ? current.map((entry) => entry.id === id ? { ...entry, ...nextEvent } : entry)
            : [...current, nextEvent]);
          return;
        }
        if (event.type === 'draft_delta') {
          setAgentStatus(t('composeAiWritingDraft'));
          return;
        }
        if (event.type === 'final') {
          const result = event.result && typeof event.result === 'object' && !Array.isArray(event.result)
            ? event.result as Record<string, unknown>
            : {};
          const body = String(result.body || '').trim();
          const bodyHtml = String(result.bodyHtml || '').trim();
          const bodyValues = composeEmailEditorBodyValuesFromAiResult(body, bodyHtml);
          if (!bodyValues.body && !bodyValues.bodyHtml) throw new Error(t('errors.generateCompose'));
          const subjectSuggestion = String(result.subjectSuggestion || '').trim();
          const usedContext = normalizeAgentUsedContext(result.usedContext);
          setDraft((current) => current ? {
            ...current,
            aiGenerated: true,
            ...bodyValues,
            subject: subjectSuggestion || current.subject,
            usedContext,
          } : current);
          setAgentStatus(t('composeAgentReady'));
          receivedFinal = true;
          return;
        }
        if (event.type === 'error') throw new Error(String(event.message || t('errors.generateCompose')));
      };

      await readEmailComposeAgentStream(response, applyAgentEvent);
      if (!current()) return;
      if (!receivedFinal) throw new Error(t('errors.generateCompose'));
    } catch (generateError) {
      if (!current()) return;
      const message = isFetchNetworkError(generateError)
        ? t('errors.actionRequest')
        : generateError instanceof Error ? generateError.message : t('errors.generateCompose');
      setError(message);
      onError(message);
      setAgentStatus(null);
    } finally {
      if (generation === draftGenerationRef.current) setIsGeneratingAi(false);
      if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null;
    }
  }, [isGeneratingAi, isSubmitting, onError, onMessageActionNotice, t, updateQuickAiProgress]);

  const generateAiReplyPreview = useCallback(async (message: EmailMessageDetail, folder: string) => {
    if (!activeAccount || isGeneratingAi || isSubmitting || activeRequestRef.current || activeAccount.capabilities?.canRunAgent === false) return;
    if (!openDraft('reply', message, '', true, { aiMode: 'quick', aiPrompt: '', usedContext: [] })) return;
    const source = sourceRef.current;
    const account = currentDraftAccount(source, currentRef.current.ownerUserId, currentRef.current.accounts);
    if (!source || !account || account.capabilities?.canWrite === false || account.capabilities?.canRunAgent === false) return;
    const generation = draftGenerationRef.current;
    const controller = new AbortController();
    activeRequestRef.current = { controller, kind: 'ai' };
    const current = () => generation === draftGenerationRef.current && source.ownerUserId === currentRef.current.ownerUserId && !controller.signal.aborted;
    setIsGeneratingAi(true);
    updateQuickAiProgress('reading_context');

    try {
      const endpoint = `/api/email/accounts/${encodeURIComponent(source.account.id)}/messages/actions?stream=1`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({
          mailboxWorkspaceId: source.mailboxWorkspaceId,
          folder,
          messageId: message.id,
          operation: 'ai-reply-preview',
          workspaceId: source.attachmentWorkspaceId,
        }),
      });
      const body = await readEmailAiDraftStream(response, {
        onDelta: (_delta, nextBody) => {
          if (!current()) return;
          const bodyValues = composeEmailEditorBodyValues(nextBody);
          setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
        },
        onStatus: (stage, label) => { if (current()) updateQuickAiProgress(stage, label); },
      });
      if (!current()) return;
      const bodyValues = composeEmailEditorBodyValues(body);
      if (!bodyValues.body && !bodyValues.bodyHtml) throw new Error(t('errors.generateCompose'));
      setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
      updateQuickAiProgress('ready');
    } catch (aiReplyError) {
      if (!current()) return;
      const messageText = isFetchNetworkError(aiReplyError)
        ? t('errors.actionRequest')
        : aiReplyError instanceof Error ? aiReplyError.message : t('errors.generateCompose');
      setError(messageText);
      throw aiReplyError;
    } finally {
      if (generation === draftGenerationRef.current) setIsGeneratingAi(false);
      if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null;
    }
  }, [activeAccount, isGeneratingAi, isSubmitting, openDraft, t, updateQuickAiProgress]);

  const submit = useCallback(async () => {
    const source = sourceRef.current;
    const account = currentDraftAccount(source, currentRef.current.ownerUserId, currentRef.current.accounts);
    const draft = draftRef.current;
    if (!draft || sendUncertainRef.current || isGeneratingAi || isSubmitting || activeRequestRef.current) return;
    if (!source || !account || account.capabilities?.canWrite === false) { setError(tm('senderChanged')); return; }
    if (draft.attachments.some(attachment => attachment.source === 'workspace') && attachmentWorkspaceRef.current !== currentRef.current.activeWorkspaceId) {
      setError(tm('attachmentWorkspaceChanged'));
      return;
    }
    setIsSubmitting(true);
    const generation = draftGenerationRef.current;
    const controller = new AbortController();
    activeRequestRef.current = { controller, kind: 'send' };
    const current = () => generation === draftGenerationRef.current && source.ownerUserId === currentRef.current.ownerUserId;
    const draftMailboxWorkspaceId = source.mailboxWorkspaceId;
    setError(null);
    onError(null);
    onMessageActionNotice(null);

    try {
      const isNewCompose = draft.mode === 'compose';
      const bodyHtml = sanitizeEmailEditorHtml(draft.bodyHtml) || plainTextToEmailHtml(draft.body);
      const attachments = pruneUnreferencedInlineEmailAttachments(draft.attachments, bodyHtml);
      const draftAccountId = source.account.id;

      const response = await fetch(isNewCompose
        ? '/api/email/send'
        : `/api/email/accounts/${encodeURIComponent(draftAccountId)}/messages/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify(isNewCompose
          ? {
              accountId: draftAccountId,
              mailboxWorkspaceId: draftMailboxWorkspaceId,
              attachmentWorkspaceId: attachmentWorkspaceRef.current,
              attachments,
              body: bodyHtml,
              cc: splitRecipientInput(draft.ccText),
              is_HTML: true,
              subject: draft.subject,
              to: splitRecipientInput(draft.toText),
            }
          : {
              mailboxWorkspaceId: draftMailboxWorkspaceId,
              attachmentWorkspaceId: attachmentWorkspaceRef.current,
              bodyOverride: draft.body,
              bodyOverrideHtml: bodyHtml,
              attachments,
              cc: splitRecipientInput(draft.ccText),
              folder: draft.folder,
              is_HTML: true,
              messageId: draft.message?.id,
              mode: draft.mode,
              operation: 'send',
              subject: draft.subject,
              to: splitRecipientInput(draft.toText),
            }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || !payload.success) {
        if (draftMailboxWorkspaceId && !payload.data?.id && (response.ok || response.status >= 500)) { sendUncertainRef.current = true; setSendUncertain(true); }
        if (draftMailboxWorkspaceId && payload.data?.id) {
          setDraft(null);
          draftRef.current = null;
          void openEmailReview({ scope: 'workspace', workspaceId: draftMailboxWorkspaceId, draftId: payload.data.id });
        }
        if (response.status === 403 || response.status === 409) void onAccessChanged();
        throw new Error(payload.error || t('errors.updateMessage'));
      }
      setDraft(null);
      draftRef.current = null;
      setComposeMinimized(false);
      setError(null);
      onMessageActionNotice(t(draft.aiGenerated ? 'aiReplySent' : 'messageSent'));
    } catch (submitError) {
      if (!current()) return;
      if (draftMailboxWorkspaceId && (isFetchNetworkError(submitError) || controller.signal.aborted)) { sendUncertainRef.current = true; setSendUncertain(true); }
      const message = isFetchNetworkError(submitError)
        ? (draftMailboxWorkspaceId ? tm('sendUncertain') : t('errors.actionRequest'))
        : submitError instanceof Error ? submitError.message : t('errors.updateMessage');
      setError(message);
      onError(message);
    } finally {
      if (generation === draftGenerationRef.current) setIsSubmitting(false);
      if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null;
    }
  }, [isGeneratingAi, isSubmitting, onAccessChanged, tm, onError, onMessageActionNotice, t]);

  return {
    sendUncertain,
    openOutbox,
    agentEvents,
    agentStatus,
    close,
    composeMinimized,
    minimize,
    resume,
    draftAccount,
    draftSenderAddress: visibleSource?.account.emailAddress ?? '',
    draftMailboxWorkspaceId: visibleSource?.mailboxWorkspaceId ?? null,
    draftAttachmentWorkspaceId: visibleSource?.attachmentWorkspaceId ?? null,
    draftCanWrite,
    draftCanGenerateAi,
    draftSourceUnavailable,
    draft: draftOwner === ownerUserId ? draft : null,
    error: error || (draftSourceUnavailable ? tm('senderChanged') : null),
    generateAiBody,
    generateAiReplyPreview,
    isGeneratingAi,
    isSubmitting,
    openDraft,
    openNewDraft,
    submit,
    updateDraft,
  };
}
