'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { BulkGenerateView } from './bulk/BulkGenerateView';
import { StudioDashboard } from './StudioDashboard';
import { CreateView } from './create/CreateView';
import { ModelLibrary } from './models/ModelLibrary';
import { PresetLibrary } from './presets/PresetLibrary';
import { ImagePlus, Layers, LayoutGrid, Sparkles, SwatchBook } from 'lucide-react';

const tabs = [
  { key: 'dashboard', path: '/studio', icon: Sparkles },
  { key: 'create', path: '/studio/create', icon: ImagePlus },
  { key: 'models', path: '/studio/models', icon: LayoutGrid },
  { key: 'presets', path: '/studio/presets', icon: SwatchBook },
  { key: 'bulk', path: '/studio/bulk', icon: Layers },
] as const;

export function StudioClient() {
  const t = useTranslations('studio');
  const pathname = usePathname();
  const router = useRouter();

  const activeTab = tabs.find((tab) => {
    if (tab.key === 'dashboard') return pathname === '/studio' || pathname === '/studio/';
    return pathname?.startsWith(tab.path);
  })?.key ?? 'dashboard';

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-background/95 px-3 pt-2 sm:px-4">
        <nav className="flex gap-1 overflow-x-auto no-scrollbar" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => router.push(tab.path)}
              className={cn(
                'relative flex flex-shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors hover:text-foreground sm:px-4',
                activeTab === tab.key
                  ? 'text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.key === 'dashboard' ? t('dashboard.tabLabel') : t(`tabs.${tab.key}`)}
              {activeTab === tab.key && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {activeTab === 'dashboard' && <StudioDashboard />}
        {activeTab === 'create' && <CreateView />}
        {activeTab === 'bulk' && <BulkGenerateView />}
        {activeTab === 'models' && <ModelLibrary />}
        {activeTab === 'presets' && <PresetLibrary />}
      </div>
    </div>
  );
}