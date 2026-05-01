'use client';


import { Link, usePathname } from '@/i18n/navigation';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { LogoutButton } from '@/app/components/LogoutButton';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';
import { AppLauncher } from '@/app/components/AppLauncher';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { HelpDropdown } from '@/app/components/onboarding/HelpDropdown';
import { HintProvider } from '@/app/components/onboarding/HintProvider';

import { Button } from '@/components/ui/button';

type SuitePageLayoutProps = {
  title: string;
  children: ReactNode;
  mainClassName?: string;
  titleClassName?: string;
  hintPage?: string;
};

export function SuitePageLayout({
  title,
  children,
  mainClassName,
  titleClassName,
  hintPage,
}: SuitePageLayoutProps) {
  const t = useTranslations('common');
  const pathname = usePathname();
  
  // Determine back navigation based on current route
  const getBackHref = () => {
    // Handle specific studio subroutes that should go back to their list
    if (pathname?.match(/^\/studio\/models\/[^/]+$/)) {
      return '/studio/models';
    }
    if (pathname?.match(/^\/studio\/presets\/[^/]+$/)) {
      return '/studio/presets';
    }
    if (pathname?.match(/^\/studio\/products\/[^/]+$/)) {
      return '/studio/products';
    }
    if (pathname?.match(/^\/studio\/personas\/[^/]+$/)) {
      return '/studio/personas';
    }
    
    // Default studio back navigation
    if (pathname?.startsWith('/studio/')) {
      return '/studio';
    }
    
    return '/';
  };
  
  const backHref = getBackHref();
  const isStudioSubroute = pathname?.startsWith('/studio/');
  const backLabel = isStudioSubroute ? t('studio') : t('suite');

  const content = (
    <div className="h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="min-w-0 flex items-center gap-2 sm:gap-3">
              <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
                <Link href={backHref}>
                  <ArrowLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">{backLabel}</span>
                </Link>
              </Button>

              <div className="min-w-0">
                <h1 className={cn('truncate text-sm font-semibold sm:text-base md:text-lg', titleClassName)}>{title}</h1>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 md:gap-3">

              {hintPage && <HelpDropdown page={hintPage} />}
              <AppLauncher />
              <NotebookNavButton />
              <ThemeToggle />
              <LogoutButton />
            </div>
          </div>
        </header>

        <main className={cn('min-h-0 flex-1 overflow-y-auto', mainClassName)}>{children}</main>
      </div>
    </div>
  );

  return <HintProvider page={hintPage ?? ''}>{content}</HintProvider>;
}