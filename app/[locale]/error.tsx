'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { captureClientException } from '@/app/lib/observability/capture-client-exception';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

const invalidElementRecoveryKey = 'canvas.invalid-element-recovery';
const invalidElementRecoveryWindowMs = 60_000;

function isInvalidElementError(error: Error) {
  return error.message.startsWith('Element type is invalid: expected a string')
    && error.message.includes('but got: undefined');
}

function reloadForInvalidElementError(error: Error) {
  if (!isInvalidElementError(error)) return;

  try {
    const previousAttempt = Number(window.sessionStorage.getItem(invalidElementRecoveryKey));
    if (Number.isFinite(previousAttempt) && Date.now() - previousAttempt < invalidElementRecoveryWindowMs) return;
    window.sessionStorage.setItem(invalidElementRecoveryKey, String(Date.now()));
    window.location.reload();
  } catch {
    return;
  }
}

export default function Error({ error, reset }: ErrorProps) {
  const t = useTranslations('common');

  useEffect(() => {
    console.error('App error:', error);
    captureClientException(error, {
      boundary: 'localized-route',
      digest: error.digest,
    });
    reloadForInvalidElementError(error);
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
