'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { BulkGenerateView } from './bulk/BulkGenerateView';
import { StudioDashboard } from './StudioDashboard';
import { CreateView } from './create/CreateView';
import { ModelLibrary } from './models/ModelLibrary';

const tabs = [
  { key: 'dashboard', path: '/studio' },
  { key: 'create', path: '/studio/create' },
  { key: 'bulk', path: '/studio/bulk' },
  { key: 'models', path: '/studio/models' },
  { key: 'presets', path: '/studio/presets' },
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
      <div className="border-b border-border bg-background/95 px-4 pt-2">
        <nav className="flex gap-1" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => router.push(tab.path)}
              className={cn(
                'relative px-4 py-2.5 text-sm font-medium transition-colors hover:text-foreground',
                activeTab === tab.key
                  ? 'text-foreground'
                  : 'text-muted-foreground',
              )}
            >
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
        {activeTab === 'presets' && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <p className="text-muted-foreground">Studio Presets are now available on a dedicated page.</p>
            <button
              onClick={() => router.push('/studio/presets')}
              className="text-sm font-medium text-primary hover:underline"
            >
              Go to Studio Presets
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
