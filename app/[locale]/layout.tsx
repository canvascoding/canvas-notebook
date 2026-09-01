import type { Metadata, Viewport } from "next";
import Script from 'next/script';
import { Suspense } from 'react';

import "@xterm/xterm/css/xterm.css";
import "@excalidraw/excalidraw/index.css";
import "../globals.css";
import { geistMono, geistSans } from '@/app/lib/fonts';
import { Toaster } from "@/components/ui/sonner";
import { InlineScript } from '@/app/components/InlineScript';
import { AppThemeProvider } from "@/app/components/ThemeProvider";
import { WorkspaceAppearanceProvider } from '@/app/components/WorkspaceAppearanceProvider';
import { WorkspaceNavigationSync } from '@/app/components/workspaces/WorkspaceNavigationSync';
import { workspaceAppearanceInitScript } from '@/app/lib/workspaces/appearance-theme-init';
import { WebSocketProvider } from '@/app/components/websocket-provider';
import {NextIntlClientProvider} from 'next-intl';
import {getMessages, setRequestLocale} from 'next-intl/server';
import {routing} from '@/i18n/routing';
import {notFound} from 'next/navigation';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export const metadata: Metadata = {
  title: "Canvas Notebook",
  description: "Canvas Notebook — self-hosted workspace suite",
  applicationName: "Canvas Notebook",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Canvas Notebook",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/favicon.svg", sizes: "any", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/icons/favicon.svg"],
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      "max-image-preview": "none",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({locale}));
}

export default async function LocaleLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{locale: string}>;
}) {
  const {locale} = await params;
  
  if (!routing.locales.includes(locale as 'de' | 'en')) {
    notFound();
  }

  // Enable static rendering
  setRequestLocale(locale);

  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <InlineScript html={'window.EXCALIDRAW_ASSET_PATH="/excalidraw/";'} />
        <Script id="theme-init" src="/theme-init.js" strategy="beforeInteractive" />
        <InlineScript html={workspaceAppearanceInitScript} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <NextIntlClientProvider messages={messages}>
          <AppThemeProvider>
            <WorkspaceAppearanceProvider>
              <Suspense fallback={null}>
                <WorkspaceNavigationSync />
              </Suspense>
              <WebSocketProvider enabled>
                {children}
                <Toaster richColors position="top-right" />
              </WebSocketProvider>
            </WorkspaceAppearanceProvider>
          </AppThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
