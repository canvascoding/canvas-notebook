'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, Loader2, MailWarning, RefreshCw, Search, Star } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EmailAccountsCard } from '@/app/components/settings/IntegrationsSettingsClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type EmailAccount = {
  id: string;
  provider: string;
  authType: string;
  emailAddress: string;
  displayName: string | null;
  isPrimary: boolean;
  status: string;
  imapHost: string | null;
};

type EmailFolder = {
  id: string;
  name: string;
  path: string;
  role: string;
  messageCount: number | null;
  unseenCount: number | null;
};

type EmailMessageSummary = {
  id: string;
  uid?: string;
  folder?: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  isRead?: boolean;
  isAnswered?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
};

type EmailMessageDetail = EmailMessageSummary & {
  to?: string[] | string;
  cc?: string[] | string;
  body?: string;
  bodyHtml?: string;
  attachments?: Array<{
    filename: string;
    contentType?: string;
    size?: number;
  }>;
};

function formatDate(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatRecipients(value: string[] | string | undefined) {
  if (!value) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return value;
}

export function EmailClient() {
  const t = useTranslations('emails');
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState('INBOX');
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<EmailMessageDetail | null>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingMessage, setIsLoadingMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) || accounts[0] || null,
    [accounts, activeAccountId],
  );
  const canReadActiveAccount = Boolean(activeAccount && (activeAccount.authType !== 'smtp_imap' || activeAccount.imapHost));

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

  const loadFolders = useCallback(async (accountId: string) => {
    if (!accountId) return;
    setIsLoadingFolders(true);
    setError(null);
    try {
      const response = await fetch(`/api/email/folders?accountId=${encodeURIComponent(accountId)}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadFolders'));
      const nextFolders = (payload.data?.folders || []) as EmailFolder[];
      setFolders(nextFolders);
      setActiveFolder((current) => {
        if (current && nextFolders.some((folder) => folder.path === current)) return current;
        return nextFolders.find((folder) => folder.role === 'inbox')?.path || nextFolders[0]?.path || 'INBOX';
      });
    } catch (loadError) {
      setFolders([]);
      setError(loadError instanceof Error ? loadError.message : t('errors.loadFolders'));
    } finally {
      setIsLoadingFolders(false);
    }
  }, [t]);

  const loadMessages = useCallback(async () => {
    if (!activeAccount || !canReadActiveAccount) return;
    setIsLoadingMessages(true);
    setError(null);
    try {
      const response = await fetch('/api/email/messages/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          accountId: activeAccount.id,
          folder: activeFolder,
          query: submittedQuery,
          limit: 25,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessages'));
      const nextMessages = (payload.data?.messages || []) as EmailMessageSummary[];
      setMessages(nextMessages);
      setSelectedMessageId((current) => current && nextMessages.some((message) => message.id === current) ? current : '');
      setSelectedMessage(null);
    } catch (loadError) {
      setMessages([]);
      setSelectedMessage(null);
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessages'));
    } finally {
      setIsLoadingMessages(false);
    }
  }, [activeAccount, activeFolder, canReadActiveAccount, submittedQuery, t]);

  const loadMessage = useCallback(async (message: EmailMessageSummary) => {
    if (!activeAccount) return;
    setSelectedMessageId(message.id);
    setIsLoadingMessage(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('folder', message.folder || activeFolder);
      const response = await fetch(
        `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/${encodeURIComponent(message.id)}?${params.toString()}`,
        { credentials: 'include', cache: 'no-store' },
      );
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessage'));
      setSelectedMessage(payload.data?.message as EmailMessageDetail);
    } catch (loadError) {
      setSelectedMessage(null);
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessage'));
    } finally {
      setIsLoadingMessage(false);
    }
  }, [activeAccount, activeFolder, t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadAccounts();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAccounts]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFolders([]);
      setMessages([]);
      setSelectedMessage(null);
      setSelectedMessageId('');
      if (!activeAccount) return;
      if (!canReadActiveAccount) return;
      void loadFolders(activeAccount.id);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeAccount, canReadActiveAccount, loadFolders]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadMessages();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadMessages]);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmittedQuery(query.trim());
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <section className="border border-border bg-card px-4 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
              <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">{t('title')}</h2>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('emptyDescription')}</p>
            </div>
          </div>
        </section>
        <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-3 px-3 py-3 sm:px-6 sm:py-5">
      <section className="flex flex-col gap-3 border border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
              <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight">{t('title')}</h2>
              {activeAccount && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="truncate">{activeAccount.emailAddress}</span>
                  {activeAccount.isPrimary && (
                    <Badge variant="secondary" className="gap-1">
                      <Star className="h-3 w-3" />
                      {t('mainEmail')}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="sr-only" htmlFor="email-account-switcher">{t('accountLabel')}</label>
            <select
              id="email-account-switcher"
              className="h-10 min-w-[220px] border border-input bg-background px-3 text-sm"
              value={activeAccountId}
              onChange={(event) => setActiveAccountId(event.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.isPrimary ? `${account.emailAddress} (${t('mainEmail')})` : account.emailAddress}
                </option>
              ))}
            </select>
            <Button type="button" variant="outline" onClick={() => void loadMessages()} disabled={!canReadActiveAccount || isLoadingMessages}>
              {isLoadingMessages ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {t('refresh')}
            </Button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-10"
          />
          <Button type="submit" disabled={!canReadActiveAccount || isLoadingMessages}>
            <Search className="mr-2 h-4 w-4" />
            {t('search')}
          </Button>
        </form>
      </section>

      {error && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {!canReadActiveAccount ? (
        <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="flex min-h-80 items-center justify-center border border-border bg-card p-6 text-center">
            <div className="max-w-md space-y-3">
              <MailWarning className="mx-auto h-9 w-9 text-muted-foreground" />
              <h3 className="text-base font-semibold">{t('imapMissingTitle')}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{t('imapMissingDescription')}</p>
            </div>
          </section>
          <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} />
        </div>
      ) : (
        <div className="grid min-h-[620px] flex-1 gap-3 lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]">
          <aside className="min-h-0 border border-border bg-card">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('folders')}
            </div>
            <div className="max-h-[240px] overflow-y-auto p-2 lg:max-h-none">
              {isLoadingFolders ? (
                <div className="flex items-center px-2 py-3 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('loadingFolders')}
                </div>
              ) : folders.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">{t('noFolders')}</div>
              ) : (
                folders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-sm transition-colors',
                      activeFolder === folder.path ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
                    )}
                    onClick={() => setActiveFolder(folder.path)}
                  >
                    <span className="min-w-0 truncate">{folder.name}</span>
                    {folder.unseenCount ? <span className="text-xs font-medium">{folder.unseenCount}</span> : null}
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="min-h-0 border border-border bg-card">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('messages')}
            </div>
            <div className="max-h-[360px] overflow-y-auto lg:max-h-none">
              {isLoadingMessages ? (
                <div className="flex items-center px-3 py-4 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('loadingMessages')}
                </div>
              ) : messages.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">{t('noMessages')}</div>
              ) : (
                messages.map((message) => (
                  <button
                    key={`${message.folder || activeFolder}:${message.id}`}
                    type="button"
                    className={cn(
                      'block w-full border-b border-border px-3 py-3 text-left transition-colors hover:bg-muted/60',
                      selectedMessageId === message.id && 'bg-primary/10',
                    )}
                    onClick={() => void loadMessage(message)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 truncate text-sm font-medium">{message.from || t('unknownSender')}</div>
                      <div className="shrink-0 text-[11px] text-muted-foreground">{formatDate(message.date)}</div>
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold">{message.subject || t('noSubject')}</div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{message.snippet}</p>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="min-h-0 border border-border bg-card">
            {isLoadingMessage ? (
              <div className="flex h-full min-h-80 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('loadingMessage')}
              </div>
            ) : selectedMessage ? (
              <article className="flex h-full min-h-0 flex-col">
                <header className="border-b border-border px-4 py-4">
                  <h3 className="text-lg font-semibold leading-7">{selectedMessage.subject || t('noSubject')}</h3>
                  <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                    <p><span className="font-medium text-foreground">{t('from')}:</span> {selectedMessage.from}</p>
                    {formatRecipients(selectedMessage.to) && <p><span className="font-medium text-foreground">{t('to')}:</span> {formatRecipients(selectedMessage.to)}</p>}
                    {formatRecipients(selectedMessage.cc) && <p><span className="font-medium text-foreground">{t('cc')}:</span> {formatRecipients(selectedMessage.cc)}</p>}
                    {selectedMessage.date && <p><span className="font-medium text-foreground">{t('date')}:</span> {formatDate(selectedMessage.date)}</p>}
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
                    {selectedMessage.body || selectedMessage.bodyHtml || selectedMessage.snippet || t('emptyBody')}
                  </pre>
                  {selectedMessage.attachments && selectedMessage.attachments.length > 0 && (
                    <div className="mt-5 border-t border-border pt-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('attachments')}</div>
                      <div className="mt-2 space-y-2">
                        {selectedMessage.attachments.map((attachment) => (
                          <div key={attachment.filename} className="border border-border px-3 py-2 text-sm">
                            <div className="font-medium">{attachment.filename}</div>
                            <div className="text-xs text-muted-foreground">{attachment.contentType || t('unknownAttachmentType')}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </article>
            ) : (
              <div className="flex h-full min-h-80 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('selectMessage')}
              </div>
            )}
          </section>
        </div>
      )}

      {canReadActiveAccount && (
        <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} />
      )}
    </div>
  );
}
