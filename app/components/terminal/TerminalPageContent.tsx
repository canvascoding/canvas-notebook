'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { TerminalPanel } from './Terminal';
import { useTerminalAvailability } from './TerminalAvailabilityProvider';

export function TerminalPageContent() {
  const { terminalEnabled, ready } = useTerminalAvailability();
  const t = useTranslations('terminal');
  if (!ready) return null;
  if (terminalEnabled) return <TerminalPanel standalone className="h-full" />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-sm text-muted-foreground">{t('disabledByAdmin')}</p>
      <Button asChild variant="outline"><Link href="/notebook">{t('backToNotebook')}</Link></Button>
    </div>
  );
}
