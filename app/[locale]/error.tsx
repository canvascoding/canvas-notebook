'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  const t = useTranslations('common');

  useEffect(() => {
    console.error('App error:', error);
  }, [error]);

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
      <AlertCircle className="h-10 w-10 text-destructive" />
      <div className="text-center">
        <h2 className="text-lg font-semibold">{t('somethingWentWrong')}</h2>
        <p className="text-sm text-muted-foreground">{t('pleaseTryAgain')}</p>
      </div>
      <Button variant="secondary" onClick={reset}>
        {t('retry')}
      </Button>
    </div>
  );
}
