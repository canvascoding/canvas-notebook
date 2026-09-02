'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type InvitationPreview = {
  invitationId: string;
  email: string;
  role: 'admin' | 'member' | 'external';
  status: 'pending' | 'accepted';
  expiresAt: number;
  requestId: string | null;
};

type InvitationSeatQuote = {
  stage: 'seat_prepare_pending' | 'approval_required' | 'seat_execute_pending' | 'billing_pending' | 'active';
  membershipId: string;
  quote: {
    quantityBefore: number;
    quantityAfter: number;
    unitAmountCents: number;
    currency: string;
    recurringAmountCents: number;
    immediateAmountCents: number | null;
    nonBillable: boolean;
    status: string;
    expiresAt: string;
  };
  approval: {
    status: string;
  };
  execution?: {
    status: string;
    paymentStatus: string | null;
    onboardingInitialized: boolean;
  };
};

function formatMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function validRequestId(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
}

export function TeamInvitationAcceptancePanel({
  token,
  initialRequestId,
}: {
  token: string;
  initialRequestId: string | null;
}) {
  const t = useTranslations('invitationAcceptance');
  const locale = useLocale();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [quote, setQuote] = useState<InvitationSeatQuote | null>(null);
  const [requestId, setRequestId] = useState(
    validRequestId(initialRequestId) ? initialRequestId : null,
  );
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'preview' | 'accept' | 'refresh' | 'activate' | null>('preview');
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  useEffect(() => {
    let mounted = true;
    fetch('/api/organization/invitations/preview', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as {
          success?: boolean;
          data?: InvitationPreview;
          error?: string;
        };
        if (!response.ok || payload.success !== true || !payload.data) {
          throw new Error(payload.error || t('errors.preview'));
        }
        if (mounted) {
          setPreview(payload.data);
          if (validRequestId(payload.data.requestId)) {
            setRequestId(payload.data.requestId);
            const url = new URL(window.location.href);
            url.searchParams.set('request', payload.data.requestId);
            window.history.replaceState(window.history.state, '', url);
          }
        }
      })
      .catch((previewError) => {
        if (mounted) {
          setError(previewError instanceof Error ? previewError.message : t('errors.preview'));
        }
      })
      .finally(() => {
        if (mounted) setBusy(null);
      });
    return () => {
      mounted = false;
    };
  }, [t, token]);

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const rememberRequestId = () => {
    if (requestId) return requestId;
    const next = crypto.randomUUID();
    const url = new URL(window.location.href);
    url.searchParams.set('request', next);
    window.history.replaceState(window.history.state, '', url);
    setRequestId(next);
    return next;
  };

  const acceptOrRefresh = async (refreshQuote: boolean) => {
    const stableRequestId = rememberRequestId();
    setBusy(refreshQuote ? 'refresh' : 'accept');
    setError(null);
    try {
      const response = await fetch('/api/organization/invitations/accept', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          requestId: stableRequestId,
          refreshQuote,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        data?: {
          quote?: InvitationSeatQuote;
        };
        error?: string;
      };
      if (!response.ok || payload.success !== true || !payload.data?.quote) {
        throw new Error(payload.error || t('errors.accept'));
      }
      setQuote(payload.data.quote);
      setPreview((current) => current ? { ...current, status: 'accepted' } : current);
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : t('errors.accept'));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    if (!requestId || !quote) return;
    if (password.length < 8 || password.length > 128) {
      setError(t('errors.password'));
      return;
    }
    setBusy('activate');
    setError(null);
    try {
      const response = await fetch('/api/organization/invitations/activate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, requestId, password }),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        data?: InvitationSeatQuote;
        error?: string;
      };
      if (!response.ok || payload.success !== true || !payload.data) {
        throw new Error(payload.error || t('errors.activate'));
      }
      setQuote(payload.data);
      if (payload.data.stage === 'active') setPassword('');
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : t('errors.activate'));
    } finally {
      setBusy(null);
    }
  };

  const quoteExpired = Boolean(
    quote && (
      ['expired', 'revoked'].includes(quote.quote.status)
      || ['expired', 'revoked'].includes(quote.approval.status)
      || Date.parse(quote.quote.expiresAt) <= currentTime
    ),
  );
  const approved = Boolean(
    quote && ['approved', 'consumed'].includes(quote.approval.status),
  );
  const active = quote?.stage === 'active';
  const billingPending = quote?.stage === 'billing_pending';
  const roleLabel = preview ? t(`roles.${preview.role}`) : '';
  const expiresLabel = useMemo(() => (
    preview
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
        .format(new Date(preview.expiresAt))
      : ''
  ), [locale, preview]);

  return (
    <main className="relative h-dvh overflow-x-hidden overflow-y-auto bg-background px-4 py-10 sm:px-6 sm:py-16">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,color-mix(in_oklab,var(--primary)_12%,transparent),transparent_34%),radial-gradient(circle_at_85%_80%,color-mix(in_oklab,var(--muted-foreground)_10%,transparent),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:42px_42px]" />
      <div className="relative mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex items-center gap-3 text-sm font-medium text-muted-foreground">
          <span className="grid size-10 place-items-center rounded-xl border bg-card shadow-sm">
            <ShieldCheck className="size-5 text-primary" />
          </span>
          <span>Canvas Notebook</span>
        </div>

        <Card className="overflow-hidden border-border/80 bg-card/95 shadow-2xl shadow-black/5 backdrop-blur">
          <div className="h-1.5 bg-[linear-gradient(90deg,var(--primary),color-mix(in_oklab,var(--primary)_35%,var(--muted)))]" />
          <CardHeader className="space-y-4 p-6 sm:p-8">
            <Badge variant="outline" className="w-fit gap-1.5">
              <Users className="size-3.5" />
              {t('eyebrow')}
            </Badge>
            <div className="space-y-2">
              <CardTitle className="text-2xl tracking-tight sm:text-3xl">{t('title')}</CardTitle>
              <CardDescription className="max-w-xl text-sm leading-6 sm:text-base">
                {t('description')}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-6 pt-0 sm:p-8 sm:pt-0">
            {busy === 'preview' ? (
              <div className="flex items-center gap-3 rounded-xl border bg-muted/35 p-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('loading')}
              </div>
            ) : preview ? (
              <div className="grid gap-3 rounded-xl border bg-muted/25 p-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('email')}</p>
                  <p className="mt-1 break-all font-medium">{preview.email}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{t('role')}</p>
                  <p className="mt-1 font-medium">{roleLabel}</p>
                </div>
                <div className="sm:col-span-2">
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock3 className="size-3.5" />
                    {t('expires', { date: expiresLabel })}
                  </p>
                </div>
              </div>
            ) : null}

            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {error}
              </div>
            )}

            {quote && (
              <div className="rounded-xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{t('quote.title')}</p>
                  <Badge variant={active ? 'default' : 'outline'}>
                    {active
                      ? t('states.active')
                      : billingPending
                        ? t('states.billingPending')
                        : approved
                          ? t('states.approved')
                          : quoteExpired
                            ? t('states.expired')
                            : t('states.waiting')}
                  </Badge>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t('quote.quantity')}</dt>
                    <dd className="font-medium">{quote.quote.quantityBefore} → {quote.quote.quantityAfter}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('quote.perSeat')}</dt>
                    <dd className="font-medium">
                      {formatMoney(quote.quote.unitAmountCents, quote.quote.currency, locale)} / {t('quote.month')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('quote.recurring')}</dt>
                    <dd className="font-medium">
                      {formatMoney(quote.quote.recurringAmountCents, quote.quote.currency, locale)} / {t('quote.month')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('quote.dueNow')}</dt>
                    <dd className="font-medium">
                      {quote.quote.immediateAmountCents === null
                        ? t('quote.dueLater')
                        : formatMoney(quote.quote.immediateAmountCents, quote.quote.currency, locale)}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            {!quote && preview && (
              <div className="space-y-3">
                <p className="text-sm leading-6 text-muted-foreground">{t('consent')}</p>
                <Button
                  type="button"
                  className="w-full sm:w-auto"
                  disabled={busy !== null}
                  onClick={() => void acceptOrRefresh(false)}
                >
                  {busy === 'accept' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <ArrowRight data-icon="inline-start" />}
                  {preview.status === 'accepted' ? t('resume') : t('accept')}
                </Button>
              </div>
            )}

            {quote && !active && (
              <div className="space-y-4 rounded-xl border bg-muted/20 p-4">
                {quoteExpired ? (
                  <>
                    <p className="text-sm text-muted-foreground">{t('expiredHint')}</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void acceptOrRefresh(true)}
                    >
                      {busy === 'refresh' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
                      {t('refresh')}
                    </Button>
                  </>
                ) : approved ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="invitation-password">{t('password')}</Label>
                      <Input
                        id="invitation-password"
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={busy !== null}
                      />
                      <p className="text-xs text-muted-foreground">
                        {billingPending ? t('billingPendingHint') : t('passwordHint')}
                      </p>
                    </div>
                    <Button type="button" disabled={busy !== null} onClick={() => void activate()}>
                      {busy === 'activate' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <KeyRound data-icon="inline-start" />}
                      {billingPending ? t('retry') : t('activate')}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm leading-6 text-muted-foreground">{t('waitingHint')}</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void acceptOrRefresh(false)}
                    >
                      {busy === 'accept' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
                      {t('check')}
                    </Button>
                  </>
                )}
              </div>
            )}

            {active && (
              <div className="space-y-4 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-100">
                <div className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <p className="font-medium">{t('completeTitle')}</p>
                    <p className="mt-1 text-sm opacity-80">{t('completeDescription')}</p>
                  </div>
                </div>
                <Button asChild>
                  <Link href="/login">{t('login')}</Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="text-center text-xs leading-5 text-muted-foreground">{t('security')}</p>
      </div>
    </main>
  );
}
