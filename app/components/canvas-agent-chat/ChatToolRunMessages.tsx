'use client';

import { useState, type ComponentType } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Brain,
  CalendarClock,
  CalendarCog,
  CalendarPlus,
  CalendarX,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  FilePlus,
  FolderOpen,
  Globe,
  Inbox,
  ListChecks,
  ListTodo,
  Loader2,
  AudioLines,
  MailOpen,
  MailPlus,
  MessagesSquare,
  Network,
  Package,
  Paintbrush,
  Palette,
  PencilLine,
  Play,
  Plug,
  PlugZap,
  Search,
  SearchCheck,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareFunction,
  Terminal,
  UserRound,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import { MarkdownMessage } from '@/app/components/canvas-agent-chat/ChatMarkdownMessage';
import { ToolDataView, ToolDataViewFromJson } from '@/app/components/canvas-agent-chat/ToolDataView';
import { deriveUploadAttachmentPreview, getAttachmentMediaUrl } from '@/app/lib/chat/attachment-preview';
import { dedupeAttachments, contentToString, getPiMessageDetails, truncatePreview } from '@/app/lib/chat/message-content';
import { formatRunDuration } from '@/app/lib/chat/run-collapse';
import type { Attachment, AttachmentOpenHandler, ChatMessage, CollapsedRun } from '@/app/lib/chat/types';
import { getToolDisplayInfo, type ToolDisplayTone } from '@/app/lib/pi/tool-display';
import type { ToolVerbosity } from '@/app/store/tool-verbosity-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const TOOL_TONE_ICONS: Record<ToolDisplayTone, ComponentType<{ className?: string }>> = {
  command: Terminal,
  file: FolderOpen,
  fileCreate: FilePlus,
  search: Search,
  web: Globe,
  image: Paintbrush,
  video: Video,
  sound: AudioLines,
  data: Package,
  person: UserRound,
  style: Palette,
  list: ListChecks,
  automationList: CalendarClock,
  automationCreate: CalendarPlus,
  automationUpdate: CalendarCog,
  automationDelete: CalendarX,
  automationTrigger: Play,
  emailAccounts: Inbox,
  emailRead: MailOpen,
  emailDraftCreate: MailPlus,
  emailDraftUpdate: PencilLine,
  emailSend: Send,
  mcp: PlugZap,
  memory: Brain,
  session: MessagesSquare,
  delegation: Network,
  todo: ListTodo,
  publicShare: ShieldCheck,
  composioSearch: SearchCheck,
  composioSchema: FileJson,
  composioExecute: SquareFunction,
  composioConnections: Plug,
  default: Settings,
};

function getPreviewableToolImageAttachments(message: ChatMessage): Attachment[] {
  if (message.role !== 'toolResult' || !message.attachments?.length) {
    return [];
  }

  return message.attachments
    .map((attachment) => deriveUploadAttachmentPreview(attachment))
    .filter((attachment) => attachment.contentKind === 'image' && Boolean(attachment.previewUrl || getAttachmentMediaUrl(attachment)));
}

export function buildToolImagePreviewGroups(messages: ChatMessage[]): Map<string, Attachment[]> {
  const groups = new Map<string, Attachment[]>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    let runEnd = messages.length;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor]?.role === 'user') {
        runEnd = cursor;
        break;
      }
    }

    const runMessages = messages.slice(index + 1, runEnd);
    const previewGroup = dedupeAttachments(runMessages.flatMap(getPreviewableToolImageAttachments));
    if (previewGroup.length > 0) {
      for (const runMessage of runMessages) {
        if (runMessage.role === 'toolResult') {
          groups.set(runMessage.id, previewGroup);
        }
      }
    }

    index = runEnd - 1;
  }

  return groups;
}

export function getToolStatusLabel(
  message: ChatMessage,
  t: ReturnType<typeof useTranslations<'chat'>>
): string {
  switch (message.status) {
    case 'sending':
      return t('toolStatusRunning');
    case 'aborting':
      return t('toolStatusAborting');
    case 'error':
      return t('toolStatusError');
    default:
      return t('toolStatusDone');
  }
}

export function ToolCallPill({
  message,
  onMediaClick,
  onAttachmentOpen,
  previewGroup,
}: {
  message: ChatMessage;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen?: AttachmentOpenHandler;
  previewGroup?: Attachment[];
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);
  const display = getToolDisplayInfo(message.toolName, locale, getPiMessageDetails(message.piMessage));
  const Icon = TOOL_TONE_ICONS[display.tone] || TOOL_TONE_ICONS.default;
  const isRunning = message.status === 'sending' || message.status === 'aborting';
  const isError = message.status === 'error';
  const bodyContent =
    contentToString(message.content) ||
    (isRunning ? t('runningTool') : t('noOutputYet'));
  const toolStatusLabel = getToolStatusLabel(message, t);
  const imageAttachments = getPreviewableToolImageAttachments(message);
  const imagePreviewGroup = previewGroup?.length ? previewGroup : imageAttachments;
  const primaryAttachmentName = imageAttachments[0]?.name;

  const copyDetails = async () => {
    const sections = [
      message.toolName ? `${t('toolTechnicalName')}: ${message.toolName}` : null,
      message.toolArgs ? `${t('toolInput')}\n${message.toolArgs}` : null,
      bodyContent ? `${t('toolOutput')}\n${bodyContent}` : null,
    ].filter(Boolean);

    try {
      await navigator.clipboard.writeText(sections.join('\n\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  const renderTrigger = () => (
    <button
      type="button"
      className={`group inline-flex max-w-[90%] items-center gap-2 rounded-full border px-2.5 py-1 text-xs shadow-sm transition-colors ${
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15'
          : isRunning
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300'
            : 'border-border/70 bg-background/85 text-muted-foreground hover:border-primary/30 hover:bg-accent hover:text-foreground'
      }`}
      aria-label={`${display.label}: ${toolStatusLabel}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate font-medium">{display.label}</span>
      {primaryAttachmentName ? (
        <span className="min-w-0 max-w-[9rem] truncate text-muted-foreground/80 sm:max-w-[13rem]">
          {primaryAttachmentName}
        </span>
      ) : null}
      {isRunning ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : isError ? (
        <XCircle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
      )}
    </button>
  );

  const detailsPanel = (
    <div data-testid="chat-tool-body" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/70 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {isMobile ? (
                <DialogTitle className="truncate text-sm font-semibold leading-normal">{display.label}</DialogTitle>
              ) : (
                <span className="truncate">{display.label}</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {isMobile ? (
                <DialogDescription asChild>
                  <span>{toolStatusLabel}</span>
                </DialogDescription>
              ) : (
                <span>{toolStatusLabel}</span>
              )}
              {message.toolName ? <span className="font-mono">{message.toolName}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => void copyDetails()}>
              <Copy className="mr-1 h-3.5 w-3.5" />
              {copied ? t('copied') : t('copy')}
            </Button>
            {isMobile ? (
              <DialogClose asChild>
                <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs">
                  <X className="mr-1 h-3.5 w-3.5" />
                  {t('close')}
                </Button>
              </DialogClose>
            ) : null}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {message.toolArgs ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t('toolInput')}
            </div>
            <div className="max-h-52 overflow-auto pr-1">
              <ToolDataViewFromJson json={message.toolArgs} />
            </div>
          </div>
        ) : null}
        <div className="rounded-md border border-border/60 bg-background p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('toolOutput')}
          </div>
          {imageAttachments.length > 0 ? (
            <div data-testid="chat-tool-attachments" className="mb-2 flex flex-wrap gap-2">
              {imageAttachments.map((attachment, index) => (
                <AttachmentPreviewItem
                  key={`${attachment.id || attachment.filePath || attachment.name}-${index}`}
                  attachment={attachment}
                  context="message"
                  previewGroup={imagePreviewGroup}
                  onOpen={onAttachmentOpen}
                />
              ))}
            </div>
          ) : null}
          <div className="max-h-52 overflow-auto pr-1">
            {(() => {
              const trimmed = bodyContent.trim();
              if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                const parsed = (() => {
                  try {
                    return JSON.parse(bodyContent);
                  } catch {
                    return null;
                  }
                })();
                if (parsed) {
                  return <ToolDataView data={parsed} />;
                }
              }
              return <MarkdownMessage content={bodyContent} variant="tool" onMediaClick={onMediaClick} />;
            })()}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div key={message.id} data-testid="chat-tool-subtle" className="flex justify-start py-0.5">
      {isMobile ? (
        <Dialog>
          <DialogTrigger asChild>{renderTrigger()}</DialogTrigger>
          <DialogContent
            layout="viewport"
            showCloseButton={false}
            className="bg-background"
          >
            {detailsPanel}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover>
          <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            collisionPadding={16}
            sticky="always"
            className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(calc(100vw-2rem),560px)] flex-col overflow-hidden p-0"
          >
            {detailsPanel}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function MessageStepIcon({ className }: { className?: string }) {
  return <Sparkles className={className} />;
}

function RunStepItem({
  message,
  toolVerbosity,
  onMediaClick,
  onAttachmentOpen,
  previewGroup,
}: {
  message: ChatMessage;
  toolVerbosity: ToolVerbosity;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen?: AttachmentOpenHandler;
  previewGroup?: Attachment[];
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const isTool = message.role === 'toolResult';
  const isAssistant = message.role === 'assistant';
  const display = isTool ? getToolDisplayInfo(message.toolName, locale, getPiMessageDetails(message.piMessage)) : null;
  const Icon = display ? (TOOL_TONE_ICONS[display.tone] || TOOL_TONE_ICONS.default) : MessageStepIcon;
  const title = isTool ? (display?.label || message.toolName || t('tool')) : isAssistant ? t('assistant') : t('system');
  const bodyContent =
    contentToString(message.content) ||
    (message.status === 'sending' ? (isTool ? t('runningTool') : t('agentWorking')) : '');
  const preview = message.previewText || truncatePreview(bodyContent || t('noOutputYet'));
  const isMinimal = toolVerbosity === 'minimal';

  if (isTool && toolVerbosity !== 'minimal') {
    return (
      <div data-testid="chat-run-step" className="min-w-0 overflow-hidden">
        <ToolCallPill
          message={message}
          onMediaClick={onMediaClick}
          onAttachmentOpen={onAttachmentOpen}
          previewGroup={previewGroup}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="chat-run-step"
      className={cn(
        'min-w-0 overflow-hidden border border-border/70 bg-background/70',
        isMinimal ? 'px-2 py-1.5' : 'p-2',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{title}</span>
          </div>
          {!isMinimal ? (
            <div className="mt-0.5 line-clamp-2 min-w-0 break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {preview}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AgentRunDisclosure({
  run,
  expanded,
  onToggle,
  toolVerbosity,
  onMediaClick,
  onAttachmentOpen,
  previewGroups,
}: {
  run: CollapsedRun;
  expanded: boolean;
  onToggle: () => void;
  toolVerbosity: ToolVerbosity;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen?: AttachmentOpenHandler;
  previewGroups?: Map<string, Attachment[]>;
}) {
  const t = useTranslations('chat');
  const duration = formatRunDuration(run.startedAt, run.endedAt);
  const summary = duration
    ? t('workedForWithSteps', { duration, count: run.steps.length })
    : t('workedSteps', { count: run.steps.length });

  return (
    <div data-testid="chat-run-disclosure" className="flex justify-start">
      <div className="min-w-0 w-full max-w-[90%]">
        <button
          type="button"
          data-testid="chat-run-disclosure-toggle"
          onClick={onToggle}
          className="group flex min-w-0 w-full items-start gap-2 border-t border-border/70 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 break-words leading-relaxed [overflow-wrap:anywhere]">{summary}</span>
        </button>

        {expanded ? (
          <div data-testid="chat-run-steps" className="mb-2 min-w-0 space-y-2 pl-4 sm:pl-6">
            {run.steps.map((step) => (
              <RunStepItem
                key={step.id}
                message={step}
                toolVerbosity={toolVerbosity}
                onMediaClick={onMediaClick}
                onAttachmentOpen={onAttachmentOpen}
                previewGroup={previewGroups?.get(step.id)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
