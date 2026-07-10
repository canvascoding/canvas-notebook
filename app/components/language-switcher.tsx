'use client';

import { useState } from 'react';
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
import { useParams } from 'next/navigation';

async function persistPreferredLocale(locale: string): Promise<boolean> {
  try {
    const response = await fetch('/api/user-preferences', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
    if (response.ok || response.status === 401) {
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

export function LanguageSwitcher() {
  const [isSaving, setIsSaving] = useState(false);
  const pathname = usePathname();
  const params = useParams();
  const currentLocale = params.locale as string || routing.defaultLocale;

  async function onSelectLocale(nextLocale: string) {
    if (nextLocale === currentLocale || isSaving) return;
    setIsSaving(true);
    const persisted = await persistPreferredLocale(nextLocale);
    if (!persisted) {
      setIsSaving(false);
      return;
    }
    // A full navigation avoids React clearing a mutated document during
    // locale transitions on public pages (see the Sentry hydration failure).
    window.location.assign(buildLocalePath(nextLocale, pathname));
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
            disabled={locale === currentLocale}
            className={locale === currentLocale ? 'bg-accent font-medium' : ''}
          >
            {locale === 'de' ? 'Deutsch' : 'English'}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
