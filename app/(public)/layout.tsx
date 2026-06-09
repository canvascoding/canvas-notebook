import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';

import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';
import '@excalidraw/excalidraw/index.css';
import '../globals.css';
import { AppThemeProvider } from '@/app/components/ThemeProvider';
import messages from '@/messages/de.json';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

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
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: ['/icons/icon-192.png'],
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
        <script
          dangerouslySetInnerHTML={{
            __html: 'window.EXCALIDRAW_ASSET_PATH="/excalidraw/";',
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <NextIntlClientProvider locale="de" messages={messages}>
          <AppThemeProvider>
            {children}
          </AppThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
