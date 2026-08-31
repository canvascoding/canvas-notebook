'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  composeRecipientText,
  extractRecipientEmailsForCompose,
  forwardSubjectForCompose,
  normalizeAgentUsedContext,
  pruneUnreferencedInlineEmailAttachments,
  replySubjectForCompose,
  splitRecipientInput,
  uniqueComposeRecipients,
} from '@/app/apps/email/components/email-compose-utils';
import { extractEmailAddressForCompose } from '@/app/apps/email/components/email-client-format';
import { isFetchNetworkError } from '@/app/apps/email/components/email-client-network';
import type {
  EmailAccount,
  EmailComposeAgentToolEvent,
  EmailComposeDraft,
  EmailComposeMode,
  EmailMessageDetail,
  EmailOutboxDraft,
  WorkspaceInboxCase,
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

type SearchParamsReader = {
  get(name: string): string | null;
};

type UseEmailComposeControllerOptions = {
  accounts: EmailAccount[];
  activeAccount: EmailAccount | null;
  activeFolder: string;
  activeWorkspaceId: string | null;
  contextIntent: NotebookEmailContextIntent | null;
  onError: (error: string | null) => void;
  onMessageActionNotice: (notice: string | null) => void;
  onMessageDialogOpenChange: (open: boolean) => void;
  searchParams: SearchParamsReader;
};

export function useEmailComposeController({
  accounts,
  activeAccount,
  activeFolder,
  activeWorkspaceId,
  contextIntent,
  onError,
  onMessageActionNotice,
  onMessageDialogOpenChange,
  searchParams,
}: UseEmailComposeControllerOptions) {
  const t = useTranslations('emails');
  const [draft, setDraft] = useState<EmailComposeDraft | null>(null);
  const [outboxEditing, setOutboxEditing] = useState<{
    id: string;
    version: number;
    scope: 'personal' | 'workspace';
    workspaceId?: string;
  } | null>(null);
  const [reviewCase, setReviewCase] = useState<WorkspaceInboxCase | null>(null);
  const [reviewCenterRevision, setReviewCenterRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<EmailComposeAgentToolEvent[]>([]);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const openedOutboxDraftRef = useRef<string | null>(null);
  const openingOutboxDraftRef = useRef<string | null>(null);

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
    const ownAddresses = new Set(accounts.map((account) => account.emailAddress.trim().toLowerCase()).filter(Boolean));
    const from = extractEmailAddressForCompose(message.from);
    const originalTo = extractRecipientEmailsForCompose(message.to);
    const originalCc = extractRecipientEmailsForCompose(message.cc);
    const to = mode === 'forward'
      ? []
      : uniqueComposeRecipients([from, ...(mode === 'reply-all' ? originalTo : [])], ownAddresses);
    const cc = mode === 'reply-all' ? uniqueComposeRecipients(originalCc, ownAddresses) : [];
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
  }, [accounts, activeFolder]);

  const openDraft = useCallback((
    mode: EmailComposeMode,
    message: EmailMessageDetail,
    body = '',
    aiGenerated = false,
    initialUpdates: ComposeDraftUpdates = {},
  ) => {
    setError(null);
    onError(null);
    onMessageActionNotice(null);
    setAgentEvents([]);
    setAgentStatus(null);
    setDraft({ ...buildDraft(mode, message, body, aiGenerated), ...initialUpdates });
    onMessageDialogOpenChange(false);
  }, [buildDraft, onError, onMessageActionNotice, onMessageDialogOpenChange]);

  const openNewDraft = useCallback(() => {
    setError(null);
    onError(null);
    onMessageActionNotice(null);
    setAgentEvents([]);
    setAgentStatus(null);
    setDraft({
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
    });
    onMessageDialogOpenChange(false);
  }, [activeFolder, onError, onMessageActionNotice, onMessageDialogOpenChange]);

  const openWorkspaceOutboxDraft = useCallback((outboxDraft: EmailOutboxDraft, workspaceId = activeWorkspaceId) => {
    if (!workspaceId) return;
    const bodyValues = composeEmailEditorBodyValues(outboxDraft.body);
    setError(null);
    onError(null);
    setAgentEvents([]);
    setAgentStatus(null);
    setReviewCase(outboxDraft.reviewCase || null);
    setOutboxEditing({ id: outboxDraft.id, version: outboxDraft.version, scope: 'workspace', workspaceId });
    setDraft({
      aiGenerated: true,
      aiMode: 'workspace-agent',
      aiPrompt: '',
      aiTone: 'casual',
      attachments: outboxDraft.attachments || [],
      ...bodyValues,
      ccText: composeRecipientText(outboxDraft.cc),
      contextFiles: [],
      mode: 'compose',
      subject: outboxDraft.subject,
      toText: composeRecipientText(outboxDraft.to),
      usedContext: [],
    });
  }, [activeWorkspaceId, onError]);

  const openPersonalOutboxDraft = useCallback((outboxDraft: EmailOutboxDraft) => {
    const bodyValues = composeEmailEditorBodyValues(outboxDraft.body);
    setError(null);
    onError(null);
    setAgentEvents([]);
    setAgentStatus(null);
    setReviewCase(null);
    setOutboxEditing({ id: outboxDraft.id, version: outboxDraft.version, scope: 'personal' });
    setDraft({
      aiGenerated: true,
      aiMode: 'workspace-agent',
      aiPrompt: '',
      aiTone: 'casual',
      attachments: outboxDraft.attachments || [],
      ...bodyValues,
      ccText: composeRecipientText(outboxDraft.cc),
      contextFiles: [],
      mode: 'compose',
      subject: outboxDraft.subject,
      toText: composeRecipientText(outboxDraft.to),
      usedContext: [],
    });
  }, [onError]);

  const openOutboxDraftById = useCallback(async ({
    draftId,
    scope,
    workspaceId,
  }: {
    draftId: string;
    scope?: 'personal' | 'workspace';
    workspaceId?: string;
  }) => {
    const isWorkspaceDraft = scope === 'workspace' || Boolean(workspaceId);
    if (isWorkspaceDraft && !workspaceId) return false;
    const endpoint = isWorkspaceDraft
      ? `/api/workspaces/${encodeURIComponent(workspaceId!)}/email/outbox`
      : '/api/email/outbox';
    const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: EmailOutboxDraft[] } | null;
    if (!response.ok || !payload?.success) return false;
    const outboxDraft = payload.data?.find((item) => item.id === draftId);
    if (!outboxDraft) return false;
    if (isWorkspaceDraft) openWorkspaceOutboxDraft(outboxDraft, workspaceId);
    else openPersonalOutboxDraft(outboxDraft);
    return true;
  }, [openPersonalOutboxDraft, openWorkspaceOutboxDraft]);

  useEffect(() => {
    const draftId = contextIntent?.draftId;
    if (
      !draftId
      || contextIntent.status !== 'complete'
      || contextIntent.view !== 'review-draft'
      || openedOutboxDraftRef.current === draftId
      || openingOutboxDraftRef.current === draftId
    ) return;
    openingOutboxDraftRef.current = draftId;
    void openOutboxDraftById({
      draftId,
      scope: contextIntent.scope,
      workspaceId: contextIntent.workspaceId,
    }).then((opened) => {
      if (opened) openedOutboxDraftRef.current = draftId;
    }).finally(() => {
      if (openingOutboxDraftRef.current === draftId) openingOutboxDraftRef.current = null;
    });
  }, [contextIntent, openOutboxDraftById]);

  useEffect(() => {
    const draftId = searchParams.get('outboxDraft')?.trim();
    if (
      !draftId
      || openedOutboxDraftRef.current === draftId
      || openingOutboxDraftRef.current === draftId
    ) return;
    const workspaceId = searchParams.get('workspaceId')?.trim();
    openingOutboxDraftRef.current = draftId;
    const clearOpeningDraft = () => {
      if (openingOutboxDraftRef.current === draftId) openingOutboxDraftRef.current = null;
    };
    void openOutboxDraftById({
      draftId,
      scope: workspaceId ? 'workspace' : 'personal',
      workspaceId,
    }).then((opened) => {
      if (opened) openedOutboxDraftRef.current = draftId;
      clearOpeningDraft();
    }).catch(clearOpeningDraft);
  }, [openOutboxDraftById, searchParams]);

  const updateDraft = useCallback((updates: ComposeDraftUpdates) => {
    if (Object.prototype.hasOwnProperty.call(updates, 'aiMode') || Object.prototype.hasOwnProperty.call(updates, 'contextFiles')) {
      setAgentEvents([]);
      setAgentStatus(null);
    }
    setDraft((current) => current ? { ...current, ...updates } : current);
  }, []);

  const close = useCallback(() => {
    if (isSubmitting || isGeneratingAi) return;
    setDraft(null);
    setOutboxEditing(null);
    setReviewCase(null);
    setError(null);
    setAgentEvents([]);
    setAgentStatus(null);
  }, [isGeneratingAi, isSubmitting]);

  const generateAiBody = useCallback(async () => {
    if (!activeAccount || !draft || !draft.aiPrompt.trim()) return;
    setIsGeneratingAi(true);
    setError(null);
    onError(null);
    onMessageActionNotice(null);
    setAgentEvents([]);
    setAgentStatus(draft.aiMode === 'workspace-agent' ? t('composeAgentWorking') : null);

    try {
      const requestBody = {
        accountId: activeAccount.id,
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
        workspaceId: activeWorkspaceId,
      };

      if (draft.aiMode === 'quick') {
        updateQuickAiProgress('reading_context');
        const response = await fetch('/api/email/compose/ai?stream=1', {
          method: 'POST',
          headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(requestBody),
        });
        const body = await readEmailAiDraftStream(response, {
          onDelta: (_delta, nextBody) => {
            const bodyValues = composeEmailEditorBodyValues(nextBody);
            setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
          },
          onStatus: (stage, label) => updateQuickAiProgress(stage, label),
        });
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
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t('errors.generateCompose'));
      }
      if (!response.body) throw new Error(t('errors.generateCompose'));

      let receivedFinal = false;
      const applyAgentEvent = (event: EmailComposeAgentStreamEvent) => {
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
      if (!receivedFinal) throw new Error(t('errors.generateCompose'));
    } catch (generateError) {
      const message = isFetchNetworkError(generateError)
        ? t('errors.actionRequest')
        : generateError instanceof Error ? generateError.message : t('errors.generateCompose');
      setError(message);
      onError(message);
      setAgentStatus(null);
    } finally {
      setIsGeneratingAi(false);
    }
  }, [activeAccount, activeWorkspaceId, draft, onError, onMessageActionNotice, t, updateQuickAiProgress]);

  const generateAiReplyPreview = useCallback(async (message: EmailMessageDetail, folder: string) => {
    if (!activeAccount) return;
    openDraft('reply', message, '', true, { aiMode: 'quick', aiPrompt: '', usedContext: [] });
    setIsGeneratingAi(true);
    updateQuickAiProgress('reading_context');

    try {
      const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions?stream=1`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          folder,
          messageId: message.id,
          operation: 'ai-reply-preview',
          workspaceId: activeWorkspaceId,
        }),
      });
      const body = await readEmailAiDraftStream(response, {
        onDelta: (_delta, nextBody) => {
          const bodyValues = composeEmailEditorBodyValues(nextBody);
          setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
        },
        onStatus: (stage, label) => updateQuickAiProgress(stage, label),
      });
      const bodyValues = composeEmailEditorBodyValues(body);
      if (!bodyValues.body && !bodyValues.bodyHtml) throw new Error(t('errors.generateCompose'));
      setDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
      updateQuickAiProgress('ready');
    } catch (aiReplyError) {
      const messageText = isFetchNetworkError(aiReplyError)
        ? t('errors.actionRequest')
        : aiReplyError instanceof Error ? aiReplyError.message : t('errors.generateCompose');
      setError(messageText);
      throw aiReplyError;
    } finally {
      setIsGeneratingAi(false);
    }
  }, [activeAccount, activeWorkspaceId, openDraft, t, updateQuickAiProgress]);

  const persistOutboxDraft = useCallback(async () => {
    if (!draft || !outboxEditing) throw new Error(t('errors.updateMessage'));
    const bodyHtml = sanitizeEmailEditorHtml(draft.bodyHtml) || plainTextToEmailHtml(draft.body);
    const attachments = pruneUnreferencedInlineEmailAttachments(draft.attachments, bodyHtml);
    const basePath = outboxEditing.scope === 'workspace'
      ? `/api/workspaces/${encodeURIComponent(outboxEditing.workspaceId || '')}/email/outbox/${encodeURIComponent(outboxEditing.id)}`
      : `/api/email/outbox/${encodeURIComponent(outboxEditing.id)}`;
    const response = await fetch(basePath, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        expectedVersion: outboxEditing.version,
        subject: draft.subject,
        body: bodyHtml,
        to: splitRecipientInput(draft.toText),
        cc: splitRecipientInput(draft.ccText),
        bcc: [],
        attachments,
        status: 'editing',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
    const version = Number(payload.data?.version);
    if (!Number.isFinite(version)) throw new Error(t('errors.updateMessage'));
    setOutboxEditing((current) => current && current.id === outboxEditing.id ? { ...current, version } : current);
    return { basePath, version, isWorkspaceOutbox: outboxEditing.scope === 'workspace' };
  }, [draft, outboxEditing, t]);

  const save = useCallback(async () => {
    if (!outboxEditing) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await persistOutboxDraft();
      onMessageActionNotice(t('composeDraftSaved'));
    } catch (saveError) {
      const message = isFetchNetworkError(saveError)
        ? t('errors.actionRequest')
        : saveError instanceof Error ? saveError.message : t('errors.updateMessage');
      setError(message);
      onError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [onError, onMessageActionNotice, outboxEditing, persistOutboxDraft, t]);

  const submit = useCallback(async () => {
    if (!draft || (!outboxEditing && !activeAccount)) return;
    setIsSubmitting(true);
    setError(null);
    onError(null);
    onMessageActionNotice(null);

    try {
      const isNewCompose = draft.mode === 'compose';
      const bodyHtml = sanitizeEmailEditorHtml(draft.bodyHtml) || plainTextToEmailHtml(draft.body);
      const attachments = pruneUnreferencedInlineEmailAttachments(draft.attachments, bodyHtml);
      if (outboxEditing) {
        const saved = await persistOutboxDraft();
        const response = await fetch(`${saved.basePath}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ expectedVersion: saved.version }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
        setOutboxEditing(null);
        setReviewCase(null);
        if (saved.isWorkspaceOutbox) setReviewCenterRevision((current) => current + 1);
        setDraft(null);
        setError(null);
        onMessageActionNotice(t('messageSent'));
        return;
      }

      const activeAccountId = activeAccount?.id;
      if (!activeAccountId) return;

      const response = await fetch(isNewCompose
        ? '/api/email/send'
        : `/api/email/accounts/${encodeURIComponent(activeAccountId)}/messages/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(isNewCompose
          ? {
              accountId: activeAccountId,
              attachments,
              body: bodyHtml,
              cc: splitRecipientInput(draft.ccText),
              is_HTML: true,
              subject: draft.subject,
              to: splitRecipientInput(draft.toText),
            }
          : {
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
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
      setDraft(null);
      setError(null);
      onMessageActionNotice(t(draft.aiGenerated ? 'aiReplySent' : 'messageSent'));
    } catch (submitError) {
      const message = isFetchNetworkError(submitError)
        ? t('errors.actionRequest')
        : submitError instanceof Error ? submitError.message : t('errors.updateMessage');
      setError(message);
      onError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [activeAccount, draft, onError, onMessageActionNotice, outboxEditing, persistOutboxDraft, t]);

  return {
    agentEvents,
    agentStatus,
    close,
    draft,
    error,
    generateAiBody,
    generateAiReplyPreview,
    isGeneratingAi,
    isSubmitting,
    isWorkspaceOutboxReview: Boolean(outboxEditing),
    openDraft,
    openNewDraft,
    openPersonalOutboxDraft,
    openWorkspaceOutboxDraft,
    reviewCase,
    reviewCenterRevision,
    save,
    submit,
    updateDraft,
  };
}
