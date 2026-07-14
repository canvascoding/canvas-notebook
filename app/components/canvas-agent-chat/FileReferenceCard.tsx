'use client';

import React from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ImageThumbnailIcon } from '@/app/components/shared/ImageThumbnailIcon';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent, isImageFile } from '@/app/lib/files/file-icons';
import { normalizeChatFilePath, type FilePathEntry } from '@/app/lib/chat/extract-file-paths';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useOpenChatFileReference } from '@/app/components/canvas-agent-chat/useOpenChatFileReference';
import { useChatFileReferenceValidation } from '@/app/components/canvas-agent-chat/useChatFileReferenceValidation';
import { cn } from '@/lib/utils';

interface FileReferenceCardProps {
  paths: FilePathEntry[];
}

function dedupeFilePathEntries(paths: FilePathEntry[]): FilePathEntry[] {
  const byPath = new Map<string, FilePathEntry>();

  for (const entry of paths) {
    const normalizedPath = normalizeChatFilePath(entry.path);
    if (!normalizedPath) {
      continue;
    }

    const existing = byPath.get(normalizedPath);
    if (!existing) {
      byPath.set(normalizedPath, {
        path: normalizedPath,
        label: entry.label,
      });
      continue;
    }

    if (!existing.label && entry.label) {
      byPath.set(normalizedPath, {
        ...existing,
        label: entry.label,
      });
    }
  }

  return Array.from(byPath.values());
}

export function FileReferenceCard({ paths }: FileReferenceCardProps) {
  const t = useTranslations('chat');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const openFileReference = useOpenChatFileReference();
  const uniquePaths = React.useMemo(() => dedupeFilePathEntries(paths), [paths]);
  const uniquePathKey = React.useMemo(
    () => uniquePaths.map((entry) => entry.path).join('\n'),
    [uniquePaths],
  );
  const { isResolving, results } = useChatFileReferenceValidation(uniquePathKey);
  const visiblePaths = uniquePaths.filter((entry) => {
    const result = results.get(entry.path);
    return !result || result.type === 'file';
  });

  const handleOpen = (filePath: string) => {
    void openFileReference(filePath);
  };

  if (visiblePaths.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border/60 pt-2" aria-busy={isResolving}>
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {t('fileReferences')}
      </div>
      <div className="flex flex-col gap-1">
        {visiblePaths.map((entry) => {
          const validation = results.get(entry.path);
          const isFile = validation?.type === 'file';
          const fileName = entry.label || entry.path.split('/').pop() || entry.path;
          const displayName = getFileDisplayPath(fileName);
          const displayPath = getFileDisplayPath(entry.path);
          const fallbackIcon = getFileIconComponent({ name: fileName, path: entry.path, type: 'file' });
          return (
            <button
              key={entry.path}
              type="button"
              onClick={() => handleOpen(entry.path)}
              disabled={!isFile}
              className={cn(
                'group flex w-full items-center gap-2 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-left transition-colors',
                isFile ? 'hover:border-primary/40 hover:bg-accent/50' : 'cursor-progress opacity-70',
              )}
              title={entry.path}
            >
              <span className="shrink-0">
                {isFile && isImageFile(entry.path) ? (
                  <ImageThumbnailIcon
                    path={entry.path}
                    name={fileName}
                    workspaceId={activeWorkspaceId}
                    className="h-5 w-5 rounded-sm"
                    fallbackIcon={fallbackIcon}
                  />
                ) : fallbackIcon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground group-hover:text-primary">
                  {displayName}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {displayPath}
                </span>
              </span>
              {isFile ? (
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-primary" />
              ) : (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
