'use client';

import { useState } from 'react';
import { Layers, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useStudioBulkAvailability } from '@/app/apps/studio/components/StudioBulkAvailabilityProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

export function StudioBulkSettingsCard() {
  const t = useTranslations('settings.experimental');
  const { studioBulkEnabled, ready, error: availabilityError, applyAvailability } = useStudioBulkAvailability();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const updateBulk = async (enabled: boolean) => {
    setSaving(true);
    setStatus('idle');
    try {
      const response = await fetch('/api/admin/experimental-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studioBulkEnabled: enabled }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success || typeof payload.data?.studioBulkEnabled !== 'boolean'
        || (payload.data.studioBulkUpdatedAt !== null
          && (typeof payload.data.studioBulkUpdatedAt !== 'string'
            || !Number.isFinite(Date.parse(payload.data.studioBulkUpdatedAt))))) {
        throw new Error('Studio bulk settings update failed');
      }
      applyAvailability({ studioBulkEnabled: payload.data.studioBulkEnabled,
        updatedAt: payload.data.studioBulkUpdatedAt });
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4" aria-hidden="true" />{t('studioBulkTitle')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-6 rounded-lg border border-border/70 p-4">
          <div className="space-y-1.5">
            <label htmlFor="studio-bulk-enabled" className="cursor-pointer text-sm font-medium">{t('enableStudioBulk')}</label>
            <p id="studio-bulk-enabled-description" className="max-w-xl text-sm leading-6 text-muted-foreground">{t('studioBulkDescription')}</p>
          </div>
          <div className="flex h-6 shrink-0 items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
            <Switch id="studio-bulk-enabled" checked={studioBulkEnabled} disabled={!ready || saving}
              onCheckedChange={updateBulk} aria-describedby="studio-bulk-enabled-description" />
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('studioBulkDisableNote')}</p>
        <div aria-live="polite" className="text-sm">
          {status === 'error' || availabilityError
            ? <p role="alert" className="text-destructive">{t(status === 'error' ? 'saveError' : 'studioBulkLoadError')}</p>
            : <p className="text-muted-foreground">{t(saving ? 'saving' : !ready ? 'loading' : status === 'saved' ? 'saved'
              : studioBulkEnabled ? 'studioBulkEnabled' : 'studioBulkDisabled')}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
