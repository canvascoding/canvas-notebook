'use client';

import { useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useDocumentReviewAvailability } from '@/app/components/file-version-center/DocumentReviewAvailabilityProvider';
import { TerminalSettingsCard } from '@/app/components/settings/TerminalSettingsCard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

export function ExperimentalFeaturesSettingsPanel() {
  const t = useTranslations('settings.experimental');
  const { documentReviewEnabled, ready, applyAvailability } = useDocumentReviewAvailability();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const updateReview = async (enabled: boolean) => {
    setSaving(true);
    setStatus('idle');
    try {
      const response = await fetch('/api/admin/experimental-settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentReviewEnabled: enabled }),
      });
      const payload = await response.json();
      if (payload.data && typeof payload.data.documentReviewEnabled === 'boolean') applyAvailability(payload.data);
      if (!response.ok || !payload.success) throw new Error('Experimental settings update failed');
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };
  return <div className="space-y-6">
    <TerminalSettingsCard />
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4" aria-hidden="true" />{t('documentReviewTitle')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-6 rounded-lg border border-border/70 p-4">
          <div className="space-y-1.5">
            <label htmlFor="document-review-enabled" className="cursor-pointer text-sm font-medium">{t('enableDocumentReview')}</label>
            <p id="document-review-enabled-description" className="max-w-xl text-sm leading-6 text-muted-foreground">{t('documentReviewDescription')}</p>
          </div>
          <div className="flex h-6 shrink-0 items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
            <Switch id="document-review-enabled" checked={documentReviewEnabled} disabled={!ready || saving}
              onCheckedChange={updateReview} aria-describedby="document-review-enabled-description" />
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('editingNote')}</p>
        <div aria-live="polite" className="text-sm">
          {status === 'error' ? <p role="alert" className="text-destructive">{t('saveError')}</p>
            : <p className="text-muted-foreground">{t(saving ? 'saving' : !ready ? 'loading' : status === 'saved' ? 'saved'
              : documentReviewEnabled ? 'enabled' : 'disabled')}</p>}
        </div>
      </CardContent>
    </Card>
  </div>;
}
