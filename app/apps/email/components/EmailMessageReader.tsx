'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Archive,
  ChevronDown,
  FolderInput,
  Forward,
  Image as ImageIcon,
  Loader2,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';

import { MarkdownMessage } from '@/app/components/canvas-agent-chat/ChatMarkdownMessage';
import { isLikelyHtmlEmailContent, normalizeEmailHtmlContent } from '@/app/lib/email/html-content';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import { extractEmailAddressForCompose, formatDate, formatRecipients } from './email-client-format';
import type {
  EmailFolder,
  EmailMessageContextMenuPosition,
  EmailMessageDetail,
  EmailMessageListActionName,
  EmailMessageListActionState,
  EmailMessageSummary,
  EmailMessageViewerActions,
  EmailMessageViewerLabels,
} from './email-client-types';

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

  if (typeof document === 'undefined') {
    return { blockedRemoteResources, html: value, styleHtml: '' };
  }

  const template = document.createElement('template');
  template.innerHTML = value;
  template.content.querySelectorAll('style').forEach((style) => {
    const result = sanitizeEmailCss(style.textContent || '', allowRemoteResources);
    blockedRemoteResources = blockedRemoteResources || result.blockedRemoteResources;
    const css = result.css.trim();
    if (css) {
      const nextStyle = document.createElement('style');
      nextStyle.textContent = css;
      styles.push(nextStyle.outerHTML);
    }
    style.remove();
  });

  return { blockedRemoteResources, html: template.innerHTML, styleHtml: styles.join('\n') };
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
  const extractedStyles = extractEmailStyleBlocks(normalizeEmailHtmlContent(value), allowRemoteResources);
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

function emailHtmlForPreview(bodyHtmlValue: string | undefined, bodyValue: string | undefined): string {
  const bodyHtml = normalizeEmailHtmlContent(bodyHtmlValue);
  if (bodyHtml) return bodyHtml;

  const body = bodyValue || '';
  return isLikelyHtmlEmailContent(body) ? normalizeEmailHtmlContent(body) : '';
}

export function EmailMessageBody({
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
  const iframeResizeObserverRef = useRef<ResizeObserver | null>(null);
  const htmlForPreview = useMemo(() => emailHtmlForPreview(message.bodyHtml, message.body), [message.body, message.bodyHtml]);
  const messageKey = `${message.id}:${htmlForPreview.length}:${message.body?.length || 0}`;
  const senderEmail = extractEmailAddressForCompose(message.from);
  const [remoteResourceState, setRemoteResourceState] = useState({ allow: false, messageKey: '' });
  const [iframeLayout, setIframeLayout] = useState({ height: 360, messageKey: '' });
  const senderAllowsRemoteResources = Boolean(senderEmail && allowedRemoteResourceSenders.includes(senderEmail));
  const allowRemoteResources = allowRemoteResourcesByDefault
    || senderAllowsRemoteResources
    || (remoteResourceState.messageKey === messageKey && remoteResourceState.allow);
  const iframeHeight = iframeLayout.messageKey === messageKey ? iframeLayout.height : 360;
  const sanitized = useMemo(
    () => htmlForPreview ? sanitizeEmailHtml(htmlForPreview, allowRemoteResources) : { blockedRemoteResources: false, html: '' },
    [allowRemoteResources, htmlForPreview],
  );
  const srcDoc = useMemo(() => buildEmailPreviewDocument(sanitized.html), [sanitized.html]);

  const resizeIframe = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const contentHeight = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0);
    const nextHeight = Math.max(240, Math.ceil(contentHeight));
    setIframeLayout((current) => (
      current.messageKey === messageKey && current.height === nextHeight
        ? current
        : { height: nextHeight, messageKey }
    ));
  }, [messageKey, setIframeLayout]);

  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    iframeResizeObserverRef.current?.disconnect();
    resizeIframe();

    const ResizeObserverConstructor = doc.defaultView?.ResizeObserver;
    if (!ResizeObserverConstructor || !doc.body) return;

    const observer = new ResizeObserverConstructor(resizeIframe);
    observer.observe(doc.documentElement);
    observer.observe(doc.body);
    iframeResizeObserverRef.current = observer;
  }, [resizeIframe]);

  useEffect(() => () => {
    iframeResizeObserverRef.current?.disconnect();
    iframeResizeObserverRef.current = null;
  }, [srcDoc]);

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
          onLoad={handleIframeLoad}
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

export function EmailMessageRowActions({
  activeAction,
  contextMenuPosition,
  folders,
  labels,
  message,
  onAction,
  onCloseContextMenu,
}: {
  activeAction: EmailMessageListActionState;
  contextMenuPosition: EmailMessageContextMenuPosition | null;
  folders: EmailFolder[];
  labels: Pick<EmailMessageViewerLabels, 'archive' | 'cancel' | 'markRead' | 'markUnread' | 'moveTo' | 'noFolders' | 'permanentDelete' | 'trash'> & { messageOptions: string };
  message: EmailMessageSummary;
  onAction(message: EmailMessageSummary, action: EmailMessageListActionName, destination?: string): void;
  onCloseContextMenu(): void;
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
        <div className="inline-flex overflow-hidden rounded-md border border-transparent bg-background/70 opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100">
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
          <EmailMessageRowActionMenuItems
            disabled={isBusy}
            labels={labels}
            message={message}
            onAction={onAction}
            onMove={() => setIsMoveOpen(true)}
            readAction={readAction}
            readLabel={readLabel}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu
        modal={false}
        open={Boolean(contextMenuPosition)}
        onOpenChange={(open) => {
          if (!open) onCloseContextMenu();
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none fixed h-px w-px"
            style={contextMenuPosition ? { left: contextMenuPosition.x, top: contextMenuPosition.y } : undefined}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          className="w-48"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <EmailMessageRowActionMenuItems
            disabled={isBusy}
            labels={labels}
            message={message}
            onAction={onAction}
            onMove={() => setIsMoveOpen(true)}
            readAction={readAction}
            readLabel={readLabel}
          />
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

function EmailMessageRowActionMenuItems({
  disabled,
  labels,
  message,
  onAction,
  onMove,
  readAction,
  readLabel,
}: {
  disabled: boolean;
  labels: Pick<EmailMessageViewerLabels, 'archive' | 'markRead' | 'markUnread' | 'moveTo' | 'permanentDelete'>;
  message: EmailMessageSummary;
  onAction(message: EmailMessageSummary, action: EmailMessageListActionName): void;
  onMove(): void;
  readAction: 'mark-read' | 'mark-unread';
  readLabel: string;
}) {
  return (
    <>
      <DropdownMenuItem disabled={disabled} onSelect={() => onAction(message, 'archive')}>
        <Archive className="h-4 w-4" />
        {labels.archive}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={onMove}>
        <FolderInput className="h-4 w-4" />
        {labels.moveTo}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => onAction(message, readAction)}>
        {message.isRead ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
        {readLabel}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => onAction(message, 'permanent-delete')} className="text-destructive focus:text-destructive">
        <XCircle className="h-4 w-4" />
        {labels.permanentDelete}
      </DropdownMenuItem>
    </>
  );
}

export function EmailMessageViewer({
  actions,
  allowRemoteResourcesByDefault,
  allowedRemoteResourceSenders,
  className,
  hasPendingUpdate = false,
  isLoading,
  isSummaryStreaming = false,
  labels,
  message,
  onAllowRemoteResourcesForSender,
  onBackToMessages,
  onKeepCurrentMessage,
  onLoadUpdatedMessage,
  onRetryMessage,
  summary,
  summaryStatus,
  unavailable = false,
}: {
  actions?: EmailMessageViewerActions;
  allowRemoteResourcesByDefault: boolean;
  allowedRemoteResourceSenders: string[];
  className?: string;
  hasPendingUpdate?: boolean;
  isLoading: boolean;
  isSummaryStreaming?: boolean;
  labels: EmailMessageViewerLabels;
  message: EmailMessageDetail | null;
  onAllowRemoteResourcesForSender(sender: string): void;
  onBackToMessages?(): void;
  onKeepCurrentMessage?(): void;
  onLoadUpdatedMessage?(): void;
  onRetryMessage?(): void;
  summary?: string;
  summaryStatus?: string | null;
  unavailable?: boolean;
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
        {unavailable ? (
          <div className="max-w-sm space-y-3" role="status">
            <p>{labels.messageUnavailable}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {onRetryMessage ? <Button type="button" size="sm" onClick={onRetryMessage}>{labels.retryMessage}</Button> : null}
              {onBackToMessages ? <Button type="button" size="sm" variant="outline" onClick={onBackToMessages}>{labels.backToMessages}</Button> : null}
            </div>
          </div>
        ) : labels.selectMessage}
      </div>
    );
  }

  return (
    <article className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>
      {hasPendingUpdate ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary" role="status">
          <span>{labels.messageContentUpdated}</span>
          <div className="flex flex-wrap gap-2">
            {onLoadUpdatedMessage ? <Button type="button" size="sm" onClick={onLoadUpdatedMessage}>{labels.loadUpdatedMessage}</Button> : null}
            {onKeepCurrentMessage ? <Button type="button" size="sm" variant="outline" onClick={onKeepCurrentMessage}>{labels.keepCurrentMessage}</Button> : null}
          </div>
        </div>
      ) : null}
      <header className="shrink-0 border-b border-border px-3 py-2.5 pr-10 sm:px-4">
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
        {(summary || isSummaryStreaming) && (
          <div className="mt-3 border border-primary/25 bg-primary/5 px-3 py-2 text-sm leading-6">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              <span>{summaryStatus || labels.aiSummary}</span>
              {isSummaryStreaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            </div>
            {summary ? (
              <MarkdownMessage content={summary} variant="assistant" />
            ) : (
              <div className="my-1 h-4 w-32 animate-pulse rounded-sm bg-primary/15" />
            )}
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
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
