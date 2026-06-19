'use client';

import { Fragment, useMemo } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Lock, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import { FileReferenceCard } from '@/app/components/canvas-agent-chat/FileReferenceCard';
import { getRecentStudioImageMediaUrls, MarkdownMessage } from '@/app/components/canvas-agent-chat/ChatMarkdownMessage';
import { SkillReferenceChipRow, useSkillReferenceCatalog } from '@/app/components/canvas-agent-chat/SkillReferenceChips';
import {
  AgentRunDisclosure,
  buildToolImagePreviewGroups,
  getToolStatusLabel,
  ToolCallPill,
} from '@/app/components/canvas-agent-chat/ChatToolRunMessages';
import { ToolDataViewFromJson } from '@/app/components/canvas-agent-chat/ToolDataView';
import { ToolOutputView } from '@/app/components/canvas-agent-chat/ToolOutputView';
import { extractFilePaths } from '@/app/lib/chat/extract-file-paths';
import { buildCollapsedRunMap } from '@/app/lib/chat/run-collapse';
import { rewriteRelativeStudioImageMarkdown } from '@/app/lib/chat/studio-image-markdown';
import type { AttachmentOpenHandler, ChatMessage } from '@/app/lib/chat/types';
import { contentToString, isAbortedAssistantPiMessage } from '@/app/lib/chat/message-content';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import type { ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';

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

export function ChatMessageList({
  messages,
  isRuntimeBusy,
  runtimePhase,
  expandedRunKeys,
  toolVerbosity,
  onToggleToolMessage,
  onToggleRunDisclosure,
  onMediaClick,
  onAttachmentOpen,
}: {
  messages: ChatMessage[];
  isRuntimeBusy: boolean;
  runtimePhase: RuntimeStatus['phase'] | null | undefined;
  expandedRunKeys: Set<string>;
  toolVerbosity: ToolVerbosity;
  onToggleToolMessage: (messageId: string) => void;
  onToggleRunDisclosure: (runKey: string) => void;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen: AttachmentOpenHandler;
}) {
  const t = useTranslations('chat');
  const skillReferenceCatalog = useSkillReferenceCatalog();
  const collapsedRunMap = useMemo(() => buildCollapsedRunMap(messages, isRuntimeBusy), [messages, isRuntimeBusy]);
  const toolImagePreviewGroups = useMemo(() => buildToolImagePreviewGroups(messages), [messages]);
  const hiddenStepIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of collapsedRunMap.values()) {
      for (const step of run.steps) {
        ids.add(step.id);
      }
    }
    return ids;
  }, [collapsedRunMap]);

  return (
    <>
      {messages.map((message, messageIndex) => {
        if (hiddenStepIds.has(message.id)) {
          return null;
        }

        const isUser = message.role === 'user';
        const isAssistant = message.role === 'assistant';
        const isTool = message.role === 'toolResult';
        const isSystem = message.role === 'system';
        const isSystemError = isSystem && message.status === 'error';
        const isCompactBreak = message.type === 'compact_break';
        const isStreamingAssistant = isAssistant && message.status === 'sending';
        const isAbortedAssistant = isAssistant && isAbortedAssistantPiMessage(message.piMessage);
        const collapsedRun = isAssistant ? collapsedRunMap.get(message.id) : undefined;
        const toolImagePreviewGroup = isTool ? toolImagePreviewGroups.get(message.id) : undefined;
        const rawBodyContent = contentToString(message.content);
        const hasVisibleAssistantContent = rawBodyContent.trim().length > 0;
        const suppressAssistantTitle = isAssistant && hasEarlierVisibleAssistantInRun(messages, messageIndex, hiddenStepIds);

        if (isTool && toolVerbosity === 'minimal') {
          return null;
        }

        if (isTool && toolVerbosity === 'subtle') {
          return (
            <ToolCallPill
              key={message.id}
              message={message}
              onMediaClick={onMediaClick}
              onAttachmentOpen={onAttachmentOpen}
              previewGroup={toolImagePreviewGroups.get(message.id)}
            />
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
                    <p className="text-sm font-semibold text-foreground">Authentication Required</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {meta.toolkitName} needs authorization to use {meta.toolName}.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {meta.redirectUrl && (
                        <Button size="sm" onClick={() => window.open(meta.redirectUrl, '_blank', 'noopener,noreferrer')}>
                          <ExternalLink className="mr-1 h-3 w-3" />
                          Connect {meta.toolkitName}
                        </Button>
                      )}
                      <Link href="/settings?tab=integrations">
                        <Button variant="outline" size="sm">
                          {t('goToSettings') || 'Settings → Integrations'}
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
          return null;
        }

        const bubbleClass = isUser
          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
          : isAbortedAssistant
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200'
            : isAssistant
              ? 'border-border bg-muted text-foreground'
              : isTool
                ? 'border-amber-500/40 bg-amber-500/10 text-foreground'
                : isSystemError
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border bg-background/80 text-muted-foreground';

        const title = isUser ? t('you') : isTool ? (message.toolName || t('tool')) : isAssistant ? t('assistant') : t('system');
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
                    ? (isTool ? t('runningTool') : t('agentWorking'))
                    : '');
        const displayBodyContent = isAssistant
          ? rewriteRelativeStudioImageMarkdown(
              bodyContent,
              getRecentStudioImageMediaUrls(messages, messageIndex),
            )
          : bodyContent;
        const toolBodyVisible = isTool ? !message.isCollapsed : true;
        const toolStatusLabel = isTool ? getToolStatusLabel(message, t) : null;

        const renderedMessage = (
          <div data-testid={`chat-message-${message.role}`} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[96%] border p-3 sm:max-w-[90%] overflow-hidden min-w-0 ${bubbleClass}`}>
              {isTool ? (
                <div>
                  <button
                    type="button"
                    data-testid="chat-tool-toggle"
                    onClick={() => onToggleToolMessage(message.id)}
                    className="flex w-full items-start gap-3 text-left"
                  >
                    <span className="mt-0.5 text-amber-600/90">
                      <Wrench className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{title}</span>
                        <span className="border border-amber-500/30 bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                          {toolStatusLabel}
                        </span>
                        {message.autoCollapsedAtEnd ? <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{t('auto')}</span> : null}
                      </div>
                      <div className="mt-1 text-sm font-medium text-foreground">{message.toolName || t('tool')}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{message.previewText || t('noOutputYet')}</div>
                    </div>
                    <span className="mt-0.5 text-muted-foreground">
                      {toolBodyVisible ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                  </button>

                  {toolBodyVisible ? (
                    <div data-testid="chat-tool-body" className="mt-3 space-y-3">
                      {message.toolArgs ? (
                        <div className="rounded-md border border-amber-500/30 bg-background/60 p-3">
                          <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{t('toolInput')}</div>
                          <div className="max-h-52 overflow-auto pr-1">
                            <ToolDataViewFromJson json={message.toolArgs} />
                          </div>
                        </div>
                      ) : null}
                      <ToolOutputView content={bodyContent} onMediaClick={onMediaClick} />
                    </div>
                  ) : null}
                </div>
              ) : (
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
                        <MarkdownMessage content={displayBodyContent} variant="assistant" onMediaClick={onMediaClick} />
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
              )}

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
          </div>
        );

        if (collapsedRun) {
          return (
            <Fragment key={message.id}>
              <AgentRunDisclosure
                run={collapsedRun}
                expanded={expandedRunKeys.has(collapsedRun.key)}
                onToggle={() => onToggleRunDisclosure(collapsedRun.key)}
                toolVerbosity={toolVerbosity}
                onMediaClick={onMediaClick}
                onAttachmentOpen={onAttachmentOpen}
                previewGroups={toolImagePreviewGroups}
              />
              {renderedMessage}
            </Fragment>
          );
        }

        return (
          <Fragment key={message.id}>
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
    </>
  );
}
