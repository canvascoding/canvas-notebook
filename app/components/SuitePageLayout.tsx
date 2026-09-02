'use client';


import { usePathname } from '@/i18n/navigation';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';


import { AppLauncher } from '@/app/components/AppLauncher';
import { NotificationBell } from '@/app/components/notifications/NotificationBell';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { HintProvider } from '@/app/components/onboarding/HintProvider';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import { AppBackButton } from '@/app/components/navigation/AppBackButton';

type SuitePageLayoutProps = {
  title: string;
  children: ReactNode;
  mainClassName?: string;
  titleClassName?: string;
  hintPage?: string;
  hintEnabled?: boolean;
};

export function SuitePageLayout({
  title,
  children,
  mainClassName,
  titleClassName,
  hintPage,
  hintEnabled = true,
}: SuitePageLayoutProps) {
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

    if (pathname?.match(/^\/automations\/[^/]+$/)) {
      return '/automations';
    }
    
    // Default studio back navigation
    if (pathname?.startsWith('/studio/')) {
      return '/studio';
    }
    
    return '/';
  };
  
  const backHref = getBackHref();
  const prefersParentFallback = Boolean(
    pathname?.match(/^\/automations\/[^/]+$/)
    || pathname?.match(/^\/studio\/(?:models|presets|products|personas)\/[^/]+$/),
  );

  const content = (
    <div className="fixed inset-0 overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="sticky top-0 z-20 shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="min-w-0 flex items-center gap-2 sm:gap-3">
              <AppBackButton fallbackHref={backHref} preferFallback={prefersParentFallback} />

              <div className="min-w-0">
                <h1 className={cn('truncate text-sm font-semibold sm:text-base md:text-lg', titleClassName)}>{title}</h1>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 md:gap-3">
              <WorkspaceSwitcher source="navbar" variant="compact" />
              <NotificationBell />
              <AppLauncher />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', mainClassName)}>{children}</main>
      </div>
    </div>
  );

  return <HintProvider page={hintPage ?? ''} enabled={hintEnabled}>{content}</HintProvider>;
}
