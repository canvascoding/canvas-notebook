'use client';

import { CircleAlert, CircleCheck, CircleHelp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { mcpConnectionErrorCopy, type McpConnectionHealth } from '@/app/lib/mcp/connection-health-types';
import { Badge } from '@/components/ui/badge';

function formatDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function McpConnectionHealthStatus({ health, requiresAuth = false, focused = false }: {
  health: McpConnectionHealth | null | undefined;
  requiresAuth?: boolean;
  focused?: boolean;
}) {
  const t = useTranslations('settings.mcpConfig');
  const locale = useLocale();
  const isReachable = health?.reachability === 'reachable';
  const needsAttention = health?.authStatus === 'reauth_required' || health?.reachability === 'unreachable';
  const StateIcon = needsAttention ? CircleAlert : isReachable ? CircleCheck : CircleHelp;

  if (!health) {
    return <p className="mt-1 text-xs text-muted-foreground">{t('health.notChecked')}</p>;
  }

  return (
    <div
      id={`mcp-connection-${health.connectionId}`}
      data-mcp-connection-id={health.connectionId}
      className={`mt-2 rounded-md border p-2 text-xs ${focused ? 'border-primary ring-2 ring-primary/20' : 'border-border bg-muted/30'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={health.enabled ? 'outline' : 'secondary'}>{health.enabled ? t('enabled') : t('disabled')}</Badge>
        {requiresAuth ? (
          <Badge variant={health.authStatus === 'authorized' ? 'outline' : health.authStatus === 'reauth_required' ? 'destructive' : 'secondary'}>
            {t(`health.auth.${health.authStatus}`)}
          </Badge>
        ) : null}
        <Badge variant={isReachable ? 'outline' : health.reachability === 'unreachable' ? 'destructive' : 'secondary'} className="gap-1">
          <StateIcon className="h-3 w-3" />
          {t(`health.reachability.${health.reachability}`)}
        </Badge>
      </div>
      <div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
        <span>{t('health.lastChecked', { value: formatDate(health.lastCheckedAt, locale) || t('health.never') })}</span>
        <span>{t('health.lastSuccessfulRequest', { value: formatDate(health.lastSuccessfulRequestAt, locale) || t('health.never') })}</span>
      </div>
      {health.lastErrorCode ? <p className="mt-2 text-destructive">{mcpConnectionErrorCopy(health.lastErrorCode, locale)}</p> : null}
    </div>
  );
}
