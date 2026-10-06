'use client';

import dynamic from 'next/dynamic';
import { FilePenLine } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { PackageDraftsWorkspace } from './PackageDraftsWorkspace';
import { PluginNavigationGuard } from './plugin-navigation-guard';
import { usePluginNavigation } from './usePluginNavigation';

const SkillsPanel = dynamic(
  () => import('./PluginsPanel').then((module) => module.SkillsPanel),
  { loading: () => <div className="space-y-4" aria-busy="true"><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="h-64 animate-pulse rounded-lg bg-muted" /></div> },
);

export function PluginsAppClient({ canManageOrganizationCapabilities }: { canManageOrganizationCapabilities: boolean }) {
  const { navigation, navigate } = usePluginNavigation();
  const t = useTranslations('skills.drafts');
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6">
      <PluginNavigationGuard unsavedChangesMessage={t('unsavedNavigation')} />
      {navigation.view === 'drafts' ? <PackageDraftsWorkspace /> : <>
        <div className="mb-4 flex justify-end">
          <Button variant="outline" onClick={() => navigate({ view: 'drafts' })} data-testid="plugin-own-drafts">
            <FilePenLine className="h-4 w-4" />{t('title')}
          </Button>
        </div>
        <SkillsPanel key={navigation.scope} canManageOrganizationCapabilities={canManageOrganizationCapabilities} />
      </>}
    </div>
  );
}
