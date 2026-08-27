'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Mail, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { WorkspaceMailboxesSettingsPanel } from '@/app/components/settings/WorkspaceMailboxesSettingsPanel';

type SystemEmailStatus = {
  configured: boolean;
  complete: boolean;
  passwordConfigured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  tlsMode?: 'implicit_tls' | 'starttls' | null;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  replyTo: string | null;
  configurationError: string | null;
  deliveryMode: 'managed' | 'local' | 'disabled';
  managedAvailable: boolean;
};

type SystemEmailForm = {
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
};

const EMPTY_FORM: SystemEmailForm = {
  host: '',
  port: '587',
  secure: false,
  username: '',
  password: '',
  fromAddress: '',
  fromName: '',
  replyTo: '',
};

function formFromStatus(status: SystemEmailStatus): SystemEmailForm {
  return {
    host: status.host || '',
    port: status.port ? String(status.port) : '587',
    secure: status.secure ?? false,
    username: status.username || '',
    password: '',
    fromAddress: status.fromAddress || '',
    fromName: status.fromName || '',
    replyTo: status.replyTo || '',
  };
}

export function SystemEmailSettingsPanel({
  canManageSystemEmail = true,
  canManageWorkspaceMailboxes = false,
}: {
  canManageSystemEmail?: boolean;
  canManageWorkspaceMailboxes?: boolean;
}) {
  const t = useTranslations('settings.systemEmail');
  const [status, setStatus] = useState<SystemEmailStatus | null>(null);
  const [form, setForm] = useState<SystemEmailForm>(EMPTY_FORM);
  const [isLoading, setIsLoading] = useState(true);
  const [action, setAction] = useState<'save' | 'test' | 'remove' | 'mode' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManageSystemEmail) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/system-email', { credentials: 'include', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.load'));
      const nextStatus = payload.data as SystemEmailStatus;
      setStatus(nextStatus);
      setForm(formFromStatus(nextStatus));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('errors.load'));
    } finally {
      setIsLoading(false);
    }
  }, [canManageSystemEmail, t]);

  useEffect(() => {
    if (!canManageSystemEmail) {
      return;
    }
    let cancelled = false;
    void fetch('/api/admin/system-email', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (cancelled) return;
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || t('errors.load'));
        }
        const nextStatus = payload.data as SystemEmailStatus;
        setStatus(nextStatus);
        setForm(formFromStatus(nextStatus));
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : t('errors.load'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManageSystemEmail, t]);

  const updateForm = <Key extends keyof SystemEmailForm>(key: Key, value: SystemEmailForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setAction('save');
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/system-email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.save'));
      const nextStatus = payload.data as SystemEmailStatus;
      setStatus(nextStatus);
      setForm(formFromStatus(nextStatus));
      setMessage(t('saved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('errors.save'));
    } finally {
      setAction(null);
    }
  };

  const updateDeliveryMode = async (mode: 'managed' | 'local' | 'disabled') => {
    setAction('mode');
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/system-email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.mode'));
      const nextStatus = payload.data as SystemEmailStatus;
      setStatus(nextStatus);
      setForm(formFromStatus(nextStatus));
      setMessage(t('modeUpdated'));
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : t('errors.mode'));
    } finally {
      setAction(null);
    }
  };

  const testConnection = async () => {
    setAction('test');
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/system-email/test', {
        method: 'POST',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.test'));
      setMessage(t('tested'));
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : t('errors.test'));
    } finally {
      setAction(null);
    }
  };

  const remove = async () => {
    setAction('remove');
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/system-email', {
        method: 'DELETE',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || t('errors.remove'));
      const nextStatus = payload.data as SystemEmailStatus;
      setStatus(nextStatus);
      setForm(EMPTY_FORM);
      setMessage(t('removed'));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t('errors.remove'));
    } finally {
      setAction(null);
    }
  };

  const isBusy = action !== null;
  const configured = status?.configured === true;
  const isManagedMode = status?.deliveryMode === 'managed';
  const isDisabledMode = status?.deliveryMode === 'disabled';

  if (!canManageSystemEmail) {
    return canManageWorkspaceMailboxes ? <WorkspaceMailboxesSettingsPanel /> : null;
  }

  return (
    <div className="space-y-5">
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base"><Mail className="h-4 w-4" />{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <Badge variant={isDisabledMode ? 'secondary' : isManagedMode ? 'default' : configured ? 'default' : 'secondary'}>
            {isDisabledMode ? t('disabledActive') : isManagedMode ? t('managedActive') : configured ? t('statusConfigured') : t('statusNotConfigured')}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{t('fallbackDescription')}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        {status?.configurationError && (
          <div className="flex gap-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('incompleteConfiguration', { error: status.configurationError })}</span>
          </div>
        )}
        {!isManagedMode && !configured && !status?.configurationError && (
          <div className="border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t('missingConfiguration')}
          </div>
        )}
        {error && <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        {message && (
          <div className="flex gap-2 border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="system-email-mode">{t('deliveryMode')}</Label>
          <select id="system-email-mode" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={status?.deliveryMode || 'local'} onChange={(event) => void updateDeliveryMode(event.target.value as 'managed' | 'local' | 'disabled')} disabled={isLoading || isBusy}>
            <option value="local">{t('modeLocal')}</option>
            <option value="managed" disabled={!status?.managedAvailable}>{t('modeManaged')}</option>
            <option value="disabled">{t('modeDisabled')}</option>
          </select>
          <p className="text-xs text-muted-foreground">{isDisabledMode ? t('disabledDescription') : isManagedMode ? t('managedDescription') : t('localDescription')}</p>
        </div>

        {isManagedMode && (
          <div className="border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {t('managedDescription')}
          </div>
        )}

        {isManagedMode && !status?.managedAvailable && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {t('managedUnavailable')}
          </div>
        )}

        {!isManagedMode && !isDisabledMode && <>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="system-smtp-host">{t('host')}</Label>
            <Input id="system-smtp-host" value={form.host} onChange={(event) => updateForm('host', event.target.value)} disabled={isLoading || isBusy} placeholder="smtp.example.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="system-smtp-port">{t('port')}</Label>
            <Input id="system-smtp-port" inputMode="numeric" value={form.port} onChange={(event) => updateForm('port', event.target.value)} disabled={isLoading || isBusy} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="system-smtp-username">{t('username')}</Label>
            <Input id="system-smtp-username" autoComplete="username" value={form.username} onChange={(event) => updateForm('username', event.target.value)} disabled={isLoading || isBusy} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="system-smtp-password">{t('password')}</Label>
            <Input id="system-smtp-password" type="password" autoComplete="new-password" value={form.password} onChange={(event) => updateForm('password', event.target.value)} disabled={isLoading || isBusy} placeholder={status?.passwordConfigured ? t('passwordUnchanged') : undefined} />
            {status?.passwordConfigured && <p className="text-xs text-muted-foreground">{t('passwordHint')}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="system-email-from">{t('fromAddress')}</Label>
            <Input id="system-email-from" type="email" value={form.fromAddress} onChange={(event) => updateForm('fromAddress', event.target.value)} disabled={isLoading || isBusy} placeholder="notifications@example.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="system-email-from-name">{t('fromName')}</Label>
            <Input id="system-email-from-name" value={form.fromName} onChange={(event) => updateForm('fromName', event.target.value)} disabled={isLoading || isBusy} placeholder="Canvas Notebook" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="system-email-reply-to">{t('replyTo')}</Label>
            <Input id="system-email-reply-to" type="email" value={form.replyTo} onChange={(event) => updateForm('replyTo', event.target.value)} disabled={isLoading || isBusy} placeholder={t('replyToPlaceholder')} />
            <p className="text-xs text-muted-foreground">{t('replyToHint')}</p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 md:col-span-2">
            <div>
              <Label htmlFor="system-smtp-secure">{t('secure')}</Label>
              <p className="text-xs text-muted-foreground">{t('secureHint')}</p>
            </div>
            <Switch id="system-smtp-secure" checked={form.secure} onCheckedChange={(checked) => updateForm('secure', checked)} disabled={isLoading || isBusy} />
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => void remove()} disabled={isLoading || isBusy || !configured}>
            {action === 'remove' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            {t('remove')}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={isLoading || isBusy}>
            {action === 'save' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {t('save')}
          </Button>
        </div>
        </>}
        {isDisabledMode && <div className="border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">{t('disabledDescription')}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => void load()} disabled={isLoading || isBusy}>
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('reload')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void testConnection()} disabled={isLoading || isBusy || isDisabledMode || (!isManagedMode && !configured)}>
            {action === 'test' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('sendTest')}
          </Button>
        </div>
      </CardContent>
    </Card>
    {canManageWorkspaceMailboxes && <WorkspaceMailboxesSettingsPanel />}
    </div>
  );
}
