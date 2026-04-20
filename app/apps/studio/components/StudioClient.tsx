'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { BulkGenerateView } from './bulk/BulkGenerateView';

const tabs = [
  { key: 'create', path: '/studio/create' },
  { key: 'bulk', path: '/studio/bulk' },
  { key: 'models', path: '/studio/models' },
  { key: 'presets', path: '/studio/presets' },
] as const;

export function StudioClient() {
  const t = useTranslations('studio');
  const pathname = usePathname();
  const router = useRouter();

  const activeTab = tabs.find((tab) => pathname?.startsWith(tab.path))?.key ?? 'models';

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
              {t(`tabs.${tab.key}`)}
              {activeTab === tab.key && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
              )}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {activeTab === 'models' && (
          <p className="text-muted-foreground">{t('comingSoon')}</p>
        )}
        {activeTab === 'create' && (
          <p className="text-muted-foreground">{t('comingSoon')}</p>
        )}
        {activeTab === 'bulk' && (
          <BulkGenerateView />
        )}
        {activeTab === 'presets' && (
          <p className="text-muted-foreground">{t('comingSoon')}</p>
        )}
      </div>
    </div>
  );
}