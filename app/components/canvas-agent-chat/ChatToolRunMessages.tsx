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
  SquareFunction,
  Terminal,
  UserRound,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import { ToolDataViewFromJson } from '@/app/components/canvas-agent-chat/ToolDataView';
import { ToolOutputView } from '@/app/components/canvas-agent-chat/ToolOutputView';
import { deriveUploadAttachmentPreview, getAttachmentMediaUrl } from '@/app/lib/chat/attachment-preview';
import { dedupeAttachments, contentToString, getPiMessageDetails } from '@/app/lib/chat/message-content';
import { formatRunDuration } from '@/app/lib/chat/run-collapse';
import type { Attachment, AttachmentOpenHandler, ChatMessage, ToolBatch, ToolBatchCall } from '@/app/lib/chat/types';
import { getToolDisplayInfo, type ToolDisplayTone } from '@/app/lib/pi/tool-display';
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
    case 'pending':
      return t('toolStatusPending');
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

const TOOL_TARGET_KEYS = ['path', 'filePath', 'query', 'pattern', 'directory', 'folder', 'name'] as const;

function getToolTargetPreview(toolArgs: string | undefined): string | null {
  if (!toolArgs) {
    return null;
  }

  try {
    const parsed = JSON.parse(toolArgs) as Record<string, unknown>;
    for (const key of TOOL_TARGET_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim().replace(/\s+/g, ' ');
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function ToolCallPill({
  message,
  onMediaClick,
  onAttachmentOpen,
  previewGroup,
  open,
  onOpenChange,
}: {
  message: ChatMessage;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen?: AttachmentOpenHandler;
  previewGroup?: Attachment[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const display = getToolDisplayInfo(message.toolName, locale, getPiMessageDetails(message.piMessage));
  const Icon = TOOL_TONE_ICONS[display.tone] || TOOL_TONE_ICONS.default;
  const isPending = message.status === 'pending';
  const isRunning = isPending || message.status === 'sending' || message.status === 'aborting';
  const isError = message.status === 'error';
  const bodyContent =
    contentToString(message.content) ||
    (isRunning && !isPending ? t('runningTool') : t('noOutputYet'));
  const toolStatusLabel = getToolStatusLabel(message, t);
  const imageAttachments = getPreviewableToolImageAttachments(message);
  const imagePreviewGroup = previewGroup?.length ? previewGroup : imageAttachments;
  const primaryAttachmentName = imageAttachments[0]?.name;
  const targetPreview = primaryAttachmentName || getToolTargetPreview(message.toolArgs);
  const isOpen = open ?? uncontrolledOpen;

  const handleOpenChange = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

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
      {targetPreview ? (
        <span className="min-w-0 max-w-[9rem] truncate text-muted-foreground/80 sm:max-w-[13rem]">
          {targetPreview}
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
      <div className="shrink-0 border-b border-border/70 px-4 py-3 sm:px-3 sm:py-2">
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
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4 sm:p-3">
        {message.toolArgs ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {t('toolInput')}
            </div>
            <div className={cn(
              isMobile
                ? 'overflow-visible'
                : 'max-h-[min(28rem,calc(100dvh-20rem))] overflow-auto pr-1',
            )}>
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
          <div className={cn(
            isMobile
              ? 'overflow-visible'
              : 'max-h-[min(32rem,calc(100dvh-18rem))] overflow-auto pr-1',
          )}>
            <ToolOutputView content={bodyContent} onMediaClick={onMediaClick} />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div key={message.id} data-testid="chat-tool-subtle" className="flex justify-start py-0.5">
      {isMobile ? (
        <Dialog open={isOpen} onOpenChange={handleOpenChange}>
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
        <Popover open={isOpen} onOpenChange={handleOpenChange}>
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

function getToolBatchCallMessage(call: ToolBatchCall): ChatMessage {
  return call.message || {
    id: `pending-${call.id}`,
    role: 'toolResult',
    content: '',
    status: 'pending',
    type: 'tool_use',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    toolArgs: call.toolArgs,
    isCollapsed: true,
  };
}

function isFinishedToolCall(call: ToolBatchCall): boolean {
  const status = call.message?.status;
  return Boolean(call.message) && status !== 'pending' && status !== 'sending' && status !== 'aborting';
}

export function ToolBatchDisclosure({
  batch,
  expanded,
  onToggle,
  onMediaClick,
  onAttachmentOpen,
  previewGroups,
}: {
  batch: ToolBatch;
  expanded: boolean;
  onToggle: () => void;
  onMediaClick?: (mediaUrl: string) => void;
  onAttachmentOpen?: AttachmentOpenHandler;
  previewGroups?: Map<string, Attachment[]>;
}) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const primaryCall = batch.calls[0];
  const primaryMessage = primaryCall ? getToolBatchCallMessage(primaryCall) : undefined;
  const display = getToolDisplayInfo(primaryCall?.toolName, locale, getPiMessageDetails(primaryMessage?.piMessage));
  const Icon = TOOL_TONE_ICONS[display.tone] || TOOL_TONE_ICONS.default;
  const completedCount = batch.calls.filter(isFinishedToolCall).length;
  const errorCount = batch.calls.filter((call) => call.message?.status === 'error').length;
  const isAborting = batch.calls.some((call) => call.message?.status === 'aborting');
  const isRunning = completedCount < batch.calls.length || batch.calls.some((call) => call.message?.status === 'sending');
  const duration = formatRunDuration(batch.startedAt, batch.endedAt);
  const targetPreview = getToolTargetPreview(primaryCall?.toolArgs);
  const summary = batch.calls.length > 1
    ? t('toolBatchSummary', { label: display.label, count: batch.calls.length })
    : display.label;
  const statusText = errorCount > 0
    ? t('toolBatchErrors', { count: errorCount })
    : isAborting
      ? t('toolStatusAborting')
      : isRunning
        ? t('toolBatchProgress', { completed: completedCount, total: batch.calls.length })
        : duration
          ? duration
          : t('toolStatusDone');

  return (
    <div data-testid="chat-run-disclosure" data-tool-batch="true" className="flex justify-start py-0.5">
      <div className="min-w-0 w-full max-w-[90%]">
        <button
          type="button"
          data-testid="chat-run-disclosure-toggle"
          onClick={onToggle}
          className={cn(
            'group flex min-h-8 min-w-0 w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-1.5 text-left text-sm text-muted-foreground transition-colors',
            'hover:border-border/60 hover:bg-muted/35 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            expanded && 'border-border/60 bg-muted/25 text-foreground',
          )}
          aria-expanded={expanded}
        >
          <Icon className={cn('h-4 w-4 shrink-0', errorCount > 0 ? 'text-destructive' : 'text-muted-foreground')} />
          <span className="min-w-0 truncate font-medium">{summary}</span>
          {targetPreview ? (
            <span className="hidden min-w-0 max-w-[12rem] truncate text-xs text-muted-foreground/75 sm:inline">
              {targetPreview}
            </span>
          ) : null}
          <span className={cn(
            'ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/80',
            errorCount > 0 && 'text-destructive',
          )}>
            {statusText}
          </span>
          {errorCount > 0 ? (
            <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : isRunning || isAborting ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
          )}
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        </button>

        {expanded ? (
          <div data-testid="chat-run-steps" className="mb-2 ml-2 min-w-0 space-y-1 border-l border-border/70 py-1 pl-3 sm:ml-3 sm:pl-4">
            {batch.calls.map((call) => {
              const message = getToolBatchCallMessage(call);
              return (
                <div key={call.id} data-testid="chat-run-step" className="min-w-0 overflow-hidden">
                  <ToolCallPill
                    message={message}
                    onMediaClick={onMediaClick}
                    onAttachmentOpen={onAttachmentOpen}
                    previewGroup={call.message ? previewGroups?.get(call.message.id) : undefined}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
