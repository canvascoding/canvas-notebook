'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, FolderInput, Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { inboundEmailAttachmentPreviewItems } from '@/app/lib/email/attachment-preview';
import { useEmailAttachmentPreview } from './useEmailAttachmentPreview';

import { WorkspaceDestinationPicker } from '@/app/components/workspaces/WorkspaceDestinationPicker';
import { useFileStore } from '@/app/store/file-store';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { EmailMessageDetail, EmailMessageViewerLabels } from './email-client-types';

type EmailAttachment = NonNullable<EmailMessageDetail['attachments']>[number];

type EmailAttachmentActionLabels = Pick<
  EmailMessageViewerLabels,
  | 'attachmentActions'
  | 'attachmentUnavailable'
  | 'attachments'
  | 'attachmentsSaveFailed'
  | 'attachmentsSaved'
  | 'cancel'
  | 'downloadAllAttachments'
  | 'downloadAttachment'
  | 'downloadLocally'
  | 'saveAttachmentsDescription'
  | 'saveAttachmentsSubmit'
  | 'saveAttachmentsTitle'
  | 'saveToWorkspace'
  | 'savingAttachments'
  | 'unknownAttachmentType'
>;

function attachmentEndpoint(accountId: string, messageId: string, folder?: string, mailboxWorkspaceId?: string | null) {
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  if (mailboxWorkspaceId) params.set('mailboxWorkspaceId', mailboxWorkspaceId);
  const base = `/api/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/attachments`;
  return params.size ? `${base}?${params.toString()}` : base;
}

function attachmentDownloadUrl(accountId: string, messageId: string, attachmentId: string, folder?: string, mailboxWorkspaceId?: string | null) {
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  if (mailboxWorkspaceId) params.set('mailboxWorkspaceId', mailboxWorkspaceId);
  const base = `${attachmentEndpoint(accountId, messageId)}/${encodeURIComponent(attachmentId)}`;
  return params.size ? `${base}?${params.toString()}` : base;
}

function compactByteSize(size: number | null | undefined) {
  return typeof size === 'number'
    ? new Intl.NumberFormat(undefined, {
        style: 'unit',
        unit: 'byte',
        unitDisplay: 'short',
        notation: 'compact',
      }).format(size)
    : '';
}

export function EmailAttachmentActions({
  accountId,
  mailboxWorkspaceId,
  onMailboxAccessChanged,
  attachments,
  folder,
  labels,
  messageId,
}: {
  accountId?: string;
  mailboxWorkspaceId?: string | null;
  onMailboxAccessChanged?(): void;
  attachments: EmailAttachment[];
  folder?: string;
  labels: EmailAttachmentActionLabels;
  messageId: string;
}) {
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const previewItems = useMemo(() => inboundEmailAttachmentPreviewItems({ accountId, messageId, folder, workspaceId: mailboxWorkspaceId, attachments }), [accountId, messageId, folder, mailboxWorkspaceId, attachments]);
  const preview = useEmailAttachmentPreview(previewItems, JSON.stringify([accountId, mailboxWorkspaceId, messageId, folder]), onMailboxAccessChanged);
  const refreshDirectory = useFileStore((state) => state.refreshDirectory);
  const downloadableAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.downloadable !== false && Boolean(attachment.id)),
    [attachments],
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState('.');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(activeWorkspace?.id ?? null);
  const [isSaving, setIsSaving] = useState(false);
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const saveRequestId = useRef(0);
  const sourceContext = JSON.stringify([activeWorkspace?.id ?? null, accountId, mailboxWorkspaceId, messageId, folder]);
  const previousSourceContext = useRef(sourceContext);

  useEffect(() => {
    if (previousSourceContext.current === sourceContext) return;
    previousSourceContext.current = sourceContext;
    // Attachment IDs belong to the message that opened the save dialog.
    setSaveOpen(false);
    setSelectedAttachmentIds([]);
  }, [sourceContext]);

  useEffect(() => {
    saveRequestId.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsSaving(false);
    return () => { saveRequestId.current += 1; };
  }, [saveOpen, sourceContext]);

  const openWorkspaceSave = (attachmentIds: string[]) => {
    if (isSaving || creatingDirectory) return;
    setSelectedAttachmentIds(attachmentIds);
    setSelectedDir('.');
    setTargetWorkspaceId(activeWorkspace?.id ?? null);
    setSaveOpen(true);
  };

  const saveToWorkspace = async () => {
    if (!saveOpen || !accountId || !targetWorkspaceId || isSaving || creatingDirectory || selectedAttachmentIds.length === 0) return;
    const sourceWorkspaceId = activeWorkspace?.id ?? null;
    if (useWorkspaceStore.getState().activeWorkspaceId !== sourceWorkspaceId) return;
    const requestId = ++saveRequestId.current;
    const targetId = targetWorkspaceId;
    const targetDirectory = selectedDir;
    const attachmentIds = [...selectedAttachmentIds];
    const current = () => requestId === saveRequestId.current
      && useWorkspaceStore.getState().activeWorkspaceId === sourceWorkspaceId;
    setIsSaving(true);
    try {
      const response = await fetch(attachmentEndpoint(accountId, messageId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailboxWorkspaceId,
          attachmentIds,
          folder,
          targetPath: targetDirectory,
          targetWorkspaceId: targetId,
        }),
      });
      if (current() && (response.status === 403 || response.status === 409)) onMailboxAccessChanged?.();
      const payload = await response.json() as { error?: string; savedCount?: number; success?: boolean };
      if (!current()) return;
      if (!response.ok || !payload.success) throw new Error(payload.error || labels.attachmentsSaveFailed);
      const savedCount = typeof payload.savedCount === 'number' ? payload.savedCount : attachmentIds.length;
      if (targetId === sourceWorkspaceId) await refreshDirectory(targetDirectory, true, targetId);
      if (!current()) return;
      toast.success(labels.attachmentsSaved.replace('{count}', String(savedCount)));
      setSaveOpen(false);
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : labels.attachmentsSaveFailed);
    } finally {
      if (current()) setIsSaving(false);
    }
  };

  const allAttachmentIds = downloadableAttachments.map((attachment) => attachment.id);
  const allDownloadUrl = accountId ? attachmentEndpoint(accountId, messageId, folder, mailboxWorkspaceId) : null;

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" />
          {labels.attachments}
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{attachments.length}</span>
        </div>
        {downloadableAttachments.length > 1 && accountId ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="outline">
                <Download className="h-4 w-4" />
                {labels.downloadAllAttachments}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem asChild>
                <a href={allDownloadUrl!} download="email-attachments.zip">
                  <Download className="h-4 w-4" />
                  {labels.downloadLocally}
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openWorkspaceSave(allAttachmentIds)}>
                <FolderInput className="h-4 w-4" />
                {labels.saveToWorkspace}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {attachments.map((attachment, index) => {
          const canDownload = attachment.downloadable !== false && Boolean(accountId && attachment.id);
          const downloadUrl = canDownload
            ? attachmentDownloadUrl(accountId!, messageId, attachment.id, folder, mailboxWorkspaceId)
            : null;
          const sizeLabel = compactByteSize(attachment.size);
          return (
            <div key={attachment.id || attachment.filename} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <button type="button" data-testid="email-attachment-preview-trigger" data-attachment-id={previewItems[index].id}
                  aria-label={preview.openLabel(attachment.filename)} disabled={!preview.canOpen}
                  className="block max-w-full truncate text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => preview.openAttachment(previewItems[index].id)}>{attachment.filename}</button>
                <div className="text-xs text-muted-foreground">
                  {[attachment.contentType || labels.unknownAttachmentType, sizeLabel].filter(Boolean).join(' · ')}
                </div>
              </div>
              {canDownload ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" size="sm" variant="outline" aria-label={labels.attachmentActions}>
                      <Download className="h-4 w-4" />
                      {labels.downloadAttachment}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem asChild>
                      <a href={downloadUrl!} download={attachment.filename}>
                        <Download className="h-4 w-4" />
                        {labels.downloadLocally}
                      </a>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openWorkspaceSave([attachment.id])}>
                      <FolderInput className="h-4 w-4" />
                      {labels.saveToWorkspace}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="text-xs text-muted-foreground">{labels.attachmentUnavailable}</span>
              )}
            </div>
          );
        })}
      </div>

      <Dialog
        open={saveOpen}
        onOpenChange={(nextOpen) => {
          if ((!isSaving && !creatingDirectory) || nextOpen) setSaveOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-xl max-h-[calc(100dvh-3rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{labels.saveAttachmentsTitle}</DialogTitle>
            <DialogDescription>
              {labels.saveAttachmentsDescription.replace('{count}', String(selectedAttachmentIds.length))}
            </DialogDescription>
          </DialogHeader>
          <WorkspaceDestinationPicker
            key={sourceContext}
            selectedWorkspaceId={targetWorkspaceId}
            selectedDir={selectedDir}
            onWorkspaceChange={setTargetWorkspaceId}
            onDirChange={setSelectedDir}
            disabled={isSaving}
            onCreatingDirectoryChange={setCreatingDirectory}
          />
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={isSaving || creatingDirectory} onClick={() => setSaveOpen(false)}>
              {labels.cancel}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={isSaving || creatingDirectory || !targetWorkspaceId || selectedAttachmentIds.length === 0}
              onClick={() => void saveToWorkspace()}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
              {isSaving ? labels.savingAttachments : labels.saveAttachmentsSubmit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {preview.dialog}
    </div>
  );
}
