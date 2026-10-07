'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { PluginNavigationGuard } from './plugin-navigation-guard';

const PluginWorkspace = dynamic(
  () => import('./PluginWorkspace').then((module) => module.PluginWorkspace),
  { loading: () => <div className="space-y-4" aria-busy="true"><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="h-64 animate-pulse rounded-lg bg-muted" /></div> },
);

export function PluginsAppClient({ canManageOrganizationCapabilities }: { canManageOrganizationCapabilities: boolean }) {
  const t = useTranslations('skills.drafts');
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6">
      <PluginNavigationGuard unsavedChangesMessage={t('unsavedNavigation')} />
      <PluginWorkspace canManageOrganizationCapabilities={canManageOrganizationCapabilities} />
    </div>
  );
}
