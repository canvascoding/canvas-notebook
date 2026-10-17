import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

import './globals.css';
import { InlineScript } from '@/app/components/InlineScript';
import { NotFoundPage } from '@/app/components/not-found/NotFoundPage';
import { AppThemeProvider, themeScript } from '@/app/components/ThemeProvider';
import { geistMono, geistSans } from '@/app/lib/fonts';

export const metadata: Metadata = {
  title: '404 · Canvas Notebook',
  robots: { index: false, follow: false },
  icons: { icon: '/icons/favicon.svg' },
};

// This app has separate locale/public root layouts. Unmatched URLs need their
// own document, with just the theme and translations needed by the 404.
export default async function GlobalNotFound() {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head><InlineScript html={themeScript} /></head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <NextIntlClientProvider locale={locale} messages={{ notFound: messages.notFound }}>
          <AppThemeProvider><NotFoundPage /></AppThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
