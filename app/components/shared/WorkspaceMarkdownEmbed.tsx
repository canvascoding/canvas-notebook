'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { FileText, Loader2, TriangleAlert } from 'lucide-react';

import { selectObsidianEmbedContent } from '@/app/lib/markdown/obsidian-embed';
import {
  getObsidianWikiDisplayLabel,
  parseObsidianWikiTarget,
} from '@/app/lib/markdown/obsidian-flavored-markdown';
import {
  loadWorkspaceMarkdownEmbed,
  type WorkspaceMarkdownEmbedDocument,
} from '@/app/lib/markdown/workspace-link-index-client';
import { useWorkspaceStore } from '@/app/store/workspace-store';

import { ObsidianWikiLink } from './ObsidianWikiLink';

type EmbedState = {
  document: WorkspaceMarkdownEmbedDocument | null;
  error: string | null;
  key: string;
};

type WorkspaceMarkdownEmbedProps = {
  ancestorPaths?: string[];
  renderContent: (content: string, sourcePath: string, ancestorPaths: string[]) => React.ReactNode;
  sourcePath?: string;
  target: string;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
}

export function WorkspaceMarkdownEmbed({
  ancestorPaths = [],
  renderContent,
  sourcePath,
  target,
}: WorkspaceMarkdownEmbedProps) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const requestKey = `${workspaceId ?? ''}\0${sourcePath ?? ''}\0${target}`;
  const [state, setState] = useState<EmbedState | null>(null);
  const parsedTarget = useMemo(() => parseObsidianWikiTarget(target), [target]);
  const label = parsedTarget ? getObsidianWikiDisplayLabel(parsedTarget) : target;

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void loadWorkspaceMarkdownEmbed(workspaceId, target, sourcePath)
      .then((document) => {
        if (!cancelled) setState({ document, error: null, key: requestKey });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            document: null,
            error: error instanceof Error ? error.message : 'Embedded document could not be loaded',
            key: requestKey,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, sourcePath, target, workspaceId]);

  const currentState = state?.key === requestKey ? state : null;
  const path = currentState?.document?.path;
  const normalizedAncestors = ancestorPaths.map(normalizePath);
  const cycleDetected = Boolean(path && normalizedAncestors.includes(normalizePath(path)));

  return (
    <aside
      className="my-3 overflow-hidden rounded-lg border border-border/80 bg-background/60"
      aria-label={`Embedded document: ${label}`}
    >
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/25 px-3 py-2 text-xs">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <ObsidianWikiLink target={target} sourcePath={sourcePath} className="min-w-0 truncate font-medium">
          {path ?? label}
        </ObsidianWikiLink>
      </div>
      {!workspaceId ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          Workspace context is unavailable.
        </div>
      ) : !currentState ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading embedded document…
        </div>
      ) : currentState.error ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-destructive">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          {currentState.error}
        </div>
      ) : cycleDetected ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          Recursive embed stopped at {path}.
        </div>
      ) : currentState.document ? (
        <div className="px-3 py-3">
          {renderContent(
            selectObsidianEmbedContent(currentState.document.content, target),
            currentState.document.path,
            [...normalizedAncestors, normalizePath(currentState.document.path)],
          )}
        </div>
      ) : null}
    </aside>
  );
}
