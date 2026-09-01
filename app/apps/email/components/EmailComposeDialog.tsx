'use client';

import { useCallback, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { FileText, Loader2, Mail, Plus, Sparkles, Wrench, X } from 'lucide-react';

import { EmailAttachmentPanel } from '@/app/apps/email/components/EmailAttachmentPanel';
import { EmailMessageBody } from '@/app/apps/email/components/EmailMessageReader';
import {
  appendComposeRecipients,
  composeRecipientText,
  isValidComposeRecipient,
  mergeVisibleEmailAttachments,
  normalizeComposeRecipient,
  splitRecipientInput,
  visibleEmailAttachments,
} from '@/app/apps/email/components/email-compose-utils';
import { formatDate, formatRecipients } from '@/app/apps/email/components/email-client-format';
import type {
  EmailComposeAgentToolEvent,
  EmailComposeAgentUsedContext,
  EmailComposeDialogLabels,
  EmailComposeDraft,
  EmailComposeTone,
  WorkspaceInboxCase,
} from '@/app/apps/email/components/email-client-types';
import {
  ComposerReferencePicker,
  type ComposerReferencePickerItem,
} from '@/app/components/canvas-agent-chat/ComposerReferencePicker';
import type { FilePickerFile } from '@/app/components/canvas-agent-chat/ChatComposer';
import { findActiveComposerReference, replaceComposerReference, type ComposerReferenceMatch } from '@/app/lib/chat/composer-references';
import type { EmailAttachmentDraft } from '@/app/lib/email/attachment-types';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { listWorkspaceFileReferences } from '@/app/lib/files/client';
import { getToolDisplayInfo } from '@/app/lib/pi/tool-display';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { EmailHtmlEditor } from './EmailHtmlEditor';

const EMAIL_CONTEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'pdf']);

function fileExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

function isSupportedEmailContextFile(file: FilePickerFile | EmailComposeDraft['contextFiles'][number]): boolean {
  return file.type !== 'directory' && EMAIL_CONTEXT_FILE_EXTENSIONS.has(fileExtension(file.path || file.name || ''));
}

function contextFileName(file: EmailComposeDraft['contextFiles'][number]): string {
  return file.name || file.path.split('/').pop() || file.path;
}

function formatToolPreview(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 4)
    .map(([key, entry]) => `${key}: ${String(entry).slice(0, 80)}`)
    .join(', ');
}

function composeDialogTitle(draft: EmailComposeDraft, labels: EmailComposeDialogLabels): string {
  if (draft.mode === 'compose') return labels.composeNewTitle;
  if (draft.aiGenerated) return labels.composeAiReplyTitle;
  if (draft.mode === 'forward') return labels.composeForwardTitle;
  if (draft.mode === 'reply-all') return labels.composeReplyAllTitle;
  return labels.composeReplyTitle;
}

function EmailComposeAgentProgress({
  events,
  labels,
  locale,
  status,
  usedContext,
}: {
  events: EmailComposeAgentToolEvent[];
  labels: EmailComposeDialogLabels;
  locale: string;
  status: string | null;
  usedContext: EmailComposeAgentUsedContext[];
}) {
  if (!status && events.length === 0 && usedContext.length === 0) return null;

  return (
    <div className="space-y-2 border border-border bg-background px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 truncate">{status || labels.composeAgentReady}</span>
        </div>
        {events.some((event) => event.status === 'running') ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </div>
      {events.length > 0 ? (
        <div className="space-y-1.5">
          {events.map((event) => {
            const display = getToolDisplayInfo(event.toolName, locale);
            const preview = event.resultPreview || event.contextPath || formatToolPreview(event.args);
            return (
              <div key={event.id} className="flex items-start gap-2 border border-border/70 bg-muted/35 px-2 py-1.5">
                <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border border-border bg-background">
                  {event.status === 'running' ? (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  ) : (
                    <Wrench className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{event.label || display.label}</div>
                  {preview ? (
                    <div className="mt-0.5 line-clamp-2 break-words text-muted-foreground" title={preview}>
                      {preview}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {usedContext.length > 0 ? (
        <div className="border-t border-border pt-2">
          <div className="mb-1 font-medium text-muted-foreground">{labels.composeUsedContext}</div>
          <div className="flex flex-wrap gap-1.5">
            {usedContext.map((entry) => (
              <span
                key={entry.path}
                className="inline-flex max-w-full items-center gap-1 border border-border bg-muted/40 px-2 py-1"
                title={entry.reason || entry.path}
              >
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{entry.path}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EmailRecipientChipInput({
  disabled,
  id,
  onChange,
  value,
}: {
  disabled?: boolean;
  id: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draftValue, setDraftValue] = useState('');
  const recipients = useMemo(() => splitRecipientInput(value), [value]);

  const setRecipients = useCallback((nextRecipients: string[]) => {
    onChange(composeRecipientText(nextRecipients));
  }, [onChange]);

  const commitRecipients = useCallback((rawValue = draftValue) => {
    const additions = splitRecipientInput(rawValue);
    if (additions.length === 0) return false;
    setRecipients(appendComposeRecipients(recipients, additions));
    setDraftValue('');
    return true;
  }, [draftValue, recipients, setRecipients]);

  const handleDraftChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    if (!/[,\n;]/u.test(nextValue)) {
      setDraftValue(nextValue);
      return;
    }

    const hasTrailingDelimiter = /[,\n;]\s*$/u.test(nextValue);
    const parts = nextValue.split(/[,\n;]/u);
    const pendingValue = hasTrailingDelimiter ? '' : parts.pop() || '';
    const additions = parts.map(normalizeComposeRecipient).filter(Boolean);
    if (additions.length > 0) {
      setRecipients(appendComposeRecipients(recipients, additions));
    }
    setDraftValue(pendingValue);
  }, [recipients, setRecipients]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',' || event.key === ';') {
      if (draftValue.trim()) {
        event.preventDefault();
        commitRecipients();
      }
      return;
    }

    if (event.key === 'Backspace' && !draftValue && recipients.length > 0) {
      event.preventDefault();
      setRecipients(recipients.slice(0, -1));
    }
  }, [commitRecipients, draftValue, recipients, setRecipients]);

  const removeRecipient = useCallback((index: number) => {
    setRecipients(recipients.filter((_, recipientIndex) => recipientIndex !== index));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [recipients, setRecipients]);

  return (
    <div
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-1 border border-input bg-background px-2 py-1.5 text-sm focus-within:ring-1 focus-within:ring-ring',
        disabled && 'opacity-50',
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {recipients.map((recipient, index) => {
        const isValid = isValidComposeRecipient(recipient);
        return (
          <span
            key={`${recipient}:${index}`}
            className={cn(
              'inline-flex max-w-full items-center gap-1 border bg-muted/40 px-2 py-1 text-xs',
              isValid ? 'border-border text-foreground' : 'border-destructive/60 bg-destructive/10 text-destructive',
            )}
            aria-invalid={!isValid}
            title={recipient}
          >
            <span className="min-w-0 truncate">{recipient}</span>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground disabled:pointer-events-none"
              aria-label={`Remove ${recipient}`}
              onClick={(event) => {
                event.stopPropagation();
                removeRecipient(index);
              }}
              disabled={disabled}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <input
        id={id}
        ref={inputRef}
        value={draftValue}
        onBlur={() => {
          if (draftValue.trim()) commitRecipients();
        }}
        onChange={handleDraftChange}
        onKeyDown={handleKeyDown}
        placeholder={recipients.length === 0 ? 'email@example.com' : ''}
        disabled={disabled}
        className="min-w-[11rem] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function EmailComposeDialog({
  agentEvents,
  agentStatus,
  allowRemoteResourcesByDefault,
  allowedRemoteResourceSenders,
  draft,
  error,
  isGeneratingAi,
  isSubmitting,
  isWorkspaceOutboxReview,
  reviewCase,
  senderAddress,
  labels,
  locale,
  onAllowRemoteResourcesForSender,
  onClose,
  onGenerateAi,
  onSave,
  onSubmit,
  onUpdate,
}: {
  agentEvents: EmailComposeAgentToolEvent[];
  agentStatus: string | null;
  allowRemoteResourcesByDefault: boolean;
  allowedRemoteResourceSenders: string[];
  draft: EmailComposeDraft | null;
  error: string | null;
  isGeneratingAi: boolean;
  isSubmitting: boolean;
  isWorkspaceOutboxReview: boolean;
  reviewCase: WorkspaceInboxCase | null;
  senderAddress: string;
  labels: EmailComposeDialogLabels;
  locale: string;
  onAllowRemoteResourcesForSender(sender: string): void;
  onClose(): void;
  onGenerateAi(): void;
  onSave(): void;
  onSubmit(): void;
  onUpdate(updates: Partial<Pick<EmailComposeDraft, 'aiMode' | 'aiPrompt' | 'aiTone' | 'attachments' | 'body' | 'bodyHtml' | 'ccText' | 'contextFiles' | 'subject' | 'toText' | 'usedContext'>>): void;
}) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [isReferencePickerOpen, setIsReferencePickerOpen] = useState(false);
  const [activeReferenceMatch, setActiveReferenceMatch] = useState<ComposerReferenceMatch | null>(null);
  const [referencePickerItems, setReferencePickerItems] = useState<ComposerReferencePickerItem<FilePickerFile>[]>([]);
  const [referenceSearchQuery, setReferenceSearchQuery] = useState('');
  const [isReferencePickerLoading, setIsReferencePickerLoading] = useState(false);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState(0);
  const aiPromptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const referenceSearchInputRef = useRef<HTMLInputElement>(null);
  const referenceRequestIdRef = useRef(0);
  const selectedContextPaths = useMemo(() => new Set((draft?.contextFiles || []).map((file) => file.path)), [draft?.contextFiles]);
  const displayedAttachments = useMemo(() => visibleEmailAttachments(draft?.attachments || []), [draft?.attachments]);
  const updateDisplayedAttachments = useCallback((attachments: EmailAttachmentDraft[]) => {
    if (!draft) return;
    onUpdate({ attachments: mergeVisibleEmailAttachments(draft.attachments, attachments) });
  }, [draft, onUpdate]);

  const closeReferencePicker = useCallback(() => {
    referenceRequestIdRef.current += 1;
    setIsReferencePickerOpen(false);
    setActiveReferenceMatch(null);
    setReferencePickerItems([]);
    setReferenceSearchQuery('');
    setSelectedReferenceIndex(0);
    setIsReferencePickerLoading(false);
  }, []);

  const loadReferenceFiles = useCallback(async (query = '') => {
    const requestId = referenceRequestIdRef.current + 1;
    referenceRequestIdRef.current = requestId;
    setIsReferencePickerLoading(true);
    try {
      if (!activeWorkspaceId) throw new Error('Workspace context is not ready');
      const files = await listWorkspaceFileReferences({ query, limit: 50, workspaceId: activeWorkspaceId });
      if (requestId !== referenceRequestIdRef.current) return;
      const items = files
        .filter(isSupportedEmailContextFile)
        .filter((file) => !selectedContextPaths.has(file.path))
        .map((file) => ({
          id: `file:${file.path}`,
          kind: 'file' as const,
          icon: getFileIconComponent({ name: file.name, path: file.path, type: file.type }),
          label: file.path,
          payload: file,
          secondaryLabel: file.name,
        }));
      setReferencePickerItems(items);
      setSelectedReferenceIndex(0);
    } catch {
      if (requestId !== referenceRequestIdRef.current) return;
      setReferencePickerItems([]);
      setSelectedReferenceIndex(0);
    } finally {
      if (requestId === referenceRequestIdRef.current) setIsReferencePickerLoading(false);
    }
  }, [activeWorkspaceId, selectedContextPaths]);

  const selectReferenceFile = useCallback((item: ComposerReferencePickerItem<FilePickerFile>) => {
    const file = item.payload;
    if (!draft || !isSupportedEmailContextFile(file)) return;
    const currentAiPrompt = aiPromptTextareaRef.current?.value ?? draft.aiPrompt;
    let nextAiPrompt = currentAiPrompt;
    let nextCursorPosition: number | null = null;

    if (activeReferenceMatch) {
      const nextPrompt = replaceComposerReference(currentAiPrompt, activeReferenceMatch, `+\"${file.path}\" `);
      nextAiPrompt = nextPrompt.nextValue;
      nextCursorPosition = nextPrompt.nextCursorPosition;
    }

    onUpdate({
      aiPrompt: nextAiPrompt,
      contextFiles: selectedContextPaths.has(file.path)
        ? draft.contextFiles
        : [...draft.contextFiles, { isImage: file.isImage, name: file.name, path: file.path, type: file.type }],
      usedContext: [],
    });
    closeReferencePicker();

    if (nextCursorPosition !== null) {
      window.setTimeout(() => {
        aiPromptTextareaRef.current?.focus();
        aiPromptTextareaRef.current?.setSelectionRange(nextCursorPosition, nextCursorPosition);
      }, 0);
    }
  }, [activeReferenceMatch, closeReferencePicker, draft, onUpdate, selectedContextPaths]);

  const openManualReferencePicker = useCallback(() => {
    if (isReferencePickerOpen) {
      closeReferencePicker();
      return;
    }
    setActiveReferenceMatch(null);
    setReferenceSearchQuery('');
    setIsReferencePickerOpen(true);
    void loadReferenceFiles('');
    window.setTimeout(() => referenceSearchInputRef.current?.focus(), 0);
  }, [closeReferencePicker, isReferencePickerOpen, loadReferenceFiles]);

  const updateReferenceSearch = useCallback((value: string) => {
    setReferenceSearchQuery(value);
    void loadReferenceFiles(value);
  }, [loadReferenceFiles]);

  const handleReferenceSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedReferenceIndex((current) => Math.min(referencePickerItems.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedReferenceIndex((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = referencePickerItems[selectedReferenceIndex];
      if (item) selectReferenceFile(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeReferencePicker();
    }
  }, [closeReferencePicker, referencePickerItems, selectReferenceFile, selectedReferenceIndex]);

  const handleAiPromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const cursorPosition = event.target.selectionStart;
    onUpdate({ aiPrompt: value });

    if (!draft || draft.aiMode !== 'workspace-agent') {
      closeReferencePicker();
      return;
    }

    const match = findActiveComposerReference(value, cursorPosition);
    if (match?.kind === 'file' && match.trigger === '+') {
      setActiveReferenceMatch(match);
      setReferenceSearchQuery(match.query);
      setIsReferencePickerOpen(true);
      void loadReferenceFiles(match.query);
    } else if (activeReferenceMatch) {
      closeReferencePicker();
    }
  }, [activeReferenceMatch, closeReferencePicker, draft, loadReferenceFiles, onUpdate]);

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => {
      if (!open && !isSubmitting && !isGeneratingAi) onClose();
    }}>
      <DialogContent layout="viewport">
        {draft ? (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-10 sm:px-5">
              <DialogTitle className="text-base leading-6">
                {isWorkspaceOutboxReview ? labels.composeWorkspaceOutboxTitle : composeDialogTitle(draft, labels)}
              </DialogTitle>
              <DialogDescription className="text-xs leading-5 sm:text-sm">
                {isWorkspaceOutboxReview ? labels.composeWorkspaceOutboxDescription : labels.composeDescription}
              </DialogDescription>
              {senderAddress ? (
                <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="shrink-0 font-medium text-foreground">{labels.from}:</span>
                  <span className="min-w-0 truncate">{senderAddress}</span>
                </div>
              ) : null}
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
              {isWorkspaceOutboxReview && reviewCase ? (
                <section className="mb-3 rounded-lg border border-primary/15 bg-primary/[0.035] px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">{labels.composeOriginalTitle}</span>
                    <Badge variant="outline">{reviewCase.priority}</Badge>
                    <Badge variant="secondary">{reviewCase.status}</Badge>
                  </div>
                  <p className="mt-1.5 truncate font-medium">{reviewCase.requesterName || reviewCase.requesterAddress || reviewCase.subject}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{reviewCase.subject}</p>
                </section>
              ) : null}
              <div className={cn('grid min-h-full gap-3', draft.message && 'lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]')}>
                <section className="min-w-0 space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-to">{labels.to}</label>
                    <EmailRecipientChipInput id="email-compose-to" value={draft.toText} onChange={(value) => onUpdate({ toText: value })} disabled={isSubmitting} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-cc">{labels.cc}</label>
                    <EmailRecipientChipInput id="email-compose-cc" value={draft.ccText} onChange={(value) => onUpdate({ ccText: value })} disabled={isSubmitting} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-subject">{labels.subject}</label>
                    <Input id="email-compose-subject" value={draft.subject} onChange={(event) => onUpdate({ subject: event.target.value })} disabled={isSubmitting} />
                  </div>
                  <div className="space-y-2 border border-border bg-muted/30 px-3 py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-ai-prompt">{labels.composeAiPromptLabel}</label>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{draft.aiMode === 'workspace-agent' ? labels.composeAiModeWorkspaceAgent : labels.composeAiModeQuick}</span>
                        <Switch
                          checked={draft.aiMode === 'workspace-agent'}
                          onCheckedChange={(checked) => onUpdate({ aiMode: checked ? 'workspace-agent' : 'quick', usedContext: [] })}
                          disabled={isSubmitting || isGeneratingAi}
                          aria-label={labels.composeAiModeWorkspaceAgent}
                        />
                      </div>
                    </div>
                    <Textarea
                      id="email-compose-ai-prompt"
                      ref={aiPromptTextareaRef}
                      value={draft.aiPrompt}
                      onChange={handleAiPromptChange}
                      placeholder={labels.composeAiPromptPlaceholder}
                      className="min-h-20 resize-y bg-background"
                      disabled={isSubmitting || isGeneratingAi}
                    />
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{labels.composeToneLabel}</span>
                          <select
                            className="h-8 border border-input bg-background px-2 text-sm text-foreground"
                            value={draft.aiTone}
                            onChange={(event) => onUpdate({ aiTone: event.target.value as EmailComposeTone })}
                            disabled={isSubmitting || isGeneratingAi}
                          >
                            <option value="formal">{labels.composeToneFormal}</option>
                            <option value="casual">{labels.composeToneCasual}</option>
                            <option value="very-casual">{labels.composeToneVeryCasual}</option>
                          </select>
                        </label>
                        {draft.aiMode === 'workspace-agent' ? (
                          <div className="relative w-full sm:w-auto">
                            <Button type="button" variant="outline" size="sm" className="w-full justify-start sm:w-auto" onClick={openManualReferencePicker} disabled={isSubmitting || isGeneratingAi}>
                              <Plus className="mr-2 h-4 w-4" />{labels.composeAddContext}
                            </Button>
                            {isReferencePickerOpen ? (
                              <ComposerReferencePicker
                                className="min-w-[20rem] max-w-[min(32rem,calc(100vw-3rem))]"
                                emptyState={labels.composeReferencePickerEmpty}
                                header={labels.composeReferencePickerHeader}
                                isLoading={isReferencePickerLoading}
                                items={referencePickerItems}
                                onSelect={selectReferenceFile}
                                onSearchKeyDown={handleReferenceSearchKeyDown}
                                onSearchValueChange={updateReferenceSearch}
                                searchAutoFocus={!activeReferenceMatch}
                                searchInputRef={referenceSearchInputRef}
                                searchPlaceholder={labels.composeReferencePickerSearchPlaceholder}
                                searchValue={referenceSearchQuery}
                                selectedIndex={selectedReferenceIndex}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={onGenerateAi} disabled={isSubmitting || isGeneratingAi || !draft.aiPrompt.trim()}>
                        {isGeneratingAi ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                        {isGeneratingAi ? labels.composeGeneratingWithAi : labels.composeGenerateWithAi}
                      </Button>
                    </div>
                    {draft.aiMode === 'workspace-agent' && draft.contextFiles.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-xs font-medium text-muted-foreground">{labels.composeContextFiles}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {draft.contextFiles.map((file) => (
                            <span key={file.path} className="inline-flex max-w-full items-center gap-1.5 border border-border bg-background px-2 py-1 text-xs" title={file.path}>
                              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 truncate">{contextFileName(file)}</span>
                              <button
                                type="button"
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                aria-label={labels.composeRemoveContextFile}
                                title={labels.composeRemoveContextFile}
                                onClick={() => onUpdate({ contextFiles: draft.contextFiles.filter((entry) => entry.path !== file.path), usedContext: [] })}
                                disabled={isSubmitting || isGeneratingAi}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <EmailComposeAgentProgress
                      events={agentEvents}
                      labels={labels}
                      locale={locale}
                      status={agentStatus || (isGeneratingAi ? labels.composeAgentWorking : null)}
                      usedContext={draft.usedContext}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="email-compose-body">{labels.composeBodyLabel}</label>
                    <EmailHtmlEditor
                      attachments={draft.attachments}
                      id="email-compose-body"
                      value={draft.bodyHtml}
                      onChange={({ html, text }) => onUpdate({ body: text, bodyHtml: html })}
                      onAttachmentsChange={(attachments) => onUpdate({ attachments })}
                      placeholder={labels.composeBodyPlaceholder}
                      disabled={isSubmitting || isGeneratingAi}
                    />
                  </div>
                  <EmailAttachmentPanel attachments={displayedAttachments} disabled={isSubmitting || isGeneratingAi} labels={labels} onChange={updateDisplayedAttachments} />
                  {error ? <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><p className="break-words">{error}</p></div> : null}
                </section>

                {draft.message ? (
                  <section className="min-w-0 overflow-hidden border border-border bg-card">
                    <div className="border-b border-border px-3 py-3 sm:px-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{labels.composeOriginalTitle}</div>
                      <h3 className="mt-2 truncate text-base font-semibold">{draft.message.subject || labels.noSubject}</h3>
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <p className="truncate"><span className="font-medium text-foreground">{labels.from}:</span> {draft.message.from}</p>
                        {formatRecipients(draft.message.to) ? <p className="truncate"><span className="font-medium text-foreground">{labels.to}:</span> {formatRecipients(draft.message.to)}</p> : null}
                        {formatRecipients(draft.message.cc) ? <p className="truncate"><span className="font-medium text-foreground">{labels.cc}:</span> {formatRecipients(draft.message.cc)}</p> : null}
                        {draft.message.date ? <p className="truncate"><span className="font-medium text-foreground">{labels.date}:</span> {formatDate(draft.message.date)}</p> : null}
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
                ) : null}
              </div>
            </div>
            <DialogFooter className="shrink-0 border-t border-border px-4 py-3 sm:px-6">
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting || isGeneratingAi}>{labels.cancel}</Button>
              {isWorkspaceOutboxReview ? (
                <Button type="button" variant="outline" onClick={onSave} disabled={isSubmitting || isGeneratingAi}>
                  {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {isSubmitting ? labels.composeSavingDraft : labels.composeSaveDraft}
                </Button>
              ) : null}
              <Button type="button" onClick={onSubmit} disabled={isSubmitting || isGeneratingAi}>
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                {isSubmitting ? labels.composeSending : labels.composeSend}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
