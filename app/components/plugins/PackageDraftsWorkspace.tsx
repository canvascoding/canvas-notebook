'use client';

import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { CapabilityPackageOwnedDraftStatus } from '@/app/lib/capabilities/packages/contracts';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { PackageDraftsSection } from './PackageDraftsSection';
import { PackageEditorSection } from './PackageEditorSection';
import { usePluginNavigation } from './usePluginNavigation';

/** Own draft metadata stays reachable independently from the visible installed catalog. */
export function PackageDraftsWorkspace({ workspaceId: requestedWorkspaceId }: { workspaceId?: string | null } = {}) {
  const t = useTranslations('skills.drafts');
  const { navigation, navigate } = usePluginNavigation();
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const workspaceId = requestedWorkspaceId ?? activeWorkspaceId;
  const open = (status: CapabilityPackageOwnedDraftStatus) => {
    navigate({ area: status.kind === 'plugin' ? 'plugins' : 'skills', view: 'drafts',
      resourceRef: status.sourceResourceRef ?? undefined, draftRef: status.draftRef, task: 'content' });
  };
  const close = () => navigate({ draftRef: undefined, resourceRef: undefined, task: undefined, file: undefined });
  return (
    <section className="space-y-6" data-testid="package-drafts-workspace">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button variant="outline" onClick={() => navigation.draftRef ? close() : navigate({ view: 'installed' })}>
          <ArrowLeft className="h-4 w-4" />{navigation.draftRef ? t('backToDrafts') : t('backToInstalled')}
        </Button>
      </header>
      {navigation.draftRef ? (
        <PackageEditorSection resourceRef={navigation.resourceRef} initialDraftRef={navigation.draftRef}
          initiallyOpen initialFile={navigation.file} workspaceId={workspaceId} onDraftStarted={draft => navigate({
            area: draft.kind === 'plugin' ? 'plugins' : 'skills', view: 'drafts', resourceRef: draft.sourceResourceRef ?? undefined,
            draftRef: draft.draftRef, task: 'content', file: undefined,
          })} />
      ) : <PackageDraftsSection workspaceId={workspaceId} onOpenDraft={open} showHeader={false} />}
    </section>
  );
}
