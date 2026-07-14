'use client';

import { FileText, Link2Off } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  resolveObsidianWikiLink,
  type ObsidianLinkResolution,
} from '@/app/lib/markdown/obsidian-link-resolver';
import { parseObsidianWikiTarget } from '@/app/lib/markdown/obsidian-flavored-markdown';
import { requestWorkspaceMarkdownLocation } from '@/app/lib/markdown/workspace-markdown-navigation';
import {
  loadWorkspaceLinkIndex,
  resolveWorkspaceLinkFromIndex,
  subscribeWorkspaceLinkIndexInvalidation,
} from '@/app/lib/markdown/workspace-link-index-client';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { cn } from '@/lib/utils';

type ObsidianWikiLinkProps = {
  children: React.ReactNode;
  className?: string;
  embed?: boolean;
  onOpenFile?: (
    path: string,
    location: Pick<ObsidianLinkResolution, 'blockId' | 'heading'>,
  ) => Promise<void> | void;
  sourcePath?: string;
  target: string;
};

export function ObsidianWikiLink({
  children,
  className,
  embed = false,
  onOpenFile,
  sourcePath,
  target,
}: ObsidianWikiLinkProps) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const parsedTarget = useMemo(() => parseObsidianWikiTarget(target), [target]);
  const resolutionKey = `${activeWorkspaceId ?? ''}\0${sourcePath ?? ''}\0${target}`;
  const [remoteResolution, setRemoteResolution] = useState<{
    error: string | null;
    key: string;
    value: ObsidianLinkResolution | null;
  } | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const synchronousResolution = useMemo(() => {
    if (!parsedTarget) return null;
    if (!parsedTarget.path || !activeWorkspaceId) {
      return resolveObsidianWikiLink(target, [], sourcePath);
    }
    return null;
  }, [activeWorkspaceId, parsedTarget, sourcePath, target]);
  const needsRemoteResolution = Boolean(parsedTarget?.path && activeWorkspaceId);
  const resolution = needsRemoteResolution
    ? remoteResolution?.key === resolutionKey ? remoteResolution.value : null
    : synchronousResolution;
  const resolutionError = needsRemoteResolution && remoteResolution?.key === resolutionKey
    ? remoteResolution.error
    : null;

  useEffect(() => subscribeWorkspaceLinkIndexInvalidation((event) => {
    if (!event.workspaceId || event.workspaceId === activeWorkspaceId) {
      setReloadVersion((version) => version + 1);
    }
  }), [activeWorkspaceId]);

  useEffect(() => {
    if (!parsedTarget?.path || !activeWorkspaceId) return;

    let cancelled = false;
    void loadWorkspaceLinkIndex(activeWorkspaceId).then((index) => {
      if (cancelled) return;
      setRemoteResolution({
        error: null,
        key: resolutionKey,
        value: resolveWorkspaceLinkFromIndex(target, index, sourcePath),
      });
    }).catch((error) => {
      if (cancelled) return;
      setRemoteResolution({
        error: error instanceof Error ? error.message : 'Failed to load workspace link index',
        key: resolutionKey,
        value: null,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, parsedTarget, reloadVersion, resolutionKey, sourcePath, target]);

  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (resolution?.status !== 'resolved' || !resolution.path) return;

    const location = { blockId: resolution.blockId, heading: resolution.heading };
    if (onOpenFile) {
      await onOpenFile(resolution.path, location);
      return;
    }

    const result = await useFileStore.getState().revealAndLoadFile(resolution.path, {
      workspaceId: activeWorkspaceId,
    });
    if (result.status === 'opened') {
      if (location.blockId || location.heading) {
        requestWorkspaceMarkdownLocation({ path: resolution.path, ...location });
      }
      return;
    }
    if (result.status !== 'superseded') toast.error(result.error);
  };

  const status = resolutionError ? 'error' : resolution?.status ?? 'resolving';
  const title = status === 'resolved'
    ? `Open ${resolution?.path}`
    : status === 'ambiguous'
      ? `Ambiguous link: ${resolution?.candidates.join(', ')}`
      : status === 'missing'
        ? `Document not found: ${parsedTarget?.path || target}`
        : status === 'error'
          ? `Document links unavailable: ${resolutionError}`
          : 'Resolving document link…';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status !== 'resolved'}
      aria-label={title}
      title={title}
      data-canvas-wiki-status={status}
      className={cn(
        'inline cursor-pointer border-0 bg-transparent p-0 text-left align-baseline underline decoration-dotted underline-offset-2',
        status === 'resolved' && 'text-primary hover:text-primary/80',
        status === 'ambiguous' && 'cursor-help text-amber-600 dark:text-amber-400',
        status === 'missing' && 'cursor-not-allowed text-destructive decoration-wavy',
        status === 'error' && 'cursor-not-allowed text-destructive decoration-wavy',
        status === 'resolving' && 'cursor-wait text-muted-foreground',
        embed && 'inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 no-underline',
        className,
      )}
    >
      {embed ? <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
      {status === 'missing' ? <Link2Off className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
