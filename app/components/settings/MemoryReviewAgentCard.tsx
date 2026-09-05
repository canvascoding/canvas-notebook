'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { AgentAvatar } from '@/app/components/agents/AgentAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type ReviewerSettings = {
  automaticMemoryEnabled: boolean;
  memoryReviewWorkerAvailable: boolean;
  runtimeConfigured: boolean;
  providerInstallationId: string | null;
  modelId: string | null;
  review: {
    status: string;
    count: number;
    lastCompletedAt: number | null;
    lastErrorCode: string | null;
  };
  providers: Array<{ installationId: string; name: string }>;
};

export function MemoryReviewAgentCard() {
  const t = useTranslations('settings.agentPanel.memoryReviewer');
  const [settings, setSettings] = useState<ReviewerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/memory?settings=1', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { success?: boolean; data?: ReviewerSettings; error?: string };
        if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error || t('loadError'));
        if (!cancelled) setSettings(payload.data);
      })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('loadError')); });
    return () => { cancelled = true; };
  }, [t]);

  const providerName = settings?.providers.find((provider) => provider.installationId === settings.providerInstallationId)?.name;
  const reviewerEnabled = Boolean(settings?.automaticMemoryEnabled && settings.memoryReviewWorkerAvailable);
  const configured = Boolean(reviewerEnabled && settings?.runtimeConfigured);
  const running = settings?.review.status === 'running';

  return (
    <Card className="border-primary/25 bg-[linear-gradient(135deg,hsl(var(--primary)/0.08),transparent_55%)]" data-testid="memory-review-agent-card">
      <CardHeader className="gap-4 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <AgentAvatar iconId="brain" className="border-primary/30 bg-primary/10 text-primary" />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{t('name')}</CardTitle>
              <Badge variant="outline">{t('reserved')}</Badge>
              <Badge variant="secondary">{t('nonChat')}</Badge>
            </div>
            <CardDescription>{t('description')}</CardDescription>
            <p className="font-mono text-xs text-muted-foreground">memory-manager</p>
          </div>
        </div>
        {!settings && !error ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : !settings?.memoryReviewWorkerAvailable ? <Badge variant="outline">{t('serverDisabled')}</Badge> : !settings.automaticMemoryEnabled ? <Badge variant="outline">{t('disabled')}</Badge> : configured ? <Badge className="gap-1.5"><CheckCircle2 className="size-3.5" />{running ? t('running') : t('ready')}</Badge> : <Badge variant="outline" className="gap-1.5"><AlertTriangle className="size-3.5" />{t('setupNeeded')}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {!settings && !error ? (
          <p className="max-w-2xl text-sm text-muted-foreground">{t('loading')}</p>
        ) : reviewerEnabled ? (
          <div className="grid gap-3 text-sm sm:grid-cols-3" data-testid="memory-review-agent-runtime-details">
            <div><p className="text-xs text-muted-foreground">{t('provider')}</p><p className="font-medium">{providerName || t('notConfigured')}</p></div>
            <div><p className="text-xs text-muted-foreground">{t('model')}</p><p className="font-medium">{settings?.modelId || t('notConfigured')}</p></div>
            <div><p className="text-xs text-muted-foreground">{t('queue')}</p><p className="flex items-center gap-1.5 font-medium"><Clock3 className="size-3.5" />{t('jobs', { count: settings?.review.count ?? 0 })}</p></div>
          </div>
        ) : (
          <p className="max-w-2xl text-sm text-muted-foreground" data-testid="memory-review-agent-disabled-copy">
            {!settings?.memoryReviewWorkerAvailable ? t('serverDisabledDescription') : t('disabledDescription')}
          </p>
        )}
        <Button asChild size="sm"><Link href="/settings?tab=memory">{t('configure')}</Link></Button>
      </CardContent>
      {error ? <p className="px-6 pb-5 text-sm text-destructive">{error}</p> : null}
    </Card>
  );
}
