'use client';

import React from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Eye, RefreshCw, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getFileDisplayPath } from '@/app/lib/files/display-name';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import type { ChatFileReference } from '@/app/lib/chat/tool-file-references';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useOpenChatFileReference } from '@/app/components/canvas-agent-chat/useOpenChatFileReference';
import { cn } from '@/lib/utils';
import type { FileSummaryChange, FileSummaryRow } from '@/app/lib/chat/file-change-summary';
import { fileSummaryNeedsReview } from '@/app/lib/chat/file-change-summary';
import { fileChangeAppStatusMessageKey } from '@/app/lib/tool-apps/file-change-data';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from '@/app/lib/file-version-center/contracts/v1';
import { openVersionCenter } from '@/app/store/file-version-center-store';
import { useDocumentReviewAvailability } from '@/app/components/file-version-center/DocumentReviewAvailabilityProvider';

export type FileReferenceViewState = { expanded: boolean; readsExpanded: boolean; query: string };
export const DEFAULT_FILE_REFERENCE_VIEW_STATE: FileReferenceViewState = { expanded: false, readsExpanded: false, query: '' };

interface FileReferenceCardProps {
  references: ChatFileReference[];
  omittedCount?: number;
  viewState?: FileReferenceViewState;
  onViewStateChange?: (state: FileReferenceViewState) => void;
  summaryRows?: FileSummaryRow[];
  onRefresh?: () => void;
  refreshing?: boolean;
  loadError?: boolean;
}

export function FileReferenceCard({ references, omittedCount = 0, viewState, onViewStateChange,
  summaryRows, onRefresh, refreshing = false, loadError = false }: FileReferenceCardProps) {
  const t = useTranslations('chat.referenceList');
  const toolT = useTranslations('chat.toolApp');
  const reviewAvailability = useDocumentReviewAvailability();
  const reviewCenterEnabled = reviewAvailability.ready && reviewAvailability.documentReviewEnabled;
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
  const rows = summaryRows ?? references.map(reference => ({ reference, changes: [] } as FileSummaryRow));
  const results = rows.filter(({ reference }) => reference.kind !== 'read');
  const reads = rows.filter(({ reference }) => reference.kind === 'read');
  const searchable = (expanded && results.length > 10) || (readsExpanded && reads.length > 10);
  const normalizedQuery = searchable ? query.trim().toLocaleLowerCase() : '';
  const matches = ({ reference }: FileSummaryRow) => !normalizedQuery || reference.path.toLocaleLowerCase().includes(normalizedQuery);
  const visibleResults = normalizedQuery ? results.filter(matches) : expanded ? results : results.slice(0, 5);
  const visibleReads = reads.filter(matches);

  const openChanges = (change: FileSummaryChange) => {
    if (!reviewCenterEnabled || useWorkspaceStore.getState().activeWorkspaceId !== change.workspaceId) return;
    openVersionCenter({
      contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
      target: { kind: 'change_group', workspaceId: change.workspaceId, changeGroupId: change.groupId, entryId: change.entry.id },
      selectedEntry: change.entry.operationId ? { kind: 'agent_operation', id: change.entry.operationId }
        : change.entry.revisionId ? { kind: 'revision', id: change.entry.revisionId } : undefined,
      initialView: change.entry.proposal || fileSummaryNeedsReview(change.entry) ? 'reviews' : 'history', source: 'chat',
    });
  };
  const statusLabel = (item: FileSummaryRow) => item.status === 'loading' ? t('loadingStatus')
    : item.status ? toolT(fileChangeAppStatusMessageKey(item.status, Boolean(item.changes[0]?.entry.proposal))) : t(item.reference.kind);
  const row = (item: FileSummaryRow) => {
    const { reference, changes, status } = item;
    const fileName = reference.path.split('/').pop() || reference.path;
    const canOpen = activeWorkspaceId === reference.workspaceId;
    return (
      <li key={`${reference.workspaceId}:${reference.path}`} className="min-w-0 rounded-md border border-border/60 bg-background/60">
        <div className="flex min-w-0 items-center">
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
          className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
        >
          <span className="shrink-0" aria-hidden="true">
            {getFileIconComponent({ name: fileName, path: reference.path, type: 'file' })}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">{getFileDisplayPath(fileName)}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{getFileDisplayPath(reference.path)}</span>
          </span>
          <span className={cn('max-w-[40%] shrink-0 text-right text-[10px] leading-tight text-muted-foreground',
            (reference.kind === 'review_required' || status === 'conflict') && 'text-amber-700 dark:text-amber-400')}>
            <span data-testid="chat-file-reference-status">{statusLabel(item)}</span>
            {item.additions != null && item.deletions != null && <span className="mt-1 block whitespace-nowrap tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-400">+{item.additions}</span>{' '}
              <span className="text-red-600 dark:text-red-400">−{item.deletions}</span>
            </span>}
          </span>
          <ExternalLink aria-hidden="true" className="hidden h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary sm:block" />
        </button>
        {reviewCenterEnabled && changes.length > 0 && <button type="button" data-testid="chat-file-reference-review" data-path={reference.path}
          disabled={!canOpen} title={t('viewChanges')} aria-label={`${t('viewChanges')}: ${reference.path}`}
          onClick={() => openChanges(changes[0])}
          className="mr-1 flex h-8 shrink-0 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <Eye aria-hidden="true" className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('viewChanges')}</span>
        </button>}
        </div>
        {reviewCenterEnabled && changes.length > 1 && <details className="border-t border-border/40 px-2.5 py-1 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('operations', { count: changes.length })}</summary>
          <div className="flex flex-wrap gap-1.5 py-1">
            {changes.map((change, index) => <button type="button" key={`${change.groupId}:${change.entry.id}`}
              data-testid="chat-file-reference-operation" disabled={!canOpen} onClick={() => openChanges(change)}
              className="rounded border border-border/70 px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              {t('operation', { count: index + 1 })}{' · '}{toolT(fileChangeAppStatusMessageKey(change.entry.state, Boolean(change.entry.proposal)))}
            </button>)}
          </div>
        </details>}
      </li>
    );
  };

  if (!rows.length && !omittedCount && !onRefresh) return null;

  return (
    <section data-testid="chat-file-references" aria-label={results.length ? t('changedTitle', { count: results.length }) : t('title')}
      className="mt-3 min-w-0 rounded-lg border border-border/70 bg-muted/20 p-2.5">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1">{results.length ? t('changedTitle', { count: results.length }) : t('title')}</span>
        {onRefresh && <button type="button" data-testid="chat-file-references-refresh" disabled={refreshing}
          aria-label={t('refresh')} title={t('refresh')} onClick={onRefresh}
          className="rounded p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <RefreshCw aria-hidden="true" className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>}
      </div>
      {loadError && <p role="status" className="mb-2 text-[11px] text-muted-foreground">{t('loadError')}</p>}
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
      {results.length > 5 && (
        <button type="button" data-testid="chat-file-references-expand" aria-expanded={expanded} aria-controls={resultId}
          onClick={() => updateState({ expanded: !expanded })}
          className="mt-1 flex min-h-8 items-center gap-1.5 rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          {expanded ? t('showLess') : t('showMore', { count: results.length - 5 })}
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
