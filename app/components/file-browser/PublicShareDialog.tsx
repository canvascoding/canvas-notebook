'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { WorkspaceFileMetadataTarget } from '@/app/lib/files/workspace-file-metadata-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileGuestManagementPanel, fileGuestTargetMatches } from '../file-guests/FileGuestManagementPanel';
import { PublicLinkPanel } from './PublicLinkPanel';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';
import { isCancelledShareRequest, useScopedShareRequest } from './sharing-client';

type GuestInfoLifetime = { scope: string; active: boolean };
type GuestInfoCache = Readonly<{ scope: string; lifetime: GuestInfoLifetime; target?: WorkspaceFileMetadataTarget;
  requestEpoch?: symbol; pending?: Promise<WorkspaceFileMetadataTarget> }>;
type GuestInfoState = { scope: string; target: WorkspaceFileMetadataTarget | null; loading: boolean; error: string };

interface PublicShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  onPublished?: () => void;
  workspaceId?: string | null;
}

export function PublicShareDialog({ open, onOpenChange, paths, onPublished, workspaceId }: PublicShareDialogProps) {
  const t = useTranslations('fileSharing');
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const teamEnabled = useWorkspaceStore((state) => state.teamFeaturesEnabled && state.databaseProvider === 'postgres');
  const workspace = workspaces.find((item) => item.id === (workspaceId ?? activeWorkspaceId));
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  const context = JSON.stringify([workspace?.id, uniquePaths]);
  const previousContext = useRef({ context, open });
  useEffect(() => {
    if (open && previousContext.current.open && previousContext.current.context !== context) onOpenChange(false);
    previousContext.current = { context, open };
  }, [context, onOpenChange, open]);
  const path = uniquePaths.length === 1 ? uniquePaths[0] : null;
  const resolvedWorkspaceId = workspace?.id ?? '';
  const request = useScopedShareRequest(resolvedWorkspaceId);
  const infoScope = open && path && workspace && workspace.id === activeWorkspaceId && teamEnabled
    && !workspace.legacy && workspace.permissions.canCreatePublicLinks ? JSON.stringify([workspace.id, path]) : null;
  const liveInfo = useRef<GuestInfoLifetime | null>(null);
  const infoCache = useRef<GuestInfoCache | null>(null);
  const [infoState, setInfoState] = useState<GuestInfoState | null>(null);
  useLayoutEffect(() => {
    if (!infoScope) return;
    const lifetime = { scope: infoScope, active: true };
    liveInfo.current = lifetime;
    return () => {
      lifetime.active = false;
      if (liveInfo.current === lifetime) liveInfo.current = null;
      if (infoCache.current?.lifetime === lifetime) infoCache.current = null;
    };
  }, [infoScope]);
  const loadTarget = useCallback(async (refresh = false): Promise<WorkspaceFileMetadataTarget> => {
    const lifetime = liveInfo.current;
    if (!infoScope || !path || !lifetime?.active || lifetime.scope !== infoScope
      || useWorkspaceStore.getState().activeWorkspaceId !== resolvedWorkspaceId) {
      throw new DOMException('Sharing context changed', 'AbortError');
    }
    const entry = infoCache.current?.lifetime === lifetime ? infoCache.current : null;
    if (entry?.pending) return entry.pending;
    if (!refresh && entry?.target) return entry.target;
    const previousTarget = entry?.target ?? null;
    const requestEpoch = Symbol('guest-info-request');
    setInfoState({ scope: infoScope, target: previousTarget, loading: true, error: '' });
    // Publish the immutable pending entry before any request can settle.
    const pending = Promise.resolve().then(async () => {
      try {
        if (!lifetime.active || liveInfo.current !== lifetime || infoCache.current?.requestEpoch !== requestEpoch) {
          throw new DOMException('Sharing context changed', 'AbortError');
        }
        const payload = await request<{ data?: { metadataTarget?: unknown } }>(`/api/files/info?${new URLSearchParams({ path })}`);
        if (!lifetime.active || liveInfo.current !== lifetime || infoCache.current?.requestEpoch !== requestEpoch) {
          throw new DOMException('Sharing context changed', 'AbortError');
        }
        if (!fileGuestTargetMatches(payload.data?.metadataTarget, resolvedWorkspaceId, path)) throw new Error(t('loadFailed'));
        const target = Object.freeze({ ...payload.data.metadataTarget });
        infoCache.current = { scope: infoScope, lifetime, target };
        setInfoState({ scope: infoScope, target, loading: false, error: '' });
        return target;
      } catch (error) {
        if (lifetime.active && liveInfo.current === lifetime && infoCache.current?.requestEpoch === requestEpoch) {
          infoCache.current = { scope: infoScope, lifetime };
          setInfoState({ scope: infoScope, target: null, loading: false,
            error: isCancelledShareRequest(error) ? '' : error instanceof Error ? error.message : t('loadFailed') });
        }
        throw error;
      }
    });
    infoCache.current = { scope: infoScope, lifetime, requestEpoch, pending };
    return pending;
  }, [infoScope, path, request, resolvedWorkspaceId, t]);
  useEffect(() => {
    let active = true;
    if (infoScope) queueMicrotask(() => { if (active) void loadTarget().catch(() => undefined); });
    return () => { active = false; };
  }, [infoScope, loadTarget]);
  const currentInfo = infoState?.scope === infoScope ? infoState : null;
  const target = currentInfo?.target;
  const canInvite = target?.kind === 'native_file' || target?.kind === 'filesystem' && target.entryType === 'file'
    && path && /\.(md|markdown)$/i.test(path);
  const canExport = path && /\.(md|mdx|markdown|html|htm)$/i.test(path);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="min-w-0 p-4 pr-12 sm:p-6 sm:pr-12">
        <DialogTitle className="flex items-center gap-2"><Share2 className="size-5" />{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {workspace && <p className="truncate text-xs text-muted-foreground" title={workspace.name}>{workspace.name}</p>}
        {path && <p className="break-all font-mono text-xs" title={path}>{path}</p>}
      </DialogHeader>
      {open && workspace && workspace.id === activeWorkspaceId ? <Tabs key={context} defaultValue="link" className="min-h-0 flex-1 gap-0 overflow-y-auto">
        <TabsList className="mx-4 mb-4 grid w-auto grid-cols-3 sm:mx-6" aria-label={t('title')}>
          <TabsTrigger value="link">{t('link')}</TabsTrigger><TabsTrigger value="people">{t('people')}</TabsTrigger><TabsTrigger value="export">{t('export')}</TabsTrigger>
        </TabsList>
        <TabsContent value="link" className="px-4 pb-4 sm:px-6"><PublicLinkPanel paths={uniquePaths} workspace={workspace} onPublished={onPublished} /></TabsContent>
        <TabsContent value="people" className="px-4 pb-4 sm:px-6">
          {!path ? <p className="text-sm text-muted-foreground">{t('guestsUnsupported')}</p>
            : !teamEnabled || workspace.legacy ? <p className="text-sm text-muted-foreground">{t('teamRequired')}</p>
            : !workspace.permissions.canCreatePublicLinks ? <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
            : !currentInfo || currentInfo.loading && !target ? <Loader2 aria-label={t('refresh')} className="size-5 animate-spin" />
            : currentInfo.error ? <p role="alert" className="text-sm text-destructive">{currentInfo.error} <Button variant="link" size="sm" onClick={() => void loadTarget(true).catch(() => undefined)}>{t('retry')}</Button></p>
            : !canInvite ? <p className="text-sm text-muted-foreground">{t('guestsUnsupported')}</p>
            : <FileGuestManagementPanel path={path} workspace={workspace} loadTarget={loadTarget} />}
        </TabsContent>
        <TabsContent value="export" className="pb-4">
          {canExport ? <ShareMarkdownDialog key={`${workspace.id}:${path}`} open onOpenChange={onOpenChange} embedded workspaceId={workspace.id} filePath={path!} fileName={path!.split('/').pop()!} kind={/\.(html|htm)$/i.test(path!) ? 'html' : 'markdown'} /> : <p className="px-4 text-sm text-muted-foreground sm:px-6">{t('selectExport')}</p>}
        </TabsContent>
      </Tabs> : <p role="status" className="p-4 text-sm">{t('workspaceLoading')}</p>}
      <DialogFooter className="shrink-0 border-t p-3"><Button variant="outline" onClick={() => onOpenChange(false)}>{t('close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
