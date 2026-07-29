'use client';

import { useEffect, useState, useTransition } from 'react';
import { Loader2, LogOut, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { authClient } from '@/app/lib/auth-client';
import { disconnectWebSocketClient } from '@/app/lib/websocket/client';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

const STATUS_REFRESH_INTERVAL_MS = 10_000;

export function OnboardingWaitingActions() {
  const t = useTranslations('onboarding');
  const locale = useLocale();
  const router = useRouter();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const refreshStatus = () => {
    startRefreshTransition(() => {
      router.refresh();
      setLastCheckedAt(new Date());
    });
  };

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshStatus();
      }
    }, STATUS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  });

  const signOut = async () => {
    setIsSigningOut(true);
    setLogoutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        throw new Error(result.error.message || t('instanceSetupWaitingLogoutError'));
      }
      disconnectWebSocketClient();
      router.push('/login');
      router.refresh();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : t('instanceSetupWaitingLogoutError'));
      setIsSigningOut(false);
    }
  };

  return (
    <div className="mt-6 flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" onClick={refreshStatus} disabled={isRefreshing || isSigningOut}>
          {isRefreshing
            ? <Loader2 data-icon="inline-start" className="animate-spin" />
            : <RefreshCw data-icon="inline-start" />}
          {isRefreshing ? t('instanceSetupWaitingChecking') : t('instanceSetupWaitingRefresh')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void signOut()}
          disabled={isRefreshing || isSigningOut}
        >
          {isSigningOut
            ? <Loader2 data-icon="inline-start" className="animate-spin" />
            : <LogOut data-icon="inline-start" />}
          {t('instanceSetupWaitingLogout')}
        </Button>
      </div>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {lastCheckedAt
          ? t('instanceSetupWaitingLastChecked', {
              time: new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(lastCheckedAt),
            })
          : t('instanceSetupWaitingAutoRefresh')}
      </p>
      {logoutError && (
        <p role="alert" className="text-sm text-destructive">
          {logoutError}
        </p>
      )}
    </div>
  );
}
