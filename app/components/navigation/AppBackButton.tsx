'use client';

import { ArrowLeft, ChevronDown, House } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

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
      router.replace(fallbackHref);
      return;
    }

    router.back();
  };

  const handleHome = () => {
    router.push('/');
  };

  return (
    <div className="inline-flex shrink-0 items-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          'relative rounded-r-none focus-visible:z-10',
          className ?? 'gap-2 px-2 sm:px-3',
        )}
        onClick={handleBack}
        aria-label={t('back')}
      >
        <ArrowLeft className="h-4 w-4" />
        <span className="hidden sm:inline">{t('back')}</span>
      </Button>

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="relative -ml-px w-7 rounded-l-none px-0 focus-visible:z-10"
            aria-label={t('openNavigationMenu')}
            title={t('openNavigationMenu')}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="w-44">
          <DropdownMenuItem onSelect={handleBack}>
            <ArrowLeft />
            {t('back')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleHome}>
            <House />
            {t('home')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
