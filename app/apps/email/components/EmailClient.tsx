'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  MailWarning,
  Settings,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

import { EmailComposeDialog } from '@/app/apps/email/components/EmailComposeDialog';
import { EmailMailboxHeader } from '@/app/apps/email/components/EmailMailboxHeader';
import { EmailMailboxNavigation } from '@/app/apps/email/components/EmailMailboxNavigation';
import { EmailMessageViewer } from '@/app/apps/email/components/EmailMessageReader';
import { EmailReviewCenter } from '@/app/apps/email/components/EmailReviewCenter';
import { useEmailWorkspaceLayout } from '@/app/apps/email/components/EmailWorkspaceLayout';
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
import type {
  EmailAccount,
  EmailComposeAgentToolEvent,
  EmailComposeDialogLabels,
  EmailComposeDraft,
  EmailComposeMode,
  EmailFolder,
  EmailMessageActionName,
  EmailMessageContextMenuPosition,
  EmailMessageDetail,
  EmailMessageListActionName,
  EmailMessageListActionState,
  EmailMessageSummary,
  EmailOutboxDraft,
  WorkspaceInboxCase,
} from '@/app/apps/email/components/email-client-types';
import { useSetEmailChatContext } from '@/app/apps/email/context/email-chat-context';
import { buildEmailPageChatContext } from '@/app/apps/email/context/email-route-chat-context';
import { EmailAccountsCard } from '@/app/components/settings/IntegrationsSettingsClient';
import {
  readEmailAiDraftStream,
  readEmailComposeAgentStream,
  readEmailSummaryStream,
  type EmailAiStreamStage,
  type EmailComposeAgentStreamEvent,
} from '@/app/lib/email/client-ai-stream';
import { plainTextToEmailHtml } from '@/app/lib/email/html-conversion';
import {
  composeEmailEditorBodyValues,
  composeEmailEditorBodyValuesFromAiResult,
  sanitizeEmailEditorHtml,
} from '@/app/lib/email/html-editor-content';
import { emailMessageContentRevision, emailMessageListScopeKey } from '@/app/lib/email/reader-refresh';
import type { NotebookEmailContextIntent } from '@/app/lib/notebook/context-surface';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const EMAIL_BACKGROUND_REFRESH_MS = 60_000;

const MESSAGE_PAGE_SIZE = 20;
type EmailClientProps = {
  contextIntent?: NotebookEmailContextIntent | null;
  embedded?: boolean;
};

function isFetchNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch|fetch failed|networkerror/iu.test(error.message);
}

export function EmailClient({
  contextIntent = null,
  embedded = false,
}: EmailClientProps = {}) {
  const t = useTranslations('emails');
  const locale = useLocale();
  const setEmailChatContext = useSetEmailChatContext();
  const searchParams = useSearchParams();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const { containerRef, listWidth, mode: layoutMode, setListWidth } = useEmailWorkspaceLayout();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [emailAllowRemoteImages, setEmailAllowRemoteImages] = useState(false);
  const [emailRemoteImageAllowedSenders, setEmailRemoteImageAllowedSenders] = useState<string[]>([]);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [foldersAccountId, setFoldersAccountId] = useState('');
  const [activeFolder, setActiveFolder] = useState('INBOX');
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [messageTotal, setMessageTotal] = useState<number | null>(null);
  const [messagePage, setMessagePage] = useState(0);
  const [selectedMessageId, setSelectedMessageId] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<EmailMessageDetail | null>(null);
  const [pendingMessageUpdate, setPendingMessageUpdate] = useState<EmailMessageDetail | null>(null);
  const [messageUnavailable, setMessageUnavailable] = useState<EmailMessageSummary | null>(null);
  const [readerRevision, setReaderRevision] = useState(0);
  const [messageDialogOpen, setMessageDialogOpen] = useState(false);
  const [isFolderSidebarOpen, setIsFolderSidebarOpen] = useState(false);
  const [messageFilter, setMessageFilter] = useState<'all' | 'unread'>('all');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  const [isLoadingMessage, setIsLoadingMessage] = useState(false);
  const [activeMessageAction, setActiveMessageAction] = useState<EmailMessageActionName | null>(null);
  const [activeMessageListAction, setActiveMessageListAction] = useState<EmailMessageListActionState>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<(EmailMessageContextMenuPosition & { messageId: string }) | null>(null);
  const [composeDraft, setComposeDraft] = useState<EmailComposeDraft | null>(null);
  const [workspaceOutboxEditing, setWorkspaceOutboxEditing] = useState<{ id: string; version: number; scope: 'personal' | 'workspace'; workspaceId?: string } | null>(null);
  const [workspaceOutboxReviewCase, setWorkspaceOutboxReviewCase] = useState<WorkspaceInboxCase | null>(null);
  const [workspaceOutboxRevision, setWorkspaceOutboxRevision] = useState(0);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeAgentEvents, setComposeAgentEvents] = useState<EmailComposeAgentToolEvent[]>([]);
  const [composeAgentStatus, setComposeAgentStatus] = useState<string | null>(null);
  const [isGeneratingComposeAi, setIsGeneratingComposeAi] = useState(false);
  const [isSubmittingCompose, setIsSubmittingCompose] = useState(false);
  const [messageActionNotice, setMessageActionNotice] = useState<string | null>(null);
  const [messageSummary, setMessageSummary] = useState('');
  const [messageSummaryStatus, setMessageSummaryStatus] = useState<string | null>(null);
  const [streamingSummaryMessageId, setStreamingSummaryMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  const folderRequestRef = useRef<AbortController | null>(null);
  const listRequestRef = useRef<AbortController | null>(null);
  const listRequestScopeRef = useRef<string | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const detailRefreshRequestRef = useRef<AbortController | null>(null);
  const selectedMessageRef = useRef<EmailMessageDetail | null>(null);
  const dismissedMessageRevisionRef = useRef<string | null>(null);
  const hasMessagesRef = useRef(false);
  const activeAccountRef = useRef<string>('');
  const activeFolderRef = useRef('INBOX');
  const appliedContextIntentRef = useRef<string | null>(null);
  const openedOutboxDraftRef = useRef<string | null>(null);
  const openingOutboxDraftRef = useRef<string | null>(null);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) || accounts[0] || null,
    [accounts, activeAccountId],
  );
  const activeFolderName = useMemo(
    () => folders.find((folder) => folder.path === activeFolder)?.name || activeFolder,
    [activeFolder, folders],
  );
  const canReadActiveAccount = Boolean(activeAccount && (activeAccount.authType !== 'smtp_imap' || activeAccount.imapHost));
  const isStreamingSelectedMessageSummary = Boolean(selectedMessage && streamingSummaryMessageId === selectedMessage.id);

  useEffect(() => {
    activeAccountRef.current = activeAccount?.id || '';
    activeFolderRef.current = activeFolder;
    hasMessagesRef.current = messages.length > 0;
    selectedMessageRef.current = selectedMessage;
  }, [activeAccount?.id, activeFolder, messages.length, selectedMessage]);

  const stopMessageSummaryStream = useCallback(() => {
    summaryAbortControllerRef.current?.abort();
    summaryAbortControllerRef.current = null;
    setStreamingSummaryMessageId(null);
  }, []);

  const clearMessageSummary = useCallback(() => {
    stopMessageSummaryStream();
    setMessageSummary('');
    setMessageSummaryStatus(null);
  }, [stopMessageSummaryStream]);

  const clearReader = useCallback(() => {
    detailRequestRef.current?.abort();
    detailRefreshRequestRef.current?.abort();
    setSelectedMessage(null);
    setSelectedMessageId('');
    setPendingMessageUpdate(null);
    setMessageUnavailable(null);
    dismissedMessageRevisionRef.current = null;
    setReaderRevision((current) => current + 1);
    setMessageActionNotice(null);
    clearMessageSummary();
    setMessageDialogOpen(false);
  }, [clearMessageSummary]);

  const composeAiStageLabel = useCallback((stage: EmailAiStreamStage | undefined, fallback?: string) => {
    if (stage === 'reading_context') return t('composeAiReadingContext');
    if (stage === 'writing') return t('composeAiWritingDraft');
    if (stage === 'ready') return t('composeAiDraftReady');
    return fallback || t('composeGeneratingWithAi');
  }, [t]);

  const summaryAiStageLabel = useCallback((stage: EmailAiStreamStage | undefined, fallback?: string) => {
    if (stage === 'reading_context') return t('summaryReadingContext');
    if (stage === 'writing') return t('summaryWriting');
    if (stage === 'ready') return t('summaryReady');
    return fallback || t('aiSummary');
  }, [t]);

  const updateQuickAiProgress = useCallback((stage: EmailAiStreamStage | undefined, fallback?: string) => {
    const label = composeAiStageLabel(stage, fallback);
    setComposeAgentStatus(label);
    setComposeAgentEvents([{
      id: 'quick-ai-draft',
      label,
      resultPreview: label,
      status: stage === 'ready' ? 'done' : 'running',
      toolName: 'email_quick_ai',
    }]);
  }, [composeAiStageLabel]);

  useEffect(() => () => stopMessageSummaryStream(), [stopMessageSummaryStream]);

  useEffect(() => {
    setEmailChatContext(buildEmailPageChatContext({
      account: activeAccount,
      activeFolder,
      activeFolderName,
      filter: messageFilter,
      selectedMessage,
      selectedMessageId,
      submittedQuery,
    }));
  }, [
    activeAccount,
    activeFolder,
    activeFolderName,
    messageFilter,
    selectedMessage,
    selectedMessageId,
    setEmailChatContext,
    submittedQuery,
  ]);

  useEffect(() => () => setEmailChatContext(null), [setEmailChatContext]);

  const loadAccounts = useCallback(async () => {
    setIsLoadingAccounts(true);
    setError(null);
    try {
      const response = await fetch('/api/email/accounts', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadAccounts'));
      const nextAccounts = (payload.data?.accounts || []) as EmailAccount[];
      setAccounts(nextAccounts);
      setActiveAccountId((current) => {
        if (current && nextAccounts.some((account) => account.id === current)) return current;
        return nextAccounts.find((account) => account.isPrimary)?.id || nextAccounts[0]?.id || '';
      });
      if (nextAccounts.length === 0) setAccountsOpen(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.loadAccounts'));
    } finally {
      setIsLoadingAccounts(false);
    }
  }, [t]);

  const loadEmailPreferences = useCallback(async () => {
    try {
      const response = await fetch('/api/user-preferences', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadPreferences'));
      setEmailAllowRemoteImages(Boolean(payload.data?.emailAllowRemoteImages));
      setEmailRemoteImageAllowedSenders(Array.isArray(payload.data?.emailRemoteImageAllowedSenders)
        ? payload.data.emailRemoteImageAllowedSenders.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []);
    } catch (preferencesError) {
      setError(preferencesError instanceof Error ? preferencesError.message : t('errors.loadPreferences'));
    }
  }, [t]);

  const allowRemoteImagesForSender = useCallback((sender: string) => {
    const normalizedSender = extractEmailAddressForCompose(sender);
    if (!normalizedSender || emailRemoteImageAllowedSenders.includes(normalizedSender)) return;
    const previousSenders = emailRemoteImageAllowedSenders;
    const nextSenders = [...previousSenders, normalizedSender];
    setEmailRemoteImageAllowedSenders(nextSenders);
    fetch('/api/user-preferences', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailRemoteImageAllowedSenders: nextSenders }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadPreferences'));
      setEmailRemoteImageAllowedSenders(Array.isArray(payload.data?.emailRemoteImageAllowedSenders)
        ? payload.data.emailRemoteImageAllowedSenders.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []);
    }).catch((preferenceError) => {
      setEmailRemoteImageAllowedSenders(previousSenders);
      setError(preferenceError instanceof Error ? preferenceError.message : t('errors.loadPreferences'));
    });
  }, [emailRemoteImageAllowedSenders, t]);

  const selectAccount = (accountId: string) => {
    listRequestRef.current?.abort();
    folderRequestRef.current?.abort();
    clearReader();
    setActiveAccountId(accountId);
    setFoldersAccountId('');
    setActiveFolder('INBOX');
    setMessagePage(0);
  };

  const selectFolder = (folder: string) => {
    if (folder === activeFolder) return;
    listRequestRef.current?.abort();
    clearReader();
    setActiveFolder(folder);
    setMessagePage(0);
  };

  const loadFolders = useCallback(async (accountId: string) => {
    if (!accountId) return;
    folderRequestRef.current?.abort();
    const controller = new AbortController();
    folderRequestRef.current = controller;
    setIsLoadingFolders(true);
    setError(null);
    try {
      const response = await fetch(`/api/email/folders?accountId=${encodeURIComponent(accountId)}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadFolders'));
      if (folderRequestRef.current !== controller || activeAccountRef.current !== accountId) return;
      const nextFolders = (payload.data?.folders || []) as EmailFolder[];
      setFolders(nextFolders);
      setFoldersAccountId(accountId);
      setActiveFolder((current) => {
        if (current && nextFolders.some((folder) => folder.path === current)) return current;
        return nextFolders.find((folder) => folder.role === 'inbox')?.path || nextFolders[0]?.path || 'INBOX';
      });
    } catch (loadError) {
      if (controller.signal.aborted || folderRequestRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : t('errors.loadFolders'));
    } finally {
      if (folderRequestRef.current === controller) setIsLoadingFolders(false);
    }
  }, [t]);

  const refreshSelectedMessage = useCallback(async () => {
    const current = selectedMessageRef.current;
    if (!activeAccount || !current) return;
    const accountId = activeAccount.id;
    const folder = current.folder || activeFolder;
    detailRefreshRequestRef.current?.abort();
    const controller = new AbortController();
    detailRefreshRequestRef.current = controller;
    try {
      const params = new URLSearchParams({ folder });
      const response = await fetch(
        `/api/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(current.id)}?${params.toString()}`,
        { credentials: 'include', cache: 'no-store', signal: controller.signal },
      );
      const payload = await response.json().catch(() => ({}));
      if (
        detailRefreshRequestRef.current !== controller
        || activeAccountRef.current !== accountId
        || activeFolderRef.current !== folder
        || selectedMessageRef.current?.id !== current.id
      ) return;
      if (response.status === 404 && payload.code === 'EMAIL_MESSAGE_NOT_FOUND') {
        setMessageUnavailable(current);
        setPendingMessageUpdate(null);
        return;
      }
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessage'));
      const nextMessage = payload.data?.message as EmailMessageDetail | undefined;
      if (!nextMessage) throw new Error(t('errors.loadMessage'));
      setMessageUnavailable(null);
      const nextRevision = emailMessageContentRevision(nextMessage);
      if (nextRevision !== emailMessageContentRevision(current) && dismissedMessageRevisionRef.current !== nextRevision) {
        setPendingMessageUpdate(nextMessage);
      }
    } catch (refreshError) {
      if (controller.signal.aborted || detailRefreshRequestRef.current !== controller) return;
      setError(refreshError instanceof Error ? refreshError.message : t('errors.loadMessage'));
    }
  }, [activeAccount, activeFolder, t]);

  const loadMessages = useCallback(async (options?: { background?: boolean }) => {
    if (!activeAccount || !canReadActiveAccount || foldersAccountId !== activeAccount.id) return;
    const scopeKey = emailMessageListScopeKey({
      accountId: activeAccount.id,
      filter: messageFilter,
      folder: activeFolder,
      page: messagePage,
      query: submittedQuery,
    });
    if (listRequestRef.current && listRequestScopeRef.current === scopeKey) return;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    listRequestScopeRef.current = scopeKey;
    const preserveVisibleData = options?.background || hasMessagesRef.current;
    setIsLoadingMessages(!preserveVisibleData);
    setIsRefreshingMessages(preserveVisibleData);
    setError(null);
    try {
      const response = await fetch('/api/email/messages/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({
          accountId: activeAccount.id,
          filter: messageFilter,
          folder: activeFolder,
          query: submittedQuery,
          limit: MESSAGE_PAGE_SIZE,
          offset: messagePage * MESSAGE_PAGE_SIZE,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessages'));
      if (
        listRequestRef.current !== controller
        || activeAccountRef.current !== activeAccount.id
        || activeFolderRef.current !== activeFolder
      ) return;
      const nextMessages = (payload.data?.messages || []) as EmailMessageSummary[];
      setMessages(nextMessages);
      setMessageTotal(typeof payload.data?.total === 'number' ? payload.data.total : null);
      void refreshSelectedMessage();
    } catch (loadError) {
      if (controller.signal.aborted || listRequestRef.current !== controller) return;
      if (!preserveVisibleData) {
        setMessages([]);
        setMessageTotal(null);
      }
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessages'));
    } finally {
      if (listRequestRef.current === controller) {
        listRequestRef.current = null;
        listRequestScopeRef.current = null;
        setIsLoadingMessages(false);
        setIsRefreshingMessages(false);
      }
    }
  }, [activeAccount, activeFolder, canReadActiveAccount, foldersAccountId, messageFilter, messagePage, refreshSelectedMessage, submittedQuery, t]);

  const updateMessageReadState = useCallback((messageId: string, isRead: boolean) => {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, isRead } : message));
    setSelectedMessage((current) => current?.id === messageId ? { ...current, isRead } : current);
  }, []);

  const markMessageReadOnOpen = useCallback(async (message: EmailMessageSummary | EmailMessageDetail) => {
    if (!activeAccount || message.isRead) return;
    const folder = message.folder || activeFolder;
    updateMessageReadState(message.id, true);

    try {
      const response = await fetch(`/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'mark-read', folder, messageId: message.id, operation: 'action' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
      void loadFolders(activeAccount.id);
    } catch {
      updateMessageReadState(message.id, false);
    }
  }, [activeAccount, activeFolder, loadFolders, t, updateMessageReadState]);

  const loadMessage = useCallback(async (message: EmailMessageSummary, options?: { openDialog?: boolean }) => {
    if (!activeAccount) return;
    detailRequestRef.current?.abort();
    detailRefreshRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    const accountId = activeAccount.id;
    const folder = message.folder || activeFolder;
    setSelectedMessageId(message.id);
    setPendingMessageUpdate(null);
    setMessageUnavailable(null);
    dismissedMessageRevisionRef.current = null;
    setIsLoadingMessage(true);
    setError(null);
    setMessageActionNotice(null);
    clearMessageSummary();
    if (layoutMode !== 'wide' || options?.openDialog) setMessageDialogOpen(true);
    try {
      const params = new URLSearchParams();
      params.set('folder', folder);
      const response = await fetch(
        `/api/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(message.id)}?${params.toString()}`,
        { credentials: 'include', cache: 'no-store', signal: controller.signal },
      );
      const payload = await response.json().catch(() => ({}));
      if (
        detailRequestRef.current !== controller
        || activeAccountRef.current !== accountId
        || activeFolderRef.current !== folder
      ) return;
      if (response.status === 404 && payload.code === 'EMAIL_MESSAGE_NOT_FOUND') {
        setSelectedMessage(null);
        setMessageUnavailable(message);
        return;
      }
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessage'));
      const nextMessage = payload.data?.message as EmailMessageDetail | undefined;
      if (!nextMessage) throw new Error(t('errors.loadMessage'));
      setSelectedMessage({ ...nextMessage, folder: nextMessage.folder || folder });
      void markMessageReadOnOpen(nextMessage);
    } catch (loadError) {
      if (controller.signal.aborted || detailRequestRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessage'));
    } finally {
      if (detailRequestRef.current === controller) setIsLoadingMessage(false);
    }
  }, [activeAccount, activeFolder, clearMessageSummary, layoutMode, markMessageReadOnOpen, t]);

  useEffect(() => {
    if (!contextIntent) {
      appliedContextIntentRef.current = null;
      return;
    }

    const intentKey = [
      contextIntent.toolCallId || contextIntent.toolName,
      contextIntent.accountId || '',
      contextIntent.folder || '',
      contextIntent.messageId || '',
      contextIntent.draftId || '',
      contextIntent.query || '',
    ].join(':');
    if (appliedContextIntentRef.current === intentKey) return;

    const timeout = window.setTimeout(() => {
      const requestedAccountId = contextIntent.accountId;
      if (isLoadingAccounts) return;
      if (requestedAccountId && !accounts.some((account) => account.id === requestedAccountId)) {
        return;
      }
      if (
        requestedAccountId
        && accounts.some((account) => account.id === requestedAccountId)
        && activeAccountId !== requestedAccountId
      ) {
        clearReader();
        setActiveAccountId(requestedAccountId);
        setFoldersAccountId('');
        setActiveFolder(contextIntent.folder || 'INBOX');
        setMessagePage(0);
        return;
      }
      if (
        !activeAccount
        && contextIntent.toolName !== 'email_list_accounts'
        && contextIntent.toolName !== 'email_list_mailboxes'
      ) return;

      if (contextIntent.folder && activeFolder !== contextIntent.folder) {
        clearReader();
        setActiveFolder(contextIntent.folder);
        setMessagePage(0);
        return;
      }

      if (
        (contextIntent.view === 'message-list'
          || contextIntent.toolName === 'email_search'
          || contextIntent.toolName === 'email_search_messages')
        && contextIntent.query !== undefined
      ) {
        clearReader();
        setQuery(contextIntent.query);
        setSubmittedQuery(contextIntent.query);
        setMessagePage(0);
        return;
      }

      appliedContextIntentRef.current = intentKey;
      if (
        (contextIntent.view === 'message'
          || contextIntent.toolName === 'email_read'
          || contextIntent.toolName === 'email_read_message')
        && contextIntent.messageId
        && selectedMessage?.id !== contextIntent.messageId
      ) {
        const matchingMessage = messages.find((message) => message.id === contextIntent.messageId);
        void loadMessage(matchingMessage || {
          id: contextIntent.messageId,
          folder: contextIntent.folder,
          from: '',
          subject: contextIntent.subject || '',
          date: '',
          snippet: '',
        });
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [
    accounts,
    activeAccount,
    activeAccountId,
    activeFolder,
    clearReader,
    contextIntent,
    isLoadingAccounts,
    loadMessage,
    messages,
    selectedMessage?.id,
  ]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadAccounts();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAccounts]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadEmailPreferences();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadEmailPreferences]);

  useEffect(() => {
    if (layoutMode !== 'wide') return;
    const timeout = window.setTimeout(() => setMessageDialogOpen(false), 0);
    return () => window.clearTimeout(timeout);
  }, [layoutMode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      listRequestRef.current?.abort();
      folderRequestRef.current?.abort();
      setFolders([]);
      setFoldersAccountId('');
      setMessages([]);
      setMessageTotal(null);
      clearReader();
      if (!activeAccount) return;
      if (!canReadActiveAccount) return;
      void loadFolders(activeAccount.id);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeAccount, canReadActiveAccount, clearReader, loadFolders]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadMessages();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadMessages]);

  useEffect(() => {
    if (!canReadActiveAccount) return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void loadMessages({ background: true });
    };
    const interval = window.setInterval(refreshIfVisible, EMAIL_BACKGROUND_REFRESH_MS);
    window.addEventListener('online', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [canReadActiveAccount, loadMessages]);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    listRequestRef.current?.abort();
    clearReader();
    setMessagePage(0);
    setSubmittedQuery(query.trim());
  };

  const toggleUnreadFilter = () => {
    listRequestRef.current?.abort();
    clearReader();
    setMessagePage(0);
    setMessageFilter((current) => current === 'unread' ? 'all' : 'unread');
  };

  const buildComposeDraft = useCallback((mode: EmailComposeMode, message: EmailMessageDetail, body = '', aiGenerated = false): EmailComposeDraft => {
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

  const openComposeDraft = useCallback((
    mode: EmailComposeMode,
    message: EmailMessageDetail,
    body = '',
    aiGenerated = false,
    initialUpdates: Partial<Pick<EmailComposeDraft, 'aiMode' | 'aiPrompt' | 'aiTone' | 'body' | 'bodyHtml' | 'usedContext'>> = {},
  ) => {
    setComposeError(null);
    setError(null);
    setMessageActionNotice(null);
    setComposeAgentEvents([]);
    setComposeAgentStatus(null);
    setComposeDraft({ ...buildComposeDraft(mode, message, body, aiGenerated), ...initialUpdates });
    setMessageDialogOpen(false);
  }, [buildComposeDraft]);

  const openNewComposeDraft = useCallback(() => {
    setComposeError(null);
    setError(null);
    setMessageActionNotice(null);
    setComposeAgentEvents([]);
    setComposeAgentStatus(null);
    setComposeDraft({
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
    setMessageDialogOpen(false);
  }, [activeFolder]);

  const openWorkspaceOutboxDraft = useCallback((outboxDraft: EmailOutboxDraft, workspaceId = activeWorkspaceId) => {
    if (!workspaceId) return;
    const bodyValues = composeEmailEditorBodyValues(outboxDraft.body);
    setComposeError(null);
    setError(null);
    setComposeAgentEvents([]);
    setComposeAgentStatus(null);
    setWorkspaceOutboxReviewCase(outboxDraft.reviewCase || null);
    setWorkspaceOutboxEditing({ id: outboxDraft.id, version: outboxDraft.version, scope: 'workspace', workspaceId });
    setComposeDraft({
      aiGenerated: true, aiMode: 'workspace-agent', aiPrompt: '', aiTone: 'casual', attachments: outboxDraft.attachments || [],
      ...bodyValues, ccText: composeRecipientText(outboxDraft.cc), contextFiles: [], mode: 'compose',
      subject: outboxDraft.subject, toText: composeRecipientText(outboxDraft.to), usedContext: [],
    });
  }, [activeWorkspaceId]);

  const openPersonalOutboxDraft = useCallback((outboxDraft: EmailOutboxDraft) => {
    const bodyValues = composeEmailEditorBodyValues(outboxDraft.body);
    setComposeError(null);
    setError(null);
    setComposeAgentEvents([]);
    setComposeAgentStatus(null);
    setWorkspaceOutboxReviewCase(null);
    setWorkspaceOutboxEditing({ id: outboxDraft.id, version: outboxDraft.version, scope: 'personal' });
    setComposeDraft({
      aiGenerated: true, aiMode: 'workspace-agent', aiPrompt: '', aiTone: 'casual', attachments: outboxDraft.attachments || [],
      ...bodyValues, ccText: composeRecipientText(outboxDraft.cc), contextFiles: [], mode: 'compose',
      subject: outboxDraft.subject, toText: composeRecipientText(outboxDraft.to), usedContext: [],
    });
  }, []);

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
    const draft = payload.data?.find((item) => item.id === draftId);
    if (!draft) return false;
    if (isWorkspaceDraft) openWorkspaceOutboxDraft(draft, workspaceId);
    else openPersonalOutboxDraft(draft);
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
      if (openingOutboxDraftRef.current === draftId) {
        openingOutboxDraftRef.current = null;
      }
    };
    void openOutboxDraftById({
      draftId,
      scope: workspaceId ? 'workspace' : 'personal',
      workspaceId,
    })
      .then((opened) => {
        if (opened) openedOutboxDraftRef.current = draftId;
        clearOpeningDraft();
      })
      .catch(() => {
        clearOpeningDraft();
      });
  }, [openOutboxDraftById, searchParams]);

  const updateComposeDraft = useCallback((updates: Partial<Pick<EmailComposeDraft, 'aiMode' | 'aiPrompt' | 'aiTone' | 'attachments' | 'body' | 'bodyHtml' | 'ccText' | 'contextFiles' | 'subject' | 'toText' | 'usedContext'>>) => {
    if (Object.prototype.hasOwnProperty.call(updates, 'aiMode') || Object.prototype.hasOwnProperty.call(updates, 'contextFiles')) {
      setComposeAgentEvents([]);
      setComposeAgentStatus(null);
    }
    setComposeDraft((current) => current ? { ...current, ...updates } : current);
  }, []);

  const closeComposeDialog = useCallback(() => {
    if (isSubmittingCompose || isGeneratingComposeAi) return;
    setComposeDraft(null);
    setWorkspaceOutboxEditing(null);
    setWorkspaceOutboxReviewCase(null);
    setComposeError(null);
    setComposeAgentEvents([]);
    setComposeAgentStatus(null);
  }, [isGeneratingComposeAi, isSubmittingCompose]);

  const generateComposeAiBody = useCallback(async () => {
    if (!activeAccount || !composeDraft || !composeDraft.aiPrompt.trim()) return;
    setIsGeneratingComposeAi(true);
    setComposeError(null);
    setError(null);
    setMessageActionNotice(null);
    setComposeAgentEvents([]);
    setComposeAgentStatus(composeDraft.aiMode === 'workspace-agent' ? t('composeAgentWorking') : null);

    try {
      const requestBody = {
        accountId: activeAccount.id,
        cc: splitRecipientInput(composeDraft.ccText),
        contextFiles: composeDraft.contextFiles.map((file) => ({ name: file.name, path: file.path })),
        currentBody: composeDraft.body,
        currentBodyHtml: composeDraft.bodyHtml,
        folder: composeDraft.folder,
        instruction: composeDraft.aiPrompt,
        messageId: composeDraft.message?.id,
        mode: composeDraft.mode,
        subject: composeDraft.subject,
        to: splitRecipientInput(composeDraft.toText),
        tone: composeDraft.aiTone,
        workspaceId: activeWorkspaceId,
      };

      if (composeDraft.aiMode === 'quick') {
        updateQuickAiProgress('reading_context');
        const response = await fetch('/api/email/compose/ai?stream=1', {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(requestBody),
        });
        const body = await readEmailAiDraftStream(response, {
          onDelta: (_delta, nextBody) => {
            const bodyValues = composeEmailEditorBodyValues(nextBody);
            setComposeDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
          },
          onStatus: (stage, label) => updateQuickAiProgress(stage, label),
        });
        const bodyValues = composeEmailEditorBodyValues(body);
        if (!bodyValues.body && !bodyValues.bodyHtml) throw new Error(t('errors.generateCompose'));
        setComposeDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
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
          setComposeAgentStatus(String(event.label || ''));
          return;
        }
        if (event.type === 'tool_start') {
          const id = String(event.id || '');
          const toolName = String(event.toolName || '');
          if (!id || !toolName) return;
          setComposeAgentEvents((current) => [
            ...current.filter((entry) => entry.id !== id),
            {
              args: event.args,
              id,
              status: 'running',
              toolName,
            },
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
          setComposeAgentEvents((current) => (
            current.some((entry) => entry.id === id)
              ? current.map((entry) => entry.id === id ? { ...entry, ...nextEvent } : entry)
              : [...current, nextEvent]
          ));
          return;
        }
        if (event.type === 'draft_delta') {
          setComposeAgentStatus(t('composeAiWritingDraft'));
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
          setComposeDraft((current) => current ? {
            ...current,
            aiGenerated: true,
            ...bodyValues,
            subject: subjectSuggestion || current.subject,
            usedContext,
          } : current);
          setComposeAgentStatus(t('composeAgentReady'));
          receivedFinal = true;
          return;
        }
        if (event.type === 'error') {
          throw new Error(String(event.message || t('errors.generateCompose')));
        }
      };

      await readEmailComposeAgentStream(response, applyAgentEvent);

      if (!receivedFinal) throw new Error(t('errors.generateCompose'));
    } catch (generateError) {
      const message = isFetchNetworkError(generateError)
        ? t('errors.actionRequest')
        : generateError instanceof Error ? generateError.message : t('errors.generateCompose');
      setComposeError(message);
      setError(message);
      setComposeAgentStatus(null);
    } finally {
      setIsGeneratingComposeAi(false);
    }
  }, [activeAccount, activeWorkspaceId, composeDraft, t, updateQuickAiProgress]);

  const persistOutboxComposeDraft = useCallback(async () => {
    if (!composeDraft || !workspaceOutboxEditing) throw new Error(t('errors.updateMessage'));
    const bodyHtml = sanitizeEmailEditorHtml(composeDraft.bodyHtml) || plainTextToEmailHtml(composeDraft.body);
    const attachments = pruneUnreferencedInlineEmailAttachments(composeDraft.attachments, bodyHtml);
    const basePath = workspaceOutboxEditing.scope === 'workspace'
      ? `/api/workspaces/${encodeURIComponent(workspaceOutboxEditing.workspaceId || '')}/email/outbox/${encodeURIComponent(workspaceOutboxEditing.id)}`
      : `/api/email/outbox/${encodeURIComponent(workspaceOutboxEditing.id)}`;
    const saveResponse = await fetch(basePath, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        expectedVersion: workspaceOutboxEditing.version, subject: composeDraft.subject, body: bodyHtml,
        to: splitRecipientInput(composeDraft.toText), cc: splitRecipientInput(composeDraft.ccText), bcc: [], attachments, status: 'editing',
      }),
    });
    const savedPayload = await saveResponse.json().catch(() => ({}));
    if (!saveResponse.ok || !savedPayload.success) throw new Error(savedPayload.error || t('errors.updateMessage'));
    const version = Number(savedPayload.data?.version);
    if (!Number.isFinite(version)) throw new Error(t('errors.updateMessage'));
    setWorkspaceOutboxEditing((current) => current && current.id === workspaceOutboxEditing.id
      ? { ...current, version }
      : current);
    return { basePath, version, isWorkspaceOutbox: workspaceOutboxEditing.scope === 'workspace' };
  }, [composeDraft, t, workspaceOutboxEditing]);

  const saveOutboxComposeDraft = useCallback(async () => {
    if (!workspaceOutboxEditing) return;
    setIsSubmittingCompose(true);
    setComposeError(null);
    try {
      await persistOutboxComposeDraft();
      setMessageActionNotice(t('composeDraftSaved'));
    } catch (saveError) {
      const message = isFetchNetworkError(saveError)
        ? t('errors.actionRequest')
        : saveError instanceof Error ? saveError.message : t('errors.updateMessage');
      setComposeError(message);
      setError(message);
    } finally {
      setIsSubmittingCompose(false);
    }
  }, [persistOutboxComposeDraft, t, workspaceOutboxEditing]);

  const submitComposeDraft = useCallback(async () => {
    if (!composeDraft || (!workspaceOutboxEditing && !activeAccount)) return;
    setIsSubmittingCompose(true);
    setComposeError(null);
    setError(null);
    setMessageActionNotice(null);

    try {
      const isNewCompose = composeDraft.mode === 'compose';
      const bodyHtml = sanitizeEmailEditorHtml(composeDraft.bodyHtml) || plainTextToEmailHtml(composeDraft.body);
      const attachments = pruneUnreferencedInlineEmailAttachments(composeDraft.attachments, bodyHtml);
      if (workspaceOutboxEditing) {
        const saved = await persistOutboxComposeDraft();
        const sendResponse = await fetch(`${saved.basePath}/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ expectedVersion: saved.version }),
        });
        const sendPayload = await sendResponse.json().catch(() => ({}));
        if (!sendResponse.ok || !sendPayload.success) throw new Error(sendPayload.error || t('errors.updateMessage'));
        setWorkspaceOutboxEditing(null);
        setWorkspaceOutboxReviewCase(null);
        if (saved.isWorkspaceOutbox) setWorkspaceOutboxRevision((current) => current + 1);
        setComposeDraft(null);
        setComposeError(null);
        setMessageActionNotice(t('messageSent'));
        return;
      }
      const response = await fetch(isNewCompose ? '/api/email/send' : `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(isNewCompose
          ? {
              accountId: activeAccount.id,
              attachments,
              body: bodyHtml,
              cc: splitRecipientInput(composeDraft.ccText),
              is_HTML: true,
              subject: composeDraft.subject,
              to: splitRecipientInput(composeDraft.toText),
            }
          : {
              bodyOverride: composeDraft.body,
              bodyOverrideHtml: bodyHtml,
              attachments,
              cc: splitRecipientInput(composeDraft.ccText),
              folder: composeDraft.folder,
              is_HTML: true,
              messageId: composeDraft.message?.id,
              mode: composeDraft.mode,
              operation: 'send',
              subject: composeDraft.subject,
              to: splitRecipientInput(composeDraft.toText),
            }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
      setComposeDraft(null);
      setComposeError(null);
      setMessageActionNotice(t(composeDraft.aiGenerated ? 'aiReplySent' : 'messageSent'));
    } catch (submitError) {
      const message = isFetchNetworkError(submitError)
        ? t('errors.actionRequest')
        : submitError instanceof Error ? submitError.message : t('errors.updateMessage');
      setComposeError(message);
      setError(message);
    } finally {
      setIsSubmittingCompose(false);
    }
  }, [activeAccount, composeDraft, persistOutboxComposeDraft, t, workspaceOutboxEditing]);

  const handleMessageAction = useCallback(async (action: EmailMessageActionName, destination?: string) => {
    if (!activeAccount || !selectedMessage) return;
    if (action === 'draft-reply' || action === 'draft-reply-all' || action === 'draft-forward') {
      const mode = action === 'draft-forward' ? 'forward' : action === 'draft-reply-all' ? 'reply-all' : 'reply';
      openComposeDraft(mode, selectedMessage);
      return;
    }
    if (action === 'permanent-delete' && !window.confirm(t('confirmPermanentDelete'))) return;

    const folder = selectedMessage.folder || activeFolder;
    setActiveMessageAction(action);
    setMessageActionNotice(null);
    setError(null);

    try {
      if (action === 'summary') {
        const controller = new AbortController();
        summaryAbortControllerRef.current?.abort();
        summaryAbortControllerRef.current = controller;
        setStreamingSummaryMessageId(selectedMessage.id);
        setMessageSummary('');
        setMessageSummaryStatus(summaryAiStageLabel('reading_context'));

        try {
          const summaryEndpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/${encodeURIComponent(selectedMessage.id)}/summary?stream=1`;
          const response = await fetch(summaryEndpoint, {
            method: 'POST',
            headers: {
              Accept: 'text/event-stream',
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal,
            body: JSON.stringify({ folder, workspaceId: activeWorkspaceId }),
          });
          const summary = await readEmailSummaryStream(
            response,
            (delta) => {
              if (summaryAbortControllerRef.current !== controller) return;
              setMessageSummary((current) => current + delta);
            },
            (stage, label) => {
              if (summaryAbortControllerRef.current !== controller) return;
              setMessageSummaryStatus(summaryAiStageLabel(stage, label));
            },
          );
          if (summaryAbortControllerRef.current === controller) {
            setMessageSummary(summary);
            setMessageSummaryStatus(summaryAiStageLabel('ready'));
          }
        } finally {
          if (summaryAbortControllerRef.current === controller) {
            summaryAbortControllerRef.current = null;
            setStreamingSummaryMessageId(null);
          }
        }
        return;
      }

      if (action === 'ai-reply') {
        openComposeDraft('reply', selectedMessage, '', true, {
          aiMode: 'quick',
          aiPrompt: '',
          usedContext: [],
        });
        setIsGeneratingComposeAi(true);
        updateQuickAiProgress('reading_context');

        try {
          const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions?stream=1`;
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              Accept: 'text/event-stream',
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
              folder,
              messageId: selectedMessage.id,
              operation: 'ai-reply-preview',
              workspaceId: activeWorkspaceId,
            }),
          });
          const body = await readEmailAiDraftStream(response, {
            onDelta: (_delta, nextBody) => {
              const bodyValues = composeEmailEditorBodyValues(nextBody);
              setComposeDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
            },
            onStatus: (stage, label) => updateQuickAiProgress(stage, label),
          });
          const bodyValues = composeEmailEditorBodyValues(body);
          if (!bodyValues.body && !bodyValues.bodyHtml) throw new Error(t('errors.generateCompose'));
          setComposeDraft((current) => current ? { ...current, aiGenerated: true, ...bodyValues, usedContext: [] } : current);
          updateQuickAiProgress('ready');
        } catch (aiReplyError) {
          const message = isFetchNetworkError(aiReplyError)
            ? t('errors.actionRequest')
            : aiReplyError instanceof Error ? aiReplyError.message : t('errors.generateCompose');
          setComposeError(message);
          throw aiReplyError;
        } finally {
          setIsGeneratingComposeAi(false);
        }
        return;
      }

      const body: Record<string, unknown> = { action, destination, folder, messageId: selectedMessage.id, operation: 'action' };

      const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));

      if (action === 'mark-read' || action === 'mark-unread') {
        const isRead = action === 'mark-read';
        setMessages((current) => current.map((message) => message.id === selectedMessage.id ? { ...message, isRead } : message));
        setSelectedMessage((current) => current ? { ...current, isRead } : current);
        setMessageActionNotice(t('messageUpdated'));
        return;
      }

      if (action === 'mark-answered' || action === 'clear-answered') {
        const isAnswered = action === 'mark-answered';
        setMessages((current) => current.map((message) => message.id === selectedMessage.id ? { ...message, isAnswered } : message));
        setSelectedMessage((current) => current ? { ...current, isAnswered } : current);
        setMessageActionNotice(t('messageUpdated'));
        return;
      }

      setMessages((current) => current.filter((message) => message.id !== selectedMessage.id));
      clearReader();
      setMessageActionNotice(t('messageMoved'));
      void loadFolders(activeAccount.id);
    } catch (actionError) {
      if (action === 'summary' && actionError instanceof DOMException && actionError.name === 'AbortError') return;
      setError(isFetchNetworkError(actionError)
        ? t('errors.actionRequest')
        : actionError instanceof Error ? actionError.message : t('errors.updateMessage'));
    } finally {
      setActiveMessageAction(null);
    }
  }, [activeAccount, activeFolder, activeWorkspaceId, clearReader, loadFolders, openComposeDraft, selectedMessage, summaryAiStageLabel, t, updateQuickAiProgress]);

  const handleMessageListAction = useCallback(async (message: EmailMessageSummary, action: EmailMessageListActionName, destination?: string) => {
    if (!activeAccount) return;
    if (action === 'permanent-delete' && !window.confirm(t('confirmPermanentDelete'))) return;
    if (action === 'move' && !destination) return;

    const folder = message.folder || activeFolder;
    const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`;
    setActiveMessageListAction({ action, messageId: message.id });
    setMessageActionNotice(null);
    setError(null);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, destination, folder, messageId: message.id, operation: 'action' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));

      if (action === 'mark-read' || action === 'mark-unread') {
        const isRead = action === 'mark-read';
        setMessages((current) => current.map((currentMessage) => currentMessage.id === message.id ? { ...currentMessage, isRead } : currentMessage));
        setSelectedMessage((current) => current?.id === message.id ? { ...current, isRead } : current);
        setMessageActionNotice(t('messageUpdated'));
        return;
      }

      setMessages((current) => current.filter((currentMessage) => currentMessage.id !== message.id));
      if (selectedMessageId === message.id) {
        clearReader();
      }
      setMessageActionNotice(t('messageMoved'));
      void loadFolders(activeAccount.id);
    } catch (actionError) {
      setError(isFetchNetworkError(actionError)
        ? t('errors.actionRequest')
        : actionError instanceof Error ? actionError.message : t('errors.updateMessage'));
    } finally {
      setActiveMessageListAction(null);
    }
  }, [activeAccount, activeFolder, clearReader, loadFolders, selectedMessageId, t]);

  const messageOffset = messagePage * MESSAGE_PAGE_SIZE;
  const messageStart = messages.length > 0 ? messageOffset + 1 : 0;
  const messageEnd = messageOffset + messages.length;
  const hasPreviousMessagePage = messagePage > 0;
  const hasNextMessagePage = messageTotal === null
    ? messages.length === MESSAGE_PAGE_SIZE
    : messageEnd < messageTotal;
  const messageRangeLabel = messages.length === 0
    ? t('messageRangeEmpty')
    : messageTotal === null
      ? t(hasNextMessagePage ? 'messageRangeMore' : 'messageRangeUnknown', { start: messageStart, end: messageEnd })
      : t('messageRange', { start: messageStart, end: messageEnd, total: messageTotal });
  const applyPendingMessageUpdate = () => {
    if (!pendingMessageUpdate) return;
    setSelectedMessage(pendingMessageUpdate);
    setPendingMessageUpdate(null);
    setMessageUnavailable(null);
    dismissedMessageRevisionRef.current = null;
    setReaderRevision((current) => current + 1);
  };
  const dismissPendingMessageUpdate = () => {
    if (!pendingMessageUpdate) return;
    dismissedMessageRevisionRef.current = emailMessageContentRevision(pendingMessageUpdate);
    setPendingMessageUpdate(null);
  };
  const messageViewerLabels = {
    aiReply: t('aiReply'),
    aiSummary: t('aiSummary'),
    archive: t('archive'),
    attachments: t('attachments'),
    backToMessages: t('backToMessages'),
    cancel: t('composeCancel'),
    cc: t('cc'),
    date: t('date'),
    emptyBody: t('emptyBody'),
    forward: t('forward'),
    from: t('from'),
    loadingMessage: t('loadingMessage'),
    loadUpdatedMessage: t('loadUpdatedMessage'),
    markRead: t('markRead'),
    markUnread: t('markUnread'),
    keepCurrentMessage: t('keepCurrentMessage'),
    messageContentUpdated: t('messageContentUpdated'),
    messageOptions: t('messageOptions'),
    messageUnavailable: t('messageUnavailable'),
    moveTo: t('moveTo'),
    noFolders: t('noFolders'),
    noSubject: t('noSubject'),
    permanentDelete: t('permanentDelete'),
    remoteImagesBlocked: t('remoteImagesBlocked'),
    reply: t('reply'),
    replyAll: t('replyAll'),
    replyOptions: t('replyOptions'),
    retryMessage: t('retryMessage'),
    selectMessage: t('selectMessage'),
    showRemoteImages: t('showRemoteImages'),
    summary: t('summary'),
    summaryReady: t('summaryReady'),
    summaryReadingContext: t('summaryReadingContext'),
    summaryWriting: t('summaryWriting'),
    to: t('to'),
    trash: t('trash'),
    unknownAttachmentType: t('unknownAttachmentType'),
  };
  const composeDialogLabels: EmailComposeDialogLabels = {
    attachmentsAdd: t('attachmentsAdd'),
    attachmentsAllFiles: t('attachmentsAllFiles'),
    attachmentsAttached: t('attachmentsAttached'),
    attachmentsCancel: t('attachmentsCancel'),
    attachmentsConfirm: t('attachmentsConfirm'),
    attachmentsDialogDescription: t('attachmentsDialogDescription'),
    attachmentsDialogTitle: t('attachmentsDialogTitle'),
    attachmentsEmpty: t('attachmentsEmpty'),
    attachmentsLimitExceeded: t('attachmentsLimitExceeded'),
    attachmentsLoading: t('attachmentsLoading'),
    attachmentsFolders: t('attachmentsFolders'),
    attachmentsRefresh: t('attachmentsRefresh'),
    attachmentsRemove: t('attachmentsRemove'),
    attachmentsSearchPlaceholder: t('attachmentsSearchPlaceholder'),
    attachmentsSortBy: t('attachmentsSortBy'),
    attachmentsSortCreated: t('attachmentsSortCreated'),
    attachmentsSortModified: t('attachmentsSortModified'),
    attachmentsSortName: t('attachmentsSortName'),
    attachmentsSortSize: t('attachmentsSortSize'),
    attachmentsSelectFiles: t('attachmentsSelectFiles'),
    attachmentsSendMarkdownAsPdf: t('attachmentsSendMarkdownAsPdf', { name: '{name}' }),
    attachmentsSendMarkdownAsPdfShort: t('attachmentsSendMarkdownAsPdfShort'),
    attachmentsTabUpload: t('attachmentsTabUpload'),
    attachmentsTabWorkspace: t('attachmentsTabWorkspace'),
    attachmentsUploadDrop: t('attachmentsUploadDrop'),
    attachmentsUploadHint: t('attachmentsUploadHint'),
    attachmentsUsageLabel: t('attachmentsUsageLabel', { used: '{used}', limit: '{limit}' }),
    cancel: t('composeCancel'),
    cc: t('cc'),
    composeAiReplyTitle: t('composeAiReplyTitle'),
    composeAiPromptLabel: t('composeAiPromptLabel'),
    composeAiPromptPlaceholder: t('composeAiPromptPlaceholder'),
    composeBodyLabel: t('composeBodyLabel'),
    composeBodyPlaceholder: t('composeBodyPlaceholder'),
    composeDescription: t('composeDescription'),
    composeForwardTitle: t('composeForwardTitle'),
    composeAddContext: t('composeAddContext'),
    composeAgentReady: t('composeAgentReady'),
    composeAgentToolDetails: t('composeAgentToolDetails'),
    composeAgentWorking: t('composeAgentWorking'),
    composeAiDraftReady: t('composeAiDraftReady'),
    composeAiModeQuick: t('composeAiModeQuick'),
    composeAiModeWorkspaceAgent: t('composeAiModeWorkspaceAgent'),
    composeAiReadingContext: t('composeAiReadingContext'),
    composeAiWritingDraft: t('composeAiWritingDraft'),
    composeGenerateWithAi: t('composeGenerateWithAi'),
    composeGeneratingWithAi: t('composeGeneratingWithAi'),
    composeContextFiles: t('composeContextFiles'),
    composeNoContextFiles: t('composeNoContextFiles'),
    composeNewTitle: t('composeNewTitle'),
    composeWorkspaceOutboxDescription: t('composeWorkspaceOutboxDescription'),
    composeWorkspaceOutboxTitle: t('composeWorkspaceOutboxTitle'),
    composeOriginalTitle: t('composeOriginalTitle'),
    composeReferencePickerEmpty: t('composeReferencePickerEmpty'),
    composeReferencePickerHeader: t('composeReferencePickerHeader'),
    composeReferencePickerSearchPlaceholder: t('composeReferencePickerSearchPlaceholder'),
    composeRemoveContextFile: t('composeRemoveContextFile'),
    composeReplyAllTitle: t('composeReplyAllTitle'),
    composeReplyTitle: t('composeReplyTitle'),
    composeSaveDraft: t('composeSaveDraft'),
    composeSavingDraft: t('composeSavingDraft'),
    composeDraftSaved: t('composeDraftSaved'),
    composeSend: t('composeSend'),
    composeSending: t('composeSending'),
    composeToneCasual: t('composeToneCasual'),
    composeToneFormal: t('composeToneFormal'),
    composeToneLabel: t('composeToneLabel'),
    composeToneVeryCasual: t('composeToneVeryCasual'),
    composeUsedContext: t('composeUsedContext'),
    date: t('date'),
    emptyBody: t('emptyBody'),
    from: t('from'),
    noSubject: t('noSubject'),
    remoteImagesBlocked: t('remoteImagesBlocked'),
    showRemoteImages: t('showRemoteImages'),
    subject: t('subject'),
    to: t('to'),
  };

  if (isLoadingAccounts) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('loadingAccounts')}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto px-3 py-6 sm:px-6 sm:py-10">
        <EmailAccountsCard
          isOpen={true}
          onOpenChange={() => undefined}
          onAccountsChanged={loadAccounts}
          presentation="setup"
          onPreviewPreferencesChanged={(preferences) => {
            setEmailAllowRemoteImages(preferences.emailAllowRemoteImages);
            setEmailRemoteImageAllowedSenders(preferences.emailRemoteImageAllowedSenders || []);
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-presentation={embedded ? 'embedded' : 'page'}
      data-layout-mode={layoutMode}
      className={cn(
        'mx-auto flex h-full min-h-0 w-full flex-col overflow-hidden',
        embedded
          ? 'max-w-none gap-2 px-0 py-0'
          : 'max-w-7xl gap-3 px-3 py-3 sm:px-6 sm:py-5',
      )}
    >
      <section className={cn(
        'shrink-0 flex flex-col gap-2 border border-border bg-card px-3 py-2 sm:px-4',
        embedded && 'border-x-0 border-t-0',
      )}>
        <EmailMailboxHeader
          accounts={accounts}
          activeAccount={activeAccount}
          canRead={canReadActiveAccount}
          isLoadingMessages={isLoadingMessages}
          isRefreshingMessages={isRefreshingMessages}
          labels={{
            account: t('accountLabel'),
            compose: t('compose'),
            mainEmail: t('mainEmail'),
            refresh: t('refresh'),
            search: t('search'),
            searchPlaceholder: t('searchPlaceholder'),
            title: t('title'),
          }}
          onAccountChange={selectAccount}
          onCompose={openNewComposeDraft}
          onManageAccounts={() => setAccountsOpen(true)}
          onQueryChange={setQuery}
          onRefresh={() => void loadMessages({ background: true })}
          onSearch={handleSearch}
          query={query}
        />
      </section>

      <EmailReviewCenter
        focusRequestKey={contextIntent?.view === 'review-center'
          ? `${contextIntent.toolCallId || contextIntent.toolName}:${contextIntent.mailboxId || ''}`
          : undefined}
        onOpenPersonalDraft={openPersonalOutboxDraft}
        onOpenWorkspaceDraft={openWorkspaceOutboxDraft}
        refreshKey={workspaceOutboxRevision}
        t={t}
        workspaceId={activeWorkspaceId}
      />

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {messageActionNotice && (
        <div className="border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          {messageActionNotice}
        </div>
      )}

      {!canReadActiveAccount ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="flex min-h-80 items-center justify-center border border-border bg-card p-6 text-center">
            <div className="max-w-md space-y-3">
              <MailWarning className="mx-auto h-9 w-9 text-muted-foreground" />
              <h3 className="text-base font-semibold">{t('imapMissingTitle')}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{t('imapMissingDescription')}</p>
              <Button type="button" onClick={() => setAccountsOpen(true)}>
                <Settings className="mr-2 h-4 w-4" />
                {t('manageAccounts')}
              </Button>
            </div>
          </section>
        </div>
      ) : (
        <div
          className={cn(
            'min-h-0 flex-1 overflow-hidden',
            layoutMode === 'wide' ? 'grid' : 'flex flex-col',
          )}
          style={layoutMode === 'wide'
            ? {
              gridTemplateColumns: isFolderSidebarOpen
                ? `220px minmax(280px, ${listWidth}px) 8px minmax(0, 1fr)`
                : `minmax(280px, ${listWidth}px) 8px minmax(0, 1fr)`,
            }
            : undefined}
        >
          <EmailMailboxNavigation
            activeFolder={activeFolder}
            activeFolderName={activeFolderName}
            activeMessageListAction={activeMessageListAction}
            folders={folders}
            hasNextPage={hasNextMessagePage}
            hasPreviousPage={hasPreviousMessagePage}
            isFolderSidebarOpen={isFolderSidebarOpen}
            isLoadingFolders={isLoadingFolders}
            isLoadingMessages={isLoadingMessages}
            labels={{
              folders: t('folders'),
              hideFolders: t('hideFolders'),
              loadingFolders: t('loadingFolders'),
              loadingMessages: t('loadingMessages'),
              messages: t('messages'),
              nextPage: t('nextPage'),
              noFolders: t('noFolders'),
              noMessages: t('noMessages'),
              noSubject: t('noSubject'),
              previousPage: t('previousPage'),
              resizeMessageList: t('resizeMessageList'),
              showFolders: t('showFolders'),
              unknownSender: t('unknownSender'),
              unreadOnly: t('unreadOnly'),
            }}
            layoutMode={layoutMode}
            listWidth={listWidth}
            messageContextMenu={messageContextMenu}
            messageFilter={messageFilter}
            messageRangeLabel={messageRangeLabel}
            messages={messages}
            onCloseContextMenu={() => setMessageContextMenu(null)}
            onContextMenu={(message, position) => setMessageContextMenu({ messageId: message.id, ...position })}
            onFolderSidebarOpenChange={setIsFolderSidebarOpen}
            onListWidthChange={setListWidth}
            onMessageAction={handleMessageListAction}
            onOpenMessage={(message, openInDialog) => void loadMessage(message, openInDialog ? { openDialog: true } : undefined)}
            onPageChange={(direction) => {
              listRequestRef.current?.abort();
              clearReader();
              setMessagePage((current) => direction === 'previous' ? Math.max(0, current - 1) : current + 1);
            }}
            onSelectFolder={selectFolder}
            onToggleUnreadFilter={toggleUnreadFilter}
            selectedMessageId={selectedMessageId}
            viewerLabels={messageViewerLabels}
          />

          {layoutMode === 'wide' && <section className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
            <EmailMessageViewer
              key={`email-message-viewer:${activeAccount?.id || ''}:${selectedMessage?.folder || activeFolder}:${selectedMessage?.id || 'empty'}:${readerRevision}`}
              actions={selectedMessage ? { activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              allowRemoteResourcesByDefault={emailAllowRemoteImages}
              allowedRemoteResourceSenders={emailRemoteImageAllowedSenders}
              hasPendingUpdate={Boolean(pendingMessageUpdate)}
              isLoading={isLoadingMessage}
              isSummaryStreaming={isStreamingSelectedMessageSummary}
              labels={messageViewerLabels}
              message={selectedMessage}
              onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
              onBackToMessages={clearReader}
              onKeepCurrentMessage={dismissPendingMessageUpdate}
              onLoadUpdatedMessage={applyPendingMessageUpdate}
              onRetryMessage={messageUnavailable ? () => void loadMessage(messageUnavailable) : undefined}
              summary={messageSummary}
              summaryStatus={messageSummaryStatus}
              unavailable={Boolean(messageUnavailable)}
            />
          </section>}
        </div>
      )}

      {canReadActiveAccount && (
        <Dialog open={messageDialogOpen} onOpenChange={setMessageDialogOpen}>
          <DialogContent layout="viewport">
            <DialogHeader className="sr-only">
              <DialogTitle>{selectedMessage?.subject || t('noSubject')}</DialogTitle>
              <DialogDescription>
                {selectedMessage ? `${t('from')}: ${selectedMessage.from}` : t('loadingMessage')}
              </DialogDescription>
            </DialogHeader>
            <EmailMessageViewer
              key={`email-message-dialog-viewer:${activeAccount?.id || ''}:${selectedMessage?.folder || activeFolder}:${selectedMessage?.id || 'empty'}:${readerRevision}`}
              actions={selectedMessage ? { activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              allowRemoteResourcesByDefault={emailAllowRemoteImages}
              allowedRemoteResourceSenders={emailRemoteImageAllowedSenders}
              className="bg-card"
              hasPendingUpdate={Boolean(pendingMessageUpdate)}
              isLoading={isLoadingMessage}
              isSummaryStreaming={isStreamingSelectedMessageSummary}
              labels={messageViewerLabels}
              message={selectedMessage}
              onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
              onBackToMessages={clearReader}
              onKeepCurrentMessage={dismissPendingMessageUpdate}
              onLoadUpdatedMessage={applyPendingMessageUpdate}
              onRetryMessage={messageUnavailable ? () => void loadMessage(messageUnavailable, { openDialog: true }) : undefined}
              summary={messageSummary}
              summaryStatus={messageSummaryStatus}
              unavailable={Boolean(messageUnavailable)}
            />
          </DialogContent>
        </Dialog>
      )}

      <EmailComposeDialog
        agentEvents={composeAgentEvents}
        agentStatus={composeAgentStatus}
        allowRemoteResourcesByDefault={emailAllowRemoteImages}
        allowedRemoteResourceSenders={emailRemoteImageAllowedSenders}
        draft={composeDraft}
        error={composeError}
        isGeneratingAi={isGeneratingComposeAi}
        isSubmitting={isSubmittingCompose}
        isWorkspaceOutboxReview={Boolean(workspaceOutboxEditing)}
        reviewCase={workspaceOutboxReviewCase}
        labels={composeDialogLabels}
        locale={locale}
        onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
        onClose={closeComposeDialog}
        onGenerateAi={() => void generateComposeAiBody()}
        onSave={() => void saveOutboxComposeDraft()}
        onSubmit={() => void submitComposeDraft()}
        onUpdate={updateComposeDraft}
      />

      {accounts.length > 0 && (
        <Dialog open={accountsOpen} onOpenChange={setAccountsOpen}>
          <DialogContent layout="viewport">
            <DialogHeader className="border-b border-border px-4 py-3 pr-10 sm:px-5">
              <DialogTitle className="text-base leading-6">{t('manageAccounts')}</DialogTitle>
              <DialogDescription className="text-xs leading-5 sm:text-sm">{t('manageAccountsDescription')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
              <EmailAccountsCard
                isOpen={true}
                onOpenChange={() => undefined}
                onAccountsChanged={loadAccounts}
                presentation="dialog"
                onPreviewPreferencesChanged={(preferences) => {
                  setEmailAllowRemoteImages(preferences.emailAllowRemoteImages);
                  setEmailRemoteImageAllowedSenders(preferences.emailRemoteImageAllowedSenders || []);
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
