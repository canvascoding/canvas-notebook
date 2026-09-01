import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';

import '@excalidraw/excalidraw/index.css';
import '../globals.css';
import { AppThemeProvider } from '@/app/components/ThemeProvider';
import { InlineScript } from '@/app/components/InlineScript';
import { geistMono, geistSans } from '@/app/lib/fonts';
import { Toaster } from '@/components/ui/sonner';
import messages from '@/messages/de.json';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'Canvas Notebook Public Preview',
  description: 'Canvas Notebook public read-only file preview',
  applicationName: 'Canvas Notebook',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Canvas Notebook',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icons/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: ['/icons/favicon.svg'],
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <InlineScript html={'window.EXCALIDRAW_ASSET_PATH="/excalidraw/";'} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <NextIntlClientProvider locale="de" messages={messages}>
          <AppThemeProvider>
            {children}
            <Toaster richColors position="top-right" />
          </AppThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
