'use client';

import { type ReactNode } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FileNode } from '@/app/store/file-store';

interface DirectoryBrowserProps {
  tree: FileNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
}

export function DirectoryBrowser({ tree, selectedPath, onSelect, expandedDirs, onToggleDir }: DirectoryBrowserProps) {
  const t = useTranslations('notebook');

  const renderDirectories = (nodes: FileNode[], depth = 0): ReactNode[] => {
    return nodes.flatMap((entry) => {
      if (entry.type !== 'directory') return [];

      const isSelected = selectedPath === entry.path;
      const isExpanded = expandedDirs.has(entry.path);

      const row = (
        <div key={entry.path} className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className="p-1 rounded hover:bg-accent/70"
            onClick={() => onToggleDir(entry.path)}
          >
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
          <button
            type="button"
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
              isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/70'
            }`}
            onClick={() => onSelect(entry.path)}
          >
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{entry.name}</span>
          </button>
        </div>
      );

      const children = isExpanded && entry.children ? renderDirectories(entry.children, depth + 1) : [];
      return [row, ...children];
    });
  };

  return (
    <div className="rounded border border-border bg-muted/40 p-2">
      <div className="mb-2 text-xs text-muted-foreground">{t('chooseDestination')}</div>
      <div className="max-h-56 overflow-auto">
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
            selectedPath === '.'
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground hover:bg-accent/70'
          }`}
          onClick={() => onSelect('.')}
        >
          <Folder className="h-4 w-4 text-muted-foreground" />
          <span className="truncate">{t('rootDirectory')}</span>
        </button>
        {renderDirectories(tree)}
      </div>
    </div>
  );
}