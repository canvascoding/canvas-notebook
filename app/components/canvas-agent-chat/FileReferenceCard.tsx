'use client';

import React from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFileStore } from '@/app/store/file-store';
import { usePathname as useLocalePathname, getPathname } from '@/i18n/navigation';
import { useLocale } from 'next-intl';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { normalizeChatFilePath, type FilePathEntry } from '@/app/lib/chat/extract-file-paths';
import { validateFileExists } from '@/app/lib/chat/validate-file-paths';

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
  const fileStore = useFileStore();
  const fileTree = fileStore.fileTree;
  const pathname = useLocalePathname();
  const locale = useLocale();
  const [validPaths, setValidPaths] = React.useState<FilePathEntry[]>([]);
  const uniquePaths = React.useMemo(() => dedupeFilePathEntries(paths), [paths]);

  React.useEffect(() => {
    const validate = async () => {
      const valid = await Promise.all(
        uniquePaths.map(async (entry) => {
          const exists = await validateFileExists(entry.path, fileTree);
          return exists ? entry : null;
        })
      );
      setValidPaths(valid.filter(Boolean) as FilePathEntry[]);
    };
    validate();
  }, [uniquePaths, fileTree]);

  const handleOpen = (filePath: string) => {
    const normalizedPath = normalizeChatFilePath(filePath);
    if (!normalizedPath) return;

    if (pathname.includes('/chat')) {
      const notebookPath = getPathname({
        locale,
        href: { pathname: '/notebook', query: { path: normalizedPath } },
      });
      window.open(notebookPath, 'canvas-notebook');
      return;
    }

    void fileStore.revealAndLoadFile(normalizedPath);
  };

  if (validPaths.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {t('fileReferences')}
      </div>
      <div className="flex flex-col gap-1">
        {validPaths.map((entry) => {
          const fileName = entry.label || entry.path.split('/').pop() || entry.path;
          return (
            <button
              key={entry.path}
              type="button"
              onClick={() => handleOpen(entry.path)}
              className="group flex w-full items-center gap-2 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/50"
              title={entry.path}
            >
              <span className="shrink-0">
                {getFileIconComponent({ name: fileName, path: entry.path, type: 'file' })}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground group-hover:text-primary">
                  {fileName}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {entry.path}
                </span>
              </span>
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-primary" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
