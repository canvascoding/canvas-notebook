'use client';

import {
  forwardRef,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { CircleHelp, FileText, Loader2, Paperclip, Settings, Square, Upload, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AttachmentPreviewItem } from '@/app/components/canvas-agent-chat/AttachmentPreviewItem';
import { ChatModelSelector } from '@/app/components/canvas-agent-chat/ChatModelSelector';
import { ChatQueuePanel } from '@/app/components/canvas-agent-chat/ChatQueuePanel';
import {
  ComposerReferencePicker,
  type ComposerReferencePickerItem,
} from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import { PlanModeToggle } from '@/app/components/canvas-agent-chat/PlanModeToggle';
import { SkillReferenceChipRow } from '@/app/components/canvas-agent-chat/SkillReferenceChips';
import { TypewriterPromptSuggestion } from '@/app/components/canvas-agent-chat/TypewriterPromptSuggestion';
import { useChatFileDrop } from '@/app/components/canvas-agent-chat/useChatFileDrop';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type {
  AiEffectiveRuntimeResolution,
  AiRuntimeSelection,
  AiRuntimeSelectionSource,
} from '@/app/lib/agent-runtime-policy/types';
import type { CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import type { Attachment, AttachmentOpenHandler, QueuePreviewItem } from '@/app/lib/chat/types';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

export type FilePickerFile = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isImage: boolean;
};

export type PluginPickerPlugin = {
  name: string;
  version: string;
  description: string;
  enabled?: boolean;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    category?: string;
    brandColor?: string;
    icon?: string;
    logo?: string;
    defaultPrompt?: string[];
  };
  skills?: Array<{
    name: string;
    title: string;
    description: string;
  }>;
};

export type SkillPickerSkill = Pick<CanvasSkill, 'name' | 'title' | 'description' | 'enabled' | 'core' | 'interface' | 'plugin'>;
export type ReferencePickerValue = FilePickerFile | PluginPickerPlugin | SkillPickerSkill;

export const ChatComposer = forwardRef<HTMLDivElement, {
  ariaHidden: boolean;
  isMobile: boolean;
  uploadError: string | null;
  onClearUploadError: () => void;
  isWebSocketUnavailable: boolean;
  showModelRequiredNotice: boolean;
  delegationPanel?: ReactNode;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  onAttachmentOpen: AttachmentOpenHandler;
  showQueuePanel: boolean;
  queueItems: QueuePreviewItem[];
  openQueueItemId: string | null;
  onOpenQueueItemChange: (entryId: string | null) => void;
  onPromoteQueuedMessage: (queueItemId: string) => void;
  onRemoveQueuedMessage: (queueItemId: string) => void;
  onEditQueuedMessage: (entry: QueuePreviewItem) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFilesDrop: (files: File[]) => void;
  onWorkspaceFilesDrop: (paths: string[]) => void;
  composerDisabled: boolean;
  isUploading: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  composerPlaceholderText: string;
  textareaHeight: number;
  planningMode: boolean;
  showReferencePicker: boolean;
  referencePickerEmptyState: string;
  referencePickerHeader: string;
  referencePickerItems: ComposerReferencePickerItem<ReferencePickerValue>[];
  onReferenceSelect: (item: ComposerReferencePickerItem<ReferencePickerValue>) => void;
  selectedReferenceIndex: number;
  primaryActionIsStop: boolean;
  primaryActionLabel: string;
  primaryActionDisabled: boolean;
  onStop: () => void | Promise<void>;
  onSend: () => void | Promise<void>;
  selectedAgentId: string;
  sessionId: string | null;
  runtimeSelection: AiRuntimeSelection | null;
  runtimeSelectionSource: AiRuntimeSelectionSource | null;
  runtimeResolution: AiEffectiveRuntimeResolution | null;
  runtimeSelectionError: string | null;
  hasLocalRuntimeSelection: boolean;
  modelSelectorDisabled: boolean;
  compactModelSelector: boolean;
  onRuntimeSelectionChange: (next: AiRuntimeSelection) => void;
  onRuntimeResolutionChange: (next: AiEffectiveRuntimeResolution) => void;
  onRuntimeResolutionRefresh: () => Promise<void> | void;
  onRuntimeStatusRefresh: () => Promise<void> | void;
  showComposerHint: boolean;
  onToggleComposerHint: () => void;
  composerHint: string;
  promptSuggestions: string[];
  showPromptSuggestions: boolean;
}>(function ChatComposer({
  ariaHidden,
  isMobile,
  uploadError,
  onClearUploadError,
  isWebSocketUnavailable,
  showModelRequiredNotice,
  delegationPanel,
  attachments,
  onRemoveAttachment,
  onAttachmentOpen,
  showQueuePanel,
  queueItems,
  openQueueItemId,
  onOpenQueueItemChange,
  onPromoteQueuedMessage,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  fileInputRef,
  onFileChange,
  onFilesDrop,
  onWorkspaceFilesDrop,
  composerDisabled,
  isUploading,
  textareaRef,
  input,
  onInputChange,
  onKeyDown,
  onPaste,
  composerPlaceholderText,
  textareaHeight,
  planningMode,
  showReferencePicker,
  referencePickerEmptyState,
  referencePickerHeader,
  referencePickerItems,
  onReferenceSelect,
  selectedReferenceIndex,
  primaryActionIsStop,
  primaryActionLabel,
  primaryActionDisabled,
  onStop,
  onSend,
  selectedAgentId,
  sessionId,
  runtimeSelection,
  runtimeSelectionSource,
  runtimeResolution,
  runtimeSelectionError,
  hasLocalRuntimeSelection,
  modelSelectorDisabled,
  compactModelSelector,
  onRuntimeSelectionChange,
  onRuntimeResolutionChange,
  onRuntimeResolutionRefresh,
  onRuntimeStatusRefresh,
  showComposerHint,
  onToggleComposerHint,
  composerHint,
  promptSuggestions,
  showPromptSuggestions,
}, ref) {
  const t = useTranslations('chat');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const { isDraggingFiles, isDraggingWorkspaceFiles, dropHandlers } = useChatFileDrop({
    disabled: composerDisabled,
    onFiles: onFilesDrop,
    onWorkspaceFiles: onWorkspaceFilesDrop,
    workspaceId: activeWorkspaceId,
  });
  const showTypewriterSuggestion = showPromptSuggestions && input.length === 0 && !isWebSocketUnavailable;

  return (
    <div
      ref={ref}
      aria-hidden={ariaHidden}
      className={cn(
        'absolute bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 px-3 pt-3',
        ariaHidden ? 'hidden' : null,
      )}
      style={{ paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom) + 0.75rem)' : '0.75rem' }}
    >
      {uploadError && (
        <div className="mb-2 flex items-center justify-between border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          <span>{uploadError}</span>
          <button type="button" onClick={onClearUploadError} className="ml-2 hover:opacity-70">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {isWebSocketUnavailable && (
        <div className="mb-2 border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100">
          <div className="font-medium">{t('liveUpdatesUnavailable')}</div>
          <div className="mt-1 text-[11px] opacity-80">{t('liveUpdatesUnavailableDescription')}</div>
        </div>
      )}

      {showModelRequiredNotice && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100">
          <div className="min-w-0">
            <div className="font-medium">{t('modelRequiredTitle')}</div>
            <div className="mt-1 text-[11px] opacity-80">{t('modelRequiredDescription')}</div>
          </div>
          <Link
            href="/settings?tab=agent-settings&panel=runtime"
            className="inline-flex shrink-0 items-center gap-1 border border-amber-500/40 bg-background/60 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Settings className="h-3 w-3" />
            {t('openAgentSettings')}
          </Link>
        </div>
      )}

      {delegationPanel}

      {attachments.length > 0 && (
        <div
          className={`mb-2 gap-2 border border-border bg-muted/60 p-2 ${
            isMobile ? 'flex overflow-x-auto no-scrollbar' : 'flex flex-wrap'
          }`}
        >
          {attachments.map((attachment, index) => (
            <AttachmentPreviewItem
              key={`${attachment.id || attachment.filePath || attachment.name}-${index}`}
              attachment={attachment}
              context="composer"
              previewGroup={attachments}
              onRemove={() => onRemoveAttachment(index)}
              onOpen={onAttachmentOpen}
            />
          ))}
        </div>
      )}

      {showQueuePanel && (
        <ChatQueuePanel
          items={queueItems}
          isMobile={isMobile}
          isWebSocketUnavailable={isWebSocketUnavailable}
          openItemId={openQueueItemId}
          onOpenItemChange={onOpenQueueItemChange}
          onPromote={onPromoteQueuedMessage}
          onRemove={onRemoveQueuedMessage}
          onEdit={onEditQueuedMessage}
        />
      )}

      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={composerDisabled}
          className="border border-transparent p-2.5 text-muted-foreground transition-colors hover:border-border hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          title={isUploading ? t('uploading') : t('attachImage')}
        >
          {isUploading
            ? <Loader2 className="h-5 w-5 animate-spin" />
            : <Paperclip className="h-5 w-5" />}
        </button>
        <input
          type="file"
          ref={fileInputRef}
          onChange={onFileChange}
          className="hidden"
          accept="image/*,application/pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html"
          multiple
        />
        <div className="relative flex-1 min-w-0">
          <div className="relative" {...dropHandlers}>
            <textarea
              ref={textareaRef}
              data-testid="chat-input"
              rows={1}
              value={input}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={composerPlaceholderText}
              style={{ height: `${textareaHeight}px` }}
              disabled={isWebSocketUnavailable}
              className={cn(
                'w-full resize-none border bg-background p-2.5 text-base placeholder:text-xs focus:outline-none focus:ring-1 md:text-sm sm:placeholder:text-sm',
                planningMode ? 'border-amber-500 focus:ring-amber-500' : 'border-border focus:ring-ring',
                isDraggingFiles || isDraggingWorkspaceFiles ? 'border-primary ring-2 ring-primary/30' : null,
                showTypewriterSuggestion ? 'placeholder:text-transparent' : 'placeholder:text-muted-foreground',
              )}
            />
            {showTypewriterSuggestion ? (
              <TypewriterPromptSuggestion
                suggestions={promptSuggestions}
                testId="chat-prompt-suggestion"
                className="left-0 right-0 top-0 overflow-hidden whitespace-nowrap px-2.5 py-2.5 text-base leading-normal md:text-sm"
              />
            ) : null}
            {isDraggingFiles || isDraggingWorkspaceFiles ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border border-primary bg-background/90 text-xs font-medium text-primary">
                <span className="inline-flex items-center gap-2">
                  {isDraggingWorkspaceFiles ? <FileText className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                  {isDraggingWorkspaceFiles ? t('dropWorkspaceReferencesHere') : t('dropFilesHere')}
                </span>
              </div>
            ) : null}
          </div>

          <SkillReferenceChipRow
            content={input}
            variant="composer"
            className="mt-1.5"
          />

          {showReferencePicker ? (
            <ComposerReferencePicker
              emptyState={referencePickerEmptyState}
              header={referencePickerHeader}
              items={referencePickerItems}
              onSelect={onReferenceSelect}
              selectedIndex={selectedReferenceIndex}
            />
          ) : null}
        </div>
        <button
          type="button"
          data-testid="chat-send"
          data-action={primaryActionIsStop ? 'stop' : 'send'}
          aria-label={primaryActionLabel}
          onClick={() => {
            if (primaryActionIsStop) {
              void onStop();
              return;
            }
            void onSend();
          }}
          className={cn(
            'flex-shrink-0 bg-primary p-2.5 text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-30',
          )}
          disabled={primaryActionDisabled}
          title={primaryActionLabel}
        >
          {primaryActionIsStop ? (
            <Square className="h-5 w-5 fill-current" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-5 w-5">
              <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
      <div className="mt-2 flex items-start justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <ChatModelSelector
              agentId={selectedAgentId}
              sessionId={sessionId}
              selection={runtimeSelection}
              selectionSource={runtimeSelectionSource}
              resolution={runtimeResolution}
              runtimeError={runtimeSelectionError}
              hasLocalSelection={hasLocalRuntimeSelection}
              disabled={modelSelectorDisabled}
              compact={compactModelSelector}
              onSelectionChange={onRuntimeSelectionChange}
              onResolutionChange={onRuntimeResolutionChange}
              onResolutionRefresh={onRuntimeResolutionRefresh}
              onRuntimeStatusRefresh={onRuntimeStatusRefresh}
            />
            <PlanModeToggle />
            <button
              type="button"
              data-testid="chat-composer-hint-toggle"
              aria-expanded={showComposerHint}
              onClick={onToggleComposerHint}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <CircleHelp className="h-3.5 w-3.5" />
              {t('hint')}
            </button>
          </div>
          {showComposerHint ? (
            <div className="max-w-[38rem] border border-border/60 bg-muted/30 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {composerHint}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
