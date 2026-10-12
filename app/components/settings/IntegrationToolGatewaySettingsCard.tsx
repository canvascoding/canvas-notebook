'use client';

import { useEffect, useState } from 'react';
import { Loader2, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

export function IntegrationToolGatewaySettingsCard() {
  const t = useTranslations('settings.experimental');
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/admin/experimental-settings', { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok || !payload.success || typeof payload.data?.integrationToolGatewayEnabled !== 'boolean') {
          throw new Error('Integration gateway setting unavailable');
        }
        if (!controller.signal.aborted) { setEnabled(payload.data.integrationToolGatewayEnabled); setReady(true); }
      }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, []);
  const updateGateway = async (next: boolean) => {
    if (!ready || saving) return;
    setSaving(true); setStatus('idle');
    try {
      const response = await fetch('/api/admin/experimental-settings', { method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ integrationToolGatewayEnabled: next }) });
      const payload = await response.json();
      if (!response.ok || !payload.success || typeof payload.data?.integrationToolGatewayEnabled !== 'boolean') {
        throw new Error('Integration gateway setting update failed');
      }
      setEnabled(payload.data.integrationToolGatewayEnabled); setStatus('saved');
    } catch { setStatus('error'); }
    finally { setSaving(false); }
  };
  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><PlugZap className="h-4 w-4" aria-hidden="true" />{t('integrationToolGatewayTitle')}</CardTitle>
      <CardDescription>{t('description')}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex items-start justify-between gap-6 rounded-lg border border-border/70 p-4">
        <div className="space-y-1.5">
          <label htmlFor="integration-tool-gateway-enabled" className="cursor-pointer text-sm font-medium">{t('enableIntegrationToolGateway')}</label>
          <p id="integration-tool-gateway-description" className="max-w-xl text-sm leading-6 text-muted-foreground">{t('integrationToolGatewayDescription')}</p>
        </div>
        <div className="flex h-6 shrink-0 items-center gap-2">
          {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
          <Switch id="integration-tool-gateway-enabled" checked={enabled} disabled={!ready || saving}
            onCheckedChange={updateGateway} aria-describedby="integration-tool-gateway-description" />
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t('integrationToolGatewayNote')}</p>
      <div aria-live="polite" className="text-sm">{status === 'error'
        ? <p role="alert" className="text-destructive">{t(ready ? 'saveError' : 'integrationToolGatewayLoadError')}</p>
        : <p className="text-muted-foreground">{t(saving ? 'saving' : !ready ? 'loading' : status === 'saved' ? 'saved'
          : enabled ? 'integrationToolGatewayEnabled' : 'integrationToolGatewayDisabled')}</p>}</div>
    </CardContent>
  </Card>;
}
