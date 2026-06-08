'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Forward,
  FolderInput,
  Image as ImageIcon,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MailWarning,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Sparkles,
  Star,
  Settings,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EmailAccountsCard } from '@/app/components/settings/IntegrationsSettingsClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

type EmailComposeMode = 'forward' | 'reply' | 'reply-all';

type EmailComposeDraft = {
  aiGenerated?: boolean;
  body: string;
  ccText: string;
  folder: string;
  message: EmailMessageDetail;
  mode: EmailComposeMode;
  subject: string;
  toText: string;
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
    'body',
    'br',
    'caption',
    'center',
    'code',
    'col',
    'colgroup',
    'dd',
    'del',
    'div',
    'dl',
    'dt',
    'em',
    'font',
    'head',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'html',
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
    'style',
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
    'bgcolor',
    'border',
    'cellpadding',
    'cellspacing',
    'class',
    'colspan',
    'dir',
    'face',
    'height',
    'href',
    'id',
    'lang',
    'rel',
    'role',
    'rowspan',
    'scope',
    'src',
    'style',
    'target',
    'title',
    'valign',
    'width',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ['ping', 'srcset'],
  FORBID_TAGS: ['base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'math', 'meta', 'object', 'script', 'select', 'svg', 'textarea'],
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

function extractEmailAddressForCompose(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = value.match(/<([^<>@\s]+@[^<>@\s]+)>/u) || value.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu);
    return (match?.[1] || '').trim().toLowerCase();
  }
  if (typeof value === 'object') {
    const record = value as {
      address?: unknown;
      email?: unknown;
      emailAddress?: { address?: unknown };
    };
    return extractEmailAddressForCompose(record.emailAddress?.address || record.address || record.email);
  }
  return '';
}

function splitRecipientInput(value: string): string[] {
  return value
    .split(/[,\n;]/u)
    .map((entry) => extractEmailAddressForCompose(entry) || entry.trim())
    .filter(Boolean);
}

function extractRecipientEmailsForCompose(value: string[] | string | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(extractRecipientEmailsForCompose);
  return splitRecipientInput(value);
}

function uniqueComposeRecipients(values: string[], ownAddresses = new Set<string>()): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const value of values) {
    const email = extractEmailAddressForCompose(value);
    if (!email || ownAddresses.has(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push(email);
  }
  return recipients;
}

function composeRecipientText(values: string[]) {
  return values.join(', ');
}

function replySubjectForCompose(subject: string) {
  const normalized = subject.trim();
  if (!normalized) return 'Re:';
  return /^re:/iu.test(normalized) ? normalized : `Re: ${normalized}`;
}

function forwardSubjectForCompose(subject: string) {
  const normalized = subject.trim();
  if (!normalized) return 'Fwd:';
  return /^(fwd|fw):/iu.test(normalized) ? normalized : `Fwd: ${normalized}`;
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

function isFetchNetworkError(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch|fetch failed|networkerror/iu.test(error.message);
}

function sanitizeEmailCss(value: string, allowRemoteResources: boolean) {
  let blockedRemoteResources = false;
  let css = value
    .replace(/@import[^;]+;/giu, '')
    .replace(/expression\s*\([^)]*\)/giu, '')
    .replace(/javascript\s*:/giu, '')
    .replace(/vbscript\s*:/giu, '');

  css = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (match, _quote: string, rawUrl: string) => {
    const url = rawUrl.trim();
    if (/^data:image\/(?:gif|jpe?g|png|webp);base64,/iu.test(url)) return `url("${url}")`;
    if (/^https?:\/\//iu.test(url)) {
      blockedRemoteResources = true;
      return allowRemoteResources ? `url("${url}")` : 'none';
    }
    return 'none';
  });

  return { blockedRemoteResources, css };
}

function extractEmailStyleBlocks(value: string, allowRemoteResources: boolean) {
  const styles: string[] = [];
  let blockedRemoteResources = false;
  const html = value.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/giu, (_match, rawCss: string) => {
    const result = sanitizeEmailCss(rawCss, allowRemoteResources);
    blockedRemoteResources = blockedRemoteResources || result.blockedRemoteResources;
    const css = result.css.replace(/<\/style/giu, '<\\/style').trim();
    if (css) styles.push(`<style>${css}</style>`);
    return '';
  });

  return { blockedRemoteResources, html, styleHtml: styles.join('\n') };
}

function buildEmailPreviewDocument(html: string) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base target="_blank">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #111827;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 14px;
    line-height: 1.45;
  }
  body {
    overflow-wrap: anywhere;
    word-break: normal;
  }
  * {
    box-sizing: border-box;
    max-width: 100%;
  }
  img {
    max-width: 100%;
    height: auto;
  }
  table {
    max-width: 100%;
    border-collapse: separate;
  }
  pre {
    white-space: pre-wrap;
  }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

function sanitizeEmailHtml(value: string, allowRemoteResources: boolean) {
  const extractedStyles = extractEmailStyleBlocks(value, allowRemoteResources);
  const sanitized = DOMPurify.sanitize(extractedStyles.html, EMAIL_HTML_SANITIZE_CONFIG);
  if (typeof document === 'undefined') return { blockedRemoteResources: false, html: sanitized };

  const template = document.createElement('template');
  template.innerHTML = sanitized;
  let blockedRemoteResources = extractedStyles.blockedRemoteResources;

  template.content.querySelectorAll('a').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim() || '';
    if (!/^(https?:|mailto:)/i.test(href)) {
      anchor.removeAttribute('href');
      return;
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });

  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const result = sanitizeEmailCss(element.getAttribute('style') || '', allowRemoteResources);
    blockedRemoteResources = blockedRemoteResources || result.blockedRemoteResources;
    if (result.css.trim()) {
      element.setAttribute('style', result.css);
    } else {
      element.removeAttribute('style');
    }
  });

  template.content.querySelectorAll('style').forEach((style) => {
    const result = sanitizeEmailCss(style.textContent || '', allowRemoteResources);
    blockedRemoteResources = blockedRemoteResources || result.blockedRemoteResources;
    if (result.css.trim()) {
      style.textContent = result.css;
    } else {
      style.remove();
    }
  });

  template.content.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src')?.trim() || '';
    if (/^data:image\/(?:gif|jpe?g|png|webp);base64,/iu.test(src)) {
      return;
    }
    if (/^https?:\/\//iu.test(src)) {
      blockedRemoteResources = true;
      if (allowRemoteResources) {
        image.setAttribute('referrerpolicy', 'no-referrer');
        image.setAttribute('loading', 'lazy');
        return;
      }
      image.remove();
      return;
    }
    image.remove();
  });

  if (!template.content.textContent?.trim() && !template.content.querySelector('img')) {
    return { blockedRemoteResources, html: '' };
  }

  return { blockedRemoteResources, html: [extractedStyles.styleHtml, template.innerHTML].filter(Boolean).join('\n') };
}

function EmailMessageBody({
  allowRemoteResourcesByDefault,
  allowedRemoteResourceSenders,
  message,
  onAllowRemoteResourcesForSender,
  remoteImagesBlockedText,
  showRemoteImagesText,
  emptyText,
}: {
  allowRemoteResourcesByDefault: boolean;
  allowedRemoteResourceSenders: string[];
  message: EmailMessageDetail;
  onAllowRemoteResourcesForSender(sender: string): void;
  remoteImagesBlockedText: string;
  showRemoteImagesText: string;
  emptyText: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const messageKey = `${message.id}:${message.bodyHtml?.length || 0}`;
  const senderEmail = extractEmailAddressForCompose(message.from);
  const [remoteResourceState, setRemoteResourceState] = useState({ allow: false, messageKey: '' });
  const [iframeLayout, setIframeLayout] = useState({ height: 360, messageKey: '' });
  const senderAllowsRemoteResources = Boolean(senderEmail && allowedRemoteResourceSenders.includes(senderEmail));
  const allowRemoteResources = allowRemoteResourcesByDefault
    || senderAllowsRemoteResources
    || (remoteResourceState.messageKey === messageKey && remoteResourceState.allow);
  const iframeHeight = iframeLayout.messageKey === messageKey ? iframeLayout.height : 360;
  const sanitized = useMemo(
    () => message.bodyHtml ? sanitizeEmailHtml(message.bodyHtml, allowRemoteResources) : { blockedRemoteResources: false, html: '' },
    [allowRemoteResources, message.bodyHtml],
  );
  const srcDoc = useMemo(() => buildEmailPreviewDocument(sanitized.html), [sanitized.html]);

  const resizeIframe = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const contentHeight = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
    const nextHeight = Math.max(240, Math.min(2400, contentHeight));
    setIframeLayout({ height: nextHeight, messageKey });
  }, [messageKey, setIframeLayout]);

  const allowRemoteResourcesForMessage = useCallback(() => {
    setRemoteResourceState({ allow: true, messageKey });
    if (senderEmail) onAllowRemoteResourcesForSender(senderEmail);
  }, [messageKey, onAllowRemoteResourcesForSender, senderEmail, setRemoteResourceState]);

  if (sanitized.html.trim()) {
    return (
      <div className="min-w-0">
        {sanitized.blockedRemoteResources && !allowRemoteResources && (
          <div className="mb-3 flex flex-col gap-2 border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span className="flex min-w-0 items-center gap-2">
              <ImageIcon className="h-4 w-4 shrink-0" />
              {remoteImagesBlockedText}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={allowRemoteResourcesForMessage}
            >
              {showRemoteImagesText}
            </Button>
          </div>
        )}
        <iframe
          ref={iframeRef}
          className="block w-full overflow-hidden border-0 bg-white"
          referrerPolicy="no-referrer"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          srcDoc={srcDoc}
          style={{ height: iframeHeight }}
          title={message.subject || 'Email content'}
          onLoad={resizeIframe}
        />
      </div>
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
  cancel: string;
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
  messageOptions: string;
  moveTo: string;
  noFolders: string;
  noSubject: string;
  permanentDelete: string;
  remoteImagesBlocked: string;
  reply: string;
  replyAll: string;
  replyOptions: string;
  selectMessage: string;
  showRemoteImages: string;
  summary: string;
  to: string;
  trash: string;
  unknownAttachmentType: string;
};

type EmailComposeDialogLabels = Pick<EmailMessageViewerLabels, 'cc' | 'date' | 'emptyBody' | 'from' | 'noSubject' | 'remoteImagesBlocked' | 'showRemoteImages' | 'to'> & {
  addRecipientToSendPolicy(email: string): string;
  cancel: string;
  composeAiReplyTitle: string;
  composeBodyLabel: string;
  composeBodyPlaceholder: string;
  composeDescription: string;
  composeForwardTitle: string;
  composeOriginalTitle: string;
  composeReplyAllTitle: string;
  composeReplyTitle: string;
  composeSend: string;
  composeSending: string;
  subject: string;
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

type EmailMessageListActionName = 'archive' | 'mark-read' | 'mark-unread' | 'move' | 'permanent-delete' | 'trash';

type EmailMessageListActionState = {
  action: EmailMessageListActionName;
  messageId: string;
} | null;

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

function EmailAiSplitButton({
  actions,
  labels,
}: {
  actions: EmailMessageViewerActions;
  labels: Pick<EmailMessageViewerLabels, 'aiReply' | 'aiSummary' | 'summary'>;
}) {
  const isBusy = Boolean(actions.activeAction);
  const isAiReplyBusy = actions.activeAction === 'ai-reply';
  const isSummaryBusy = actions.activeAction === 'summary';

  return (
    <DropdownMenu modal={false}>
      <div className="inline-flex shrink-0 overflow-hidden rounded-md">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-r-none"
          disabled={isBusy}
          onClick={() => actions.onAction('ai-reply')}
          title={labels.aiReply}
        >
          {isAiReplyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {labels.aiReply}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            className="h-8 w-7 rounded-l-none border-l border-border/70 px-0"
            disabled={isBusy}
            aria-label={labels.aiSummary}
            title={labels.aiSummary}
          >
            {isSummaryBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" sideOffset={8} className="w-44">
        <DropdownMenuItem onSelect={() => actions.onAction('summary')}>
          <Sparkles className="h-4 w-4" />
          {labels.summary}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmailMessageRowActions({
  activeAction,
  folders,
  labels,
  message,
  onAction,
}: {
  activeAction: EmailMessageListActionState;
  folders: EmailFolder[];
  labels: Pick<EmailMessageViewerLabels, 'archive' | 'cancel' | 'markRead' | 'markUnread' | 'moveTo' | 'noFolders' | 'permanentDelete' | 'trash'> & { messageOptions: string };
  message: EmailMessageSummary;
  onAction(message: EmailMessageSummary, action: EmailMessageListActionName, destination?: string): void;
}) {
  const [isMoveOpen, setIsMoveOpen] = useState(false);
  const isBusy = activeAction?.messageId === message.id;
  const isArchiveBusy = isBusy && activeAction?.action === 'archive';
  const isMoveBusy = isBusy && activeAction?.action === 'move';
  const isReadBusy = isBusy && (activeAction?.action === 'mark-read' || activeAction?.action === 'mark-unread');
  const isTrashBusy = isBusy && activeAction?.action === 'trash';
  const isPermanentDeleteBusy = isBusy && activeAction?.action === 'permanent-delete';
  const readAction = message.isRead ? 'mark-unread' : 'mark-read';
  const readLabel = message.isRead ? labels.markUnread : labels.markRead;
  const selectableFolders = folders.filter((folder) => folder.selectable !== false && folder.path !== message.folder);

  return (
    <>
      <DropdownMenu modal={false}>
        <div className="inline-flex overflow-hidden rounded-md border border-transparent bg-background/70 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-8 w-8 rounded-r-none"
            disabled={isBusy}
            aria-label={labels.trash}
            title={labels.trash}
            onClick={() => onAction(message, 'trash')}
          >
            {isTrashBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="h-8 w-7 rounded-l-none border-l border-border/70 px-0"
              disabled={isBusy}
              aria-label={labels.messageOptions}
              title={labels.messageOptions}
            >
              {isArchiveBusy || isMoveBusy || isReadBusy || isPermanentDeleteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent align="end" sideOffset={8} className="w-48">
          <DropdownMenuItem onSelect={() => onAction(message, 'archive')}>
            <Archive className="h-4 w-4" />
            {labels.archive}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIsMoveOpen(true)}>
            <FolderInput className="h-4 w-4" />
            {labels.moveTo}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction(message, readAction)}>
            {message.isRead ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
            {readLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction(message, 'permanent-delete')} className="text-destructive focus:text-destructive">
            <XCircle className="h-4 w-4" />
            {labels.permanentDelete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isMoveOpen} onOpenChange={setIsMoveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-base">{labels.moveTo}</DialogTitle>
            <DialogDescription className="truncate text-sm">{message.subject}</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto border border-border">
            {selectableFolders.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">{labels.noFolders}</div>
            ) : (
              selectableFolders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted"
                  disabled={isBusy}
                  onClick={() => {
                    setIsMoveOpen(false);
                    onAction(message, 'move', folder.path);
                  }}
                >
                  <span className="min-w-0 truncate">{folder.name}</span>
                  {folder.unseenCount ? <span className="shrink-0 text-xs text-muted-foreground">{folder.unseenCount}</span> : null}
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsMoveOpen(false)}>
              {labels.cancel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EmailMessageViewer({
  actions,
  allowRemoteResourcesByDefault,
  allowedRemoteResourceSenders,
  className,
  isLoading,
  labels,
  message,
  onAllowRemoteResourcesForSender,
  summary,
}: {
  actions?: EmailMessageViewerActions;
  allowRemoteResourcesByDefault: boolean;
  allowedRemoteResourceSenders: string[];
  className?: string;
  isLoading: boolean;
  labels: EmailMessageViewerLabels;
  message: EmailMessageDetail | null;
  onAllowRemoteResourcesForSender(sender: string): void;
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
    <article className={cn('h-full min-h-0 overflow-y-auto', className)}>
      <header className="border-b border-border px-3 py-2.5 pr-10 sm:px-4">
        <h3 className="text-base font-semibold leading-6 sm:text-lg sm:leading-7">{message.subject || labels.noSubject}</h3>
        <div className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground sm:text-sm">
          <p><span className="font-medium text-foreground">{labels.from}:</span> {message.from}</p>
          {formatRecipients(message.to) && <p><span className="font-medium text-foreground">{labels.to}:</span> {formatRecipients(message.to)}</p>}
          {formatRecipients(message.cc) && <p><span className="font-medium text-foreground">{labels.cc}:</span> {formatRecipients(message.cc)}</p>}
          {message.date && <p><span className="font-medium text-foreground">{labels.date}:</span> {formatDate(message.date)}</p>}
        </div>
        {actions && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2.5">
            <EmailReplySplitButton actions={actions} labels={labels} />
            <Button type="button" size="sm" variant="outline" disabled={Boolean(actions.activeAction)} onClick={() => actions.onAction('draft-forward')} title={labels.forward}>
              {actions.activeAction === 'draft-forward' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Forward className="h-4 w-4" />}
              {labels.forward}
            </Button>
            <EmailAiSplitButton actions={actions} labels={labels} />
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
          <div className="mt-3 border border-primary/25 bg-primary/5 px-3 py-2 text-sm leading-6">
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{labels.aiSummary}</div>
            <p className="whitespace-pre-wrap">{summary}</p>
          </div>
        )}
      </header>
      <div className="px-4 py-4">
        <EmailMessageBody
          allowRemoteResourcesByDefault={allowRemoteResourcesByDefault}
          allowedRemoteResourceSenders={allowedRemoteResourceSenders}
          message={message}
          onAllowRemoteResourcesForSender={onAllowRemoteResourcesForSender}
          emptyText={labels.emptyBody}
          remoteImagesBlockedText={labels.remoteImagesBlocked}
          showRemoteImagesText={labels.showRemoteImages}
        />
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

function composeDialogTitle(draft: EmailComposeDraft, labels: EmailComposeDialogLabels) {
  if (draft.aiGenerated) return labels.composeAiReplyTitle;
  if (draft.mode === 'forward') return labels.composeForwardTitle;
  if (draft.mode === 'reply-all') return labels.composeReplyAllTitle;
  return labels.composeReplyTitle;
}

function EmailComposeDialog({
  allowRemoteResourcesByDefault,
  allowedRemoteResourceSenders,
  draft,
  error,
  isAddingSendPolicyRecipient,
  isSubmitting,
  labels,
  onAddSendPolicyRecipient,
  onAllowRemoteResourcesForSender,
  onClose,
  onSubmit,
  onUpdate,
}: {
  allowRemoteResourcesByDefault: boolean;
  allowedRemoteResourceSenders: string[];
  draft: EmailComposeDraft | null;
  error: string | null;
  isAddingSendPolicyRecipient: boolean;
  isSubmitting: boolean;
  labels: EmailComposeDialogLabels;
  onAddSendPolicyRecipient(email: string): void;
  onAllowRemoteResourcesForSender(sender: string): void;
  onClose(): void;
  onSubmit(): void;
  onUpdate(updates: Partial<Pick<EmailComposeDraft, 'body' | 'ccText' | 'subject' | 'toText'>>): void;
}) {
  const blockedRecipient = useMemo(() => extractBlockedSendPolicyRecipient(error), [error]);

  return (
    <Dialog
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <DialogContent layout="viewport">
        {draft && (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-10 sm:px-5">
              <DialogTitle className="text-base leading-6">{composeDialogTitle(draft, labels)}</DialogTitle>
              <DialogDescription className="text-xs leading-5 sm:text-sm">{labels.composeDescription}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
              <div className="grid min-h-full gap-3 lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]">
                <section className="min-w-0 space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-to">
                      {labels.to}
                    </label>
                    <Input
                      id="email-compose-to"
                      value={draft.toText}
                      onChange={(event) => onUpdate({ toText: event.target.value })}
                      disabled={isSubmitting}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-cc">
                      {labels.cc}
                    </label>
                    <Input
                      id="email-compose-cc"
                      value={draft.ccText}
                      onChange={(event) => onUpdate({ ccText: event.target.value })}
                      disabled={isSubmitting}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-subject">
                      {labels.subject}
                    </label>
                    <Input
                      id="email-compose-subject"
                      value={draft.subject}
                      onChange={(event) => onUpdate({ subject: event.target.value })}
                      disabled={isSubmitting}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-body">
                      {labels.composeBodyLabel}
                    </label>
                    <Textarea
                      id="email-compose-body"
                      value={draft.body}
                      onChange={(event) => onUpdate({ body: event.target.value })}
                      placeholder={labels.composeBodyPlaceholder}
                      className="min-h-52 resize-y"
                      disabled={isSubmitting}
                    />
                  </div>
                  {error && (
                    <div className="space-y-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      <p className="break-words">{error}</p>
                      {blockedRecipient && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full border-destructive/40 bg-background text-foreground hover:bg-destructive/10 sm:w-auto"
                          onClick={() => onAddSendPolicyRecipient(blockedRecipient)}
                          disabled={isAddingSendPolicyRecipient}
                        >
                          {isAddingSendPolicyRecipient ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                          {labels.addRecipientToSendPolicy(blockedRecipient)}
                        </Button>
                      )}
                    </div>
                  )}
                </section>

                <section className="min-w-0 overflow-hidden border border-border bg-card">
                  <div className="border-b border-border px-3 py-3 sm:px-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {labels.composeOriginalTitle}
                    </div>
                    <h3 className="mt-2 truncate text-base font-semibold">{draft.message.subject || labels.noSubject}</h3>
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      <p className="truncate"><span className="font-medium text-foreground">{labels.from}:</span> {draft.message.from}</p>
                      {formatRecipients(draft.message.to) && <p className="truncate"><span className="font-medium text-foreground">{labels.to}:</span> {formatRecipients(draft.message.to)}</p>}
                      {formatRecipients(draft.message.cc) && <p className="truncate"><span className="font-medium text-foreground">{labels.cc}:</span> {formatRecipients(draft.message.cc)}</p>}
                      {draft.message.date && <p className="truncate"><span className="font-medium text-foreground">{labels.date}:</span> {formatDate(draft.message.date)}</p>}
                    </div>
                  </div>
                  <div className="max-h-[42dvh] overflow-y-auto px-3 py-3 sm:px-4 lg:max-h-[calc(100dvh-20rem)]">
                    <EmailMessageBody
                      allowRemoteResourcesByDefault={allowRemoteResourcesByDefault}
                      allowedRemoteResourceSenders={allowedRemoteResourceSenders}
                      message={draft.message}
                      onAllowRemoteResourcesForSender={onAllowRemoteResourcesForSender}
                      emptyText={labels.emptyBody}
                      remoteImagesBlockedText={labels.remoteImagesBlocked}
                      showRemoteImagesText={labels.showRemoteImages}
                    />
                  </div>
                </section>
              </div>
            </div>
            <DialogFooter className="shrink-0 border-t border-border px-4 py-3 sm:px-6">
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                {labels.cancel}
              </Button>
              <Button type="button" onClick={onSubmit} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                {isSubmitting ? labels.composeSending : labels.composeSend}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EmailClient() {
  const t = useTranslations('emails');
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [emailAllowRemoteImages, setEmailAllowRemoteImages] = useState(false);
  const [emailRemoteImageAllowedSenders, setEmailRemoteImageAllowedSenders] = useState<string[]>([]);
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
  const [isFolderSidebarOpen, setIsFolderSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(true);
  const [isLoadingFolders, setIsLoadingFolders] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingMessage, setIsLoadingMessage] = useState(false);
  const [activeMessageAction, setActiveMessageAction] = useState<EmailMessageActionName | null>(null);
  const [activeMessageListAction, setActiveMessageListAction] = useState<EmailMessageListActionState>(null);
  const [isAddingSendPolicyRecipient, setIsAddingSendPolicyRecipient] = useState(false);
  const [composeDraft, setComposeDraft] = useState<EmailComposeDraft | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [isSubmittingCompose, setIsSubmittingCompose] = useState(false);
  const [messageActionNotice, setMessageActionNotice] = useState<string | null>(null);
  const [messageSummary, setMessageSummary] = useState('');
  const [error, setError] = useState<string | null>(null);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) || accounts[0] || null,
    [accounts, activeAccountId],
  );
  const activeFolderName = useMemo(
    () => folders.find((folder) => folder.path === activeFolder)?.name || activeFolder,
    [activeFolder, folders],
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

  const loadMessage = useCallback(async (message: EmailMessageSummary, options?: { openDialog?: boolean }) => {
    if (!activeAccount) return;
    setSelectedMessageId(message.id);
    setIsLoadingMessage(true);
    setError(null);
    setMessageActionNotice(null);
    setMessageSummary('');
    if (isCompactViewport || options?.openDialog) setMessageDialogOpen(true);
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
    const timeout = window.setTimeout(() => {
      void loadEmailPreferences();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadEmailPreferences]);

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

  const addRecipientToSendPolicy = useCallback(async (email: string) => {
    if (!activeAccount || !email) return;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return;
    const currentSendTo = activeAccount.policy?.sendTo || [];
    const nextSendTo = Array.from(new Set([...currentSendTo, normalizedEmail]));
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
      setError((current) => extractBlockedSendPolicyRecipient(current) === normalizedEmail ? null : current);
      setComposeError((current) => extractBlockedSendPolicyRecipient(current) === normalizedEmail ? null : current);
      setMessageActionNotice(t('sendPolicyRecipientAdded', { email: normalizedEmail }));
    } catch (policyError) {
      setError(policyError instanceof Error ? policyError.message : t('errors.updatePolicy'));
    } finally {
      setIsAddingSendPolicyRecipient(false);
    }
  }, [activeAccount, t]);

  const addBlockedRecipientToSendPolicy = useCallback(async () => {
    if (!blockedSendPolicyRecipient) return;
    await addRecipientToSendPolicy(blockedSendPolicyRecipient);
  }, [addRecipientToSendPolicy, blockedSendPolicyRecipient]);

  const buildComposeDraft = useCallback((mode: EmailComposeMode, message: EmailMessageDetail, body = '', aiGenerated = false): EmailComposeDraft => {
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
      body,
      ccText: composeRecipientText(cc),
      folder: message.folder || activeFolder,
      message,
      mode,
      subject,
      toText: composeRecipientText(to),
    };
  }, [accounts, activeFolder]);

  const openComposeDraft = useCallback((mode: EmailComposeMode, message: EmailMessageDetail, body = '', aiGenerated = false) => {
    setComposeError(null);
    setError(null);
    setMessageActionNotice(null);
    setComposeDraft(buildComposeDraft(mode, message, body, aiGenerated));
    setMessageDialogOpen(false);
  }, [buildComposeDraft]);

  const updateComposeDraft = useCallback((updates: Partial<Pick<EmailComposeDraft, 'body' | 'ccText' | 'subject' | 'toText'>>) => {
    setComposeDraft((current) => current ? { ...current, ...updates } : current);
  }, []);

  const closeComposeDialog = useCallback(() => {
    if (isSubmittingCompose) return;
    setComposeDraft(null);
    setComposeError(null);
  }, [isSubmittingCompose]);

  const submitComposeDraft = useCallback(async () => {
    if (!activeAccount || !composeDraft) return;
    setIsSubmittingCompose(true);
    setComposeError(null);
    setError(null);
    setMessageActionNotice(null);

    try {
      const response = await fetch(`/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          bodyOverride: composeDraft.body,
          cc: splitRecipientInput(composeDraft.ccText),
          folder: composeDraft.folder,
          messageId: composeDraft.message.id,
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
  }, [activeAccount, composeDraft, t]);

  const handleMessageAction = useCallback(async (action: EmailMessageActionName, destination?: string) => {
    if (!activeAccount || !selectedMessage) return;
    if (action === 'draft-reply' || action === 'draft-reply-all' || action === 'draft-forward') {
      const mode = action === 'draft-forward' ? 'forward' : action === 'draft-reply-all' ? 'reply-all' : 'reply';
      openComposeDraft(mode, selectedMessage);
      return;
    }
    if (action === 'permanent-delete' && !window.confirm(t('confirmPermanentDelete'))) return;

    const folder = selectedMessage.folder || activeFolder;
    const endpoint = `/api/email/accounts/${encodeURIComponent(activeAccount.id)}/messages/actions`;
    setActiveMessageAction(action);
    setMessageActionNotice(null);
    setError(null);

    try {
      let body: Record<string, unknown>;
      if (action === 'summary') {
        body = { folder, messageId: selectedMessage.id, operation: 'summary' };
      } else if (action === 'ai-reply') {
        body = { folder, messageId: selectedMessage.id, operation: 'ai-reply-preview' };
      } else {
        body = { action, destination, folder, messageId: selectedMessage.id, operation: 'action' };
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.updateMessage'));

      if (action === 'summary') {
        setMessageSummary(String(payload.data?.summary || ''));
        return;
      }

      if (action === 'ai-reply') {
        openComposeDraft('reply', selectedMessage, String(payload.data?.body || ''), true);
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
      setError(isFetchNetworkError(actionError)
        ? t('errors.actionRequest')
        : actionError instanceof Error ? actionError.message : t('errors.updateMessage'));
    } finally {
      setActiveMessageAction(null);
    }
  }, [activeAccount, activeFolder, loadFolders, openComposeDraft, selectedMessage, t]);

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
        setSelectedMessage(null);
        setSelectedMessageId('');
        setMessageSummary('');
        setMessageDialogOpen(false);
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
  }, [activeAccount, activeFolder, loadFolders, selectedMessageId, t]);

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
    cancel: t('composeCancel'),
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
    messageOptions: t('messageOptions'),
    moveTo: t('moveTo'),
    noFolders: t('noFolders'),
    noSubject: t('noSubject'),
    permanentDelete: t('permanentDelete'),
    remoteImagesBlocked: t('remoteImagesBlocked'),
    reply: t('reply'),
    replyAll: t('replyAll'),
    replyOptions: t('replyOptions'),
    selectMessage: t('selectMessage'),
    showRemoteImages: t('showRemoteImages'),
    summary: t('summary'),
    to: t('to'),
    trash: t('trash'),
    unknownAttachmentType: t('unknownAttachmentType'),
  };
  const composeDialogLabels: EmailComposeDialogLabels = {
    addRecipientToSendPolicy: (email: string) => t('addRecipientToSendPolicy', { email }),
    cancel: t('composeCancel'),
    cc: t('cc'),
    composeAiReplyTitle: t('composeAiReplyTitle'),
    composeBodyLabel: t('composeBodyLabel'),
    composeBodyPlaceholder: t('composeBodyPlaceholder'),
    composeDescription: t('composeDescription'),
    composeForwardTitle: t('composeForwardTitle'),
    composeOriginalTitle: t('composeOriginalTitle'),
    composeReplyAllTitle: t('composeReplyAllTitle'),
    composeReplyTitle: t('composeReplyTitle'),
    composeSend: t('composeSend'),
    composeSending: t('composeSending'),
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
        <EmailAccountsCard
          isOpen={accountsOpen}
          onOpenChange={setAccountsOpen}
          onAccountsChanged={loadAccounts}
          onPreviewPreferencesChanged={(preferences) => {
            setEmailAllowRemoteImages(preferences.emailAllowRemoteImages);
            setEmailRemoteImageAllowedSenders(preferences.emailRemoteImageAllowedSenders || []);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-3 overflow-y-auto px-3 py-3 sm:px-6 sm:py-5 lg:overflow-hidden">
      <section className="shrink-0 flex flex-col gap-2 border border-border bg-card px-3 py-2 sm:px-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
              <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold tracking-tight">{t('title')}</h2>
              {activeAccount && (
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">{activeAccount.emailAddress}</span>
                  {activeAccount.isPrimary && (
                    <Badge variant="secondary" className="hidden gap-1 sm:inline-flex">
                      <Star className="h-3 w-3" />
                      {t('mainEmail')}
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" variant="outline" aria-label={t('accountLabel')} title={t('accountLabel')} onClick={() => setAccountsOpen(true)}>
              <Settings className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{t('accountLabel')}</span>
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={t('refresh')}
              title={t('refresh')}
              onClick={() => void loadMessages()}
              disabled={!canReadActiveAccount || isLoadingMessages}
            >
              {isLoadingMessages ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-9"
          />
          <Button type="submit" size="icon-sm" className="h-9 w-9 shrink-0" disabled={!canReadActiveAccount || isLoadingMessages} aria-label={t('search')} title={t('search')}>
            <Search className="h-4 w-4" />
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
            'grid flex-none gap-3 lg:min-h-0 lg:flex-1 lg:overflow-hidden',
            isFolderSidebarOpen
              ? 'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]'
              : 'lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]',
          )}
        >
          {isFolderSidebarOpen && (
            <aside className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="min-w-0 truncate text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {t('folders')}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('hideFolders')}
                  aria-expanded={isFolderSidebarOpen}
                  title={t('hideFolders')}
                  onClick={() => setIsFolderSidebarOpen(false)}
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
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
          )}

          <section className="flex min-h-0 flex-col overflow-hidden border border-border bg-card">
            <div className="flex flex-col gap-2 border-b border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-2">
                {!isFolderSidebarOpen && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('showFolders')}
                    aria-expanded={isFolderSidebarOpen}
                    title={t('showFolders')}
                    onClick={() => setIsFolderSidebarOpen(true)}
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </Button>
                )}
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {t('messages')}
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{messageRangeLabel}</span>
                    {!isFolderSidebarOpen && activeFolderName && (
                      <Badge variant="secondary" className="max-w-full truncate" title={activeFolderName}>
                        {activeFolderName}
                      </Badge>
                    )}
                  </div>
                </div>
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
                  <div
                    key={`${message.folder || activeFolder}:${message.id}`}
                    className={cn(
                      'group/message flex w-full items-stretch border-b border-border transition-colors hover:bg-muted/60',
                      selectedMessageId === message.id && 'bg-primary/10',
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-3 py-3 text-left"
                      onClick={() => void loadMessage(message)}
                      onDoubleClick={() => void loadMessage(message, { openDialog: true })}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 truncate text-sm font-medium">{message.from || t('unknownSender')}</div>
                        <div className="shrink-0 text-[11px] text-muted-foreground">{formatDate(message.date)}</div>
                      </div>
                      <div className="mt-1 truncate text-sm font-semibold">{message.subject || t('noSubject')}</div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{message.snippet}</p>
                    </button>
                    <div className="flex shrink-0 items-start px-2 py-2">
                      <EmailMessageRowActions
                        activeAction={activeMessageListAction}
                        folders={folders}
                        labels={messageViewerLabels}
                        message={message}
                        onAction={handleMessageListAction}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="hidden min-h-0 flex-col overflow-hidden border border-border bg-card lg:flex">
            <EmailMessageViewer
              actions={selectedMessage ? { activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              allowRemoteResourcesByDefault={emailAllowRemoteImages}
              allowedRemoteResourceSenders={emailRemoteImageAllowedSenders}
              isLoading={isLoadingMessage}
              labels={messageViewerLabels}
              message={selectedMessage}
              onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
              summary={messageSummary}
            />
          </section>
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
              actions={selectedMessage ? { activeAction: activeMessageAction, folders, onAction: handleMessageAction } : undefined}
              allowRemoteResourcesByDefault={emailAllowRemoteImages}
              allowedRemoteResourceSenders={emailRemoteImageAllowedSenders}
              className="bg-card"
              isLoading={isLoadingMessage}
              labels={messageViewerLabels}
              message={selectedMessage}
              onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
              summary={messageSummary}
            />
          </DialogContent>
        </Dialog>
      )}

      <EmailComposeDialog
        allowRemoteResourcesByDefault={emailAllowRemoteImages}
        allowedRemoteResourceSenders={emailRemoteImageAllowedSenders}
        draft={composeDraft}
        error={composeError}
        isAddingSendPolicyRecipient={isAddingSendPolicyRecipient}
        isSubmitting={isSubmittingCompose}
        labels={composeDialogLabels}
        onAddSendPolicyRecipient={(email) => void addRecipientToSendPolicy(email)}
        onAllowRemoteResourcesForSender={allowRemoteImagesForSender}
        onClose={closeComposeDialog}
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
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-5">
              <section className="border border-border bg-muted/25 px-3 py-3">
                <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-account-switcher">
                  {t('accountLabel')}
                </label>
                <select
                  id="email-account-switcher"
                  className="mt-2 h-10 w-full min-w-0 border border-input bg-background px-3 text-sm"
                  value={activeAccountId}
                  onChange={(event) => selectAccount(event.target.value)}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.isPrimary ? `${account.emailAddress} (${t('mainEmail')})` : account.emailAddress}
                    </option>
                  ))}
                </select>
              </section>
              <EmailAccountsCard
                isOpen={true}
                onOpenChange={() => undefined}
                onAccountsChanged={loadAccounts}
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
