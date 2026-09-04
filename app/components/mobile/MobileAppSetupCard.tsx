'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Check, Clock3, Copy, Download, Loader2, QrCode, ShieldCheck, Smartphone, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';

import {
  createMobileSetupLink,
  isMobileSetupCompatibility,
  MOBILE_APP_STORE_URL,
  type MobileSetupCompatibility,
} from '@/app/lib/mobile/setup-link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type MobileAppSetupAction = 'open-app' | 'app-store' | 'copy-link';

type MobileAppSetupCardProps = {
  placement: 'dialog' | 'settings';
  onAction?: (action: MobileAppSetupAction) => void;
};

type SetupState =
  | { status: 'loading' }
  | { status: 'ready'; compatibility: MobileSetupCompatibility; serverUrl: string; setupLink: string }
  | { status: 'error'; reason: 'load' | 'secure-origin' };

function useMobileSetupState(revision: number): SetupState {
  const [state, setState] = useState<SetupState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function loadSetup() {
      try {
        const response = await fetch('/api/mobile/v1/compatibility', {
          cache: 'no-store',
          credentials: 'include',
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok || !isMobileSetupCompatibility(payload)) throw new Error('Invalid compatibility response');
        if (window.location.protocol !== 'https:') {
          setState({ status: 'error', reason: 'secure-origin' });
          return;
        }
        const serverUrl = window.location.origin;
        setState({
          status: 'ready',
          compatibility: payload,
          serverUrl,
          setupLink: createMobileSetupLink(serverUrl, payload.instance.id),
        });
      } catch {
        if (controller.signal.aborted) return;
        setState({ status: 'error', reason: 'load' });
      }
    }

    void loadSetup();
    return () => controller.abort();
  }, [revision]);

  return state;
}

export function MobileAppSetupCard({ placement, onAction }: MobileAppSetupCardProps) {
  const t = useTranslations('mobileAppSetup');
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const state = useMobileSetupState(revision);
  const isDialog = placement === 'dialog';
  const serverLabel = state.status === 'ready'
    ? state.compatibility.instance.name
    : t('serverFallback');
  const serverHost = state.status === 'ready' ? new URL(state.serverUrl).host : '';

  const copyLink = useCallback(async () => {
    if (state.status !== 'ready') return;
    try {
      await navigator.clipboard.writeText(state.setupLink);
      setCopied(true);
      onAction?.('copy-link');
      window.setTimeout(() => setCopied(false), 2_500);
    } catch {
      setCopied(false);
    }
  }, [onAction, state]);

  return (
    <section
      aria-labelledby={`mobile-app-setup-title-${placement}`}
      className={cn(
        'relative isolate overflow-hidden border border-border bg-card shadow-sm',
        isDialog ? 'min-h-[22rem] border-0 shadow-none' : 'min-h-[30rem]',
      )}
    >
      <div className="absolute inset-0 -z-20 bg-gradient-to-br from-card via-card to-muted/50" />
      <div className="absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
      <div className="absolute inset-y-0 left-0 -z-10 w-px bg-primary" />
      {!isDialog ? (
        <div className="absolute right-5 top-5 flex items-center gap-2 text-[0.62rem] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          <span className="h-1.5 w-1.5 bg-emerald-500" aria-hidden="true" />
          {t('available')}
        </div>
      ) : null}

      <div className={cn('grid h-full', isDialog ? 'lg:grid-cols-[minmax(0,1fr)_18rem]' : 'lg:grid-cols-[minmax(0,1fr)_20rem]')}>
        <div className={cn('relative flex min-w-0 flex-col px-5 pb-5 sm:px-7 sm:pb-7', isDialog ? 'pt-7 sm:pt-9' : 'pt-16 lg:px-10 lg:pb-10')}>
          <div className="max-w-2xl">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
                <Smartphone className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">{t('eyebrow')}</p>
            </div>
            <h3 id={`mobile-app-setup-title-${placement}`} className={cn('font-semibold leading-[1.05] tracking-[-0.04em]', isDialog ? 'text-3xl sm:text-4xl' : 'text-4xl sm:text-5xl')}>
              {t('title')}
            </h3>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
              {t('description')}
            </p>
          </div>

          <div className="mt-7 grid gap-px border border-border bg-border sm:grid-cols-3">
            {(['scan', 'verify', 'login'] as const).map((step, index) => (
              <div key={step} className="bg-background/90 p-4">
                <p className="font-mono text-[0.62rem] font-bold tracking-[0.16em] text-primary">0{index + 1}</p>
                <p className="mt-2 text-sm font-semibold">{t(`steps.${step}.title`)}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t(`steps.${step}.description`)}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {state.status === 'ready' ? (
              <Button asChild className="rounded-none">
                <a href={state.setupLink} onClick={() => onAction?.('open-app')}>
                  <Smartphone className="h-4 w-4" />
                  {t('openApp')}
                </a>
              </Button>
            ) : null}
            <Button asChild variant="outline" className="rounded-none">
              <a href={MOBILE_APP_STORE_URL} target="_blank" rel="noreferrer" onClick={() => onAction?.('app-store')}>
                <Download className="h-4 w-4" />
                {t('appStore')}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </Button>
            {state.status === 'ready' ? (
              <Button type="button" variant="ghost" onClick={copyLink} className="rounded-none">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? t('copied') : t('copyLink')}
              </Button>
            ) : null}
          </div>

          <div className="mt-auto flex items-start gap-2 pt-7 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            <p>{t('privacy')}</p>
          </div>

        </div>

        <aside className="relative border-t border-border bg-foreground p-5 text-background lg:border-l lg:border-t-0 lg:p-6">
          <div className="relative z-10 mx-auto flex max-w-[17rem] flex-col">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-[0.6rem] font-bold uppercase tracking-[0.18em] text-background/55">{t('thisServer')}</p>
                <p className="mt-1 truncate text-sm font-semibold">{serverLabel}</p>
                <p className="truncate font-mono text-[0.65rem] text-background/55">{serverHost}</p>
              </div>
              <QrCode className="h-5 w-5 shrink-0 text-background/50" aria-hidden="true" />
            </div>

            <div className="mt-5 flex aspect-square items-center justify-center bg-white p-3 shadow-[0_14px_35px_rgba(0,0,0,0.28)]">
              {state.status === 'loading' ? (
                <Loader2 className="h-7 w-7 animate-spin text-slate-500" aria-label={t('loading')} />
              ) : state.status === 'ready' ? (
                <QRCodeSVG
                  value={state.setupLink}
                  size={236}
                  level="M"
                  marginSize={4}
                  bgColor="#ffffff"
                  fgColor="#111827"
                  title={t('qrTitle', { server: serverLabel })}
                  className="h-full w-full"
                />
              ) : (
                <div className="p-4 text-center text-slate-900">
                  <p className="text-sm font-semibold">{state.reason === 'secure-origin' ? t('secureRequiredTitle') : t('loadFailedTitle')}</p>
                  <p className="mt-2 text-xs leading-5 text-slate-600">
                    {state.reason === 'secure-origin' ? t('secureRequired') : t('loadFailed')}
                  </p>
                  {state.reason === 'load' ? (
                    <button type="button" onClick={() => setRevision((current) => current + 1)} className="mt-3 border-b border-slate-900 text-xs font-bold uppercase tracking-wider">
                      {t('retry')}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            <p className="mt-3 text-center font-mono text-[0.6rem] uppercase tracking-[0.14em] text-background/55">{t('scanHint')}</p>
            <div className="relative mx-auto mt-4 h-24 w-24">
              <Image
                src="/images/bradley/bradley-character-starter.png"
                alt={t('bradleyAlt')}
                fill
                sizes="96px"
                className="object-contain object-bottom"
              />
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

export function MobileAppSetupDialog({
  open,
  onOpenChange,
  onPermanentDismiss,
  onAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPermanentDismiss: () => void;
  onAction?: (action: MobileAppSetupAction) => void;
}) {
  const t = useTranslations('mobileAppSetup');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-1.25rem)] gap-0 overflow-y-auto rounded-none border-border p-0 shadow-2xl sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">{t('title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>

        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border bg-background px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
              <Smartphone className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Canvas Mobile</p>
              <p className="mt-0.5 flex items-center gap-2 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                <span className="h-1.5 w-1.5 bg-emerald-500" aria-hidden="true" />
                {t('available')}
              </p>
            </div>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0 rounded-none"
              aria-label={t('dismiss')}
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </header>

        <MobileAppSetupCard placement="dialog" onAction={onAction} />

        <footer className="flex flex-col gap-3 border-t border-border bg-muted/25 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground">
            <Clock3 className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('reminderHint')}
          </p>
          <Button type="button" variant="ghost" className="h-10 justify-start rounded-none sm:justify-center" onClick={onPermanentDismiss}>
            {t('neverShow')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
