'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Link2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { openWorkspaceMarkdownPath } from '@/app/lib/markdown/workspace-markdown-navigation-client';
import {
  loadWorkspaceLinkIndex,
  subscribeWorkspaceLinkIndexInvalidation,
} from '@/app/lib/markdown/workspace-link-index-client';
import type {
  WorkspaceLinkEdge,
  WorkspaceLinkIndex,
} from '@/app/lib/markdown/workspace-link-index-core';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

type MarkdownBacklinksPanelProps = {
  className?: string;
  filePath?: string;
};

const MAX_VISIBLE_LINKS = 100;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function LinkRow({
  detail,
  edge,
  label,
  onOpen,
}: {
  detail: string;
  edge: WorkspaceLinkEdge;
  label: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="group flex min-h-11 w-full items-center gap-3 rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-left transition-colors hover:border-primary/35 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground/80">{edge.raw}</span>
      </span>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function MarkdownBacklinksPanel({ className, filePath }: MarkdownBacklinksPanelProps) {
  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const normalizedPath = filePath ? normalizePath(filePath) : '';
  const indexKey = `${activeWorkspaceId ?? ''}\0${normalizedPath}`;
  const [reloadVersion, setReloadVersion] = useState(0);
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
  const documentByPath = useMemo(() => new Map(
    currentIndex?.documents.map((document) => [document.path, document]) ?? [],
  ), [currentIndex]);
  const backlinks = currentIndex?.backlinks[normalizedPath] ?? [];
  const outgoing = currentIndex?.edges.filter((edge) => (
    edge.sourcePath === normalizedPath && edge.status === 'resolved' && edge.targetPath
  )) ?? [];
  const broken = currentIndex?.edges.filter((edge) => (
    edge.sourcePath === normalizedPath && edge.status !== 'resolved'
  )) ?? [];

  if (!activeWorkspaceId || !normalizedPath) return null;

  const openPath = async (path: string, edge?: WorkspaceLinkEdge) => {
    const result = await openWorkspaceMarkdownPath({
      blockId: edge?.blockId,
      heading: edge?.heading,
      path,
      workspaceId: activeWorkspaceId,
    });
    if (!['opened', 'superseded'].includes(result.status)) {
      toast.error(result.error ?? t('markdownEditorLinkOpenError'));
    }
  };

  const renderOverflow = (count: number) => count > MAX_VISIBLE_LINKS ? (
    <p className="px-1 text-xs text-muted-foreground">
      {t('markdownEditorBacklinksMore', { count: count - MAX_VISIBLE_LINKS })}
    </p>
  ) : null;

  return (
    <details
      className={cn(
        'group mx-4 mb-5 mt-8 overflow-hidden rounded-xl border border-border/70 bg-muted/20 md:ml-[4.75rem] md:mr-5',
        className,
      )}
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2 marker:hidden hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{t('markdownEditorBacklinks')}</span>
          <span className="block text-xs text-muted-foreground">
            {currentIndex
              ? t('markdownEditorBacklinksCount', { count: backlinks.length })
              : state?.key === indexKey && state.error
                ? t('markdownEditorBacklinksUnavailable')
                : t('markdownEditorBacklinksLoading')}
          </span>
        </span>
        {!currentIndex && !(state?.key === indexKey && state.error) ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <span className="rounded-full bg-background px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
            {backlinks.length}
          </span>
        )}
      </summary>

      <div className="grid gap-5 border-t border-border/60 bg-background/50 p-3">
        {state?.key === indexKey && state.error ? (
          <p className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {state.error}
          </p>
        ) : null}

        {currentIndex ? (
          <>
            <section className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('markdownEditorBacklinksIncoming', { count: backlinks.length })}
              </h3>
              {backlinks.length > 0 ? backlinks.slice(0, MAX_VISIBLE_LINKS).map((edge) => {
                const source = documentByPath.get(edge.sourcePath);
                return (
                  <LinkRow
                    key={edge.id}
                    edge={edge}
                    label={source?.title || edge.sourcePath}
                    detail={edge.sourcePath}
                    onOpen={() => void openPath(edge.sourcePath)}
                  />
                );
              }) : (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  {t('markdownEditorBacklinksEmpty')}
                </p>
              )}
              {renderOverflow(backlinks.length)}
            </section>

            {outgoing.length > 0 ? (
              <section className="grid gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('markdownEditorBacklinksOutgoing', { count: outgoing.length })}
                </h3>
                {outgoing.slice(0, MAX_VISIBLE_LINKS).map((edge) => {
                  const targetPath = edge.targetPath!;
                  const target = documentByPath.get(targetPath);
                  return (
                    <LinkRow
                      key={edge.id}
                      edge={edge}
                      label={target?.title || targetPath}
                      detail={targetPath}
                      onOpen={() => void openPath(targetPath, edge)}
                    />
                  );
                })}
                {renderOverflow(outgoing.length)}
              </section>
            ) : null}

            {broken.length > 0 ? (
              <section className="grid gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-destructive">
                  {t('markdownEditorBacklinksBroken', { count: broken.length })}
                </h3>
                {broken.slice(0, MAX_VISIBLE_LINKS).map((edge) => (
                  <div key={edge.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{edge.targetText}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{edge.raw}</span>
                    </span>
                    <span className="rounded-full border border-destructive/25 px-2 py-0.5 text-[10px] uppercase text-destructive">
                      {edge.status}
                    </span>
                  </div>
                ))}
                {renderOverflow(broken.length)}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}
