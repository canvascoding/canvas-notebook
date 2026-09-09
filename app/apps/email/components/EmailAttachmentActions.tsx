'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Download, FolderInput, Loader2, Paperclip } from 'lucide-react';
import { toast } from 'sonner';

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

function attachmentEndpoint(accountId: string, messageId: string, folder?: string) {
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  const base = `/api/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/attachments`;
  return params.size ? `${base}?${params.toString()}` : base;
}

function attachmentDownloadUrl(accountId: string, messageId: string, attachmentId: string, folder?: string) {
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
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
  attachments,
  folder,
  labels,
  messageId,
}: {
  accountId?: string;
  attachments: EmailAttachment[];
  folder?: string;
  labels: EmailAttachmentActionLabels;
  messageId: string;
}) {
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
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

  const openWorkspaceSave = (attachmentIds: string[]) => {
    setSelectedAttachmentIds(attachmentIds);
    setSelectedDir('.');
    setTargetWorkspaceId(activeWorkspace?.id ?? null);
    setSaveOpen(true);
  };

  const saveToWorkspace = async () => {
    if (!accountId || !targetWorkspaceId || selectedAttachmentIds.length === 0) return;
    setIsSaving(true);
    try {
      const response = await fetch(attachmentEndpoint(accountId, messageId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachmentIds: selectedAttachmentIds,
          folder,
          targetPath: selectedDir,
          targetWorkspaceId,
        }),
      });
      const payload = await response.json() as { error?: string; savedCount?: number; success?: boolean };
      if (!response.ok || !payload.success) throw new Error(payload.error || labels.attachmentsSaveFailed);
      const savedCount = typeof payload.savedCount === 'number' ? payload.savedCount : selectedAttachmentIds.length;
      if (targetWorkspaceId === activeWorkspace?.id) await refreshDirectory(selectedDir, true);
      toast.success(labels.attachmentsSaved.replace('{count}', String(savedCount)));
      setSaveOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.attachmentsSaveFailed);
    } finally {
      setIsSaving(false);
    }
  };

  const allAttachmentIds = downloadableAttachments.map((attachment) => attachment.id);
  const allDownloadUrl = accountId ? attachmentEndpoint(accountId, messageId, folder) : null;

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
        {attachments.map((attachment) => {
          const canDownload = attachment.downloadable !== false && Boolean(accountId && attachment.id);
          const downloadUrl = canDownload
            ? attachmentDownloadUrl(accountId!, messageId, attachment.id, folder)
            : null;
          const sizeLabel = compactByteSize(attachment.size);
          return (
            <div key={attachment.id || attachment.filename} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{attachment.filename}</div>
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
          if (!isSaving || nextOpen) setSaveOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{labels.saveAttachmentsTitle}</DialogTitle>
            <DialogDescription>
              {labels.saveAttachmentsDescription.replace('{count}', String(selectedAttachmentIds.length))}
            </DialogDescription>
          </DialogHeader>
          <WorkspaceDestinationPicker
            selectedWorkspaceId={targetWorkspaceId}
            selectedDir={selectedDir}
            onWorkspaceChange={setTargetWorkspaceId}
            onDirChange={setSelectedDir}
          />
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={isSaving} onClick={() => setSaveOpen(false)}>
              {labels.cancel}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={isSaving || !targetWorkspaceId || selectedAttachmentIds.length === 0}
              onClick={() => void saveToWorkspace()}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
              {isSaving ? labels.savingAttachments : labels.saveAttachmentsSubmit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
