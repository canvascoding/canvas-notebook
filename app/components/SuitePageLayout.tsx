import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { LogoutButton } from '@/app/components/LogoutButton';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { HelpDropdown } from '@/app/components/onboarding/HelpDropdown';

import { Button } from '@/components/ui/button';

type SuitePageLayoutProps = {
  title: string;
  username: string;
  children: ReactNode;
  mainClassName?: string;
  showLogo?: boolean;
  titleClassName?: string;
  hintPage?: string;
};

export function SuitePageLayout({
  title,
  username,
  children,
  mainClassName,
  showLogo = false,
  titleClassName,
  hintPage,
}: SuitePageLayoutProps) {
  const t = useTranslations('common');

  return (
    <div className="h-[100dvh] overflow-hidden bg-background text-foreground">
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="min-w-0 flex items-center gap-2 sm:gap-3">
              <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
                <Link href="/">
                  <ArrowLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">{t('suite')}</span>
                </Link>
              </Button>
              {showLogo ? (
                <Image
                  src="/logo.jpg"
                  alt="Canvas Notebook logo"
                  width={32}
                  height={32}
                  className="shrink-0 border border-border"
                />
              ) : null}
              <div className="min-w-0">
                <h1 className={cn('truncate text-sm font-semibold sm:text-base md:text-lg', titleClassName)}>{title}</h1>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 md:gap-3">
              <div className="hidden min-[480px]:flex flex-col items-end">
                <span className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">{t('user')}</span>
                <span className="max-w-[140px] truncate text-xs">{username}</span>
              </div>
              {hintPage && <HelpDropdown page={hintPage} />}
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
}
