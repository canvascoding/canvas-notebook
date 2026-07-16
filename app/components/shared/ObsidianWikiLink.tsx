'use client';

import { FileText, Link2Off } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { WorkspaceDocumentPreviewDialog } from '@/app/components/shared/WorkspaceDocumentPreviewDialog';
import {
  resolveObsidianWikiLink,
  type ObsidianLinkResolution,
} from '@/app/lib/markdown/obsidian-link-resolver';
import { parseObsidianWikiTarget } from '@/app/lib/markdown/obsidian-flavored-markdown';
import {
  loadWorkspaceDocumentReference,
  subscribeWorkspaceLinkIndexInvalidation,
  type WorkspaceDocumentReferenceLookup,
} from '@/app/lib/markdown/workspace-link-index-client';
import {
  workspaceDocumentTitleFromPath,
  type WorkspaceDocumentReference,
} from '@/app/lib/markdown/workspace-document-preview';
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
  preferDocumentTitle?: boolean;
  sourcePath?: string;
  target: string;
};

export function ObsidianWikiLink({
  children,
  className,
  embed = false,
  onOpenFile,
  preferDocumentTitle = false,
  sourcePath,
  target,
}: ObsidianWikiLinkProps) {
  const t = useTranslations('notebook');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const parsedTarget = useMemo(() => parseObsidianWikiTarget(target), [target]);
  const resolutionKey = `${activeWorkspaceId ?? ''}\0${sourcePath ?? ''}\0${target}`;
  const [remoteResolution, setRemoteResolution] = useState<{
    error: string | null;
    key: string;
    value: WorkspaceDocumentReferenceLookup | null;
  } | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const synchronousResolution = useMemo(() => {
    if (!parsedTarget) return null;
    if (!parsedTarget.path || !activeWorkspaceId) {
      return resolveObsidianWikiLink(target, [], sourcePath);
    }
    return null;
  }, [activeWorkspaceId, parsedTarget, sourcePath, target]);
  const needsRemoteResolution = Boolean(parsedTarget && activeWorkspaceId);
  const remoteLookup = needsRemoteResolution && remoteResolution?.key === resolutionKey
    ? remoteResolution.value
    : null;
  const resolution = needsRemoteResolution
    ? remoteLookup?.resolution ?? null
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
    if (!parsedTarget || !activeWorkspaceId) return;

    let cancelled = false;
    void loadWorkspaceDocumentReference(activeWorkspaceId, target, sourcePath).then((lookup) => {
      if (cancelled) return;
      setRemoteResolution({
        error: null,
        key: resolutionKey,
        value: lookup,
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

  const fallbackPath = resolution?.status === 'resolved' ? resolution.path : null;
  const reference: WorkspaceDocumentReference | null = remoteLookup?.reference ?? (
    fallbackPath ? {
      blockId: resolution?.blockId,
      heading: resolution?.heading,
      path: fallbackPath,
      title: workspaceDocumentTitleFromPath(fallbackPath),
    } : null
  );
  const documentTitle = remoteLookup?.document?.title || reference?.title || null;
  const displayChildren = preferDocumentTitle && parsedTarget?.path && !parsedTarget.alias && documentTitle
    ? documentTitle
    : children;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (reference) setPreviewOpen(true);
  };

  const status = resolutionError ? 'error' : resolution?.status ?? 'resolving';
  const title = status === 'resolved' && reference
    ? t('markdownDocumentLinkPreview', { title: reference.title })
    : status === 'ambiguous'
      ? t('markdownDocumentLinkAmbiguous', { candidates: resolution?.candidates.join(', ') || target })
      : status === 'missing'
        ? t('markdownDocumentLinkMissing', { target: parsedTarget?.path || target })
        : status === 'error'
          ? t('markdownDocumentLinkUnavailable', { error: resolutionError || '' })
          : t('markdownDocumentLinkResolving');

  return (
    <>
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
        {displayChildren}
      </button>
      <WorkspaceDocumentPreviewDialog
        open={previewOpen}
        reference={reference}
        onOpenChange={setPreviewOpen}
        onOpenDocument={onOpenFile ? async (nextReference) => {
          await onOpenFile(nextReference.path, {
            blockId: nextReference.blockId ?? null,
            heading: nextReference.heading ?? null,
          });
        } : undefined}
      />
    </>
  );
}
