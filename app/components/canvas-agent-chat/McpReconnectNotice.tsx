'use client';

import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { PlugZap } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
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
    <InlineNotice data-testid="mcp-reconnect-notice" className="mt-2 max-w-lg" size="compact"
      variant={recovered ? 'success' : disabled ? 'info' : 'warning'}
      icon={<PlugZap aria-hidden="true" />}
      title={connection.serverName}
      actions={<Button asChild variant="outline" size="xs">
        <Link href={mcpConnectionSettingsHref(connection.connectionId)}>
          {disabled || recovered ? german ? 'Verbindung öffnen' : 'Open connection' : german ? 'Erneut verbinden' : 'Reconnect'}
        </Link>
      </Button>}
    >
      {description}
    </InlineNotice>
  );
}
