'use client';

import { useState, useSyncExternalStore } from 'react';
import { usePathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { buildLocalePath } from '@/app/lib/locale-path';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Languages } from 'lucide-react';
import { useLocale } from 'next-intl';

function getBrowserPathLocale(fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const match = window.location.pathname.match(/^\/(de|en)(?:\/|$)/u);
  return match?.[1] || routing.defaultLocale;
}

function subscribeToBrowserLocation() {
  return () => undefined;
}

async function persistPreferredLocale(locale: string): Promise<boolean> {
  try {
    const response = await fetch('/api/user-preferences', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
    if (response.ok) {
      return true;
    }
    if (response.status === 401) {
      // Public setup/login pages have no user preference to persist yet. Keep
      // next-intl's locale cookie in sync before the document navigation.
      document.cookie = `NEXT_LOCALE=${encodeURIComponent(locale)}; Path=/; SameSite=Lax; Max-Age=31536000`;
      return true;
    }
    if (!response.ok) {
      console.warn('[LanguageSwitcher] Failed to save preferred locale:', response.status);
    }
  } catch (error) {
    console.warn('[LanguageSwitcher] Failed to save preferred locale:', error);
  }
  return false;
}

export function LanguageSwitcher({
  preserveSearch = false,
}: {
  preserveSearch?: boolean;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const pathname = usePathname();
  const locale = useLocale();
  const currentLocale = useSyncExternalStore(
    subscribeToBrowserLocation,
    () => getBrowserPathLocale(locale),
    () => locale,
  );

  async function onSelectLocale(nextLocale: string) {
    const activeLocale = getBrowserPathLocale(currentLocale);
    if (nextLocale === activeLocale || isSaving) return;
    setIsSaving(true);
    const persisted = await persistPreferredLocale(nextLocale);
    if (!persisted) {
      setIsSaving(false);
      return;
    }
    // A full navigation avoids React clearing a mutated document during
    // locale transitions on public pages (see the Sentry hydration failure).
    const search = preserveSearch ? window.location.search : '';
    window.location.assign(`${buildLocalePath(nextLocale, pathname)}${search}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-8 w-8"
          disabled={isSaving}
        >
          <Languages className="h-4 w-4" />
          <span className="sr-only">Switch language</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {routing.locales.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => void onSelectLocale(locale)}
            disabled={isSaving}
            className={locale === currentLocale ? 'bg-accent font-medium' : ''}
          >
            {locale === 'de' ? 'Deutsch' : 'English'}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
