'use client';

import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { CheckSquare2, Loader2, Paperclip, RefreshCw, Search, Square, Upload, X } from 'lucide-react';

import type { FilePickerFile } from '@/app/components/canvas-agent-chat/ChatComposer';
import { ImageThumbnailIcon } from '@/app/components/shared/ImageThumbnailIcon';
import {
  EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
  emailAttachmentLimitUsageBytes,
  formatEmailAttachmentSize,
  inferEmailAttachmentMimeType,
  type EmailAttachmentDraft,
} from '@/app/lib/email/attachment-types';
import { getFileIconComponent, isImageFile } from '@/app/lib/files/file-icons';
import { toUploadPreviewUrl } from '@/app/lib/utils/media-url';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type WorkspaceAttachmentFile = FilePickerFile & {
  size?: number;
};

export type EmailAttachmentPanelLabels = {
  attachmentsAdd: string;
  attachmentsAttached: string;
  attachmentsCancel: string;
  attachmentsConfirm: string;
  attachmentsDialogDescription: string;
  attachmentsDialogTitle: string;
  attachmentsEmpty: string;
  attachmentsLimitExceeded: string;
  attachmentsLoading: string;
  attachmentsRefresh: string;
  attachmentsRemove: string;
  attachmentsSearchPlaceholder: string;
  attachmentsSelectFiles: string;
  attachmentsTabUpload: string;
  attachmentsTabWorkspace: string;
  attachmentsUploadDrop: string;
  attachmentsUploadHint: string;
  attachmentsUsageLabel: string;
};

type EmailAttachmentPanelProps = {
  attachments: EmailAttachmentDraft[];
  disabled?: boolean;
  labels: EmailAttachmentPanelLabels;
  onChange: (attachments: EmailAttachmentDraft[]) => void;
};

type UploadResponse = {
  success: boolean;
  error?: string;
  files?: EmailAttachmentDraft[];
};

function attachmentKey(attachment: Pick<EmailAttachmentDraft, 'id' | 'path' | 'source' | 'uploadId'>): string {
  if (attachment.id) return attachment.id;
  if (attachment.source === 'workspace') return `workspace:${attachment.path || ''}`;
  return `upload:${attachment.uploadId || ''}`;
}

function makeWorkspaceAttachment(file: WorkspaceAttachmentFile): EmailAttachmentDraft {
  return {
    id: `workspace:${file.path}`,
    source: 'workspace',
    name: file.name || file.path.split('/').pop() || file.path,
    mimeType: inferEmailAttachmentMimeType(file.name || file.path),
    size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0,
    path: file.path,
  };
}

function mergeAttachments(current: EmailAttachmentDraft[], additions: EmailAttachmentDraft[]): EmailAttachmentDraft[] {
  const byKey = new Map(current.map((attachment) => [attachmentKey(attachment), attachment]));
  for (const attachment of additions) {
    byKey.set(attachmentKey(attachment), attachment);
  }
  return Array.from(byKey.values());
}

function isImageAttachment(attachment: EmailAttachmentDraft): boolean {
  return attachment.mimeType.startsWith('image/') || isImageFile(attachment.name) || Boolean(attachment.path && isImageFile(attachment.path));
}

function AttachmentIcon({ attachment }: { attachment: EmailAttachmentDraft }) {
  const [hasUploadPreviewError, setHasUploadPreviewError] = useState(false);
  const fallbackIcon = getFileIconComponent({
    name: attachment.name,
    path: attachment.path || attachment.name,
    type: 'file',
    className: 'h-4 w-4',
  });

  if (attachment.source === 'workspace' && attachment.path && isImageAttachment(attachment)) {
    return (
      <ImageThumbnailIcon
        path={attachment.path}
        name={attachment.name}
        className="h-7 w-7"
        fallbackIcon={fallbackIcon}
      />
    );
  }

  if (attachment.source === 'upload' && attachment.uploadId && isImageAttachment(attachment) && !hasUploadPreviewError) {
    return (
      <span className="block h-7 w-7 shrink-0 overflow-hidden border border-border/70 bg-muted/40">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={toUploadPreviewUrl(attachment.uploadId, 64, { preset: 'mini' })}
          alt={attachment.name}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setHasUploadPreviewError(true)}
        />
      </span>
    );
  }

  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border/70 bg-muted/30">
      {fallbackIcon}
    </span>
  );
}

function AttachmentRow({
  attachment,
  isSelected,
  onClick,
}: {
  attachment: EmailAttachmentDraft;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  const rowClassName = cn(
    'flex w-full min-w-0 items-center gap-2 border border-border bg-background px-2 py-1.5 text-left text-xs',
    onClick ? 'transition hover:border-primary/50 hover:bg-muted/60' : null,
    isSelected ? 'border-primary bg-primary/5 text-primary' : null,
  );
  const rowContent = (
    <>
      {onClick ? (
        isSelected ? <CheckSquare2 className="h-4 w-4 shrink-0" /> : <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : null}
      <AttachmentIcon attachment={attachment} />
      <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{formatEmailAttachmentSize(attachment.size)}</span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={rowClassName} title={attachment.path || attachment.name}>
        {rowContent}
      </button>
    );
  }

  return (
    <div className={rowClassName} title={attachment.path || attachment.name}>
      {rowContent}
    </div>
  );
}

export function EmailAttachmentPanel({ attachments, disabled = false, labels, onChange }: EmailAttachmentPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'workspace' | 'upload'>('workspace');
  const [search, setSearch] = useState('');
  const [workspaceFiles, setWorkspaceFiles] = useState<EmailAttachmentDraft[]>([]);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EmailAttachmentDraft[]>([]);

  const usage = emailAttachmentLimitUsageBytes(attachments);
  const selectedPreview = useMemo(() => mergeAttachments(attachments, selected), [attachments, selected]);
  const selectedUsage = emailAttachmentLimitUsageBytes(selectedPreview);
  const isSelectionOverLimit = selectedUsage > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES;

  const loadWorkspaceFiles = useCallback(async (query = search) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setIsWorkspaceLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (query.trim()) params.set('q', query.trim());
      const response = await fetch(`/api/files/list?${params.toString()}`, { credentials: 'include', cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (requestId !== requestIdRef.current) return;
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Failed to load files');
      const files = Array.isArray(payload.files) ? payload.files as WorkspaceAttachmentFile[] : [];
      setWorkspaceFiles(files.filter((file) => file.type === 'file').map(makeWorkspaceAttachment));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setWorkspaceFiles([]);
      setError(err instanceof Error ? err.message : 'Failed to load files');
    } finally {
      if (requestId === requestIdRef.current) setIsWorkspaceLoading(false);
    }
  }, [search]);

  const openAttachmentDialog = useCallback(() => {
    setSelected([]);
    setSearch('');
    setError(null);
    setOpen(true);
    void loadWorkspaceFiles('');
  }, [loadWorkspaceFiles]);

  const toggleSelected = useCallback((attachment: EmailAttachmentDraft) => {
    setError(null);
    setSelected((current) => {
      const key = attachmentKey(attachment);
      if (current.some((item) => attachmentKey(item) === key)) {
        return current.filter((item) => attachmentKey(item) !== key);
      }
      const next = [...current, attachment];
      if (emailAttachmentLimitUsageBytes(mergeAttachments(attachments, next)) > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
        setError(labels.attachmentsLimitExceeded);
        return current;
      }
      return next;
    });
  }, [attachments, labels.attachmentsLimitExceeded]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    setError(null);
    try {
      const optimistic = files.map((file) => ({
        id: `pending:${file.name}:${file.size}`,
        source: 'upload' as const,
        name: file.name,
        mimeType: inferEmailAttachmentMimeType(file.name, file.type),
        size: file.size,
      }));
      if (emailAttachmentLimitUsageBytes(mergeAttachments(attachments, [...selected, ...optimistic])) > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
        throw new Error(labels.attachmentsLimitExceeded);
      }

      const formData = new FormData();
      files.forEach((file) => formData.append('files', file, file.name));
      const response = await fetch('/api/email/attachments/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({})) as UploadResponse;
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Upload failed');
      const uploaded = Array.isArray(payload.files) ? payload.files : [];
      setSelected((current) => mergeAttachments(current, uploaded));
      setTab('workspace');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [attachments, labels.attachmentsLimitExceeded, selected]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(event.dataTransfer.files || []);
    void uploadFiles(files);
  }, [uploadFiles]);

  const removeAttachment = useCallback((attachment: EmailAttachmentDraft) => {
    const key = attachmentKey(attachment);
    onChange(attachments.filter((item) => attachmentKey(item) !== key));
  }, [attachments, onChange]);

  const confirmSelection = useCallback(() => {
    const next = mergeAttachments(attachments, selected);
    if (emailAttachmentLimitUsageBytes(next) > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
      setError(labels.attachmentsLimitExceeded);
      return;
    }
    onChange(next);
    setOpen(false);
  }, [attachments, labels.attachmentsLimitExceeded, onChange, selected]);

  return (
    <section className="space-y-2 border border-border bg-muted/20 px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{labels.attachmentsAttached}</div>
          <div className={cn('mt-0.5 text-xs', usage > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES ? 'text-destructive' : 'text-muted-foreground')}>
            {labels.attachmentsUsageLabel.replace('{used}', formatEmailAttachmentSize(usage)).replace('{limit}', formatEmailAttachmentSize(EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES))}
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={openAttachmentDialog} disabled={disabled}>
          <Paperclip className="mr-2 h-4 w-4" />
          {labels.attachmentsAdd}
        </Button>
      </div>

      {attachments.length > 0 ? (
        <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
          {attachments.map((attachment) => (
            <div key={attachmentKey(attachment)} className="flex min-w-0 items-center gap-1">
              <AttachmentRow attachment={attachment} />
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground hover:text-destructive disabled:opacity-50"
                aria-label={labels.attachmentsRemove}
                title={labels.attachmentsRemove}
                onClick={() => removeAttachment(attachment)}
                disabled={disabled}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{labels.attachmentsDialogTitle}</DialogTitle>
            <DialogDescription>{labels.attachmentsDialogDescription}</DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(value) => setTab(value as 'workspace' | 'upload')} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="workspace">{labels.attachmentsTabWorkspace}</TabsTrigger>
              <TabsTrigger value="upload">{labels.attachmentsTabUpload}</TabsTrigger>
            </TabsList>

            <TabsContent value="workspace" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex gap-2 py-3">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      void loadWorkspaceFiles(event.target.value);
                    }}
                    placeholder={labels.attachmentsSearchPlaceholder}
                    className="pl-8"
                  />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => { void loadWorkspaceFiles(search); }} disabled={isWorkspaceLoading}>
                  <RefreshCw className={cn('mr-2 h-4 w-4', isWorkspaceLoading && 'animate-spin')} />
                  {labels.attachmentsRefresh}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto border border-border bg-background p-2">
                {isWorkspaceLoading ? (
                  <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {labels.attachmentsLoading}
                  </div>
                ) : workspaceFiles.length === 0 ? (
                  <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">{labels.attachmentsEmpty}</div>
                ) : (
                  <div className="space-y-1">
                    {workspaceFiles.map((attachment) => {
                      const key = attachmentKey(attachment);
                      const isSelected = selected.some((item) => attachmentKey(item) === key)
                        || attachments.some((item) => attachmentKey(item) === key);
                      return (
                        <AttachmentRow
                          key={key}
                          attachment={attachment}
                          isSelected={isSelected}
                          onClick={() => toggleSelected(attachment)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="upload" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
              <div
                className={cn(
                  'flex min-h-64 flex-1 flex-col items-center justify-center gap-4 border border-dashed bg-background p-6 text-center',
                  isDragOver ? 'border-primary bg-primary/5' : 'border-border',
                )}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.dataTransfer.types.includes('Files')) setIsDragOver(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setIsDragOver(false);
                }}
                onDrop={handleDrop}
              >
                <Upload className="h-7 w-7 text-muted-foreground" />
                <div>
                  <div className="text-sm font-medium text-foreground">{isDragOver ? labels.attachmentsUploadDrop : labels.attachmentsUploadHint}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {labels.attachmentsUsageLabel.replace('{used}', formatEmailAttachmentSize(selectedUsage)).replace('{limit}', formatEmailAttachmentSize(EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES))}
                  </div>
                </div>
                <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
                  {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {labels.attachmentsSelectFiles}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    void uploadFiles(files);
                    event.target.value = '';
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>

          {selected.length > 0 ? (
            <div className="max-h-28 shrink-0 space-y-1 overflow-y-auto border-t border-border pt-3">
              {selected.map((attachment) => (
                <AttachmentRow key={attachmentKey(attachment)} attachment={attachment} isSelected />
              ))}
            </div>
          ) : null}

          {error ? <p className="shrink-0 text-sm text-destructive">{error}</p> : null}

          <DialogFooter className="shrink-0 items-center justify-between gap-2 sm:justify-between">
            <div className={cn('text-xs', isSelectionOverLimit ? 'text-destructive' : 'text-muted-foreground')}>
              {labels.attachmentsUsageLabel.replace('{used}', formatEmailAttachmentSize(selectedUsage)).replace('{limit}', formatEmailAttachmentSize(EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES))}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {labels.attachmentsCancel}
              </Button>
              <Button type="button" disabled={selected.length === 0 || isSelectionOverLimit || isUploading} onClick={confirmSelection}>
                {labels.attachmentsConfirm}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
