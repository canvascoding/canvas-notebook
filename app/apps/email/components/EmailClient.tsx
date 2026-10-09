'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { authClient } from '@/app/lib/auth-client';
import { parseEmailSearchQuery } from '@/app/lib/email/search-query';
import { EmailComposeDialog } from '@/app/apps/email/components/EmailComposeDialog';
import { EmailSetupGuide, type EmailMailboxSetup } from '@/app/apps/email/components/EmailSetupGuide';
import { EmailMailboxHeader } from '@/app/apps/email/components/EmailMailboxHeader';
import { EmailMailboxNavigation } from '@/app/apps/email/components/EmailMailboxNavigation';
import { EmailFocusHeader } from '@/app/apps/email/components/EmailFocusHeader';
import { EmailFocusNavigation } from '@/app/apps/email/components/EmailFocusNavigation';
import { EmailClassificationDetails } from '@/app/apps/email/components/EmailClassificationDetails';
import { useEmailFocusFeed } from '@/app/apps/email/components/useEmailFocusFeed';
import type { EmailClassificationAvailability } from '@/app/lib/email/classification/admin-service';
import type { EmailClassificationFeedItem, EmailFeedMode, EmailFeedView } from '@/app/lib/email/classification/feed-types';
import type { EmailMailboxScope, EmailMailboxSourceOption } from '@/app/lib/email/classification/mailbox-types';
import type { EmailCategory } from '@/app/lib/email/classification/types';
import { EmailMessageViewer } from '@/app/apps/email/components/EmailMessageReader';
import { EmailReviewCenter } from '@/app/apps/email/components/EmailReviewCenter';
import { EmailPaneResizeHandle, useEmailWorkspaceLayout } from '@/app/apps/email/components/EmailWorkspaceLayout';
import { extractEmailAddressForCompose } from '@/app/apps/email/components/email-client-format';
import { isFetchNetworkError } from '@/app/apps/email/components/email-client-network';
import { emailAccountSelectionKey, emailAccountContextKey, emailFeedMessageSummary, sameEmailSelection } from './email-focus-integration';
import { setEmailPersonalFocusDone } from './email-classification-client';
import { emailFocusIntentKey, resolvedEmailFocusMessage } from './email-focus-deep-link';
import type {
  EmailAccount,
  EmailComposeDialogLabels,
  EmailFolder,
  EmailMessageActionName,
  EmailMessageContextMenuPosition,
  EmailMessageDetail,
  EmailMessageListActionName,
  EmailMessageListActionState,
  EmailMessageSummary,
} from '@/app/apps/email/components/email-client-types';
import { useEmailComposeController } from '@/app/apps/email/components/useEmailComposeController';
import { useSetEmailChatContext } from '@/app/apps/email/context/email-chat-context';
import { buildEmailPageChatContext } from '@/app/apps/email/context/email-route-chat-context';
import { EmailAccountsCard } from '@/app/components/settings/IntegrationsSettingsClient';
import {
  readEmailSummaryStream,
  type EmailAiStreamStage,
} from '@/app/lib/email/client-ai-stream';
import {
  claimEmailCacheFollowUp,
  EMAIL_CACHE_FOLLOW_UP_DELAY_MS,
  emailCacheFollowUpKey,
  emailMessageContentRevision,
  emailMessageDetailScopeKey,
  emailMessageListScopeKey,
  shouldApplyEmailRefresh,
} from '@/app/lib/email/reader-refresh';
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

export function EmailClient({
  contextIntent = null,
  embedded = false,
}: EmailClientProps = {}) {
  const t = useTranslations('emails');
  const locale = useLocale();
  const tm = useTranslations('emailMailboxes');
  const tf = useTranslations('emailFocus');
  const { data: session, isPending: isSessionPending, refetch: refetchSession } = authClient.useSession();
  const selectionStorageKey = session?.user.id ? `emails.mailbox:${session.user.id}` : null;
  const setEmailChatContext = useSetEmailChatContext();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const { containerRef, listWidth, availableWidth, mode: layoutMode, setListWidth } = useEmailWorkspaceLayout();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [personalSetupOpen, setPersonalSetupOpen] = useState(false);
  const [mailboxSetup, setMailboxSetup] = useState<EmailMailboxSetup>({ canManageBusiness: false, manageableWorkspaces: [] });
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [accountsUser, setAccountsUser] = useState<string | null>(null);
  const accountsUserRef = useRef<string | null>(null);
  const accountsRequestRef = useRef<AbortController | null>(null);
  const currentUserRef = useRef(selectionStorageKey);
  useLayoutEffect(() => { currentUserRef.current = selectionStorageKey; }, [selectionStorageKey]);
  const [emailAllowRemoteImages, setEmailAllowRemoteImages] = useState(false);
  const [emailRemoteImageAllowedSenders, setEmailRemoteImageAllowedSenders] = useState<string[]>([]);
  const [classificationAvailability, setClassificationAvailability] = useState<EmailClassificationAvailability | null>(null);
  const [experienceChoice, setExperienceChoice] = useState<EmailFeedMode | null>(null);
  const [intentExperience, setIntentExperience] = useState<{ key: string; mode: EmailFeedMode } | null>(null);
  const feedIntentKey = emailFocusIntentKey(contextIntent);
  const feedIntentIdentity = feedIntentKey ? JSON.stringify([selectionStorageKey, session?.session.id, feedIntentKey]) : null;
  const currentFeedIntentRef = useRef(feedIntentIdentity);
  const configuredFeedIntentRef = useRef<string | null>(null);
  const appliedFeedIntentRef = useRef<string | null>(null);
  const feedIntentNavigationEpochRef = useRef(0);
  const cancelFeedIntentRequestRef = useRef<(() => void) | null>(null);
  const consumeExternalFeedIntent = useCallback(() => {
    feedIntentNavigationEpochRef.current++;
    if (currentFeedIntentRef.current) appliedFeedIntentRef.current = currentFeedIntentRef.current;
    cancelFeedIntentRequestRef.current?.();
  }, []);
  useLayoutEffect(() => {
    currentFeedIntentRef.current = feedIntentIdentity;
    if (!feedIntentIdentity) { configuredFeedIntentRef.current = null; appliedFeedIntentRef.current = null; }
  }, [feedIntentIdentity]);
  const [emailPreferencesReady, setEmailPreferencesReady] = useState(false);
  const [emailPreferencesUser, setEmailPreferencesUser] = useState<string | null>(null);
  const [focusConfigurationUser, setFocusConfigurationUser] = useState<string | null>(null);
  const [focusSources, setFocusSources] = useState<EmailMailboxSourceOption[]>([]);
  const [focusSourcesReady, setFocusSourcesReady] = useState(false);
  const [focusSourcesError, setFocusSourcesError] = useState(false);
  const [focusScope, setFocusScope] = useState<EmailMailboxScope>({ kind: 'all' });
  const [focusView, setFocusView] = useState<EmailFeedView>('focus');
  const [focusCategory, setFocusCategory] = useState<EmailCategory | null>(null);
  const [focusSearch, setFocusSearch] = useState('');
  const [selectedFeedItem, setSelectedFeedItem] = useState<EmailClassificationFeedItem | null>(null);
  const [composeSenderOpen, setComposeSenderOpen] = useState(false);
  const [composeSenderKey, setComposeSenderKey] = useState('');
  const pendingFeedOpenRef = useRef<{ item: EmailClassificationFeedItem; accountKey: string; openDialog: boolean; epoch: number } | null>(null);
  const feedSelectionEpochRef = useRef(0);
  const pendingComposeAccountRef = useRef<string | null>(null);
  const experienceOwnerRef = useRef<string | null>(null);
  const modeWriteEpochRef = useRef(0);
  const modeWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const sourceRequestRef = useRef<AbortController | null>(null);
  const previousSourceAccountsRef = useRef<{ owner: string; keys: Set<string> } | null>(null);
  const [deniedMailboxKey, setDeniedMailboxKey] = useState<string | null>(null);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [foldersAccountId, setFoldersAccountId] = useState('');
  const [foldersMailboxKey, setFoldersMailboxKey] = useState('');
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
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const [serverHasMore, setServerHasMore] = useState<boolean | null>(null);
  const [focused, setFocused] = useState(false);
  const focusFolderRestore = useRef(false);
  const previousFolder = useRef('INBOX');
  const tSearch = useTranslations('emailSearch');
  const effectiveListWidth = Math.max(280, Math.min(listWidth, availableWidth - (isFolderSidebarOpen ? 220 : 0) - 8 - 360));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { setIsFolderSidebarOpen(window.localStorage.getItem('emails.foldersVisible') === 'true'); } catch { /* Storage is optional. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const changeFolderSidebar = (open: boolean) => {
    if (open && focused) window.dispatchEvent(new CustomEvent('email-focus-change', { detail: { focused: false, preserveFolders: true } }));
    setIsFolderSidebarOpen(open);
    try { window.localStorage.setItem('emails.foldersVisible', String(open)); } catch { /* Storage is optional. */ }
  };
  const toggleFocus = () => {
    const next = !focused;
    if (next) { focusFolderRestore.current = isFolderSidebarOpen; setIsFolderSidebarOpen(false); }
    else setIsFolderSidebarOpen(focusFolderRestore.current);
    setFocused(next);
    window.dispatchEvent(new CustomEvent('email-focus-change', { detail: { focused: next } }));
  };
  useEffect(() => {
    const syncFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ focused: boolean; preserveFolders?: boolean }>).detail;
      if (focused && detail?.focused === false) {
        setFocused(false);
        if (!detail.preserveFolders) setIsFolderSidebarOpen(focusFolderRestore.current);
      }
    };
    window.addEventListener('email-focus-change', syncFocus);
    return () => window.removeEventListener('email-focus-change', syncFocus);
  }, [focused]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent('email-focus-change', { detail: { focused: false } })); }, []);
  const [accountsLoadError, setAccountsLoadError] = useState<string | null>(null);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false);
  const [isLoadingMessage, setIsLoadingMessage] = useState(false);
  const [activeMessageAction, setActiveMessageAction] = useState<EmailMessageActionName | null>(null);
  const [activeMessageListAction, setActiveMessageListAction] = useState<EmailMessageListActionState>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<(EmailMessageContextMenuPosition & { messageId: string }) | null>(null);
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
  const listFollowUpTimerRef = useRef<number | null>(null);
  const detailFollowUpTimerRef = useRef<number | null>(null);
  const listFollowUpKeysRef = useRef(new Set<string>());
  const detailFollowUpKeysRef = useRef(new Set<string>());
  const listRequestEpochRef = useRef(0);
  const detailRequestEpochRef = useRef(0);
  const messageMutationRevisionRef = useRef(0);
  const activeMessageMutationsRef = useRef(0);
  const pendingListFollowUpRef = useRef(false);
  const pendingDetailFollowUpRef = useRef(false);
  const listFollowUpRunnerRef = useRef<() => void>(() => undefined);
  const detailFollowUpRunnerRef = useRef<() => void>(() => undefined);
  const selectedMessageRef = useRef<EmailMessageDetail | null>(null);
  const dismissedMessageRevisionRef = useRef<string | null>(null);
  const hasMessagesRef = useRef(false);
  const activeAccountRef = useRef<string>('');
  const activeFolderRef = useRef('INBOX');
  const composeDraftRef = useRef(false);
  const minimizeComposeRef = useRef<() => void>(() => undefined);
  const appliedContextIntentRef = useRef<string | null>(null);
  const appliedSearchToolCallRef = useRef<string | null>(null);

  const activeAccount = useMemo(
    () => accountsUser !== selectionStorageKey ? null : accounts.find((account) => (account.workspaceId ? `${account.id}:${account.workspaceId}` : account.id) === activeAccountId) || null,
    [accounts, accountsUser, activeAccountId, selectionStorageKey],
  );
  const activeFolderName = useMemo(
    () => activeFolder === 'all' ? tSearch('allFolders') : folders.find((folder) => folder.path === activeFolder)?.name || activeFolder,
    [activeFolder, folders, tSearch],
  );
  const mailboxWorkspaceId = activeAccount?.workspaceId || null;
  const activeReadAccountId = activeAccount?.id;
  const mailboxScopeKey = activeAccount ? `${activeAccount.id}:${mailboxWorkspaceId || 'personal'}` : '';
  const mailboxScopeRef = useRef(mailboxScopeKey);
  useLayoutEffect(() => { mailboxScopeRef.current = mailboxScopeKey; }, [mailboxScopeKey]);
  const canReadActiveAccount = Boolean(deniedMailboxKey !== mailboxScopeKey && activeAccount && (activeAccount.capabilities?.canRead ?? (activeAccount.authType !== 'smtp_imap' || activeAccount.imapHost)));
  const canWriteActiveAccount = Boolean(deniedMailboxKey !== mailboxScopeKey && activeAccount && (activeAccount.capabilities?.canWrite ?? true));
  const canRunAgent = canWriteActiveAccount && (activeAccount?.capabilities?.canRunAgent ?? true);
  const effectiveExperience = intentExperience?.key === feedIntentIdentity ? intentExperience.mode : experienceChoice;
  const experienceMode: EmailFeedMode = classificationAvailability?.enabled && effectiveExperience !== 'classic' ? 'focus' : 'classic';
  const focusControlsReady = Boolean(selectionStorageKey && accountsUser === selectionStorageKey && focusConfigurationUser === selectionStorageKey
    && emailPreferencesUser === selectionStorageKey && classificationAvailability && emailPreferencesReady);
  const usesIndexedFeed = focusControlsReady && (experienceMode === 'focus' || focusScope.kind !== 'mailbox');
  const focusFeed = useEmailFocusFeed({ userId: session?.user.id || '', enabled: usesIndexedFeed, scope: focusScope,
    mode: experienceMode, view: experienceMode === 'classic' || focusSearch ? 'all' : focusView, category: focusSearch ? null : focusCategory, search: focusSearch });
  const isStreamingSelectedMessageSummary = Boolean(selectedMessage && streamingSummaryMessageId === selectedMessage.id);

  useLayoutEffect(() => {
    activeAccountRef.current = mailboxScopeKey;
    activeFolderRef.current = activeFolder;
    hasMessagesRef.current = messages.length > 0;
    selectedMessageRef.current = selectedMessage;
  }, [mailboxScopeKey, activeAccount?.id, activeFolder, messages.length, selectedMessage]);

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

  const cancelListFollowUp = useCallback(() => {
    if (listFollowUpTimerRef.current !== null) window.clearTimeout(listFollowUpTimerRef.current);
    listFollowUpTimerRef.current = null;
    pendingListFollowUpRef.current = false;
  }, []);

  const cancelDetailFollowUp = useCallback(() => {
    if (detailFollowUpTimerRef.current !== null) window.clearTimeout(detailFollowUpTimerRef.current);
    detailFollowUpTimerRef.current = null;
    pendingDetailFollowUpRef.current = false;
  }, []);

  const beginMessageMutation = useCallback(() => {
    activeMessageMutationsRef.current += 1;
    messageMutationRevisionRef.current += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeMessageMutationsRef.current = Math.max(0, activeMessageMutationsRef.current - 1);
      messageMutationRevisionRef.current += 1;
      if (activeMessageMutationsRef.current > 0) return;
      if (pendingListFollowUpRef.current) {
        pendingListFollowUpRef.current = false;
        listFollowUpRunnerRef.current();
      }
      if (pendingDetailFollowUpRef.current) {
        pendingDetailFollowUpRef.current = false;
        detailFollowUpRunnerRef.current();
      }
    };
  }, []);

  const scheduleListFollowUp = useCallback((scopeKey: string, cache: unknown, requestEpoch: number) => {
    const followUpKey = emailCacheFollowUpKey(scopeKey, cache);
    if (!claimEmailCacheFollowUp(listFollowUpKeysRef.current, followUpKey)) return;
    cancelListFollowUp();
    listFollowUpTimerRef.current = window.setTimeout(() => {
      listFollowUpTimerRef.current = null;
      if (listRequestEpochRef.current !== requestEpoch) return;
      if (activeMessageMutationsRef.current > 0) {
        pendingListFollowUpRef.current = true;
        return;
      }
      listFollowUpRunnerRef.current();
    }, EMAIL_CACHE_FOLLOW_UP_DELAY_MS);
  }, [cancelListFollowUp]);

  const scheduleDetailFollowUp = useCallback((scopeKey: string, cache: unknown, requestEpoch: number) => {
    const followUpKey = emailCacheFollowUpKey(scopeKey, cache);
    if (!claimEmailCacheFollowUp(detailFollowUpKeysRef.current, followUpKey)) return;
    cancelDetailFollowUp();
    detailFollowUpTimerRef.current = window.setTimeout(() => {
      detailFollowUpTimerRef.current = null;
      if (detailRequestEpochRef.current !== requestEpoch) return;
      if (activeMessageMutationsRef.current > 0) {
        pendingDetailFollowUpRef.current = true;
        return;
      }
      detailFollowUpRunnerRef.current();
    }, EMAIL_CACHE_FOLLOW_UP_DELAY_MS);
  }, [cancelDetailFollowUp]);

  const clearReader = useCallback((options?: { preserveQueuedOpen?: boolean }) => {
    if (!options?.preserveQueuedOpen) { pendingFeedOpenRef.current = null; feedSelectionEpochRef.current++; }
    cancelDetailFollowUp();
    detailRequestEpochRef.current += 1;
    detailRequestRef.current?.abort();
    detailRefreshRequestRef.current?.abort();
    selectedMessageRef.current = null;
    setSelectedMessage(null);
    setSelectedFeedItem(null);
    setSelectedMessageId('');
    setPendingMessageUpdate(null);
    setMessageUnavailable(null);
    dismissedMessageRevisionRef.current = null;
    setReaderRevision((current) => current + 1);
    setMessageActionNotice(null);
    clearMessageSummary();
    setMessageDialogOpen(false);
  }, [cancelDetailFollowUp, clearMessageSummary]);

  const summaryAiStageLabel = useCallback((stage: EmailAiStreamStage | undefined, fallback?: string) => {
    if (stage === 'reading_context') return t('summaryReadingContext');
    if (stage === 'writing') return t('summaryWriting');
    if (stage === 'ready') return t('summaryReady');
    return fallback || t('aiSummary');
  }, [t]);

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
    if (!selectionStorageKey) return;
    accountsRequestRef.current?.abort();
    const controller = new AbortController();
    accountsRequestRef.current = controller;
    const userChanged = accountsUserRef.current !== selectionStorageKey;
    if (userChanged) { setAccounts([]); setActiveAccountId(''); clearReader(); setMessages([]); }
    setIsLoadingAccounts(true);
    setAccountsLoadError(null);
    try {
      const response = await fetch('/api/email/mailboxes', { credentials: 'include', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadAccounts'));
      if (controller.signal.aborted || currentUserRef.current !== selectionStorageKey) return;
      accountsUserRef.current = selectionStorageKey;
      setAccountsUser(selectionStorageKey);
      const nextAccounts = (payload.data?.accounts || []) as EmailAccount[];
      if (activeAccountRef.current && !nextAccounts.some(account => emailAccountContextKey(account) === activeAccountRef.current)) clearReader();
      setAccounts(nextAccounts);
      setMailboxSetup({ canManageBusiness: payload.data?.setup?.canManageBusiness === true, manageableWorkspaces: Array.isArray(payload.data?.setup?.manageableWorkspaces) ? payload.data.setup.manageableWorkspaces : [] });
      setActiveAccountId((current) => {
        const key = (account: EmailAccount) => account.workspaceId ? `${account.id}:${account.workspaceId}` : account.id;
        let saved = userChanged ? '' : current;
        try { saved ||= window.sessionStorage.getItem(selectionStorageKey) || ''; } catch { /* Session storage is optional. */ }
        if (saved) return nextAccounts.some(account => key(account) === saved) ? saved : '';
        const initial = nextAccounts.find(account => account.isPrimary && !account.workspaceId) || nextAccounts[0];
        return initial ? key(initial) : '';
      });

    } catch (loadError) {
      if (controller.signal.aborted || currentUserRef.current !== selectionStorageKey) return;
      setAccountsLoadError(loadError instanceof Error ? loadError.message : t('errors.loadAccounts'));
    } finally {
      if (!controller.signal.aborted && currentUserRef.current === selectionStorageKey) setIsLoadingAccounts(false);
    }
  }, [t, selectionStorageKey, clearReader]);

  const loadFocusConfiguration = useCallback(async () => {
    if (!selectionStorageKey) return;
    sourceRequestRef.current?.abort();
    const controller = new AbortController(); sourceRequestRef.current = controller;
    const responses = await Promise.allSettled([
      fetch('/api/email/classification/availability', { credentials: 'include', cache: 'no-store', signal: controller.signal }).then(async response => ({ response, payload: await response.json() })),
      fetch('/api/email/classification/mailboxes', { credentials: 'include', cache: 'no-store', signal: controller.signal }).then(async response => ({ response, payload: await response.json() })),
    ]);
    if (controller.signal.aborted || currentUserRef.current !== selectionStorageKey) return;
    const availability = responses[0]; const catalogue = responses[1];
    if (availability.status === 'fulfilled' && availability.value.response.ok && typeof availability.value.payload.data?.enabled === 'boolean') {
      setClassificationAvailability(availability.value.payload.data);
      setFocusConfigurationUser(selectionStorageKey);
    }
    if (catalogue.status === 'fulfilled' && catalogue.value.response.ok && Array.isArray(catalogue.value.payload.data?.mailboxes)) {
      const sources = catalogue.value.payload.data.mailboxes as EmailMailboxSourceOption[];
      const nextSourceKeys = new Set(sources.map(source => `${source.accountId}:${source.workspaceId || 'personal'}`));
      const previousSourceKeys = previousSourceAccountsRef.current?.owner === selectionStorageKey ? previousSourceAccountsRef.current.keys : new Set<string>();
      const removedKeys = new Set([...previousSourceKeys].filter(key => !nextSourceKeys.has(key)));
      previousSourceAccountsRef.current = { owner: selectionStorageKey, keys: nextSourceKeys };
      setFocusSources(sources); setFocusSourcesReady(true); setFocusSourcesError(false);
      setAccounts(current => current.map(account => {
        const source = sources.find(candidate => candidate.accountId === account.id && candidate.workspaceId === (account.workspaceId || null));
        if (source) return { ...account, capabilities: source.capabilities };
        return removedKeys.has(emailAccountContextKey(account)) ? { ...account, capabilities: {
          canRead: false, canWrite: false, canManage: false, canDelete: false, canRunAgent: false,
        } } : account;
      }));
      if (removedKeys.size) {
        if (removedKeys.has(activeAccountRef.current)) clearReader();
        void loadAccounts();
      }
      if (experienceOwnerRef.current !== selectionStorageKey) {
        experienceOwnerRef.current = selectionStorageKey;
        let scope: EmailMailboxScope = { kind: 'all' };
        try {
          const stored = JSON.parse(window.localStorage.getItem(`emails.feedScope:${selectionStorageKey}`) || 'null');
          if (stored && ['all', 'personal', 'work'].includes(stored.kind)) scope = { kind: stored.kind };
          else if (stored?.kind === 'mailbox' && sources.some(source => source.mailboxRef === stored.mailboxRef)) scope = { kind: 'mailbox', mailboxRef: stored.mailboxRef };
        } catch { /* Optional local presentation preference. */ }
        setFocusScope(scope);
        if (scope.kind === 'mailbox') {
          const source = sources.find(source => source.mailboxRef === scope.mailboxRef);
          if (source) {
            if (`${source.accountId}:${source.workspaceId || 'personal'}` !== activeAccountRef.current) clearReader();
            setActiveAccountId(source.workspaceId ? `${source.accountId}:${source.workspaceId}` : source.accountId);
          }
        }
      }
    } else {
      setFocusSourcesError(true);
      if (catalogue.status === 'fulfilled' && [401, 403].includes(catalogue.value.response.status)) {
        setFocusSources([]); setFocusSourcesReady(false);
        if (catalogue.value.response.status === 401 || selectedMessageRef.current?.origin) clearReader();
      }
    }
  }, [selectionStorageKey, clearReader, loadAccounts]);

  useEffect(() => {
    if (!selectionStorageKey) return;
    const timer = window.setTimeout(() => { void loadFocusConfiguration(); }, 0);
    const onChanged = () => { void loadFocusConfiguration(); };
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') onChanged(); }, 30_000);
    window.addEventListener('canvas-email-classification-settings-updated', onChanged);
    window.addEventListener('online', onChanged);
    window.addEventListener('focus', onChanged);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); sourceRequestRef.current?.abort();
      window.removeEventListener('canvas-email-classification-settings-updated', onChanged); window.removeEventListener('online', onChanged); window.removeEventListener('focus', onChanged); };
  }, [selectionStorageKey, loadFocusConfiguration]);

  const changeExperienceMode = useCallback(async (mode: EmailFeedMode, preserveCurrentMailboxAndFolder = false) => {
    if (!selectionStorageKey || mode === 'focus' && !classificationAvailability?.enabled) return;
    consumeExternalFeedIntent();
    const epoch = ++modeWriteEpochRef.current; const previous = experienceChoice; const previousIntent = intentExperience;
    setIntentExperience(null);
    setExperienceChoice(mode);
    if (!preserveCurrentMailboxAndFolder && mode === 'classic' && focusScope.kind === 'mailbox') {
      const source = focusSources.find(source => source.mailboxRef === focusScope.mailboxRef);
      if (source) {
        if (`${source.accountId}:${source.workspaceId || 'personal'}` !== mailboxScopeKey || activeFolder !== 'INBOX') clearReader();
        setActiveAccountId(source.workspaceId ? `${source.accountId}:${source.workspaceId}` : source.accountId); setActiveFolder('INBOX');
      }
    }
    try {
      const write = modeWriteChainRef.current.catch(() => undefined).then(async () => {
        if (currentUserRef.current !== selectionStorageKey) return;
        const response = await fetch('/api/user-preferences', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emailExperienceMode: mode }) });
        if (!response.ok) throw new Error('Mode preference was not saved.');
      });
      modeWriteChainRef.current = write;
      await write;
    } catch {
      if (currentUserRef.current === selectionStorageKey && epoch === modeWriteEpochRef.current) { setExperienceChoice(previous); setIntentExperience(previousIntent); setError(tf('modeSaveError')); }
    }
  }, [selectionStorageKey, classificationAvailability?.enabled, experienceChoice, intentExperience, focusScope, focusSources, mailboxScopeKey, activeFolder, clearReader, tf, consumeExternalFeedIntent]);

  const changeFocusScope = (scope: EmailMailboxScope) => {
    consumeExternalFeedIntent();
    setFocusScope(scope); setFocusSearch('');
    try { window.localStorage.setItem(`emails.feedScope:${selectionStorageKey}`, JSON.stringify(scope)); } catch { /* Optional presentation preference. */ }
    if (scope.kind === 'mailbox' && experienceMode === 'classic') {
      const source = focusSources.find(source => source.mailboxRef === scope.mailboxRef);
      if (source) {
        if (`${source.accountId}:${source.workspaceId || 'personal'}` !== mailboxScopeKey || activeFolder !== 'INBOX') clearReader();
        setActiveAccountId(source.workspaceId ? `${source.accountId}:${source.workspaceId}` : source.accountId); setActiveFolder('INBOX');
      }
    }
  };

  const mailboxFetch = useCallback(async (input: string, init: RequestInit = {}) => {
    const scope = mailboxScopeKey;
    const url = new URL(input, window.location.origin);
    if (mailboxWorkspaceId) url.searchParams.set('mailboxWorkspaceId', mailboxWorkspaceId);
    const body = typeof init.body === 'string' ? JSON.stringify({ ...JSON.parse(init.body), mailboxWorkspaceId }) : init.body;
    const response = await fetch(url.toString(), { ...init, body });
    if (mailboxScopeRef.current !== scope) throw new DOMException('Mailbox changed', 'AbortError');
    if (response.status === 403 || response.status === 409) {
      setDeniedMailboxKey(scope);
      clearReader();
      setMessages([]);
      setFolders([]);
      setFoldersAccountId('');
      void loadAccounts();
    }
    return response;
  }, [mailboxScopeKey, mailboxWorkspaceId, clearReader, loadAccounts]);

  useEffect(() => {
    if (selectionStorageKey && accountsUserRef.current === selectionStorageKey && activeAccountId) {
      try { window.sessionStorage.setItem(selectionStorageKey, activeAccountId); } catch { /* Session storage is optional. */ }
    }
  }, [selectionStorageKey, activeAccountId]);

  const loadEmailPreferences = useCallback(async () => {
    if (!selectionStorageKey) return;
    try {
      const response = await fetch('/api/user-preferences', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadPreferences'));
      if (currentUserRef.current !== selectionStorageKey) return;
      setExperienceChoice(payload.data?.emailExperienceMode === 'focus' || payload.data?.emailExperienceMode === 'classic' ? payload.data.emailExperienceMode : null);
      setEmailPreferencesReady(true);
      setEmailPreferencesUser(selectionStorageKey);
      setEmailAllowRemoteImages(Boolean(payload.data?.emailAllowRemoteImages));
      setEmailRemoteImageAllowedSenders(Array.isArray(payload.data?.emailRemoteImageAllowedSenders)
        ? payload.data.emailRemoteImageAllowedSenders.filter((entry: unknown): entry is string => typeof entry === 'string')
        : []);
    } catch (preferencesError) {
      setError(preferencesError instanceof Error ? preferencesError.message : t('errors.loadPreferences'));
    }
  }, [t, selectionStorageKey]);

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
    consumeExternalFeedIntent();
    if (composeDraftRef.current) minimizeComposeRef.current();
    const source = focusSources.find(source => (source.workspaceId ? `${source.accountId}:${source.workspaceId}` : source.accountId) === accountId);
    if (source && focusControlsReady) setFocusScope({ kind: 'mailbox', mailboxRef: source.mailboxRef });
    setDeniedMailboxKey(null);
    listRequestRef.current?.abort();
    folderRequestRef.current?.abort();
    clearReader();
    setMessages([]);
    setActiveAccountId(accountId);
    setFoldersAccountId('');
    setActiveFolder('INBOX');
    setMessagePage(0);
  };

  const openFocusMailbox = (mailboxRef: string, manageConnection = false) => {
    const source = focusSources.find(candidate => candidate.mailboxRef === mailboxRef);
    if (!source?.capabilities.canRead || manageConnection && !source.capabilities.canManage) return;
    const account = accounts.find(candidate => candidate.id === source.accountId
      && (candidate.workspaceId || null) === source.workspaceId && candidate.capabilities?.canRead !== false);
    if (!account) { setError(tf('selectionError')); void loadAccounts(); void loadFocusConfiguration(); return; }
    changeFocusScope({ kind: 'mailbox', mailboxRef });
    selectAccount(emailAccountSelectionKey(account));
    setQuery(''); setSubmittedQuery(''); setMessageFilter('all'); setSearchNotice(null);
    setSearchRevision(current => current + 1);
    // Select the source explicitly before switching: the mode callback still has
    // the previous aggregate scope until React renders again.
    void changeExperienceMode('classic', true);
    if (manageConnection) setAccountsOpen(true);
  };

  const selectFolder = (folder: string) => {
    consumeExternalFeedIntent();
    if (folder === activeFolder) return;
    listRequestRef.current?.abort();
    clearReader();
    if (folder !== 'all') previousFolder.current = folder;
    setActiveFolder(folder);
    setMessagePage(0);
  };

  const loadFolders = useCallback(async (accountId: string) => {
    if (!accountId || mailboxScopeRef.current !== mailboxScopeKey) return;
    folderRequestRef.current?.abort();
    const controller = new AbortController();
    folderRequestRef.current = controller;
    setIsLoadingFolders(true);
    setError(null);
    try {
      const response = await mailboxFetch(`/api/email/folders?accountId=${encodeURIComponent(accountId)}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadFolders'));
      if (folderRequestRef.current !== controller || activeAccountRef.current !== mailboxScopeKey) return;
      const nextFolders = (payload.data?.folders || []) as EmailFolder[];
      setFolders(nextFolders);
      setFoldersAccountId(accountId);
      setFoldersMailboxKey(mailboxScopeKey);
      setActiveFolder((current) => {
        if (current === 'all' || (current && nextFolders.some((folder) => folder.path === current))) return current;
        return nextFolders.find((folder) => folder.role === 'inbox')?.path || nextFolders[0]?.path || 'INBOX';
      });
    } catch (loadError) {
      if (controller.signal.aborted || folderRequestRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : t('errors.loadFolders'));
    } finally {
      if (folderRequestRef.current === controller) setIsLoadingFolders(false);
    }
  }, [mailboxFetch, mailboxScopeKey, t]);

  const refreshSelectedMessage = useCallback(async () => {
    const current = selectedMessageRef.current;
    if (!activeAccount || !current) return;
    const accountId = activeAccount.id;
    const folder = current.folder || activeFolder;
    cancelDetailFollowUp();
    const requestEpoch = ++detailRequestEpochRef.current;
    const mutationRevision = messageMutationRevisionRef.current;
    detailRefreshRequestRef.current?.abort();
    const controller = new AbortController();
    detailRefreshRequestRef.current = controller;
    try {
      const params = new URLSearchParams({ folder });
      const response = await mailboxFetch(
        `/api/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(current.id)}?${params.toString()}`,
        { credentials: 'include', cache: 'no-store', signal: controller.signal },
      );
      const payload = await response.json().catch(() => ({}));
      if (
        detailRefreshRequestRef.current !== controller
        || activeAccountRef.current !== mailboxScopeKey
        || selectedMessageRef.current?.folder !== current.folder
        || selectedMessageRef.current?.id !== current.id
        || !shouldApplyEmailRefresh({
          requestEpoch,
          currentEpoch: detailRequestEpochRef.current,
          mutationRevision,
          currentMutationRevision: messageMutationRevisionRef.current,
          mutationInFlight: activeMessageMutationsRef.current > 0,
        })
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
      scheduleDetailFollowUp(emailMessageDetailScopeKey({ accountId, folder, messageId: current.id }), payload.data?.cache, requestEpoch);
      const nextRevision = emailMessageContentRevision(nextMessage);
      if (nextRevision !== emailMessageContentRevision(current) && dismissedMessageRevisionRef.current !== nextRevision) {
        setPendingMessageUpdate({ ...nextMessage, id: current.id, folder, messageRef: current.messageRef, selectionKey: current.selectionKey,
          origin: current.origin, personalFocus: current.personalFocus });
      }
    } catch (refreshError) {
      if (controller.signal.aborted || detailRefreshRequestRef.current !== controller) return;
      setError(refreshError instanceof Error ? refreshError.message : t('errors.loadMessage'));
    }
  }, [mailboxFetch, mailboxScopeKey, activeAccount, activeFolder, cancelDetailFollowUp, scheduleDetailFollowUp, t]);

  const loadMessages = useCallback(async (options?: { background?: boolean; swrFollowUp?: boolean }) => {
    if (usesIndexedFeed || !activeAccount || !canReadActiveAccount || foldersAccountId !== activeAccount?.id || foldersMailboxKey !== mailboxScopeKey) return;
    const scopeKey = emailMessageListScopeKey({
      accountId: activeAccount.id,
      filter: messageFilter,
      folder: activeFolder,
      page: messagePage,
      query: submittedQuery,
    });
    if (listRequestRef.current && listRequestScopeRef.current === scopeKey) return;
    cancelListFollowUp();
    const requestEpoch = ++listRequestEpochRef.current;
    const mutationRevision = messageMutationRevisionRef.current;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    listRequestScopeRef.current = scopeKey;
    const preserveVisibleData = options?.background || hasMessagesRef.current;
    setIsLoadingMessages(!preserveVisibleData);
    setIsRefreshingMessages(preserveVisibleData);
    setError(null);
    setSearchNotice(null);
    try {
      parseEmailSearchQuery(submittedQuery);
      const response = await mailboxFetch('/api/email/messages/list', {
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
        || activeAccountRef.current !== mailboxScopeKey
        || activeFolderRef.current !== activeFolder
        || !shouldApplyEmailRefresh({
          requestEpoch,
          currentEpoch: listRequestEpochRef.current,
          mutationRevision,
          currentMutationRevision: messageMutationRevisionRef.current,
          mutationInFlight: activeMessageMutationsRef.current > 0,
        })
      ) return;
      const nextMessages = (payload.data?.messages || []) as EmailMessageSummary[];
      setMessages(nextMessages);
      setServerHasMore(typeof payload.data?.hasMore === 'boolean' ? payload.data.hasMore : null);
      setSearchNotice(typeof payload.data?.searchNotice === 'string' ? payload.data.searchNotice : null);
      setMessageTotal(typeof payload.data?.total === 'number' ? payload.data.total : null);
      scheduleListFollowUp(scopeKey, payload.data?.cache, requestEpoch);
      if (!options?.swrFollowUp) void refreshSelectedMessage();
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
  }, [usesIndexedFeed, mailboxFetch, mailboxScopeKey, activeAccount, activeFolder, canReadActiveAccount, cancelListFollowUp, foldersAccountId, foldersMailboxKey, messageFilter, messagePage, refreshSelectedMessage, scheduleListFollowUp, submittedQuery, t]);

  const updateMessageReadState = useCallback((target: EmailMessageSummary, isRead: boolean, expectedScope: string) => {
    if (mailboxScopeRef.current !== expectedScope) return;
    setMessages((current) => current.map((message) => sameEmailSelection(message, target) ? { ...message, isRead } : message));
    setSelectedMessage((current) => sameEmailSelection(current, target) ? { ...current!, isRead } : current);
  }, []);

  const markMessageReadOnOpen = useCallback(async (message: EmailMessageSummary | EmailMessageDetail) => {
    if (!activeAccount || !canWriteActiveAccount || message.isRead) return;
    const folder = message.folder || activeFolder;
    const finishMutation = beginMessageMutation();
    updateMessageReadState(message, true, mailboxScopeKey);

    try {
      const response = await mailboxFetch(`/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'mark-read', folder, messageId: message.id, operation: 'action' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
      if (mailboxScopeRef.current === mailboxScopeKey) void loadFolders(activeAccount.id);
    } catch {
      updateMessageReadState(message, false, mailboxScopeKey);
    } finally {
      finishMutation();
    }
  }, [mailboxFetch, mailboxScopeKey, canWriteActiveAccount, activeAccount, activeFolder, beginMessageMutation, loadFolders, t, updateMessageReadState]);

  const loadMessage = useCallback(async (message: EmailMessageSummary, options?: { openDialog?: boolean }) => {
    if (!activeAccount) return;
    cancelDetailFollowUp();
    const requestEpoch = ++detailRequestEpochRef.current;
    detailRequestRef.current?.abort();
    detailRefreshRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    const accountId = activeAccount.id;
    const folder = message.folder || activeFolder;
    setSelectedMessageId(message.id);
    selectedMessageRef.current = null;
    setSelectedMessage(null);
    if (message.messageRef && message.origin && message.selectionKey) {
      setSelectedFeedItem({ messageRef: message.messageRef, selectionKey: message.selectionKey, origin: message.origin,
        message: { from: message.from, subject: message.subject, date: message.date, snippet: message.snippet,
          isRead: message.isRead, isFlagged: message.isFlagged, hasAttachments: message.hasAttachments,
          ...(Array.isArray(message.to) ? { to: message.to } : {}), ...(Array.isArray(message.cc) ? { cc: message.cc } : {}) },
        classification: message.classification ?? null, personalFocus: message.personalFocus ?? { done: false, version: 0 } });
    }
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
      const response = await mailboxFetch(
        `/api/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(message.id)}?${params.toString()}`,
        { credentials: 'include', cache: 'no-store', signal: controller.signal },
      );
      const payload = await response.json().catch(() => ({}));
      if (
        detailRequestRef.current !== controller
        || activeAccountRef.current !== mailboxScopeKey
        || activeFolderRef.current !== activeFolder
        || requestEpoch !== detailRequestEpochRef.current
      ) return;
      if (response.status === 404 && payload.code === 'EMAIL_MESSAGE_NOT_FOUND') {
        setSelectedMessage(null);
        setMessageUnavailable(message);
        return;
      }
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessage'));
      const nextMessage = payload.data?.message as EmailMessageDetail | undefined;
      if (!nextMessage) throw new Error(t('errors.loadMessage'));
      const resolvedMessage = { ...nextMessage, id: message.id, folder: nextMessage.folder || folder, messageRef: message.messageRef ?? nextMessage.messageRef,
        selectionKey: message.selectionKey ?? nextMessage.selectionKey, origin: message.origin ?? nextMessage.origin,
        classification: nextMessage.classification ?? message.classification, personalFocus: message.personalFocus ?? nextMessage.personalFocus };
      setSelectedMessage(resolvedMessage);
      scheduleDetailFollowUp(emailMessageDetailScopeKey({ accountId, folder, messageId: message.id }), payload.data?.cache, requestEpoch);
      void markMessageReadOnOpen(resolvedMessage);
    } catch (loadError) {
      if (controller.signal.aborted || detailRequestRef.current !== controller) return;
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessage'));
    } finally {
      if (detailRequestRef.current === controller) setIsLoadingMessage(false);
    }
  }, [mailboxFetch, mailboxScopeKey, activeAccount, activeFolder, cancelDetailFollowUp, clearMessageSummary, layoutMode, markMessageReadOnOpen, scheduleDetailFollowUp, t]);

  const openFeedMessage = (item: EmailClassificationFeedItem, openDialog = false) => {
    if (composeDraftRef.current) minimizeComposeRef.current();
    const account = accounts.find(candidate => candidate.id === item.origin.accountId && (candidate.workspaceId || null) === item.origin.workspaceId);
    const source = focusSources.find(candidate => candidate.mailboxRef === item.origin.mailboxRef && candidate.accountSource === item.origin.accountSource);
    if (!account || !source || !source.capabilities.canRead) { setError(tf('selectionError')); void loadFocusConfiguration(); return; }
    const accountKey = emailAccountContextKey(account);
    if (accountKey === mailboxScopeKey && foldersMailboxKey === accountKey && activeFolder === item.origin.folder) {
      ++feedSelectionEpochRef.current;
      pendingFeedOpenRef.current = null;
      void loadMessage(emailFeedMessageSummary(item), { openDialog });
      return;
    }
    clearReader();
    const epoch = ++feedSelectionEpochRef.current;
    pendingFeedOpenRef.current = { item, accountKey, openDialog, epoch };
    setDeniedMailboxKey(null);
    setActiveAccountId(emailAccountSelectionKey(account)); setActiveFolder(item.origin.folder);
  };
  const openFeedMessageRef = useRef(openFeedMessage);
  useLayoutEffect(() => { openFeedMessageRef.current = openFeedMessage; });

  useEffect(() => {
    const queued = pendingFeedOpenRef.current;
    if (!queued || queued.epoch !== feedSelectionEpochRef.current || queued.accountKey !== mailboxScopeKey
      || foldersMailboxKey !== queued.accountKey || isLoadingFolders || activeFolder !== queued.item.origin.folder || !canReadActiveAccount) return;
    const timer = window.setTimeout(() => {
      if (pendingFeedOpenRef.current !== queued || queued.epoch !== feedSelectionEpochRef.current) return;
      pendingFeedOpenRef.current = null;
      void loadMessage(emailFeedMessageSummary(queued.item), { openDialog: queued.openDialog });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mailboxScopeKey, foldersMailboxKey, isLoadingFolders, activeFolder, canReadActiveAccount, loadMessage]);

  useEffect(() => {
    if (!selectedFeedItem) return;
    const invalid = focusFeed.error && [401, 403, 404, 409, 503].includes(focusFeed.error.status);
    const source = focusSources.find(candidate => candidate.mailboxRef === selectedFeedItem.origin.mailboxRef);
    if (invalid || focusSourcesReady && (!source || !source.capabilities.canRead)) {
      const timer = window.setTimeout(() => clearReader(), 0); return () => window.clearTimeout(timer);
    }
  }, [selectedFeedItem, focusFeed.error, focusSources, focusSourcesReady, clearReader]);

  useEffect(() => {
    listFollowUpRunnerRef.current = () => {
      void loadMessages({ background: true, swrFollowUp: true });
    };
  }, [loadMessages]);

  useEffect(() => {
    detailFollowUpRunnerRef.current = () => {
      void refreshSelectedMessage();
    };
  }, [refreshSelectedMessage]);

  useEffect(() => {
    cancelListFollowUp();
    listRequestEpochRef.current += 1;
    listRequestRef.current?.abort();
  }, [mailboxFetch, activeAccount?.id, activeFolder, cancelListFollowUp, foldersAccountId, messageFilter, messagePage, submittedQuery, searchRevision]);

  useEffect(() => () => {
    cancelListFollowUp();
    cancelDetailFollowUp();
    listRequestEpochRef.current += 1;
    detailRequestEpochRef.current += 1;
    listRequestRef.current?.abort();
    detailRequestRef.current?.abort();
    detailRefreshRequestRef.current?.abort();
  }, [cancelDetailFollowUp, cancelListFollowUp]);

  useEffect(() => {
    if (feedIntentKey) return;
    if (!contextIntent) {
      appliedContextIntentRef.current = null;
      appliedSearchToolCallRef.current = null;
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
      if (composeDraftRef.current) return;
      const requestedAccountId = contextIntent.accountId;
      if (isLoadingAccounts) return;
      if (requestedAccountId && !accounts.some((account) => account.id === requestedAccountId)) {
        return;
      }
      if (
        requestedAccountId
        && accounts.some((account) => account.id === requestedAccountId)
        && (activeAccount?.id !== requestedAccountId || (contextIntent.workspaceId && activeAccount.workspaceId !== contextIntent.workspaceId))
      ) {
        clearReader();
        const requested = accounts.find(account => account.id === requestedAccountId && (!contextIntent.workspaceId || account.workspaceId === contextIntent.workspaceId));
        if (!requested) return;
        setActiveAccountId(requested.workspaceId ? `${requested.id}:${requested.workspaceId}` : requested.id);
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

      const opensMessage = (
        contextIntent.view === 'message'
        || contextIntent.toolName === 'email_read'
        || contextIntent.toolName === 'email_read_message'
      ) && Boolean(contextIntent.messageId);
      // Account changes clear the reader and load the target account's folders in
      // a separate effect. Wait for that reset to finish before opening a deep
      // link; otherwise the reset aborts this detail request and the intent is
      // already marked as applied.
      if (opensMessage && foldersAccountId !== activeAccount?.id) return;

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
        appliedContextIntentRef.current = intentKey;
        // Late tool results can resolve the mailbox without replaying a search
        // the user has already edited or submitted.
        if (contextIntent.toolCallId && appliedSearchToolCallRef.current === contextIntent.toolCallId) return;
        appliedSearchToolCallRef.current = contextIntent.toolCallId;
        clearReader();
        const source = focusSources.find(source => source.accountId === activeAccount?.id && source.workspaceId === (activeAccount?.workspaceId || null));
        if (source) {
          setFocusScope({ kind: 'mailbox', mailboxRef: source.mailboxRef });
          void changeExperienceMode('classic', true);
        }
        setQuery(contextIntent.query);
        setSubmittedQuery(contextIntent.query);
        setMessagePage(0);
        return;
      }

      appliedContextIntentRef.current = intentKey;
      if (opensMessage && contextIntent.messageId && selectedMessage?.id !== contextIntent.messageId) {
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
    changeExperienceMode,
    contextIntent,
    feedIntentKey,
    focusSources,
    foldersAccountId,
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
      setFoldersMailboxKey('');
      setMessages([]);
      setMessageTotal(null);
      clearReader({ preserveQueuedOpen: true });
      if (!activeReadAccountId) return;
      if (!canReadActiveAccount) return;
      void loadFolders(activeReadAccountId);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [mailboxFetch, mailboxScopeKey, activeReadAccountId, canReadActiveAccount, clearReader, loadFolders]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadMessages();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadMessages, searchRevision]);

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

  const applySearch = (value: string) => {
    try { parseEmailSearchQuery(value); } catch (failure) {
      setError(tSearch('invalidQuery', { reason: failure instanceof Error ? failure.message : String(failure) }));
      return;
    }
    listRequestEpochRef.current += 1;
    listRequestRef.current?.abort();
    listRequestRef.current = null;
    clearReader();
    setMessagePage(0);
    setServerHasMore(null);
    setSubmittedQuery(value.trim());
    setSearchRevision(current => current + 1);
  };
  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    applySearch(query);
  };

  const toggleUnreadFilter = () => {
    listRequestRef.current?.abort();
    clearReader();
    setMessagePage(0);
    setMessageFilter((current) => current === 'unread' ? 'all' : 'unread');
  };

  const composeController = useEmailComposeController({
    ownerUserId: session?.user.id || null,
    accounts,
    activeAccount,
    activeFolder,
    activeWorkspaceId,
    mailboxWorkspaceId,
    onAccessChanged: loadAccounts,
    contextIntent,
    onError: setError,
    onMessageActionNotice: setMessageActionNotice,
    onMessageDialogOpenChange: setMessageDialogOpen,
  });
  const {
    agentEvents: composeAgentEvents,
    agentStatus: composeAgentStatus,
    close: closeComposeDialog,
    draft: composeDraft,
    error: composeError,
    generateAiBody: generateComposeAiBody,
    generateAiReplyPreview,
    isGeneratingAi: isGeneratingComposeAi,
    isSubmitting: isSubmittingCompose,
    openDraft: openComposeDraft,
    openNewDraft: openNewComposeDraft,
    submit: submitComposeDraft,
    updateDraft: updateComposeDraft,
  } = composeController;
  const minimizeCompose = composeController.minimize;
  useLayoutEffect(() => { composeDraftRef.current = Boolean(composeDraft); minimizeComposeRef.current = minimizeCompose; }, [composeDraft, minimizeCompose]);

  useEffect(() => {
    if (!feedIntentIdentity || !contextIntent || !focusControlsReady || !focusSourcesReady
      || appliedFeedIntentRef.current === feedIntentIdentity) return;
    const controller = new AbortController();
    let deadline: number | null = null;
    const timer = window.setTimeout(() => {
      if (currentFeedIntentRef.current !== feedIntentIdentity || controller.signal.aborted) return;
      if (configuredFeedIntentRef.current !== feedIntentIdentity) {
        configuredFeedIntentRef.current = feedIntentIdentity;
        modeWriteEpochRef.current++;
        if (composeDraftRef.current) minimizeComposeRef.current();
        clearReader();
        setIntentExperience({ key: feedIntentIdentity, mode: contextIntent.experienceMode ?? 'focus' });
        setFocusScope({ kind: contextIntent.feedScope ?? 'all' });
        setFocusView(contextIntent.feedView ?? 'focus');
        setFocusCategory(null); setFocusSearch(''); setError(null);
      }
      const epoch = feedSelectionEpochRef.current;
      const navigationEpoch = feedIntentNavigationEpochRef.current;
      const current = () => !controller.signal.aborted && currentFeedIntentRef.current === feedIntentIdentity
        && currentUserRef.current === selectionStorageKey && feedSelectionEpochRef.current === epoch
        && feedIntentNavigationEpochRef.current === navigationEpoch;
      if (contextIntent.messageRef === undefined) { appliedFeedIntentRef.current = feedIntentIdentity; return; }
      const messageRef = contextIntent.messageRef;
      if (!/^emm:[a-f0-9]{64}$/u.test(messageRef)) {
        appliedFeedIntentRef.current = feedIntentIdentity; setError(tf('selectionError')); return;
      }
      deadline = window.setTimeout(() => {
        const ownsSelection = current();
        controller.abort();
        if (ownsSelection) { appliedFeedIntentRef.current = feedIntentIdentity; clearReader(); setError(tf('selectionError')); }
      }, 30_000);
      void (async () => {
        try {
          const response = await fetch(`/api/email/classification/message?${new URLSearchParams({ messageRef })}`, {
            credentials: 'include', cache: 'no-store', signal: controller.signal,
          });
          if (!current()) return;
          const payload: unknown = await response.json();
          if (!current()) return;
          const item = response.ok && payload && typeof payload === 'object' && 'success' in payload && payload.success === true
            && 'data' in payload ? resolvedEmailFocusMessage(payload.data, messageRef) : null;
          appliedFeedIntentRef.current = feedIntentIdentity;
          if (!item) { clearReader(); setError(tf('selectionError')); return; }
          openFeedMessageRef.current(item);
        } catch {
          if (current()) { appliedFeedIntentRef.current = feedIntentIdentity; clearReader(); setError(tf('selectionError')); }
        } finally { if (deadline !== null) window.clearTimeout(deadline); }
      })();
    }, 0);
    const cancel = () => { window.clearTimeout(timer); if (deadline !== null) window.clearTimeout(deadline); controller.abort(); };
    cancelFeedIntentRequestRef.current = cancel;
    return () => { cancel(); if (cancelFeedIntentRequestRef.current === cancel) cancelFeedIntentRequestRef.current = null; };
  }, [feedIntentIdentity, contextIntent, focusControlsReady, focusSourcesReady, selectionStorageKey, clearReader, tf]);

  const openFocusCompose = () => {
    if (composeController.draft) { composeController.resume(); return; }
    const writable = accounts.filter(account => account.capabilities?.canWrite !== false);
    if (!writable.length) return;
    if (focusScope.kind === 'mailbox') {
      const source = focusSources.find(source => source.mailboxRef === focusScope.mailboxRef);
      const account = writable.find(candidate => candidate.id === source?.accountId && (candidate.workspaceId || null) === source?.workspaceId);
      if (account) {
        if (emailAccountContextKey(account) === mailboxScopeKey) { openNewComposeDraft(); return; }
        pendingComposeAccountRef.current = emailAccountContextKey(account);
        clearReader();
        setActiveAccountId(emailAccountSelectionKey(account));
        return;
      }
    }
    setComposeSenderKey(emailAccountSelectionKey(writable.find(account => emailAccountContextKey(account) === mailboxScopeKey) || writable[0]));
    setComposeSenderOpen(true);
  };

  useEffect(() => {
    if (!activeAccount || pendingComposeAccountRef.current !== mailboxScopeKey) return;
    const timer = window.setTimeout(() => {
      if (pendingComposeAccountRef.current !== mailboxScopeRef.current) return;
      pendingComposeAccountRef.current = null; openNewComposeDraft();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeAccount, mailboxScopeKey, openNewComposeDraft]);

  const applyClassificationItem = (item: EmailClassificationFeedItem) => {
    focusFeed.updateItem(item);
    setSelectedFeedItem(current => current?.messageRef === item.messageRef ? item : current);
    setSelectedMessage(current => current?.messageRef === item.messageRef ? { ...current, classification: item.classification,
      personalFocus: item.personalFocus, origin: item.origin } : current);
  };

  const markPersonalFocus = async (item: EmailClassificationFeedItem, done: boolean) => {
    try { applyClassificationItem(await setEmailPersonalFocusDone(item, done)); }
    catch { setError(tf('focusStateSaveError')); }
  };

  const currentAssessmentItem = useMemo(() => {
    if (!selectedFeedItem) return null;
    const source = focusSources.find(candidate => candidate.mailboxRef === selectedFeedItem.origin.mailboxRef);
    return source ? { ...selectedFeedItem, origin: { ...selectedFeedItem.origin, capabilities: source.capabilities } } : selectedFeedItem;
  }, [selectedFeedItem, focusSources]);

  const handleMessageAction = useCallback(async (action: EmailMessageActionName, destination?: string) => {
    if (!activeAccount || !selectedMessage) return;
    if (['summary', 'ai-reply'].includes(action) ? !canRunAgent : !canWriteActiveAccount) return;
    if (['trash', 'permanent-delete'].includes(action) && activeAccount.capabilities?.canDelete === false) return;
    if (action === 'draft-reply' || action === 'draft-reply-all' || action === 'draft-forward') {
      const mode = action === 'draft-forward' ? 'forward' : action === 'draft-reply-all' ? 'reply-all' : 'reply';
      openComposeDraft(mode, selectedMessage);
      return;
    }
    if (!canWriteActiveAccount || (['trash', 'permanent-delete'].includes(action) && activeAccount.capabilities?.canDelete === false)) return;
    if (action === 'permanent-delete' && !window.confirm(t('confirmPermanentDelete'))) return;

    const folder = selectedMessage.folder || activeFolder;
    setActiveMessageAction(action);
    setMessageActionNotice(null);
    setError(null);
    let finishMutation: (() => void) | null = null;

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
          const response = await mailboxFetch(summaryEndpoint, {
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
        await generateAiReplyPreview(selectedMessage, folder);
        return;
      }

      finishMutation = beginMessageMutation();
      const body: Record<string, unknown> = { action, destination, folder, messageId: selectedMessage.id, operation: 'action' };

      const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`;
      const response = await mailboxFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));

      if (mailboxScopeRef.current !== mailboxScopeKey || !sameEmailSelection(selectedMessageRef.current, selectedMessage)) return;

      if (action === 'mark-read' || action === 'mark-unread') {
        const isRead = action === 'mark-read';
        setMessages((current) => current.map((message) => message.id === selectedMessage.id ? { ...message, isRead } : message));
        setSelectedMessage((current) => sameEmailSelection(current, selectedMessage) ? { ...current!, isRead } : current);
        setMessageActionNotice(t('messageUpdated'));
        return;
      }

      if (action === 'mark-answered' || action === 'clear-answered') {
        const isAnswered = action === 'mark-answered';
        setMessages((current) => current.map((message) => message.id === selectedMessage.id ? { ...message, isAnswered } : message));
        setSelectedMessage((current) => sameEmailSelection(current, selectedMessage) ? { ...current!, isAnswered } : current);
        setMessageActionNotice(t('messageUpdated'));
        return;
      }

      setMessages((current) => current.filter((message) => message.id !== selectedMessage.id));
      clearReader();
      setMessageActionNotice(t('messageMoved'));
      void loadFolders(activeAccount.id);
    } catch (actionError) {
      if (mailboxScopeRef.current !== mailboxScopeKey) return;
      if (action === 'summary' && actionError instanceof DOMException && actionError.name === 'AbortError') return;
      setError(isFetchNetworkError(actionError)
        ? t('errors.actionRequest')
        : actionError instanceof Error ? actionError.message : t('errors.updateMessage'));
    } finally {
      finishMutation?.();
      setActiveMessageAction(null);
    }
  }, [mailboxFetch, mailboxScopeKey, canRunAgent, canWriteActiveAccount, activeAccount, activeFolder, activeWorkspaceId, beginMessageMutation, clearReader, generateAiReplyPreview, loadFolders, openComposeDraft, selectedMessage, summaryAiStageLabel, t]);

  const handleMessageListAction = useCallback(async (message: EmailMessageSummary, action: EmailMessageListActionName, destination?: string) => {
    if (!activeAccount) return;
    if (!canWriteActiveAccount || (['trash', 'permanent-delete'].includes(action) && activeAccount.capabilities?.canDelete === false)) return;
    if (action === 'permanent-delete' && !window.confirm(t('confirmPermanentDelete'))) return;
    if (action === 'move' && !destination) return;

    const folder = message.folder || activeFolder;
    const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`;
    setActiveMessageListAction({ action, messageId: message.id });
    setMessageActionNotice(null);
    setError(null);
    const finishMutation = beginMessageMutation();

    try {
      const response = await mailboxFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, destination, folder, messageId: message.id, operation: 'action' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));
      if (mailboxScopeRef.current !== mailboxScopeKey) return;

      if (action === 'mark-read' || action === 'mark-unread') {
        const isRead = action === 'mark-read';
        setMessages((current) => current.map((currentMessage) => currentMessage.id === message.id ? { ...currentMessage, isRead } : currentMessage));
        setSelectedMessage((current) => sameEmailSelection(current, message) ? { ...current!, isRead } : current);
        setMessageActionNotice(t('messageUpdated'));
        return;
      }

      setMessages((current) => current.filter((currentMessage) => currentMessage.id !== message.id));
      if (sameEmailSelection(selectedMessageRef.current, message)) {
        clearReader();
      }
      setMessageActionNotice(t('messageMoved'));
      void loadFolders(activeAccount.id);
    } catch (actionError) {
      if (mailboxScopeRef.current !== mailboxScopeKey) return;
      setError(isFetchNetworkError(actionError)
        ? t('errors.actionRequest')
        : actionError instanceof Error ? actionError.message : t('errors.updateMessage'));
    } finally {
      finishMutation();
      setActiveMessageListAction(null);
    }
  }, [mailboxFetch, mailboxScopeKey, canWriteActiveAccount, activeAccount, activeFolder, beginMessageMutation, clearReader, loadFolders, t]);

  const messageOffset = messagePage * MESSAGE_PAGE_SIZE;
  const messageStart = messages.length > 0 ? messageOffset + 1 : 0;
  const messageEnd = messageOffset + messages.length;
  const hasPreviousMessagePage = messagePage > 0;
  const hasNextMessagePage = serverHasMore ?? (messageTotal === null
    ? messages.length === MESSAGE_PAGE_SIZE
    : messageEnd < messageTotal);
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
    attachmentActions: t('attachmentActions'),
    attachmentUnavailable: t('attachmentUnavailable'),
    attachmentsSaveFailed: t('attachmentsSaveFailed'),
    attachmentsSaved: t('attachmentsSaved', { count: '{count}' }),
    backToMessages: t('backToMessages'),
    cancel: t('composeCancel'),
    cc: t('cc'),
    date: t('date'),
    emptyBody: t('emptyBody'),
    downloadAttachment: t('downloadAttachment'),
    downloadAllAttachments: t('downloadAllAttachments'),
    downloadLocally: t('downloadLocally'),
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
    saveAttachmentsDescription: t('saveAttachmentsDescription', { count: '{count}' }),
    saveAttachmentsSubmit: t('saveAttachmentsSubmit'),
    saveAttachmentsTitle: t('saveAttachmentsTitle'),
    saveToWorkspace: t('saveToWorkspace'),
    selectMessage: t('selectMessage'),
    showRemoteImages: t('showRemoteImages'),
    summary: t('summary'),
    summaryReady: t('summaryReady'),
    summaryReadingContext: t('summaryReadingContext'),
    summaryWriting: t('summaryWriting'),
    savingAttachments: t('savingAttachments'),
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

  const reviewCenter = (
    <div id="onboarding-email-review" className="shrink-0">
      <EmailReviewCenter
        focusRequestKey={contextIntent?.view === 'review-center'
          ? `${contextIntent.toolCallId || contextIntent.toolName}:${contextIntent.mailboxId || ''}`
          : undefined}
      />
    </div>
  );

  if (!selectionStorageKey && !isSessionPending) {
    return <section className="m-4 space-y-3 rounded-md border border-destructive/30 p-4" role="alert" data-testid="email-session-error">
      <p className="text-sm text-destructive">{t('errors.loadSession')}</p>
      <Button variant="outline" onClick={() => void refetchSession()}>{tm('retry')}</Button>
    </section>;
  }

  if (isLoadingAccounts || !selectionStorageKey) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t('loadingAccounts')}
      </div>
    );
  }

  if (accountsLoadError) {
    return <section className="m-4 space-y-3 rounded-md border border-destructive/30 p-4" role="alert">
      <p className="text-sm text-destructive">{accountsLoadError}</p>
      <Button variant="outline" onClick={() => void loadAccounts()}>{tm('retry')}</Button>
    </section>;
  }

  if (accounts.length === 0 && !composeDraft) {
    return (
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 overflow-y-auto px-3 py-6 sm:px-6 sm:py-10">
        {reviewCenter}
        {!personalSetupOpen ? <EmailSetupGuide setup={mailboxSetup} onPersonalSetup={() => setPersonalSetupOpen(true)} /> : <>
        <Button className="self-start" variant="ghost" onClick={() => setPersonalSetupOpen(false)}>{tm('backToSetup')}</Button>
        <EmailAccountsCard
          isOpen={true}
          onOpenChange={() => undefined}
          onAccountsChanged={() => { setDeniedMailboxKey(null); void loadAccounts(); }}
          presentation="setup"
          onPreviewPreferencesChanged={(preferences) => {
            setEmailAllowRemoteImages(preferences.emailAllowRemoteImages);
            setEmailRemoteImageAllowedSenders(preferences.emailRemoteImageAllowedSenders || []);
          }}
        />
        </>}
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
        {focusControlsReady && <EmailFocusHeader scope={focusScope} mode={experienceMode} classificationEnabled={classificationAvailability?.enabled ?? false}
          mailboxes={focusSources} search={focusSearch} onScopeChange={changeFocusScope} onModeChange={mode => void changeExperienceMode(mode)}
          onSearchChange={value => { consumeExternalFeedIntent(); setFocusSearch(value); }} onCompose={openFocusCompose} onRefresh={() => { focusFeed.reload(); void loadFocusConfiguration(); }}
          loading={focusFeed.loading || focusFeed.loadingMore} canCompose={accounts.some(account => account.capabilities?.canWrite !== false)}
          mailboxesLoading={!focusSourcesReady && !focusSourcesError} mailboxesError={focusSourcesError} controlsOnly={!usesIndexedFeed}
          focused={focused} onDistractionFree={toggleFocus}
          canConfigureClassification={classificationAvailability?.canConfigure === true}
          processingReason={classificationAvailability?.reason} />}
        {!usesIndexedFeed && <EmailMailboxHeader
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
          submittedQuery={submittedQuery}
          scope={activeFolder === 'all' ? 'all' : 'folder'}
          searchNotice={searchNotice}
          onSearchQuery={applySearch}
          onResetSearch={() => { setQuery(''); applySearch(''); }}
          onScopeChange={(scope) => selectFolder(scope === 'all' ? 'all' : (folders.find(folder => folder.path === previousFolder.current)?.path || folders.find(folder => folder.role === 'inbox')?.path || 'INBOX'))}
          focused={focused}
          onFocus={toggleFocus}
        />}
      </section>

      {reviewCenter}

      {composeDraft && composeController.composeMinimized && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm">
        <span className="min-w-0 truncate">{composeController.draftSenderAddress} · {composeDraft.subject || t('noSubject')}</span>
        <Button type="button" size="sm" variant="outline" onClick={composeController.resume}>{tf('resumeDraft')}</Button>
      </div>}

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

      {!usesIndexedFeed && !canReadActiveAccount ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {activeAccount ? <div className="p-3 sm:p-5"><EmailSetupGuide setup={mailboxSetup} account={activeAccount} denied={deniedMailboxKey === mailboxScopeKey} onPersonalSetup={() => setAccountsOpen(true)} onCompose={openNewComposeDraft} /></div> : <section className="space-y-3 p-6 text-center"><h3 className="font-semibold">{tm('selectMailbox')}</h3><p className="text-sm text-muted-foreground">{tm('selectionRemoved')}</p></section>}
        </div>
      ) : (
        <div
          className={cn(
            'min-h-0 flex-1 overflow-hidden',
            layoutMode === 'wide' ? 'grid' : 'flex flex-col',
          )}
          style={layoutMode === 'wide'
            ? {
              gridTemplateColumns: usesIndexedFeed ? `minmax(280px, ${effectiveListWidth}px) 8px minmax(0, 1fr)` : isFolderSidebarOpen
                ? `220px minmax(280px, ${effectiveListWidth}px) 8px minmax(0, 1fr)`
                : `minmax(280px, ${effectiveListWidth}px) 8px minmax(0, 1fr)`,
            }
            : undefined}
        >
          {usesIndexedFeed ? <>
            <EmailFocusNavigation feed={focusFeed.feed} view={focusSearch || experienceMode === 'classic' ? 'all' : focusView}
              category={focusSearch ? null : focusCategory} onViewChange={view => { consumeExternalFeedIntent(); setFocusView(view); setFocusSearch(''); }}
              onCategoryChange={category => { consumeExternalFeedIntent(); setFocusCategory(category); }} onOpen={(item, dialog) => { consumeExternalFeedIntent(); openFeedMessage(item, dialog); }} onDone={(item, done) => void markPersonalFocus(item, done)}
              selectionKey={selectedFeedItem?.selectionKey || ''} loading={focusFeed.loading} loadingMore={focusFeed.loadingMore}
              error={focusFeed.error} hasUpdates={focusFeed.hasUpdates} hasMore={focusFeed.hasMore} onReload={focusFeed.reload}
              onLoadMore={focusFeed.loadMore} aggregate={focusScope.kind !== 'mailbox'}
              mailboxes={focusSources} onOpenMailbox={openFocusMailbox} />
            {layoutMode === 'wide' && <EmailPaneResizeHandle label={t('resizeMessageList')} width={effectiveListWidth} onWidthChange={setListWidth} />}
          </> : <EmailMailboxNavigation
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
              noMessages: submittedQuery ? tSearch('noMatches') : t('noMessages'),
              noSubject: t('noSubject'),
              previousPage: t('previousPage'),
              resizeMessageList: t('resizeMessageList'),
              showFolders: t('showFolders'),
              unknownSender: t('unknownSender'),
              unreadOnly: t('unreadOnly'),
            }}
            layoutMode={layoutMode}
            listWidth={effectiveListWidth}
            messageContextMenu={messageContextMenu}
            messageFilter={messageFilter}
            messageRangeLabel={messageRangeLabel}
            messages={messages}
            onCloseContextMenu={() => setMessageContextMenu(null)}
            onContextMenu={(message, position) => canWriteActiveAccount && setMessageContextMenu({ messageId: message.id, ...position })}
            onFolderSidebarOpenChange={changeFolderSidebar}
            onListWidthChange={setListWidth}
            onMessageAction={handleMessageListAction}
            canWrite={canWriteActiveAccount}
            canDelete={activeAccount?.capabilities?.canDelete ?? true}
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
            searchQuery={submittedQuery}
          />}

          {layoutMode === 'wide' && <section className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
            {experienceMode === 'focus' && currentAssessmentItem && <div className="max-h-[min(40dvh,50%)] shrink-0 overflow-y-auto" data-testid="email-assessment-scroll">
              <EmailClassificationDetails item={currentAssessmentItem} userId={session?.user.id || ''}
                onItemChange={applyClassificationItem} onUnavailable={() => clearReader()} />
            </div>}
            <EmailMessageViewer
              key={`email-message-viewer:${mailboxScopeKey}:${selectedMessage?.selectionKey || selectedMessage?.id || 'empty'}:${readerRevision}`}
              actions={selectedMessage ? { canWrite: canWriteActiveAccount, canRunAgent, activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              accountId={activeAccount?.id}
              mailboxWorkspaceId={mailboxWorkspaceId}
              onMailboxAccessChanged={() => { setDeniedMailboxKey(mailboxScopeKey); clearReader(); setMessages([]); setFolders([]); setFoldersAccountId(''); void loadAccounts(); }}
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
            {experienceMode === 'focus' && currentAssessmentItem && <div className="max-h-[min(40dvh,50%)] shrink-0 overflow-y-auto [&>section]:pr-12" data-testid="email-assessment-scroll">
              <EmailClassificationDetails item={currentAssessmentItem} userId={session?.user.id || ''}
                onItemChange={applyClassificationItem} onUnavailable={() => clearReader()} />
            </div>}
            <EmailMessageViewer
              key={`email-message-dialog-viewer:${mailboxScopeKey}:${selectedMessage?.selectionKey || selectedMessage?.id || 'empty'}:${readerRevision}`}
              actions={selectedMessage ? { canWrite: canWriteActiveAccount, canRunAgent, activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              accountId={activeAccount?.id}
              mailboxWorkspaceId={mailboxWorkspaceId}
              onMailboxAccessChanged={() => { setDeniedMailboxKey(mailboxScopeKey); clearReader(); setMessages([]); setFolders([]); setFoldersAccountId(''); void loadAccounts(); }}
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
        canGenerateAi={composeController.draftCanGenerateAi}
        submitDisabled={!composeController.draftCanWrite || composeController.sendUncertain}
        onOpenOutbox={composeController.sendUncertain ? composeController.openOutbox : undefined}
        accountId={composeController.draftAccount?.id}
        mailboxWorkspaceId={composeController.draftMailboxWorkspaceId}
        senderAddress={composeController.draftSenderAddress}
        attachmentWorkspaceId={composeController.draftAttachmentWorkspaceId}
        composeMinimized={composeController.composeMinimized}
        onMinimize={composeController.minimize}
        minimizeLabel={tf('minimizeDraft')}
        labels={composeDialogLabels}
        locale={locale}
        onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
        onClose={closeComposeDialog}
        onGenerateAi={() => void generateComposeAiBody()}
        onSubmit={() => void submitComposeDraft()}
        onUpdate={updateComposeDraft}
      />

      <Dialog open={composeSenderOpen} onOpenChange={setComposeSenderOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{tf('sourceComposeTitle')}</DialogTitle><DialogDescription>{tf('selectSender')}</DialogDescription></DialogHeader>
          <select className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm" aria-label={tf('selectSender')}
            value={composeSenderKey} onChange={event => setComposeSenderKey(event.target.value)}>
            {accounts.filter(account => account.capabilities?.canWrite !== false).map(account => <option key={emailAccountSelectionKey(account)} value={emailAccountSelectionKey(account)}>
              {account.emailAddress}{account.workspaceName ? ` · ${account.workspaceName}` : ''}
            </option>)}
          </select>
          <Button type="button" disabled={!accounts.some(account => emailAccountSelectionKey(account) === composeSenderKey && account.capabilities?.canWrite !== false)}
            onClick={() => {
              const account = accounts.find(candidate => emailAccountSelectionKey(candidate) === composeSenderKey && candidate.capabilities?.canWrite !== false);
              if (!account) return;
              setComposeSenderOpen(false);
              if (emailAccountContextKey(account) === mailboxScopeKey) openNewComposeDraft();
              else { pendingComposeAccountRef.current = emailAccountContextKey(account); clearReader(); setActiveAccountId(emailAccountSelectionKey(account)); }
            }}>{tf('composeWithSender')}</Button>
        </DialogContent>
      </Dialog>

      {accounts.length > 0 && (
        <Dialog open={accountsOpen} onOpenChange={setAccountsOpen}>
          <DialogContent layout="viewport">
            <DialogHeader className="border-b border-border px-4 py-3 pr-10 sm:px-5">
              <DialogTitle className="text-base leading-6">{t('manageAccounts')}</DialogTitle>
              <DialogDescription className="text-xs leading-5 sm:text-sm">{t('manageAccountsDescription')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
              {activeAccount?.workspaceId ? <EmailSetupGuide setup={mailboxSetup} account={activeAccount} denied={deniedMailboxKey === mailboxScopeKey} onPersonalSetup={() => undefined} /> : <EmailAccountsCard
                isOpen={true}
                onOpenChange={() => undefined}
                onAccountsChanged={() => { setDeniedMailboxKey(null); void loadAccounts(); }}
                presentation="dialog"
                onPreviewPreferencesChanged={(preferences) => {
                  setEmailAllowRemoteImages(preferences.emailAllowRemoteImages);
                  setEmailRemoteImageAllowedSenders(preferences.emailRemoteImageAllowedSenders || []);
                }}
              />}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
