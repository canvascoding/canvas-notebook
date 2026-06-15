'use client';

import { useMemo } from 'react';
import { ChevronDown, ImagePlus, Layers, LayoutGrid, Ratio, SwatchBook } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

const studioRouteItems = [
  { key: 'create', href: '/studio', icon: ImagePlus, labelKey: 'tabs.create' },
  { key: 'models', href: '/studio/models', icon: LayoutGrid, labelKey: 'tabs.models' },
  { key: 'presets', href: '/studio/presets', icon: SwatchBook, labelKey: 'tabs.presets' },
  { key: 'bulk', href: '/studio/bulk', icon: Layers, labelKey: 'tabs.bulk' },
  { key: 'aspectRatio', href: '/studio/aspect-ratio', icon: Ratio, labelKey: 'tabs.resize' },
] as const;

type StudioRouteItem = (typeof studioRouteItems)[number];

function isActiveStudioRoute(pathname: string | null, item: StudioRouteItem) {
  if (!pathname) return item.key === 'create';

  if (item.key === 'create') {
    return pathname === '/studio' || pathname === '/studio/' || pathname.startsWith('/studio/create');
  }

  if (item.key === 'models') {
    return (
      pathname.startsWith('/studio/models') ||
      pathname.startsWith('/studio/products') ||
      pathname.startsWith('/studio/personas')
    );
  }

  return pathname.startsWith(item.href);
}

export function StudioRouteNav() {
  const t = useTranslations('studio');
  const pathname = usePathname();
  const activeItem = useMemo(
    () => studioRouteItems.find((item) => isActiveStudioRoute(pathname, item)) ?? studioRouteItems[0],
    [pathname],
  );
  const ActiveIcon = activeItem.icon;

  return (
    <>
      <nav
        aria-label={t('title')}
        className="hidden min-w-0 items-center rounded-full border border-border/70 bg-muted/40 p-1 shadow-sm xl:flex"
      >
        {studioRouteItems.map((item) => {
          const Icon = item.icon;
          const active = isActiveStudioRoute(pathname, item);

          return (
            <Button
              key={item.key}
              asChild
              variant={active ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                'h-8 rounded-full px-2.5 text-xs font-medium',
                active ? 'shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Link href={item.href} aria-current={active ? 'page' : undefined}>
                <Icon className="h-3.5 w-3.5" />
                <span>{t(item.labelKey)}</span>
              </Link>
            </Button>
          );
        })}
      </nav>

      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 rounded-full px-2.5 xl:hidden"
            aria-label={t('title')}
          >
            <ActiveIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{t(activeItem.labelKey)}</span>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {studioRouteItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveStudioRoute(pathname, item);

            return (
              <DropdownMenuItem key={item.key} asChild>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('gap-2', active && 'bg-accent font-medium text-accent-foreground')}
                >
                  <Icon className="h-4 w-4" />
                  {t(item.labelKey)}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
