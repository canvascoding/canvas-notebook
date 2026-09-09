'use client';

import { startTransition, useCallback, useEffect, useState } from 'react';
import { Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type McpSharedDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  revision: number;
  config: { url: string; auth: string; oauth?: boolean };
};

type DefinitionPayload = {
  canManageDefinitions: boolean;
  organizationId: string | null;
  definitions: McpSharedDefinition[];
};

export function McpSharedDefinitionsPanel({ onConnectionsChanged }: {
  onConnectionsChanged: () => void | Promise<void>;
}) {
  const t = useTranslations('settings.mcpDefinitions');
  const [payload, setPayload] = useState<DefinitionPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [connectingDefinition, setConnectingDefinition] = useState<McpSharedDefinition | null>(null);
  const [displayName, setDisplayName] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/integrations/mcp-definitions', { credentials: 'include', cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || t('errors.load'));
      setPayload(result.data as DefinitionPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { startTransition(() => { void load(); }); }, [load]);

  useEffect(() => {
    const refreshDefinitions = () => { void load(); };
    window.addEventListener('mcp_definitions_updated', refreshDefinitions);
    return () => window.removeEventListener('mcp_definitions_updated', refreshDefinitions);
  }, [load]);

  const connect = async () => {
    if (!connectingDefinition || !displayName.trim()) return;
    setActiveAction(`connect:${connectingDefinition.id}`);
    setError(null);
    try {
      const response = await fetch('/api/integrations/mcp-connections', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', definitionId: connectingDefinition.id, displayName: displayName.trim() }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || t('errors.connect'));
      setConnectingDefinition(null);
      setDisplayName('');
      await onConnectionsChanged();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : t('errors.connect'));
    } finally {
      setActiveAction(null);
    }
  };

  const setEnabled = async (definition: McpSharedDefinition, enabled: boolean) => {
    setActiveAction(`enabled:${definition.id}`);
    setError(null);
    try {
      const response = await fetch('/api/integrations/mcp-definitions', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_enabled', id: definition.id, enabled }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || t('errors.update'));
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : t('errors.update'));
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <section className="rounded-lg border border-border p-4" aria-labelledby="mcp-shared-definitions-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="mcp-shared-definitions-heading" className="text-base font-semibold">{t('title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={isLoading || Boolean(activeAction)}>
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {t('refresh')}
        </Button>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      {isLoading ? <div className="mt-4 flex items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t('loading')}</div> : null}
      {!isLoading && payload?.definitions.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">{t('empty')}</p> : null}
      {!isLoading && payload?.definitions.length ? (
        <div className="mt-4 divide-y divide-border overflow-hidden rounded-md border border-border">
          {payload.definitions.map((definition) => (
            <div key={definition.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><PlugZap className="h-4 w-4 text-muted-foreground" /><span className="font-medium">{definition.name}</span><Badge variant={definition.enabled ? 'outline' : 'secondary'}>{definition.enabled ? t('enabled') : t('disabled')}</Badge></div>
                <p className="mt-1 break-all text-xs text-muted-foreground">{definition.config.url}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {payload.canManageDefinitions ? <Button type="button" variant="outline" size="sm" disabled={Boolean(activeAction)} onClick={() => void setEnabled(definition, !definition.enabled)}>{definition.enabled ? t('disable') : t('enable')}</Button> : null}
                {definition.enabled ? <Button type="button" size="sm" disabled={Boolean(activeAction)} onClick={() => { setConnectingDefinition(definition); setDisplayName(definition.name); }}>{t('addConnection')}</Button> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <Dialog open={Boolean(connectingDefinition)} onOpenChange={(open) => { if (!open) setConnectingDefinition(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('connectTitle', { definition: connectingDefinition?.name || '' })}</DialogTitle><DialogDescription>{t('connectDescription')}</DialogDescription></DialogHeader>
          <div className="space-y-2"><Label htmlFor="mcp-definition-display-name">{t('accountLabel')}</Label><Input id="mcp-definition-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} autoFocus /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setConnectingDefinition(null)} disabled={Boolean(activeAction)}>{t('cancel')}</Button><Button type="button" onClick={() => void connect()} disabled={!displayName.trim() || Boolean(activeAction)}>{activeAction ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t('addConnection')}</Button></div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
