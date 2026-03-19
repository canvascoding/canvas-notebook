'use client';

import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

interface ThemeProviderProps {
  children: ReactNode;
}

export function AppThemeProvider({ children }: ThemeProviderProps) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
