'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { SettingsAccordionCard } from '@/app/components/settings/SettingsAccordionCard';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type LicenseNotificationPreferences = {
  teamLicenseNotificationsEnabled: boolean;
  teamLicenseEmailNotificationsEnabled: boolean;
};

type PreferenceKey = keyof LicenseNotificationPreferences;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPreferences(payload: unknown): LicenseNotificationPreferences | null {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) return null;
  const data = payload.data;
  for (const key of ['teamLicenseNotificationsEnabled', 'teamLicenseEmailNotificationsEnabled']) {
    if (key in data && typeof data[key] !== 'boolean') return null;
  }
  return {
    teamLicenseNotificationsEnabled: data.teamLicenseNotificationsEnabled !== false,
    teamLicenseEmailNotificationsEnabled: data.teamLicenseEmailNotificationsEnabled !== false,
  };
}

export function LicenseNotificationSettings() {
  const locale = useLocale();
  const isGerman = locale.startsWith('de');
  const copy = isGerman ? {
    title: 'Lizenz-Benachrichtigungen',
    description: 'Persönliche Einstellungen für Hinweise zu deiner Team-Lizenz und deinem Team-Zugang.',
    inApp: 'Team-Lizenzhinweise in der App',
    inAppDescription: 'Zeigt für dich relevante Lizenzwarnungen und Änderungen deines Team-Zugangs in den Benachrichtigungen.',
    email: 'Team-Lizenz-E-Mails',
    emailDescription: 'Informiert dich per E-Mail, wenn sich dein Team-Zugang ändert.',
    loading: 'Einstellungen werden geladen …',
    saving: 'Wird gespeichert …',
    loadError: 'Die Benachrichtigungseinstellungen konnten nicht geladen werden.',
    saveError: 'Die Änderung konnte nicht gespeichert werden. Die bisherige Einstellung bleibt erhalten.',
    retry: 'Erneut versuchen',
  } : {
    title: 'License notifications',
    description: 'Personal preferences for your Team license alerts and Team access.',
    inApp: 'In-app Team license alerts',
    inAppDescription: 'Shows license warnings and Team access changes relevant to you in notifications.',
    email: 'Team license emails',
    emailDescription: 'Emails you when your Team access changes.',
    loading: 'Loading preferences …',
    saving: 'Saving …',
    loadError: 'Notification preferences could not be loaded.',
    saveError: 'The change could not be saved. Your previous preference is unchanged.',
    retry: 'Retry',
  };
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<LicenseNotificationPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<PreferenceKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadingInFlight = useRef(false);
  const savingInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let scrollFrame: number | null = null;
    const reveal = () => {
      setOpen(true);
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        document.getElementById('license-notifications')?.scrollIntoView({ block: 'start' });
      });
    };
    const openFromHash = () => {
      if (window.location.hash === '#license-notifications') reveal();
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    window.addEventListener('license_notification_settings_requested', reveal);
    return () => {
      window.removeEventListener('hashchange', openFromHash);
      window.removeEventListener('license_notification_settings_requested', reveal);
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
    };
  }, []);

  const loadPreferences = useCallback(async () => {
    if (loadingInFlight.current || savingInFlight.current) return;
    loadingInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/user-preferences', {
        cache: 'no-store',
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      });
      const next = readPreferences(await response.json().catch(() => null));
      if (!response.ok || !next) throw new Error(copy.loadError);
      if (mounted.current) setPreferences(next);
    } catch {
      if (mounted.current) setError(copy.loadError);
    } finally {
      loadingInFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [copy.loadError]);

  useEffect(() => {
    if (!open || preferences) return;
    const timer = window.setTimeout(() => void loadPreferences(), 0);
    return () => window.clearTimeout(timer);
  }, [open, preferences, loadPreferences]);

  const savePreference = async (key: PreferenceKey, enabled: boolean) => {
    if (!preferences || loadingInFlight.current || savingInFlight.current) return;
    savingInFlight.current = true;
    setSaving(key);
    setError(null);
    try {
      const response = await fetch('/api/user-preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: enabled }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(payload) || payload.success !== true) throw new Error(copy.saveError);
      const saved = isRecord(payload.data) && typeof payload.data[key] === 'boolean'
        ? payload.data[key] as boolean : enabled;
      if (mounted.current) {
        setPreferences((current) => current ? { ...current, [key]: saved } : current);
      }
      if (key === 'teamLicenseNotificationsEnabled') {
        window.dispatchEvent(new Event('notification_summary_updated'));
      }
    } catch {
      if (mounted.current) setError(copy.saveError);
    } finally {
      savingInFlight.current = false;
      if (mounted.current) setSaving(null);
    }
  };

  return (
    <SettingsAccordionCard id="license-notifications" title={copy.title} isOpen={open} onOpenChange={setOpen}>
      <p className="text-sm text-muted-foreground">{copy.description}</p>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{copy.loading}
      </p> : null}
      {error ? <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>{error}</p>
        <Button type="button" variant="outline" size="sm" disabled={loading || saving !== null}
          onClick={() => void loadPreferences()}>{copy.retry}</Button>
      </div> : null}
      {preferences ? <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="license-in-app-notifications">{copy.inApp}</Label>
            <p id="license-in-app-notifications-description" className="text-sm text-muted-foreground">{copy.inAppDescription}</p>
          </div>
          <Switch id="license-in-app-notifications" checked={preferences.teamLicenseNotificationsEnabled}
            aria-describedby="license-in-app-notifications-description" disabled={loading || saving !== null}
            onCheckedChange={(enabled) => void savePreference('teamLicenseNotificationsEnabled', enabled)} />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="license-email-notifications">{copy.email}</Label>
            <p id="license-email-notifications-description" className="text-sm text-muted-foreground">{copy.emailDescription}</p>
          </div>
          <Switch id="license-email-notifications" checked={preferences.teamLicenseEmailNotificationsEnabled}
            aria-describedby="license-email-notifications-description" disabled={loading || saving !== null}
            onCheckedChange={(enabled) => void savePreference('teamLicenseEmailNotificationsEnabled', enabled)} />
        </div>
      </div> : null}
      {saving ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{copy.saving}
      </p> : null}
    </SettingsAccordionCard>
  );
}
