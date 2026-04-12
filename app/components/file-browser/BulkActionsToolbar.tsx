'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Move, Trash2, Download, X, CheckSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFileStore } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';

interface BulkActionsToolbarProps {
  className?: string;
}

export function BulkActionsToolbar({ className }: BulkActionsToolbarProps) {
  const t = useTranslations('notebook');
  const {
    multiSelectPaths,
    clearMultiSelect,
    deletePath,
    downloadFile,
  } = useFileStore();

  const selectedCount = multiSelectPaths.length;

  const hasProtected = useMemo(() => {
    return multiSelectPaths.some(path => isProtectedAppOutputFolder(path));
  }, [multiSelectPaths]);

  const handleDelete = async () => {
    const pathsToDelete = multiSelectPaths.filter(path => !isProtectedAppOutputFolder(path));
    const protectedCount = multiSelectPaths.length - pathsToDelete.length;

    if (pathsToDelete.length === 0) {
      toast.error(t('protectedFoldersDeleteOnly'));
      return;
    }

    const confirmMessage = protectedCount > 0
      ? t('deleteItemsConfirmWithSkipped', { count: selectedCount, skipped: protectedCount })
      : t('deleteItemsConfirm', { count: selectedCount });

    const confirmed = window.confirm(confirmMessage);
    if (!confirmed) return;

    try {
      await deletePath(pathsToDelete);
      if (protectedCount > 0) {
        toast.info(t('protectedFoldersSkipped', { count: protectedCount }));
      }
    } catch (error) {
      console.error('Failed to delete multiple files:', error);
    }
  };

  const handleDownload = async () => {
    for (const path of multiSelectPaths) {
      try {
        await downloadFile(path);
      } catch (error) {
        console.error(`Failed to download ${path}:`, error);
      }
    }
    toast.success(t('download'));
  };

  const handleMove = () => {
    if (hasProtected) {
      toast.error(t('protectedFolderMove'));
      return;
    }
    window.dispatchEvent(new CustomEvent('notebook-bulk-move-open'));
  };

  if (selectedCount === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        'absolute bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm [@media(max-width:280px)]:flex-col',
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium shrink-0">
        <CheckSquare className="h-4 w-4 text-primary" />
        <span>{t('selectedCount', { count: selectedCount })}</span>
      </div>

      <div className="h-4 w-px bg-border shrink-0 hidden [@media(min-width:281px)]:block" />

      <div className="flex flex-wrap items-center justify-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleMove}
          disabled={hasProtected}
          className="h-8 px-2"
          title={t('move')}
        >
          <Move className="h-4 w-4" />
          <span className="ml-1">{t('move')}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          className="h-8 px-2"
          title={t('download')}
        >
          <Download className="h-4 w-4" />
          <span className="ml-1">{t('download')}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          disabled={hasProtected}
          className="h-8 px-2 text-destructive hover:text-destructive"
          title={t('delete')}
        >
          <Trash2 className="h-4 w-4" />
          <span className="ml-1">{t('delete')}</span>
        </Button>
      </div>

      <div className="h-4 w-px bg-border shrink-0 hidden [@media(min-width:281px)]:block" />

      <Button
        variant="ghost"
        size="sm"
        onClick={clearMultiSelect}
        className="h-8 px-2 shrink-0"
        title={t('cancel')}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
