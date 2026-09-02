'use client';

import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

type AppBackButtonProps = {
  fallbackHref: string;
  /** Use this for detail views with a stable, meaningful parent page. */
  preferFallback?: boolean;
  className?: string;
};

export function AppBackButton({ fallbackHref, preferFallback = false, className }: AppBackButtonProps) {
  const router = useRouter();
  const t = useTranslations('common');

  const handleBack = () => {
    // A new tab starts with one history entry. In that case we keep people in Canvas
    // rather than invoking the browser's unavailable back action.
    if (preferFallback || window.history.length <= 1) {
      router.push(fallbackHref);
      return;
    }

    router.back();
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className ?? 'gap-2 px-2 sm:px-3'}
      onClick={handleBack}
    >
      <ArrowLeft className="h-4 w-4" />
      <span className="hidden sm:inline">{t('back')}</span>
    </Button>
  );
}
