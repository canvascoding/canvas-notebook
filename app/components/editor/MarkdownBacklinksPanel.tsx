'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Link2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { WorkspaceDocumentPreviewDialog } from '@/app/components/shared/WorkspaceDocumentPreviewDialog';
import {
  loadWorkspaceLinkIndex,
  subscribeWorkspaceLinkIndexInvalidation,
} from '@/app/lib/markdown/workspace-link-index-client';
import type {
  WorkspaceLinkEdge,
  WorkspaceLinkIndex,
} from '@/app/lib/markdown/workspace-link-index-core';
import type { WorkspaceDocumentReference } from '@/app/lib/markdown/workspace-document-preview';
import {
  groupWorkspaceReferenceEdges,
  workspaceReferenceDirectory,
  type WorkspaceReferenceGroup,
} from '@/app/lib/markdown/workspace-reference-groups';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

type MarkdownBacklinksPanelProps = {
  className?: string;
  filePath?: string;
};

const MAX_VISIBLE_LINKS = 8;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function LinkRow({
  group,
  onPreview,
}: {
  group: WorkspaceReferenceGroup;
  onPreview: () => void;
}) {
  const t = useTranslations('notebook');
  const directory = workspaceReferenceDirectory(group.reference.path);
  const location = group.reference.heading
    ? `# ${group.reference.heading}`
    : group.reference.blockId
      ? `^${group.reference.blockId}`
      : null;
  return (
    <button
      type="button"
      className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-border/55 bg-background/75 px-3 py-2.5 text-left shadow-sm transition-[border-color,background-color,transform] hover:-translate-y-px hover:border-primary/30 hover:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onPreview}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/55 bg-muted/35 text-muted-foreground group-hover:text-primary">
        <FileText className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{group.reference.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{directory || t('markdownEditorBacklinksWorkspaceRoot')}</span>
          {location ? <span className="shrink-0 text-primary/80">· {location}</span> : null}
        </span>
      </span>
      {group.edges.length > 1 ? (
        <span
          className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
          title={t('markdownEditorBacklinksOccurrences', { count: group.edges.length })}
        >
          {group.edges.length}
        </span>
      ) : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </button>
  );
}

type ActiveSection = 'incoming' | 'outgoing' | 'broken';

function BrokenLinkRow({ edge, count }: { count: number; edge: WorkspaceLinkEdge }) {
  const t = useTranslations('notebook');
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/[0.035] px-3 py-2.5">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{edge.alias || edge.targetText}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {edge.status === 'ambiguous'
            ? t('markdownEditorBacklinksAmbiguous')
            : t('markdownEditorBacklinksMissing')}
        </span>
      </span>
      {count > 1 ? (
        <span className="rounded-full border border-destructive/20 px-2 py-0.5 text-[10px] tabular-nums text-destructive">
          {count}
        </span>
      ) : null}
    </div>
  );
}

export function MarkdownBacklinksPanel({ className, filePath }: MarkdownBacklinksPanelProps) {
  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const normalizedPath = filePath ? normalizePath(filePath) : '';
  const indexKey = `${activeWorkspaceId ?? ''}\0${normalizedPath}`;
  const [reloadVersion, setReloadVersion] = useState(0);
  const [activeSection, setActiveSection] = useState<ActiveSection>('incoming');
  const [showAll, setShowAll] = useState(false);
  const [previewReference, setPreviewReference] = useState<WorkspaceDocumentReference | null>(null);
  const [state, setState] = useState<{
    error: string | null;
    index: WorkspaceLinkIndex | null;
    key: string;
  } | null>(null);

  useEffect(() => subscribeWorkspaceLinkIndexInvalidation((event) => {
    if (!event.workspaceId || event.workspaceId === activeWorkspaceId) {
      setReloadVersion((version) => version + 1);
    }
  }), [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId || !normalizedPath) return undefined;
    let cancelled = false;
    void loadWorkspaceLinkIndex(activeWorkspaceId).then((index) => {
      if (!cancelled) setState({ error: null, index, key: indexKey });
    }).catch((error) => {
      if (!cancelled) {
        setState({
          error: error instanceof Error ? error.message : t('markdownEditorBacklinksLoadError'),
          index: null,
          key: indexKey,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, indexKey, normalizedPath, reloadVersion, t]);

  const currentIndex = state?.key === indexKey ? state.index : null;
  const backlinks = useMemo(
    () => currentIndex?.backlinks[normalizedPath] ?? [],
    [currentIndex, normalizedPath],
  );
  const outgoing = useMemo(() => currentIndex?.edges.filter((edge) => (
    edge.sourcePath === normalizedPath && edge.status === 'resolved' && edge.targetPath
  )) ?? [], [currentIndex, normalizedPath]);
  const broken = useMemo(() => currentIndex?.edges.filter((edge) => (
    edge.sourcePath === normalizedPath && edge.status !== 'resolved'
  )) ?? [], [currentIndex, normalizedPath]);
  const incomingGroups = useMemo(() => groupWorkspaceReferenceEdges(
    backlinks,
    currentIndex?.documents ?? [],
    'incoming',
  ), [backlinks, currentIndex?.documents]);
  const outgoingGroups = useMemo(() => groupWorkspaceReferenceEdges(
    outgoing,
    currentIndex?.documents ?? [],
    'outgoing',
  ), [currentIndex?.documents, outgoing]);
  const brokenGroups = useMemo(() => {
    const groups = new Map<string, { count: number; edge: WorkspaceLinkEdge }>();
    for (const edge of broken) {
      const key = `${edge.status}\0${edge.targetText}`;
      const existing = groups.get(key);
      if (existing) existing.count += 1;
      else groups.set(key, { count: 1, edge });
    }
    return Array.from(groups.values());
  }, [broken]);

  if (!activeWorkspaceId || !normalizedPath) return null;

  const activeReferenceGroups = activeSection === 'incoming' ? incomingGroups : outgoingGroups;
  const visibleReferenceGroups = showAll
    ? activeReferenceGroups
    : activeReferenceGroups.slice(0, MAX_VISIBLE_LINKS);
  const visibleBrokenGroups = showAll ? brokenGroups : brokenGroups.slice(0, MAX_VISIBLE_LINKS);
  const sectionItemCount = activeSection === 'broken' ? brokenGroups.length : activeReferenceGroups.length;
  const selectSection = (section: ActiveSection) => {
    setActiveSection(section);
    setShowAll(false);
  };

  return (
    <details
      className={cn(
        'group mx-3 mb-5 mt-8 overflow-hidden rounded-2xl border border-border/70 bg-muted/20 shadow-sm md:ml-[4.75rem] md:mr-5',
        className,
      )}
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-3 py-2.5 marker:hidden hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4 [&::-webkit-details-marker]:hidden">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background/80 text-muted-foreground shadow-sm">
          <Link2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t('markdownEditorBacklinks')}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {currentIndex
              ? t('markdownEditorBacklinksSummary', {
                  documents: incomingGroups.length,
                  references: backlinks.length,
                })
              : state?.key === indexKey && state.error
                ? t('markdownEditorBacklinksUnavailable')
                : t('markdownEditorBacklinksLoading')}
          </span>
        </span>
        {!currentIndex && !(state?.key === indexKey && state.error) ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        )}
      </summary>

      <div className="grid gap-3 border-t border-border/60 bg-background/50 p-3 sm:p-4">
        {state?.key === indexKey && state.error ? (
          <p className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {state.error}
          </p>
        ) : null}

        {currentIndex ? (
          <section className="grid gap-3">
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border/55 bg-muted/35 p-1" role="tablist" aria-label={t('markdownEditorBacklinks')}>
              {([
                ['incoming', t('markdownEditorBacklinksIncoming', { count: incomingGroups.length })],
                ['outgoing', t('markdownEditorBacklinksOutgoing', { count: outgoingGroups.length })],
                ['broken', t('markdownEditorBacklinksBroken', { count: brokenGroups.length })],
              ] as const).map(([section, label]) => (
                <button
                  key={section}
                  type="button"
                  role="tab"
                  aria-selected={activeSection === section}
                  className={cn(
                    'shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeSection === section && 'bg-background text-foreground shadow-sm',
                    section === 'broken' && brokenGroups.length > 0 && activeSection !== section && 'text-destructive',
                  )}
                  onClick={() => selectSection(section)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="grid gap-2" role="tabpanel">
              {sectionItemCount > 0 ? activeSection === 'broken' ? visibleBrokenGroups.map((item) => (
                  <BrokenLinkRow
                    key={`${item.edge.status}:${item.edge.targetText}`}
                    edge={item.edge}
                    count={item.count}
                  />
                )) : visibleReferenceGroups.map((item) => (
                  <LinkRow
                    key={item.reference.path}
                    group={item}
                    onPreview={() => setPreviewReference(item.reference)}
                  />
                )) : (
                <p className="rounded-xl border border-dashed border-border/70 px-3 py-5 text-center text-sm text-muted-foreground">
                  {activeSection === 'incoming'
                    ? t('markdownEditorBacklinksEmpty')
                    : t('markdownEditorBacklinksSectionEmpty')}
                </p>
              )}
            </div>

            {sectionItemCount > MAX_VISIBLE_LINKS ? (
              <button
                type="button"
                className="justify-self-center rounded-lg px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll
                  ? t('markdownEditorBacklinksShowLess')
                  : t('markdownEditorBacklinksShowAll', { count: sectionItemCount - MAX_VISIBLE_LINKS })}
              </button>
            ) : null}
          </section>
        ) : null}
      </div>

      <WorkspaceDocumentPreviewDialog
        open={previewReference !== null}
        reference={previewReference}
        onOpenChange={(open) => {
          if (!open) setPreviewReference(null);
        }}
      />
    </details>
  );
}
