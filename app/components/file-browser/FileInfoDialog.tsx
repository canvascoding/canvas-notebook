'use client';

import { FileText, Folder, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { workspaceHeaders } from '@/app/lib/files/client';
import { formatCompactFileDate, formatCompactFileSize } from '@/app/lib/files/format';
import { getFileFormat, getFileTitle } from '@/app/lib/files/metadata';
import type { FileNode } from '@/app/lib/files/types';

interface FileInfoDialogProps {
  node: FileNode | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FileInfoDialog({ node, open, onOpenChange }: FileInfoDialogProps) {
  const t = useTranslations('notebook');
  const locale = useLocale();
  const [file, setFile] = useState<FileNode | null>(node);

  useEffect(() => {
    if (!open || !node) return;
    const controller = new AbortController();
    fetch(`/api/files/info?path=${encodeURIComponent(node.path)}`, {
      headers: workspaceHeaders(),
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('File information could not be loaded');
        return response.json() as Promise<{ data?: FileNode }>;
      })
      .then((result) => {
        if (result.data) setFile(result.data);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // The information card remains useful with the metadata in the loaded tree.
        console.warn('[FileInfoDialog] Falling back to cached file metadata', error);
      });

    return () => controller.abort();
  }, [node, open]);

  const displayedFile = file?.path === node?.path ? file : node;
  const sizeLabel = displayedFile?.size === undefined
    ? t('fileInfoUnavailable')
    : `${formatCompactFileSize(displayedFile.size)} (${t('fileInfoBytes', {
        bytes: new Intl.NumberFormat(locale).format(displayedFile.size),
      })})`;
  const modifiedLabel = displayedFile?.modified === undefined
    ? t('fileInfoUnavailable')
    : formatCompactFileDate(displayedFile.modified, locale);
  const createdLabel = displayedFile?.created === undefined
    ? t('fileInfoUnavailable')
    : formatCompactFileDate(displayedFile.created, locale);
  const FileIcon = displayedFile?.type === 'directory' ? Folder : FileText;

  const fields = displayedFile ? [
    [t('fileInfoTitleLabel'), getFileTitle(displayedFile)],
    [t('fileInfoName'), displayedFile.name],
    [t('fileInfoFormat'), displayedFile.format || getFileFormat(displayedFile)],
    [t('fileInfoModified'), modifiedLabel],
    [t('fileInfoCreated'), createdLabel],
    [t('fileInfoSize'), sizeLabel],
  ] as const : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden p-0">
        <DialogHeader className="border-b border-border bg-muted/35 px-5 pb-4 pt-5 pr-12">
          <DialogTitle className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background shadow-sm">
              <Info className="h-4 w-4 text-muted-foreground" />
            </span>
            <span className="truncate">{t('fileInfoTitle')}</span>
          </DialogTitle>
          <DialogDescription>{t('fileInfoDescription')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2">
          <div className="flex min-w-0 items-center gap-3 border-b border-border/70 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <FileIcon className="h-4 w-4 text-muted-foreground" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium" title={displayedFile?.name}>{displayedFile?.name}</span>
              <span className="block text-xs text-muted-foreground">{displayedFile?.type === 'directory' ? t('folder') : t('file')}</span>
            </span>
          </div>

          <dl className="grid grid-cols-[minmax(7.5rem,auto)_minmax(0,1fr)] gap-x-5">
            {fields.map(([label, value], index) => (
              <div key={label} className="contents">
                <dt className={`py-3 text-sm text-muted-foreground ${index < fields.length - 1 ? 'border-b border-border/70' : ''}`}>
                  {label}
                </dt>
                <dd className={`min-w-0 py-3 text-sm font-medium ${index < fields.length - 1 ? 'border-b border-border/70' : ''} ${label === t('fileInfoSize') ? 'tabular-nums' : ''}`}>
                  <span className="block truncate" title={value}>{value}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <DialogFooter className="border-t border-border bg-muted/20 px-5 py-3">
          <Button type="button" onClick={() => onOpenChange(false)}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
