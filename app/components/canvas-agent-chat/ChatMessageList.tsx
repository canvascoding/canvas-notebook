'use client';

import { createRef, Fragment, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import { FileReferenceCard } from '@/app/components/canvas-agent-chat/FileReferenceCard';
import { getRecentStudioImageMediaUrls, MarkdownMessage } from '@/app/components/canvas-agent-chat/ChatMarkdownMessage';
import {
  formatChatRuntimeIdentity,
  indexChatRuntimeChanges,
  type ChatRuntimeChange,
} from '@/app/components/canvas-agent-chat/chatRuntimeChanges';
import { SkillReferenceChipRow, useSkillReferenceCatalog } from '@/app/components/canvas-agent-chat/SkillReferenceChips';
import {
  buildToolImagePreviewGroups,
  ToolBatchDisclosure,
} from '@/app/components/canvas-agent-chat/ChatToolRunMessages';
import { extractFilePaths } from '@/app/lib/chat/extract-file-paths';
import { buildToolBatchProjection } from '@/app/lib/chat/run-collapse';
import { rewriteRelativeStudioImageMarkdown } from '@/app/lib/chat/studio-image-markdown';
import type { AttachmentOpenHandler, ChatMessage } from '@/app/lib/chat/types';
import { contentToString, isAbortedAssistantPiMessage } from '@/app/lib/chat/message-content';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import type { ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

function hasEarlierVisibleAssistantInRun(
  messages: ChatMessage[],
  messageIndex: number,
  hiddenMessageIds: Set<string>,
): boolean {
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const previousMessage = messages[index];
    if (previousMessage.role === 'user') {
      return false;
    }

    if (hiddenMessageIds.has(previousMessage.id) || previousMessage.role !== 'assistant') {
      continue;
    }

    if (previousMessage.status === 'sending' || contentToString(previousMessage.content).trim().length > 0) {
      return true;
    }
  }

  return false;
}

function getCompactBreakLabel(
  message: ChatMessage,
  t: ReturnType<typeof useTranslations<'chat'>>,
): string {
  const meta = message.compactMeta;
  if (!meta) {
    return message.content;
  }

  const baseLabel = meta.kind === 'manual' ? t('compactManual') : t('compactAutomatic');
  if (meta.omittedMessageCount > 0) {
    return t('compactWithCount', { label: baseLabel, count: meta.omittedMessageCount });
  }

  return baseLabel;
}

function RuntimeChangeSeparator({ change }: { change: ChatRuntimeChange }) {
  const t = useTranslations('chat');
  const from = formatChatRuntimeIdentity(change.from);
  const to = formatChatRuntimeIdentity(change.to);
  const title = t('runtimeChangeTitle', { from, to });

  return (
    <div
      data-testid="chat-runtime-change"
      aria-label={title}
      title={title}
      className="flex min-w-0 items-center gap-2 py-1"
    >
      <div className="h-px min-w-3 flex-1 bg-border/70" />
      <div className="flex min-w-0 max-w-[85%] items-center gap-1.5 border border-border/60 bg-background/90 px-2 py-1 text-[10px] leading-none text-muted-foreground shadow-sm">
        <span className="shrink-0 font-semibold uppercase tracking-[0.12em]">
          {t('runtimeChangeLabel')}
        </span>
        <span aria-hidden="true" className="text-border">·</span>
        <span className="min-w-0 truncate font-mono tracking-tight">
          {from} → {to}
        </span>
      </div>
      <div className="h-px min-w-3 flex-1 bg-border/70" />
    </div>
  );
}

function StreamingMessageIndicator() {
  const t = useTranslations('chat');
  return (
    <div
      data-testid="chat-assistant-streaming-indicator"
      aria-label={t('assistantStreamingAria')}
      className="inline-flex min-h-8 min-w-12 items-center justify-center px-1 text-muted-foreground/80"
    >
      <span className="sr-only">{t('assistantStreamingSr')}</span>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          aria-hidden="true"
          className="chat-streaming-dot mx-0.5 h-1.5 w-1.5 rounded-full bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

async function writeMessageTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  const selection = document.getSelection();
  const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard copy failed.');
    }
  } finally {
    document.body.removeChild(textarea);
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}

function getRichClipboardHtml(contentElement: HTMLElement): string {
  const copy = contentElement.cloneNode(true) as HTMLElement;

  copy.querySelectorAll('button').forEach((button) => {
    const text = button.textContent?.trim();
    if (!text) {
      button.remove();
      return;
    }
    const replacement = document.createElement('span');
    replacement.textContent = text;
    button.replaceWith(replacement);
  });
  copy.querySelectorAll('svg').forEach((icon) => icon.remove());
  copy.querySelectorAll<HTMLElement>('*').forEach((element) => {
    element.removeAttribute('class');
    element.removeAttribute('style');
  });

  return copy.innerHTML;
}

async function writeRichMessageToClipboard(text: string, contentElement: HTMLElement | null): Promise<void> {
  const html = contentElement ? getRichClipboardHtml(contentElement) : '';

  if (html && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      // Fall back to the plain-text clipboard API for browsers that reject HTML clipboard data.
    }
  }

  await writeMessageTextToClipboard(text);
}

function MessageActionBar({
  align,
  text,
  markdownText,
  isRichCopy,
  richContentRef,
}: {
  align: 'start' | 'end';
  text: string;
  markdownText?: string;
  isRichCopy: boolean;
  richContentRef?: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations('chat');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const canCopy = text.trim().length > 0;

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const scheduleReset = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1400);
  }, []);

  const handleMarkdownCopy = useCallback(async () => {
    if (!canCopy) {
      return;
    }

    try {
      await writeMessageTextToClipboard(markdownText ?? text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    scheduleReset();
  }, [canCopy, markdownText, scheduleReset, text]);

  const handleFormattedCopy = useCallback(async () => {
    if (!canCopy) {
      return;
    }

    try {
      await writeRichMessageToClipboard(text, richContentRef?.current ?? null);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    scheduleReset();
  }, [canCopy, richContentRef, scheduleReset, text]);

  const copyLabel = copyState === 'copied'
    ? t('copied')
    : isRichCopy
      ? t('copyFormatted')
      : t('copy');
  const CopyIcon = copyState === 'copied' ? Check : Copy;

  return (
    <div
      data-testid={`chat-message-actions-${align === 'end' ? 'user' : 'assistant'}`}
      className={cn(
        'mt-1 flex min-h-7 items-center gap-1 px-1 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-within:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
        copyState !== 'idle' && 'sm:opacity-100',
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              'border border-transparent bg-background/70 text-muted-foreground shadow-none hover:border-border/70 hover:bg-accent hover:text-foreground',
              isRichCopy && 'rounded-r-none border-r-border/70',
            )}
            onClick={() => void (isRichCopy ? handleFormattedCopy() : handleMarkdownCopy())}
            disabled={!canCopy}
            aria-label={copyLabel}
            title={copyLabel}
          >
            <CopyIcon data-icon="inline-start" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={align === 'end' ? 'left' : 'top'} sideOffset={4}>
          {copyLabel}
        </TooltipContent>
      </Tooltip>
      {isRichCopy ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-l-none border border-l-0 border-transparent bg-background/70 text-muted-foreground shadow-none hover:border-border/70 hover:bg-accent hover:text-foreground"
              disabled={!canCopy}
              aria-label={t('copyOptions')}
              title={t('copyOptions')}
            >
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={() => void handleMarkdownCopy()}>
              <Copy />
              {t('copyMarkdown')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function ChatMessageList({
  messages,
  assistantName,
  runtimePhase,
  expandedRunKeys,
  toolVerbosity,
  onToggleRunDisclosure,
  onMediaClick,
  onAttachmentOpen,
}: {
  messages: ChatMessage[];
  assistantName: string;
  runtimePhase: RuntimeStatus['phase'] | null | undefined;
  expandedRunKeys: Set<string>;
  toolVerbosity: ToolVerbosity;
  onToggleRunDisclosure: (runKey: string) => void;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen: AttachmentOpenHandler;
}) {
  const t = useTranslations('chat');
  const skillReferenceCatalog = useSkillReferenceCatalog();
  const toolBatchProjection = useMemo(() => buildToolBatchProjection(messages), [messages]);
  const toolImagePreviewGroups = useMemo(() => buildToolImagePreviewGroups(messages), [messages]);
  const runtimeChanges = useMemo(() => indexChatRuntimeChanges(messages), [messages]);
  const hiddenToolMessageIds = toolBatchProjection.hiddenToolMessageIds;

  return (
    <TooltipProvider delayDuration={300}>
      {messages.map((message, messageIndex) => {
        const runtimeChange = runtimeChanges.get(message.id);
        const isUser = message.role === 'user';
        const isAssistant = message.role === 'assistant';
        const isTool = message.role === 'toolResult';
        const isSystem = message.role === 'system';
        const isSystemError = isSystem && message.status === 'error';
        const isCompactBreak = message.type === 'compact_break';
        const isStreamingAssistant = isAssistant && message.status === 'sending';
        const isAbortedAssistant = isAssistant && isAbortedAssistantPiMessage(message.piMessage);
        const toolBatch = toolBatchProjection.batchesByAnchorId.get(message.id);
        const toolImagePreviewGroup = isTool ? toolImagePreviewGroups.get(message.id) : undefined;
        const rawBodyContent = contentToString(message.content);
        const hasVisibleAssistantContent = rawBodyContent.trim().length > 0;
        const suppressAssistantTitle = isAssistant && hasEarlierVisibleAssistantInRun(messages, messageIndex, hiddenToolMessageIds);
        const batchDisclosure = toolBatch && toolVerbosity !== 'minimal' ? (
          <ToolBatchDisclosure
            batch={toolBatch}
            expanded={expandedRunKeys.has(toolBatch.key)}
            onToggle={() => onToggleRunDisclosure(toolBatch.key)}
            onMediaClick={onMediaClick}
            onAttachmentOpen={onAttachmentOpen}
            previewGroups={toolImagePreviewGroups}
          />
        ) : null;

        if (hiddenToolMessageIds.has(message.id)) {
          return (
            <Fragment key={message.id}>
              {batchDisclosure}
            </Fragment>
          );
        }

        if (isCompactBreak) {
          return (
            <div key={message.id} data-testid="chat-compaction-break" className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-border/80" />
              <div className="border border-border/70 bg-background/90 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {getCompactBreakLabel(message, t)}
              </div>
              <div className="h-px flex-1 bg-border/80" />
            </div>
          );
        }

        if (message.type === 'composio_auth_required' && message.composioAuthMeta) {
          const meta = message.composioAuthMeta;
          return (
            <div key={message.id} className="flex justify-start">
              <div className="max-w-[90%] rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
                <div className="flex items-start gap-3">
                  <Lock className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{t('composioAuthTitle')}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('composioAuthDescription', { toolkit: meta.toolkitName, tool: meta.toolName })}
                    </p>
                    {meta.profileName ? (
                      <p className="mt-2 rounded-md border border-blue-500/20 bg-background/70 px-2.5 py-2 text-xs text-muted-foreground">
                        {t('composioAuthProfile', { name: meta.profileName })}
                        {' · '}
                        {meta.profileSource === 'workspace_override'
                          ? t('composioAuthWorkspaceOnly')
                          : t('composioAuthDefault')}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {meta.redirectUrl && (
                        <Button size="sm" onClick={() => window.open(meta.redirectUrl, '_blank', 'noopener,noreferrer')}>
                          <ExternalLink className="mr-1 h-3 w-3" />
                          {t('composioAuthConnect', { toolkit: meta.toolkitName })}
                        </Button>
                      )}
                      <Link href={`/settings?tab=integrations&section=composio${meta.workspaceId ? `&workspaceId=${encodeURIComponent(meta.workspaceId)}` : ''}`}>
                        <Button variant="outline" size="sm">
                          {t('goToIntegrations')}
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        if (isAssistant && !isStreamingAssistant && !hasVisibleAssistantContent && message.status !== 'error' && !isAbortedAssistant) {
          return batchDisclosure ? <Fragment key={message.id}>{batchDisclosure}</Fragment> : null;
        }

        const bubbleClass = isUser
          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
          : isAbortedAssistant
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200'
            : isAssistant
              ? 'border-border bg-muted text-foreground'
              : isSystemError
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border bg-background/80 text-muted-foreground';

        const title = isUser ? t('you') : isAssistant ? assistantName : t('system');
        const bodyContent =
          rawBodyContent ||
          (isAbortedAssistant
            ? t('runStopped')
            : message.status === 'queued_follow_up'
              ? t('queuedAfterCurrentRun')
              : message.status === 'queued_steering'
                ? t('queuedAsSteeringMessage')
                : message.status === 'aborting'
                  ? t('willSendAfterStop')
                  : message.status === 'sending'
                  ? t('agentWorking')
                  : '');
        const displayBodyContent = isAssistant
          ? rewriteRelativeStudioImageMarkdown(
              bodyContent,
              getRecentStudioImageMediaUrls(messages, messageIndex),
            )
          : bodyContent;
        const copyContent = isAssistant ? displayBodyContent : bodyContent;
        const showMessageActions = (isUser || isAssistant) && !isStreamingAssistant && copyContent.trim().length > 0;
        const richContentRef = isAssistant ? createRef<HTMLDivElement>() : undefined;
        const renderedMessage = (
          <div
            data-testid={`chat-message-${message.role}`}
            className={cn(
              'group/message flex flex-col',
              isUser ? 'items-end' : 'items-start',
            )}
          >
            <div className={`max-w-[96%] border p-3 sm:max-w-[90%] overflow-hidden min-w-0 ${bubbleClass}`}>
              <>
                  {!isAssistant || !suppressAssistantTitle ? (
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{title}</span>
                      {isAbortedAssistant ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('runStoppedBadge')}</span> : null}
                      {message.status === 'aborting' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70" />}
                      {message.status === 'queued_follow_up' ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('queue')}</span> : null}
                      {message.status === 'queued_steering' ? <span className="text-[10px] uppercase tracking-widest opacity-60">{t('steer')}</span> : null}
                    </div>
                  ) : null}

                  {isUser ? (
                    <>
                      <MarkdownMessage content={bodyContent} variant="user" onMediaClick={onMediaClick} />
                      <SkillReferenceChipRow
                        content={bodyContent}
                        skillsByName={skillReferenceCatalog}
                        variant="user"
                        className="mt-2"
                      />
                    </>
                  ) : isAssistant ? (
                    isStreamingAssistant && !rawBodyContent ? (
                      <StreamingMessageIndicator />
                    ) : (
                      <>
                        <div ref={richContentRef}>
                          <MarkdownMessage content={displayBodyContent} variant="assistant" onMediaClick={onMediaClick} />
                        </div>
                        <SkillReferenceChipRow
                          content={bodyContent}
                          skillsByName={skillReferenceCatalog}
                          variant="message"
                          className="mt-2"
                        />
                        {isStreamingAssistant ? (
                          <div className="mt-2 inline-flex items-center gap-1 text-muted-foreground/70">
                            {[0, 160, 320].map((delay) => (
                              <span
                                key={delay}
                                aria-hidden="true"
                                className="chat-streaming-dot h-1 w-1 rounded-full bg-current"
                                style={{ animationDelay: `${delay}ms` }}
                              />
                            ))}
                            <span className="sr-only">{t('assistantStreamingSr')}</span>
                          </div>
                        ) : null}
                      </>
                    )
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{bodyContent}</div>
                  )}
              </>

              {message.attachments && message.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {message.attachments.map((attachment, index) => (
                    <AttachmentPreviewItem
                      key={`${attachment.id || attachment.filePath || attachment.name}-${index}`}
                      attachment={attachment}
                      context="message"
                      previewGroup={toolImagePreviewGroup || message.attachments}
                      onOpen={onAttachmentOpen}
                    />
                  ))}
                </div>
              )}

              {isAssistant && !isStreamingAssistant && bodyContent && (() => {
                const filePaths = extractFilePaths(bodyContent);
                return filePaths.length > 0 ? <FileReferenceCard paths={filePaths} /> : null;
              })()}
            </div>
            {showMessageActions ? (
              <MessageActionBar
                align={isUser ? 'end' : 'start'}
                text={copyContent}
                markdownText={isAssistant ? bodyContent : undefined}
                isRichCopy={isAssistant}
                richContentRef={richContentRef}
              />
            ) : null}
          </div>
        );

        if (batchDisclosure) {
          return (
            <Fragment key={message.id}>
              {runtimeChange ? <RuntimeChangeSeparator change={runtimeChange} /> : null}
              {renderedMessage}
              {batchDisclosure}
            </Fragment>
          );
        }

        return (
          <Fragment key={message.id}>
            {runtimeChange ? <RuntimeChangeSeparator change={runtimeChange} /> : null}
            {renderedMessage}
          </Fragment>
        );
      })}
      {toolVerbosity === 'minimal' && runtimePhase === 'running_tool' ? (
        <div data-testid="chat-minimal-tool-activity" className="flex justify-start px-1 py-1">
          <div className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-3 text-muted-foreground/80">
            {[0, 160, 320].map((delay) => (
              <span
                key={delay}
                aria-hidden="true"
                className="chat-streaming-dot h-1.5 w-1.5 rounded-full bg-current"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
            <span className="sr-only">{t('toolWorking')}</span>
          </div>
        </div>
      ) : null}
    </TooltipProvider>
  );
}
