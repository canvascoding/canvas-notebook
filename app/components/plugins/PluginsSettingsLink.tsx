'use client';

import { Puzzle, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

export function PluginsSettingsLink() {
  const t = useTranslations('home.apps.plugins');
  return (
    <div className="rounded-lg border bg-card p-5">
      <Puzzle className="mb-3 h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t('description')}</p>
      <Button asChild className="mt-4 gap-2"><Link href="/plugins">{t('open')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>
    </div>
  );
}
