'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, FileJson2, FileText, Loader2, Scale } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type LegalSummary = {
  success: true;
  packageVersion: string;
  lockfileSha256: string;
  summary: {
    totalComponents: number;
    npmComponents: number;
    nonNpmComponents: number;
    runtimeComponents: number;
    developmentOnlyComponents: number;
    allowed: number;
    reviewRequired: number;
    blocked: number;
    distributedReviewRequired: number;
    developmentOnlyReviewRequired: number;
  };
  releaseGate: {
    status: 'approved' | 'blocked';
    approvalStatus: 'pending' | 'approved';
    approvalReviewedBy: string | null;
    approvalReviewedAt: string | null;
    blockers: Array<{ name: string; versionOrCommit: string; reason: string }>;
  };
};

export function LegalSettingsPanel() {
  const t = useTranslations('settings.legal');
  const [data, setData] = useState<LegalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/legal/third-party', { cache: 'no-store' })
      .then(async (response) => {
        const payload = await response.json() as LegalSummary | { success: false; error?: string };
        if (!response.ok || !payload.success) {
          throw new Error('error' in payload && payload.error ? payload.error : t('loadFailed'));
        }
        if (!cancelled) setData(payload);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('loadFailedTitle')}</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  const gateApproved = data.releaseGate.status === 'approved';
  return (
    <div className="space-y-4">
      <Alert variant={gateApproved ? 'default' : 'destructive'}>
        {gateApproved
          ? <CheckCircle2 className="h-4 w-4" />
          : <AlertTriangle className="h-4 w-4" />}
        <AlertTitle>{gateApproved ? t('gateApproved') : t('gateBlocked')}</AlertTitle>
        <AlertDescription>
          {gateApproved
            ? t('gateApprovedDescription')
            : t('gateBlockedDescription', { count: data.releaseGate.blockers.length })}
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Scale className="h-5 w-5 text-primary" />
                {t('inventoryTitle')}
              </CardTitle>
              <CardDescription className="mt-1">
                {t('inventoryDescription', { version: data.packageVersion })}
              </CardDescription>
            </div>
            <Badge variant={gateApproved ? 'default' : 'destructive'}>
              {gateApproved ? t('approvedBadge') : t('blockedBadge')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {[
              [t('totalComponents'), data.summary.totalComponents],
              [t('runtimeComponents'), data.summary.runtimeComponents],
              [t('distributedReviewRequired'), data.summary.distributedReviewRequired],
              [t('developmentOnlyReviewRequired'), data.summary.developmentOnlyReviewRequired],
              [t('blockedComponents'), data.summary.blocked],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href="/api/legal/third-party/notices" target="_blank" rel="noreferrer">
                <FileText className="h-4 w-4" />
                {t('openNotices')}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="/api/legal/third-party/inventory" target="_blank" rel="noreferrer">
                <FileJson2 className="h-4 w-4" />
                {t('openInventory')}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>

          {!gateApproved && data.releaseGate.blockers.length > 0 && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4">
              <h3 className="text-sm font-semibold">{t('blockersTitle')}</h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                {data.releaseGate.blockers.slice(0, 8).map((blocker) => (
                  <li key={`${blocker.name}:${blocker.versionOrCommit}`}>
                    <span className="font-medium text-foreground">
                      {blocker.name} {blocker.versionOrCommit}
                    </span>
                    <span className="block">{blocker.reason}</span>
                  </li>
                ))}
              </ul>
              {data.releaseGate.blockers.length > 8 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('moreBlockers', { count: data.releaseGate.blockers.length - 8 })}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
