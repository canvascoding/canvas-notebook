'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type Provider = 'local' | 'openai' | 'groq';
type Settings = { enabled: boolean; provider: Provider; model: string; language: string };
type Status = { available: boolean; reason: string | null };
type LocalInstall = { state: 'missing' | 'installing' | 'installed' | 'failed' | 'disabled'; message?: string };
type CredentialStatus = { configured: boolean; source: 'integrations' | 'agents' | 'environment' | null };
type Credentials = Record<'openai' | 'groq', CredentialStatus>;
type ResponseData = { success: boolean; data?: { settings: Settings; status: Status; localInstall: LocalInstall; credentials: Credentials }; error?: string };
type InstallResponse = { success: boolean; data?: { localInstall: LocalInstall }; error?: string };
type CredentialResponse = { success: boolean; data?: { credentials: Credentials; status: Status }; error?: string };

const models: Record<Provider, readonly string[]> = {
  local: ['tiny', 'base', 'small', 'medium', 'large-v3'],
  openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
  groq: ['whisper-large-v3-turbo', 'whisper-large-v3'],
};

export function DictationSettingsPanel({ onboarding = false }: { onboarding?: boolean }) {
  const t = useTranslations('dictation');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [localInstall, setLocalInstall] = useState<LocalInstall | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch('/api/admin/dictation', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as ResponseData;
        if (!response.ok || !body.data) throw new Error(body.error || t('loadError'));
        if (active) { setSettings(body.data.settings); setStatus(body.data.status); setLocalInstall(body.data.localInstall); setCredentials(body.data.credentials); }
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : t('loadError')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    if (localInstall?.state !== 'installing') return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/admin/dictation', { cache: 'no-store' });
        const body = await response.json() as ResponseData;
        if (!response.ok || !body.data) throw new Error(body.error || t('loadError'));
        if (active) { setLocalInstall(body.data.localInstall); setStatus(body.data.status); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : t('loadError'));
      }
    };
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [localInstall?.state, t]);

  async function installLocalRuntime() {
    setInstalling(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/dictation', { method: 'POST' });
      const body = await response.json() as InstallResponse;
      if (!response.ok || !body.data) throw new Error(body.error || t('installError'));
      setLocalInstall(body.data.localInstall);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('installError'));
    } finally {
      setInstalling(false);
    }
  }

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
      setLocalInstall(body.data.localInstall);
      setCredentials(body.data.credentials);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function saveCredential() {
    if (!settings || settings.provider === 'local' || !apiKey.trim()) return;
    setCredentialSaving(true);
    setCredentialSaved(false);
    setError(null);
    try {
      const response = await fetch('/api/admin/dictation/credential', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: settings.provider, apiKey: apiKey.trim() }),
      });
      const body = await response.json() as CredentialResponse;
      if (!response.ok || !body.data) throw new Error(body.error || t('credentialSaveError'));
      setCredentials(body.data.credentials);
      setApiKey('');
      setCredentialSaved(true);
      setStatus(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('credentialSaveError'));
    } finally {
      setCredentialSaving(false);
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
            setSettings({ ...settings, provider, model: models[provider][0] }); setStatus(null); setSaved(false); setApiKey(''); setCredentialSaved(false);
          }} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="local" disabled={localInstall?.state === 'disabled'}>{t('providers.local')}</option>
            <option value="openai">OpenAI</option>
            <option value="groq">Groq</option>
          </select>
          <p className="text-xs text-muted-foreground">{t('providerDescription')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="dictation-model">{t('model')}</Label><select id="dictation-model" value={settings.model} onChange={(event) => { setSettings({ ...settings, model: event.target.value }); setStatus(null); setSaved(false); }} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">{models[settings.provider].map((model) => <option key={model} value={model}>{model}</option>)}</select></div>
          <div className="space-y-2"><Label htmlFor="dictation-language">{t('language')}</Label><select id="dictation-language" value={settings.language} onChange={(event) => { setSettings({ ...settings, language: event.target.value }); setStatus(null); setSaved(false); }} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option value="auto">{t('automatic')}</option><option value="de">Deutsch</option><option value="en">English</option></select></div>
        </div>
        {settings.provider === 'local' && localInstall?.state === 'disabled' ? <InlineNotice variant="info" size="compact">{t('localDisabled')}</InlineNotice> : settings.provider === 'local' ? <InlineNotice
          variant={localInstall?.state === 'installed' ? 'success' : localInstall?.state === 'installing' ? 'info' : localInstall?.state === 'failed' ? 'destructive' : 'warning'}
          role="group"
          actions={(localInstall?.state === 'missing' || localInstall?.state === 'failed') ? <Button type="button" variant="outline" size="sm" onClick={() => void installLocalRuntime()} disabled={installing}>
            {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('installLocal')}
          </Button> : undefined}
        >
          <p>{t('localNote')}</p>
          <p>{t('localInstallDisclosure')} <a className="underline" href="https://ffmpeg.org/legal.html" target="_blank" rel="noopener noreferrer">{t('localLicenseLink')}</a></p>
          {localInstall?.state === 'installed' && <p role="status">{t('localInstalled')}</p>}
          {localInstall?.state === 'installing' && <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />{t('localInstalling')}</p>}
          {localInstall?.state === 'failed' && <p role="alert">{localInstall.message || t('installError')}</p>}
        </InlineNotice> : <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm text-muted-foreground">{t('cloudNote')}</p>
          <div className="space-y-2">
            <Label htmlFor="dictation-api-key">{settings.provider === 'openai' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY'}</Label>
            <Input id="dictation-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setCredentialSaved(false); }} placeholder={t('credentialPlaceholder')} />
            <InlineNotice size="compact" variant={credentials?.[settings.provider]?.configured ? 'success' : 'warning'}>
              {credentials?.[settings.provider]?.configured ? t('credentialConfigured') : t('credentialMissing')}
            </InlineNotice>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => void saveCredential()} disabled={credentialSaving || !apiKey.trim()}>
              {credentialSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('saveCredential')}
            </Button>
            {credentialSaved && <span role="status" className="text-xs text-muted-foreground">{t('credentialSaved')}</span>}
          </div>
        </div>}
        {status && settings.enabled && <InlineNotice size="compact" variant={status.available ? 'success' : 'warning'}>{status.available ? t('available') : settings.provider === 'local' ? t('localUnavailable') : `${t('unavailable')} ${status.reason ?? ''}`}</InlineNotice>}
        <div className="flex items-center gap-3"><Button type="button" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{t('save')}</Button>{saved && <span role="status" className="text-sm text-muted-foreground">{t('saved')}</span>}</div>
      </>}
      {error && <InlineNotice variant="destructive" size="compact">{error}</InlineNotice>}
    </section>
  );
}
