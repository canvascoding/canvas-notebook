'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/app/components/ThemeProvider';
import { Button } from '@/components/ui/button';

function subscribe() {
  return () => {};
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isClient = useSyncExternalStore(subscribe, () => true, () => false);
  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2 px-2 sm:px-3"
      onClick={() => {
        if (isClient) {
          setTheme(isDark ? 'light' : 'dark');
        }
      }}
      aria-label={isClient ? (isDark ? 'Switch to light mode' : 'Switch to dark mode') : 'Switch theme'}
      title={isClient ? (isDark ? 'Switch to light mode' : 'Switch to dark mode') : 'Switch theme'}
    >
      {isClient ? (isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />) : <Moon className="h-4 w-4" />}
      <span className="hidden sm:inline">{isClient ? (isDark ? 'Light' : 'Dark') : 'Theme'}</span>
    </Button>
  );
}
