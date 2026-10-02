'use client';

import dynamic from 'next/dynamic';
import { usePluginNavigation } from './usePluginNavigation';

const SkillsPanel = dynamic(
  () => import('./PluginsPanel').then((module) => module.SkillsPanel),
  { loading: () => <div className="space-y-4" aria-busy="true"><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="h-64 animate-pulse rounded-lg bg-muted" /></div> },
);

export function PluginsAppClient({ canManageOrganizationCapabilities }: { canManageOrganizationCapabilities: boolean }) {
  const { navigation } = usePluginNavigation();
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:px-6">
      <SkillsPanel key={navigation.scope} canManageOrganizationCapabilities={canManageOrganizationCapabilities} />
    </div>
  );
}
