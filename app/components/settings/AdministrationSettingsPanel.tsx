'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, SquareTerminal } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useTerminalAvailability } from '@/app/components/terminal/TerminalAvailabilityProvider';

export function AdministrationSettingsPanel() {
  const t = useTranslations('settings.administration');
  const { terminalEnabled, ready, applyAvailability } = useTerminalAvailability();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const updateTerminal = async (enabled: boolean) => {
    setSaving(true);
    setError(false);
    setSaved(false);
    try {
      const response = await fetch('/api/admin/terminal-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminalEnabled: enabled }),
      });
      const payload = await response.json();
      if (payload.data && typeof payload.data.terminalEnabled === 'boolean') applyAvailability(payload.data);
      if (!response.ok || !payload.success) throw new Error('Terminal settings update failed');
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SquareTerminal className="h-4 w-4" aria-hidden="true" />
          {t('terminalTitle')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-6 rounded-lg border border-border/70 p-4">
          <div className="space-y-1.5">
            <label htmlFor="terminal-enabled" className="cursor-pointer text-sm font-medium">{t('enableTerminal')}</label>
            <p id="terminal-enabled-description" className="max-w-xl text-sm leading-6 text-muted-foreground">{t('terminalDescription')}</p>
          </div>
          <div className="flex h-6 shrink-0 items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
            <Switch
              id="terminal-enabled"
              checked={terminalEnabled}
              disabled={!ready || saving}
              onCheckedChange={updateTerminal}
              aria-describedby="terminal-enabled-description"
            />
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('disableNote')}</p>
        <div aria-live="polite" className="text-sm">
          {error ? <p role="alert" className="text-destructive">{t('saveError')}</p>
            : <p className="text-muted-foreground">{saving ? t('saving') : !ready ? t('loading') : saved ? t('saved') : t(terminalEnabled ? 'enabled' : 'disabled')}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
