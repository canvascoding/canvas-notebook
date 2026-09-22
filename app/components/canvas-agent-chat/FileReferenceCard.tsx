'use client';

import React from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import type { ChatFileReference } from '@/app/lib/chat/tool-file-references';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useOpenChatFileReference } from '@/app/components/canvas-agent-chat/useOpenChatFileReference';
import { cn } from '@/lib/utils';

export type FileReferenceViewState = { expanded: boolean; readsExpanded: boolean; query: string };
export const DEFAULT_FILE_REFERENCE_VIEW_STATE: FileReferenceViewState = { expanded: false, readsExpanded: false, query: '' };

interface FileReferenceCardProps {
  references: ChatFileReference[];
  omittedCount?: number;
  viewState?: FileReferenceViewState;
  onViewStateChange?: (state: FileReferenceViewState) => void;
}

export function FileReferenceCard({ references, omittedCount = 0, viewState, onViewStateChange }: FileReferenceCardProps) {
  const t = useTranslations('chat.referenceList');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const openFileReference = useOpenChatFileReference();
  const [localState, setLocalState] = React.useState(DEFAULT_FILE_REFERENCE_VIEW_STATE);
  const { expanded, readsExpanded, query } = viewState ?? localState;
  const updateState = (patch: Partial<FileReferenceViewState>) => {
    const next = { ...(viewState ?? localState), ...patch };
    if (onViewStateChange) onViewStateChange(next);
    else setLocalState(next);
  };
  const id = React.useId();
  const resultId = `${id}-results`;
  const readsId = `${id}-reads`;
  const searchId = `${id}-search`;
  const results = references.filter((reference) => reference.kind !== 'read');
  const reads = references.filter((reference) => reference.kind === 'read');
  const searchable = (expanded && results.length > 10) || (readsExpanded && reads.length > 10);
  const normalizedQuery = searchable ? query.trim().toLocaleLowerCase() : '';
  const matches = (reference: ChatFileReference) => !normalizedQuery || reference.path.toLocaleLowerCase().includes(normalizedQuery);
  const visibleResults = normalizedQuery ? results.filter(matches) : expanded ? results : results.slice(0, 3);
  const visibleReads = reads.filter(matches);

  const row = (reference: ChatFileReference) => {
    const fileName = reference.path.split('/').pop() || reference.path;
    const canOpen = activeWorkspaceId === reference.workspaceId;
    return (
      <li key={`${reference.workspaceId}:${reference.path}`} className="min-w-0">
        <button
          type="button"
          data-testid="chat-file-reference-item"
          data-path={reference.path}
          disabled={!canOpen}
          onClick={() => {
            if (useWorkspaceStore.getState().activeWorkspaceId === reference.workspaceId) {
              void openFileReference(reference.path);
            }
          }}
          title={canOpen ? reference.path : `${reference.path} · ${t('differentWorkspace')}`}
          className="group flex w-full min-w-0 items-center gap-2.5 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
        >
          <span className="shrink-0" aria-hidden="true">
            {getFileIconComponent({ name: fileName, path: reference.path, type: 'file' })}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">{getFileDisplayPath(fileName)}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{getFileDisplayPath(reference.path)}</span>
          </span>
          <span className={cn('max-w-[40%] shrink-0 text-right text-[10px] leading-tight text-muted-foreground', reference.kind === 'review_required' && 'text-amber-700 dark:text-amber-400')}>
            {t(reference.kind)}
          </span>
          <ExternalLink aria-hidden="true" className="hidden h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary sm:block" />
        </button>
      </li>
    );
  };

  if (!references.length && !omittedCount) return null;

  return (
    <section data-testid="chat-file-references" aria-label={t('title')} className="mt-3 min-w-0 border-t border-border/60 pt-2.5">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        <span>{t('title')}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums tracking-normal">{references.length}</span>
      </div>
      {searchable && (
        <div className="mb-2">
          <label htmlFor={searchId} className="sr-only">{t('search')}</label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <input id={searchId} data-testid="chat-file-references-search" type="search" value={query}
              onChange={(event) => updateState({ query: event.target.value })} placeholder={t('search')}
              className="h-8 w-full min-w-0 rounded-md border border-input bg-background pl-8 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
        </div>
      )}
      <div id={resultId}>
        <ul className={cn('space-y-1', (expanded || normalizedQuery) && results.length > 10 && 'max-h-72 overflow-y-auto overscroll-contain pr-1')}>
          {visibleResults.map(row)}
        </ul>
        {(expanded || normalizedQuery) && results.length > 0 && !visibleResults.length && <p className="py-2 text-xs text-muted-foreground">{t('noMatches')}</p>}
      </div>
      {results.length > 3 && (
        <button type="button" data-testid="chat-file-references-expand" aria-expanded={expanded} aria-controls={resultId}
          onClick={() => updateState({ expanded: !expanded })}
          className="mt-1 flex min-h-8 items-center gap-1.5 rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          {expanded ? t('showLess') : t('showMore', { count: results.length - 3 })}
        </button>
      )}
      {reads.length > 0 && (
        <div className={cn(results.length > 0 && 'mt-1 border-t border-border/40 pt-1')}>
          <button type="button" data-testid="chat-read-references-toggle" aria-expanded={readsExpanded} aria-controls={readsId}
            onClick={() => updateState({ readsExpanded: !readsExpanded })}
            className="flex min-h-8 w-full items-center gap-1.5 rounded px-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {readsExpanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            {t('readDocuments', { count: reads.length })}
          </button>
          <div id={readsId} hidden={!readsExpanded}>
            {readsExpanded && <ul className={cn('space-y-1 pt-1', reads.length > 10 && 'max-h-72 overflow-y-auto overscroll-contain pr-1')}>{visibleReads.map(row)}</ul>}
            {readsExpanded && !visibleReads.length && <p className="py-2 text-xs text-muted-foreground">{t('noMatches')}</p>}
          </div>
        </div>
      )}
      {omittedCount > 0 && <p className="mt-2 text-[11px] text-muted-foreground">{t('omitted', { count: omittedCount })}</p>}
    </section>
  );
}
