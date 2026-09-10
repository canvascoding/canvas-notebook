'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { PlugZap } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { mcpConnectionErrorCopy, mcpConnectionSettingsHref, type McpConnectionHealth, type McpReconnectHint } from '@/app/lib/mcp/connection-health-types';

/** Persisted tool failures offer a current connection action without replaying a tool. */
export function McpReconnectNotice({ connection }: { connection: McpReconnectHint }) {
  const locale = useLocale();
  const german = locale === 'de';
  const [health, setHealth] = useState<McpConnectionHealth | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/api/integrations/mcp-status?summary=1', { signal: abort.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json();
        const server = result.data?.servers?.find((item: { connectionId?: string }) => item.connectionId === connection.connectionId);
        if (!abort.signal.aborted) setHealth(server?.health || null);
      }).catch(() => undefined);
    return () => abort.abort();
  }, [connection.connectionId]);
  const recovered = health?.enabled && health.authStatus === 'authorized';
  const disabled = health?.enabled === false;
  const description = disabled
    ? german ? 'Diese Verbindung ist deaktiviert.' : 'This connection is disabled.'
    : recovered
      ? german ? 'Das Konto ist wieder verbunden. Du kannst die Aktion erneut ausführen.' : 'The account is connected again. You can retry the action.'
      : mcpConnectionErrorCopy(health?.lastErrorCode || 'reauth_required', locale);

  return (
    <div data-testid="mcp-reconnect-notice" className="mt-2 flex max-w-lg flex-wrap items-center gap-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
      <PlugZap className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{connection.serverName}</p>
        <p className="mt-0.5 text-muted-foreground">{description}</p>
      </div>
      <Button asChild variant="outline" size="sm" className="h-7 text-xs">
        <Link href={mcpConnectionSettingsHref(connection.connectionId)}>
          {disabled || recovered ? german ? 'Verbindung öffnen' : 'Open connection' : german ? 'Erneut verbinden' : 'Reconnect'}
        </Link>
      </Button>
    </div>
  );
}
