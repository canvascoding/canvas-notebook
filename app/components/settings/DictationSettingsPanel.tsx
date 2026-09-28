'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type Provider = 'local' | 'openai' | 'groq';
type Settings = { enabled: boolean; provider: Provider; model: string; language: string };
type Status = { available: boolean; reason: string | null };
type ResponseData = { success: boolean; data?: { settings: Settings; status: Status }; error?: string };

const models: Record<Provider, readonly string[]> = {
  local: ['tiny', 'base', 'small', 'medium', 'large-v3'],
  openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
};

export function DictationSettingsPanel({ onboarding = false }: { onboarding?: boolean }) {
  const t = useTranslations('dictation');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch('/api/admin/dictation', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as ResponseData;
        if (!response.ok || !body.data) throw new Error(body.error || t('loadError'));
        if (active) { setSettings(body.data.settings); setStatus(body.data.status); }
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : t('loadError')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [t]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/admin/dictation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const body = await response.json() as ResponseData;
      if (!response.ok || !body.data) throw new Error(body.error || t('saveError'));
      setSettings(body.data.settings);
      setStatus(body.data.status);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-6" data-testid="dictation-settings">
      {onboarding && <div><h3 className="text-lg font-semibold">{t('title')}</h3><p className="text-sm text-muted-foreground">{t('description')}</p></div>}
      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</p>}
      {settings && <>
        <div className="flex items-center justify-between gap-4">
          <div><Label htmlFor="dictation-enabled" className="font-medium">{t('enabled')}</Label><p className="text-sm text-muted-foreground">{t('enabledDescription')}</p></div>
          <Switch id="dictation-enabled" checked={settings.enabled} onCheckedChange={(enabled) => { setSettings({ ...settings, enabled }); setStatus(null); setSaved(false); }} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dictation-provider">{t('provider')}</Label>
          <select id="dictation-provider" value={settings.provider} onChange={(event) => {
            const provider = event.target.value as Provider;
            setSettings({ ...settings, provider, model: models[provider][0] }); setStatus(null); setSaved(false);
          }} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="local">{t('providers.local')}</option>
            <option value="openai">OpenAI</option>
            <option value="groq">Groq</option>
          </select>
          <p className="text-xs text-muted-foreground">{t('providerDescription')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="dictation-model">{t('model')}</Label><select id="dictation-model" value={settings.model} onChange={(event) => { setSettings({ ...settings, model: event.target.value }); setStatus(null); setSaved(false); }} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">{models[settings.provider].map((model) => <option key={model} value={model}>{model}</option>)}</select></div>
          <div className="space-y-2"><Label htmlFor="dictation-language">{t('language')}</Label><select id="dictation-language" value={settings.language} onChange={(event) => { setSettings({ ...settings, language: event.target.value }); setStatus(null); setSaved(false); }} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option value="auto">{t('automatic')}</option><option value="de">Deutsch</option><option value="en">English</option></select></div>
        </div>
        {settings.provider === 'local' ? <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{t('localNote')}</p> : <p className="text-sm text-muted-foreground">{t('cloudNote')}</p>}
        {status && settings.enabled && <p role="status" className={status.available ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-sm text-amber-700 dark:text-amber-400'}>{status.available ? t('available') : `${t('unavailable')} ${status.reason ?? ''}`}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-3"><Button type="button" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('save')}</Button>{saved && <span role="status" className="text-sm text-muted-foreground">{t('saved')}</span>}</div>
      </>}
    </section>
  );
}
