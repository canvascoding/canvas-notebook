'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Forward,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MailWarning,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Sparkles,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EmailAccountsCard } from '@/app/components/settings/IntegrationsSettingsClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  policy: {
    readFrom: string[];
    sendTo: string[];
  };
};

type EmailFolder = {
  id: string;
  name: string;
  path: string;
  role: string;
  selectable?: boolean;
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

const MESSAGE_PAGE_SIZE = 20;
const COMPACT_VIEWPORT_QUERY = '(max-width: 1023px)';
const SEND_POLICY_ERROR_PATTERN = /send policy:\s*([^\s,;]+)/iu;
const EMAIL_HTML_SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a',
    'abbr',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'col',
    'colgroup',
    'dd',
    'del',
    'div',
    'dl',
    'dt',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  ALLOWED_ATTR: [
    'abbr',
    'align',
    'alt',
    'aria-label',
    'border',
    'cellpadding',
    'cellspacing',
    'colspan',
    'dir',
    'height',
    'href',
    'lang',
    'rel',
    'rowspan',
    'scope',
    'src',
    'target',
    'title',
    'width',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ['ping', 'srcset', 'style'],
  FORBID_TAGS: ['base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'math', 'meta', 'object', 'script', 'select', 'style', 'svg', 'textarea'],
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

function extractBlockedSendPolicyRecipient(error: string | null): string | null {
  const match = error?.match(SEND_POLICY_ERROR_PATTERN);
  const email = match?.[1]?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  return email;
}

function sendPolicyAllowsEmail(email: string, sendTo: string[]): boolean {
  if (sendTo.length === 0) return true;
  const normalizedEmail = email.toLowerCase();
  return sendTo.some((entry) => {
    const normalizedEntry = entry.trim().toLowerCase();
    return normalizedEntry === normalizedEmail || (normalizedEntry.startsWith('@') && normalizedEmail.endsWith(normalizedEntry));
  });
}

function sanitizeEmailHtml(value: string) {
  const sanitized = DOMPurify.sanitize(value, EMAIL_HTML_SANITIZE_CONFIG);
  if (typeof document === 'undefined') return sanitized;

  const template = document.createElement('template');
  template.innerHTML = sanitized;

  template.content.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim() || '';
    if (!/^(https?:|mailto:)/i.test(href)) {
      anchor.removeAttribute('href');
      return;
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });

  template.content.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src')?.trim() || '';
    if (!/^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(src)) {
      image.remove();
    }
  });

  if (!template.content.textContent?.trim() && !template.content.querySelector('img')) {
    return '';
  }

  return template.innerHTML;
}

function EmailMessageBody({ message, emptyText }: { message: EmailMessageDetail; emptyText: string }) {
  const sanitizedHtml = useMemo(
    () => message.bodyHtml ? sanitizeEmailHtml(message.bodyHtml) : '',
    [message.bodyHtml],
  );

  if (sanitizedHtml.trim()) {
    return (
      <div
        className="min-w-0 overflow-x-auto break-words text-sm leading-6 text-foreground [&_*]:max-w-full [&_a]:break-words [&_a]:font-medium [&_a]:text-primary [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-border [&_ol]:ml-5 [&_ol]:list-decimal [&_p]:mb-3 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2 [&_ul]:ml-5 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    );
  }

  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
      {message.body || message.snippet || emptyText}
    </pre>
  );
}

type EmailMessageViewerLabels = {
  aiReply: string;
  aiSummary: string;
  archive: string;
  attachments: string;
  cc: string;
  clearDone: string;
  date: string;
  emptyBody: string;
  forward: string;
  from: string;
  loadingMessage: string;
  markDone: string;
  markRead: string;
  markUnread: string;
  moveTo: string;
  noSubject: string;
  permanentDelete: string;
  reply: string;
  replyAll: string;
  replyOptions: string;
  selectMessage: string;
  summary: string;
  to: string;
  trash: string;
  unknownAttachmentType: string;
};

type EmailMessageActionName =
  | 'archive'
  | 'ai-reply'
  | 'clear-answered'
  | 'draft-forward'
  | 'draft-reply'
  | 'draft-reply-all'
  | 'mark-answered'
  | 'mark-read'
  | 'mark-unread'
  | 'move'
  | 'permanent-delete'
  | 'summary'
  | 'trash';

type EmailMessageViewerActions = {
  activeAction: EmailMessageActionName | null;
  folders: EmailFolder[];
  onAction(action: EmailMessageActionName, destination?: string): void;
};

function EmailReplySplitButton({
  actions,
  labels,
}: {
  actions: EmailMessageViewerActions;
  labels: Pick<EmailMessageViewerLabels, 'reply' | 'replyAll' | 'replyOptions'>;
}) {
  const isBusy = Boolean(actions.activeAction);
  const isReplyBusy = actions.activeAction === 'draft-reply';
  const isReplyAllBusy = actions.activeAction === 'draft-reply-all';

  return (
    <DropdownMenu modal={false}>
      <div className="inline-flex shrink-0 overflow-hidden rounded-md">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-r-none"
          disabled={isBusy}
          onClick={() => actions.onAction('draft-reply-all')}
          title={labels.replyAll}
        >
          {isReplyAllBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ReplyAll className="h-4 w-4" />}
          {labels.replyAll}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            className="h-8 w-7 rounded-l-none border-l border-border/70 px-0"
            disabled={isBusy}
            aria-label={labels.replyOptions}
            title={labels.replyOptions}
          >
            {isReplyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" sideOffset={8} className="w-44">
        <DropdownMenuItem onSelect={() => actions.onAction('draft-reply')}>
          <Reply className="h-4 w-4" />
          {labels.reply}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmailMessageViewer({
  actions,
  className,
  isLoading,
  labels,
  message,
  summary,
}: {
  actions?: EmailMessageViewerActions;
  className?: string;
  isLoading: boolean;
  labels: EmailMessageViewerLabels;
  message: EmailMessageDetail | null;
  summary?: string;
}) {
  if (isLoading) {
    return (
      <div className={cn('flex h-full min-h-80 items-center justify-center text-sm text-muted-foreground', className)}>
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {labels.loadingMessage}
      </div>
    );
  }

  if (!message) {
    return (
      <div className={cn('flex h-full min-h-80 items-center justify-center px-6 text-center text-sm text-muted-foreground', className)}>
        {labels.selectMessage}
      </div>
    );
  }

  return (
    <article className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className="border-b border-border px-4 py-4 pr-12">
        <h3 className="text-lg font-semibold leading-7">{message.subject || labels.noSubject}</h3>
        <div className="mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">{labels.from}:</span> {message.from}</p>
          {formatRecipients(message.to) && <p><span className="font-medium text-foreground">{labels.to}:</span> {formatRecipients(message.to)}</p>}
          {formatRecipients(message.cc) && <p><span className="font-medium text-foreground">{labels.cc}:</span> {formatRecipients(message.cc)}</p>}
          {message.date && <p><span className="font-medium text-foreground">{labels.date}:</span> {formatDate(message.date)}</p>}
        </div>
        {actions && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <EmailReplySplitButton actions={actions} labels={labels} />
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('draft-forward')} title={labels.forward}>
              {actions.activeAction === 'draft-forward' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Forward className="h-4 w-4" />}
              {labels.forward}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('summary')} title={labels.summary}>
              {actions.activeAction === 'summary' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {labels.summary}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('ai-reply')} title={labels.aiReply}>
              {actions.activeAction === 'ai-reply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {labels.aiReply}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(actions.activeAction)}
              onClick={() => actions.onAction(message.isRead ? 'mark-unread' : 'mark-read')}
              title={message.isRead ? labels.markUnread : labels.markRead}
            >
              {actions.activeAction === 'mark-read' || actions.activeAction === 'mark-unread'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : message.isRead ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
              {message.isRead ? labels.markUnread : labels.markRead}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={Boolean(actions.activeAction)}
              onClick={() => actions.onAction(message.isAnswered ? 'clear-answered' : 'mark-answered')}
              title={message.isAnswered ? labels.clearDone : labels.markDone}
            >
              {actions.activeAction === 'mark-answered' || actions.activeAction === 'clear-answered'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : message.isAnswered ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              {message.isAnswered ? labels.clearDone : labels.markDone}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('archive')} title={labels.archive}>
              {actions.activeAction === 'archive' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
              {labels.archive}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('trash')} title={labels.trash}>
              {actions.activeAction === 'trash' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {labels.trash}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('permanent-delete')} title={labels.permanentDelete}>
              {actions.activeAction === 'permanent-delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              {labels.permanentDelete}
            </Button>
            <label className="sr-only" htmlFor={`email-message-move-${message.id}`}>{labels.moveTo}</label>
            <select
              id={`email-message-move-${message.id}`}
              className="h-8 max-w-full border border-input bg-background px-2 text-sm"
              defaultValue=""
              disabled={Boolean(actions.activeAction)}
              onChange={(event) => {
                const destination = event.target.value;
                event.target.value = '';
                if (destination) actions.onAction('move', destination);
              }}
            >
              <option value="">{labels.moveTo}</option>
              {actions.folders.filter((folder) => folder.selectable !== false && folder.path !== message.folder).map((folder) => (
                <option key={folder.path} value={folder.path}>{folder.name}</option>
              ))}
            </select>
          </div>
        )}
        {summary && (
          <div className="mt-4 border border-primary/25 bg-primary/5 px-3 py-2 text-sm leading-6">
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{labels.aiSummary}</div>
            <p className="whitespace-pre-wrap">{summary}</p>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <EmailMessageBody message={message} emptyText={labels.emptyBody} />
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-5 border-t border-border pt-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{labels.attachments}</div>
            <div className="mt-2 flex flex-col gap-2">
              {message.attachments.map((attachment) => (
                <div key={attachment.filename} className="border border-border px-3 py-2 text-sm">
                  <div className="font-medium">{attachment.filename}</div>
                  <div className="text-xs text-muted-foreground">{attachment.contentType || labels.unknownAttachmentType}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export function EmailClient() {
  const t = useTranslations('emails');
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState('');
  const [folders, setFolders] = useState<EmailFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState('INBOX');
  const [messages, setMessages] = useState<EmailMessageSummary[]>([]);
  const [messageTotal, setMessageTotal] = useState<number | null>(null);
  const [messagePage, setMessagePage] = useState(0);
  const [selectedMessageId, setSelectedMessageId] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<EmailMessageDetail | null>(null);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [messageDialogOpen, setMessageDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingMessage, setIsLoadingMessage] = useState(false);
  const [activeMessageAction, setActiveMessageAction] = useState<EmailMessageActionName | null>(null);
  const [isAddingSendPolicyRecipient, setIsAddingSendPolicyRecipient] = useState(false);
  const [messageActionNotice, setMessageActionNotice] = useState<string | null>(null);
  const [messageSummary, setMessageSummary] = useState('');
  const [error, setError] = useState<string | null>(null);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) || accounts[0] || null,
    [accounts, activeAccountId],
  );
  const canReadActiveAccount = Boolean(activeAccount && (activeAccount.authType !== 'smtp_imap' || activeAccount.imapHost));
  const blockedSendPolicyRecipient = useMemo(() => extractBlockedSendPolicyRecipient(error), [error]);
  const canAddBlockedSendPolicyRecipient = Boolean(
    activeAccount
    && blockedSendPolicyRecipient
    && !sendPolicyAllowsEmail(blockedSendPolicyRecipient, activeAccount.policy?.sendTo || []),
  );

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

  const selectAccount = (accountId: string) => {
    setActiveAccountId(accountId);
    setMessagePage(0);
  };

  const selectFolder = (folder: string) => {
    setActiveFolder(folder);
    setMessagePage(0);
  };

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
          limit: MESSAGE_PAGE_SIZE,
          offset: messagePage * MESSAGE_PAGE_SIZE,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.loadMessages'));
      const nextMessages = (payload.data?.messages || []) as EmailMessageSummary[];
      setMessages(nextMessages);
      setMessageTotal(typeof payload.data?.total === 'number' ? payload.data.total : null);
      setSelectedMessageId((current) => current && nextMessages.some((message) => message.id === current) ? current : '');
      setSelectedMessage(null);
      setMessageActionNotice(null);
      setMessageSummary('');
      setMessageDialogOpen(false);
    } catch (loadError) {
      setMessages([]);
      setMessageTotal(null);
      setSelectedMessage(null);
      setMessageActionNotice(null);
      setMessageSummary('');
      setMessageDialogOpen(false);
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessages'));
    } finally {
      setIsLoadingMessages(false);
    }
  }, [activeAccount, activeFolder, canReadActiveAccount, messagePage, submittedQuery, t]);

  const loadMessage = useCallback(async (message: EmailMessageSummary) => {
    if (!activeAccount) return;
    setSelectedMessageId(message.id);
    setIsLoadingMessage(true);
    setError(null);
    setMessageActionNotice(null);
    setMessageSummary('');
    if (isCompactViewport) setMessageDialogOpen(true);
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
      setMessageDialogOpen(false);
      setError(loadError instanceof Error ? loadError.message : t('errors.loadMessage'));
    } finally {
      setIsLoadingMessage(false);
    }
  }, [activeAccount, activeFolder, isCompactViewport, t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadAccounts();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAccounts]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const updateViewport = () => {
      setIsCompactViewport(mediaQuery.matches);
      if (!mediaQuery.matches) {
        setMessageDialogOpen(false);
      }
    };

    updateViewport();
    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setFolders([]);
      setMessages([]);
      setMessageTotal(null);
      setSelectedMessage(null);
      setSelectedMessageId('');
      setMessageActionNotice(null);
      setMessageSummary('');
      setMessageDialogOpen(false);
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
    setMessagePage(0);
    setSubmittedQuery(query.trim());
  };

  const addBlockedRecipientToSendPolicy = useCallback(async () => {
    if (!activeAccount || !blockedSendPolicyRecipient) return;
    const currentSendTo = activeAccount.policy?.sendTo || [];
    const nextSendTo = Array.from(new Set([...currentSendTo, blockedSendPolicyRecipient]));
    setIsAddingSendPolicyRecipient(true);
    setMessageActionNotice(null);

    try {
      const response = await fetch(`/api/email/accounts/${encodeURIComponent(activeAccount.id)}/policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sendTo: nextSendTo }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updatePolicy'));
      const updatedAccount = payload.data as EmailAccount | undefined;
      setAccounts((current) => current.map((account) => (
        account.id === activeAccount.id
          ? updatedAccount || { ...account, policy: { ...account.policy, sendTo: nextSendTo } }
          : account
      )));
      setError(null);
      setMessageActionNotice(t('sendPolicyRecipientAdded', { email: blockedSendPolicyRecipient }));
    } catch (policyError) {
      setError(policyError instanceof Error ? policyError.message : t('errors.updatePolicy'));
    } finally {
      setIsAddingSendPolicyRecipient(false);
    }
  }, [activeAccount, blockedSendPolicyRecipient, t]);

  const handleMessageAction = useCallback(async (action: EmailMessageActionName, destination?: string) => {
    if (!activeAccount || !selectedMessage) return;
    if (action === 'permanent-delete' && !window.confirm(t('confirmPermanentDelete'))) return;

    const folder = selectedMessage.folder || activeFolder;
    const endpointBase = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/${encodeURIComponent(selectedMessage.id)}`;
    setActiveMessageAction(action);
    setMessageActionNotice(null);
    setError(null);

    try {
      let response: Response;
      if (action === 'summary') {
        response = await fetch(`${endpointBase}/summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ folder }),
        });
      } else if (action === 'ai-reply') {
        response = await fetch(`${endpointBase}/ai-reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ folder }),
        });
      } else if (action === 'draft-reply' || action === 'draft-reply-all' || action === 'draft-forward') {
        const mode = action === 'draft-forward' ? 'forward' : action === 'draft-reply-all' ? 'reply-all' : 'reply';
        response = await fetch(`${endpointBase}/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ folder, mode }),
        });
      } else {
        response = await fetch(`${endpointBase}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action, destination, folder }),
        });
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));

      if (action === 'summary') {
        setMessageSummary(String(payload.data?.summary || ''));
        return;
      }

      if (action === 'ai-reply') {
        setMessageActionNotice(t('aiReplyDraftCreated'));
        return;
      }

      if (action === 'draft-reply' || action === 'draft-reply-all' || action === 'draft-forward') {
        setMessageActionNotice(t('draftCreated'));
        return;
      }

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
      setSelectedMessage(null);
      setSelectedMessageId('');
      setMessageSummary('');
      setMessageDialogOpen(false);
      setMessageActionNotice(t('messageMoved'));
      void loadFolders(activeAccount.id);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('errors.updateMessage'));
    } finally {
      setActiveMessageAction(null);
    }
  }, [activeAccount, activeFolder, loadFolders, selectedMessage, t]);

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
  const messageViewerLabels = {
    aiReply: t('aiReply'),
    aiSummary: t('aiSummary'),
    archive: t('archive'),
    attachments: t('attachments'),
    cc: t('cc'),
    clearDone: t('clearDone'),
    date: t('date'),
    emptyBody: t('emptyBody'),
    forward: t('forward'),
    from: t('from'),
    loadingMessage: t('loadingMessage'),
    markDone: t('markDone'),
    markRead: t('markRead'),
    markUnread: t('markUnread'),
    moveTo: t('moveTo'),
    noSubject: t('noSubject'),
    permanentDelete: t('permanentDelete'),
    reply: t('reply'),
    replyAll: t('replyAll'),
    replyOptions: t('replyOptions'),
    selectMessage: t('selectMessage'),
    summary: t('summary'),
    to: t('to'),
    trash: t('trash'),
    unknownAttachmentType: t('unknownAttachmentType'),
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
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
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
        <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} onAccountsChanged={loadAccounts} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-3 overflow-y-auto px-3 py-3 sm:px-6 sm:py-5 lg:overflow-hidden">
      <section className="shrink-0 flex flex-col gap-3 border border-border bg-card px-3 py-3 sm:px-4">
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
              className="h-10 w-full min-w-0 border border-input bg-background px-3 text-sm sm:min-w-[220px]"
              value={activeAccountId}
              onChange={(event) => selectAccount(event.target.value)}
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
        <div className="flex flex-col gap-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
          <span className="min-w-0 break-words">{error}</span>
          {canAddBlockedSendPolicyRecipient && blockedSendPolicyRecipient && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full border-destructive/40 bg-background text-foreground hover:bg-destructive/10 sm:w-auto"
              onClick={() => void addBlockedRecipientToSendPolicy()}
              disabled={isAddingSendPolicyRecipient}
            >
              {isAddingSendPolicyRecipient ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              {t('addRecipientToSendPolicy', { email: blockedSendPolicyRecipient })}
            </Button>
          )}
        </div>
      )}

      {messageActionNotice && (
        <div className="border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          {messageActionNotice}
        </div>
      )}

      {!canReadActiveAccount ? (
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="flex min-h-80 items-center justify-center border border-border bg-card p-6 text-center">
            <div className="max-w-md space-y-3">
              <MailWarning className="mx-auto h-9 w-9 text-muted-foreground" />
              <h3 className="text-base font-semibold">{t('imapMissingTitle')}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{t('imapMissingDescription')}</p>
            </div>
          </section>
          <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} onAccountsChanged={loadAccounts} />
        </div>
      ) : (
        <div className="grid flex-none gap-3 lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('folders')}
            </div>
            <div className="max-h-44 overflow-y-auto p-2 lg:max-h-none lg:flex-1">
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
                    onClick={() => selectFolder(folder.path)}
                  >
                    <span className="min-w-0 truncate">{folder.name}</span>
                    {folder.unseenCount ? <span className="text-xs font-medium">{folder.unseenCount}</span> : null}
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
            <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t('messages')}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{messageRangeLabel}</div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('previousPage')}
                  onClick={() => setMessagePage((current) => Math.max(0, current - 1))}
                  disabled={!hasPreviousMessagePage || isLoadingMessages}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('nextPage')}
                  onClick={() => setMessagePage((current) => current + 1)}
                  disabled={!hasNextMessagePage || isLoadingMessages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 max-h-[52dvh] overflow-y-auto lg:max-h-none lg:flex-1">
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

          <section className="hidden min-h-0 flex-col overflow-hidden border border-border bg-card lg:flex">
            <EmailMessageViewer
              actions={selectedMessage ? { activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              isLoading={isLoadingMessage}
              labels={messageViewerLabels}
              message={selectedMessage}
              summary={messageSummary}
            />
          </section>
        </div>
      )}

      {canReadActiveAccount && (
        <Dialog open={isCompactViewport && messageDialogOpen} onOpenChange={setMessageDialogOpen}>
          <DialogContent layout="viewport" className="lg:hidden">
            <DialogHeader className="sr-only">
              <DialogTitle>{selectedMessage?.subject || t('noSubject')}</DialogTitle>
              <DialogDescription>
                {selectedMessage ? `${t('from')}: ${selectedMessage.from}` : t('loadingMessage')}
              </DialogDescription>
            </DialogHeader>
            <EmailMessageViewer
              actions={selectedMessage ? { activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              className="bg-card"
              isLoading={isLoadingMessage}
              labels={messageViewerLabels}
              message={selectedMessage}
              summary={messageSummary}
            />
          </DialogContent>
        </Dialog>
      )}

      {canReadActiveAccount && (
        <EmailAccountsCard isOpen={accountsOpen} onOpenChange={setAccountsOpen} onAccountsChanged={loadAccounts} />
      )}
    </div>
  );
}
