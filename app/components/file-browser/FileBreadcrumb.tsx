'use client';

import { ChevronRight, House } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { cn } from '@/lib/utils';

interface FileBreadcrumbProps {
  currentDirectory: string;
  onNavigate: (dir: string) => void;
  dropTargetPath?: string | null;
}

export function FileBreadcrumb({ currentDirectory, onNavigate, dropTargetPath }: FileBreadcrumbProps) {
  const t = useTranslations('notebook');

  if (currentDirectory === '.') {
    return (
      <nav className="flex min-w-0 flex-1 items-center gap-0.5" aria-label={t('breadcrumbLabel')}>
        <button
          onClick={() => onNavigate('.')}
          className={cn(
            'flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
            dropTargetPath === '.' && 'bg-primary/10 text-primary ring-1 ring-primary/50',
          )}
          aria-label={t('jumpToWorkspaceRoot')}
          data-file-drop-path="."
        >
          <House className="h-3.5 w-3.5" />
        </button>
      </nav>
    );
  }

  const segments = currentDirectory.split('/').filter(Boolean);

  return (
    <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none" aria-label={t('breadcrumbLabel')}>
      <button
        onClick={() => onNavigate('.')}
        className={cn(
          'flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
          dropTargetPath === '.' && 'bg-primary/10 text-primary ring-1 ring-primary/50',
        )}
        aria-label={t('jumpToWorkspaceRoot')}
        data-file-drop-path="."
      >
        <House className="h-3.5 w-3.5" />
      </button>
      {segments.map((segment, i) => {
        const dirPath = segments.slice(0, i + 1).join('/');
        const isLast = i === segments.length - 1;

        return (
          <Fragment key={i}>
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            <button
              onClick={() => onNavigate(dirPath)}
              className={cn(
                'shrink-0 rounded px-1 py-0.5 text-xs transition-colors',
                isLast
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                dropTargetPath === dirPath && 'bg-primary/10 text-primary ring-1 ring-primary/50',
              )}
              title={dirPath}
              aria-current={isLast ? 'page' : undefined}
              data-file-drop-path={dirPath}
            >
              {segment}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
