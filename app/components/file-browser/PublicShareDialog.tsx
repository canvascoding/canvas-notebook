'use client';

import { useEffect, useRef } from 'react';
import { Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileGuestManagementPanel } from '../file-guests/FileGuestManagementPanel';
import { PublicLinkPanel } from './PublicLinkPanel';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';

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
  const canInvite = path && /\.(md|markdown)$/i.test(path);
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
          {!canInvite ? <p className="text-sm text-muted-foreground">{t('guestsUnsupported')}</p>
            : !teamEnabled || workspace.legacy ? <p className="text-sm text-muted-foreground">{t('teamRequired')}</p>
            : !workspace.permissions.canCreatePublicLinks ? <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
            : <FileGuestManagementPanel path={path!} workspace={workspace} />}
        </TabsContent>
        <TabsContent value="export" className="pb-4">
          {canExport ? <ShareMarkdownDialog key={`${workspace.id}:${path}`} open onOpenChange={onOpenChange} embedded workspaceId={workspace.id} filePath={path!} fileName={path!.split('/').pop()!} kind={/\.(html|htm)$/i.test(path!) ? 'html' : 'markdown'} /> : <p className="px-4 text-sm text-muted-foreground sm:px-6">{t('selectExport')}</p>}
        </TabsContent>
      </Tabs> : <p role="status" className="p-4 text-sm">{t('workspaceLoading')}</p>}
      <DialogFooter className="shrink-0 border-t p-3"><Button variant="outline" onClick={() => onOpenChange(false)}>{t('close')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
