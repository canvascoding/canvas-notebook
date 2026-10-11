'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Folder, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFileStore } from '@/app/store/file-store';
import type { FileNode } from '@/app/lib/files/types';
import { useShallow } from 'zustand/react/shallow';
import { FolderCreationControl } from './FolderCreationControl';

export interface DirectoryBrowserProps {
  tree: FileNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  loadingDirs?: Set<string>;
  onLoadSubdirectory?: (path: string) => Promise<void>;
  disabled?: boolean;
  onCreateDirectory?: (parentPath: string, name: string) => Promise<string | null>;
  onCreatingDirectoryChange?: (busy: boolean) => void;
  isDirectoryDisabled?: (path: string) => boolean;
}

export function DirectoryBrowser({
  tree,
  selectedPath,
  onSelect,
  expandedDirs,
  onToggleDir,
  loadingDirs: providedLoadingDirs,
  onLoadSubdirectory,
  disabled = false,
  onCreateDirectory,
  onCreatingDirectoryChange,
  isDirectoryDisabled,
}: DirectoryBrowserProps) {
  const t = useTranslations('notebook');
  const { loadSubdirectory, storeLoadingDirs } = useFileStore(useShallow((state) => ({
    loadSubdirectory: state.loadSubdirectory,
    storeLoadingDirs: state.loadingDirs,
  })));
  const loadingDirs = providedLoadingDirs ?? storeLoadingDirs;
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const activeRef = useRef(true);
  const interactionDisabled = disabled || creatingDirectory;
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const handleToggleDir = async (path: string, isExpanded: boolean) => {
    if (interactionDisabled) return;
    onToggleDir(path);
    if (!isExpanded) {
      await (onLoadSubdirectory ?? ((dirPath: string) => loadSubdirectory(dirPath, true)))(path);
    }
  };

  const renderDirectories = (nodes: FileNode[], depth = 0): ReactNode[] => {
    return nodes.flatMap((entry) => {
      if (entry.type !== 'directory') return [];

      const isSelected = selectedPath === entry.path;
      const isExpanded = expandedDirs.has(entry.path);
      const isLoading = loadingDirs.has(entry.path);
      const pathDisabled = Boolean(isDirectoryDisabled?.(entry.path));

      const row = (
        <div key={entry.path} className="flex min-w-0 items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className="shrink-0 rounded p-1 hover:bg-accent/70"
            onClick={() => void handleToggleDir(entry.path, isExpanded)}
            aria-label={t(isExpanded ? 'collapseFolder' : 'expandFolder', { name: entry.name })}
            aria-expanded={isExpanded}
            disabled={interactionDisabled}
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
            disabled={interactionDisabled || pathDisabled}
            aria-pressed={isSelected}
            title={entry.path}
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
      {onCreateDirectory ? (
        <p className="mb-2 break-all text-xs text-muted-foreground" aria-live="polite">
          {t('selectedDestinationFolder')}: <span className="font-mono">{selectedPath === '.' ? '/' : `/${selectedPath}`}</span>
        </p>
      ) : null}
      <div className="max-h-56 min-w-0 overflow-x-hidden overflow-y-auto">
        <button
          type="button"
          className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-sm ${
            selectedPath === '.'
              ? 'bg-accent text-accent-foreground'
              : 'text-foreground hover:bg-accent/70'
          }`}
          onClick={() => onSelect('.')}
          disabled={interactionDisabled || Boolean(isDirectoryDisabled?.('.'))}
          aria-pressed={selectedPath === '.'}
        >
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{t('rootDirectory')}</span>
        </button>
        {renderDirectories(tree)}
      </div>
      {onCreateDirectory ? (
        <FolderCreationControl parentPath={selectedPath}
          disabled={disabled || Boolean(isDirectoryDisabled?.(selectedPath))}
          onCreateDirectory={async (parentPath, name) => {
            const path = await onCreateDirectory(parentPath, name);
            if (activeRef.current && path) onSelect(path);
            return path;
          }}
          onCreatingDirectoryChange={(busy) => { setCreatingDirectory(busy); onCreatingDirectoryChange?.(busy); }} />
      ) : null}
    </div>
  );
}
