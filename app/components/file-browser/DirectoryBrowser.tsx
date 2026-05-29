'use client';

import { type ReactNode } from 'react';
import { ChevronRight, Folder, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFileStore, type FileNode } from '@/app/store/file-store';

interface DirectoryBrowserProps {
  tree: FileNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
}

export function DirectoryBrowser({ tree, selectedPath, onSelect, expandedDirs, onToggleDir }: DirectoryBrowserProps) {
  const t = useTranslations('notebook');
  const { loadSubdirectory, loadingDirs } = useFileStore();

  const handleToggleDir = async (path: string, isExpanded: boolean) => {
    onToggleDir(path);
    if (!isExpanded) {
      await loadSubdirectory(path, true);
    }
  };

  const renderDirectories = (nodes: FileNode[], depth = 0): ReactNode[] => {
    return nodes.flatMap((entry) => {
      if (entry.type !== 'directory') return [];

      const isSelected = selectedPath === entry.path;
      const isExpanded = expandedDirs.has(entry.path);
      const isLoading = loadingDirs.has(entry.path);

      const row = (
        <div key={entry.path} className="flex min-w-0 items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className="shrink-0 rounded p-1 hover:bg-accent/70"
            onClick={() => void handleToggleDir(entry.path, isExpanded)}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            )}
          </button>
          <button
            type="button"
            className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm ${
              isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/70'
            }`}
            onClick={() => onSelect(entry.path)}
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
        </div>
      );

      const children = isExpanded && entry.children ? renderDirectories(entry.children, depth + 1) : [];
      return [row, ...children];
    });
  };

  return (
    <div className="min-w-0 overflow-hidden rounded border border-border bg-muted/40 p-2">
      <div className="mb-2 text-xs text-muted-foreground">{t('chooseDestination')}</div>
      <div className="max-h-56 min-w-0 overflow-x-hidden overflow-y-auto">
        <button
          type="button"
          className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm ${
            selectedPath === '.'
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground hover:bg-accent/70'
          }`}
          onClick={() => onSelect('.')}
        >
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{t('rootDirectory')}</span>
        </button>
        {renderDirectories(tree)}
      </div>
    </div>
  );
}
