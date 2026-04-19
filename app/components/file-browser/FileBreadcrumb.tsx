'use client';

import { ChevronRight, House } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';

interface FileBreadcrumbProps {
  currentDirectory: string;
  onNavigate: (dir: string) => void;
}

export function FileBreadcrumb({ currentDirectory, onNavigate }: FileBreadcrumbProps) {
  const t = useTranslations('notebook');

  if (currentDirectory === '.') {
    return (
      <nav className="flex min-w-0 flex-1 items-center gap-0.5">
        <button
          onClick={() => onNavigate('.')}
          className="flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t('jumpToWorkspaceRoot')}
        >
          <House className="h-3.5 w-3.5" />
        </button>
      </nav>
    );
  }

  const segments = currentDirectory.split('/').filter(Boolean);

  return (
    <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none">
      <button
        onClick={() => onNavigate('.')}
        className="flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t('jumpToWorkspaceRoot')}
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
              className={`shrink-0 rounded px-1 py-0.5 text-xs transition-colors ${
                isLast
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              title={dirPath}
            >
              {segment}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}