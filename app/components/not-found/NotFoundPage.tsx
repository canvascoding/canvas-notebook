'use client';

import Image from 'next/image';
import { ArrowLeft, ArrowRight, ArrowUpRight, House, LogIn } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useSyncExternalStore } from 'react';

import { authClient } from '@/app/lib/auth-client';
import { Button } from '@/components/ui/button';

const productUrl = 'https://canvas-notebook.app';

function subscribeToHydration() {
  return () => undefined;
}

export function NotFoundPage() {
  const t = useTranslations('notFound');
  const locale = useLocale();
  const router = useRouter();
  const homeHref = `/${locale}`;
  const loginHref = `/${locale}/login`;
  const { data: session, isPending, error } = authClient.useSession();
  // A surrounding layout may already have resolved Better Auth on the client.
  // Keep the first hydration render identical to the server's neutral view.
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const checking = !hydrated || isPending;
  const anonymous = !checking && !error && !session;
  const state = checking ? 'checking' : error ? 'unavailable' : session ? 'authenticated' : 'anonymous';

  const goBack = () => {
    // history.length can count an initial about:blank entry. Prefer the
    // browser's usable navigation entries, with a fallback for older browsers.
    const navigation = (window as Window & { navigation?: { canGoBack: boolean } }).navigation;
    const canGoBack = navigation?.canGoBack
      ?? (window.history.length > 2 || (window.history.length > 1 && Boolean(document.referrer)));
    if (canGoBack) router.back();
    else router.push(homeHref);
  };

  const artwork = (
    <div className="relative flex h-52 w-full items-center justify-center sm:h-72 lg:h-[28rem]" aria-hidden="true">
      <span className="absolute top-0 font-mono text-[clamp(8rem,22vw,17rem)] leading-none font-bold tracking-[-0.08em] text-foreground/[0.07] select-none dark:text-foreground/[0.09]">404</span>
      <div className="absolute bottom-3 h-12 w-40 bg-blue-500/15 blur-3xl sm:bottom-8 sm:w-64" />
      <Image
        src="/images/bradley/bradley-character-starter.png"
        alt=""
        width={420}
        height={420}
        sizes="(min-width: 1024px) 420px, (min-width: 640px) 300px, 220px"
        className="relative mt-6 h-56 w-56 object-contain select-none sm:mt-10 sm:h-80 sm:w-80 lg:h-[26rem] lg:w-[26rem]"
        priority
      />
    </div>
  );

  return (
    <main className="relative isolate flex min-h-[100svh] flex-col overflow-x-clip bg-background px-6 text-foreground sm:px-10 lg:px-16" data-testid="not-found-page" data-session-state={state}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:64px_64px] opacity-25 [mask-image:radial-gradient(ellipse_at_20%_40%,black,transparent_65%)]" />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 pt-[max(1.5rem,env(safe-area-inset-top))] sm:pt-9">
        <a href={anonymous ? productUrl : homeHref} aria-label={anonymous ? t('discover') : t('home')} className="inline-flex min-h-11 items-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4">
          <Image src="/images/bradley/bradley-icon.svg" alt="" width={32} height={32} className="h-8 w-8" />
          <span className="text-sm font-bold tracking-tight">Canvas Notebook</span>
        </a>
        <span className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground">404</span>
      </header>

      <section aria-labelledby="not-found-title" className="mx-auto grid w-full max-w-6xl flex-1 content-center items-center gap-5 py-7 sm:gap-8 sm:py-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        {anonymous ? (
          <a href={productUrl} aria-label={t('discover')} className="block outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4">{artwork}</a>
        ) : artwork}

        <div className="min-w-0">
          <p className="mb-3 text-[10px] font-bold tracking-[0.2em] text-blue-600 uppercase dark:text-blue-400">{t('eyebrow')}</p>
          <h1 id="not-found-title" className="max-w-xl text-3xl leading-[1.12] font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl">{t('title')}</h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">{t('description')}</p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="min-h-11 gap-2 px-5">
              <a href={anonymous ? loginHref : homeHref}>
                {anonymous ? <LogIn aria-hidden="true" /> : <House aria-hidden="true" />}
                {anonymous ? t('login') : t('home')}
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
            <Button type="button" variant="outline" size="lg" className="min-h-11 gap-2 px-5" onClick={goBack}>
              <ArrowLeft aria-hidden="true" />
              {t('back')}
            </Button>
          </div>

          <div className="mt-3 min-h-5 text-xs leading-relaxed text-muted-foreground" role="status" aria-live="polite">
            {checking ? t('checkingSession') : error ? t('sessionUnavailable') : null}
          </div>

          {anonymous ? (
            <aside className="mt-5 max-w-md border-t border-border pt-5 sm:mt-7 sm:pt-6" aria-labelledby="not-found-promo-title" data-testid="not-found-promo">
              <p id="not-found-promo-title" className="text-sm font-bold">{t('promoTitle')}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t('promoDescription')}</p>
              <a href={productUrl} className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-blue-600 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 dark:text-blue-400">
                {t('discover')}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </aside>
          ) : null}
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-[10px] text-muted-foreground sm:pb-9">
        <span>{t('footer')}</span>
        <span className="font-mono tracking-[0.14em]" aria-hidden="true">CANVAS / 404</span>
      </footer>
    </main>
  );
}
