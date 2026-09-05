'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export function AutomationRunDiagnostics({
  runId,
  status,
  metadata,
}: {
  runId: string;
  status: string;
  metadata: Record<string, unknown> | null;
}) {
  const t = useTranslations('automationen.ux');
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/automations/runs/${encodeURIComponent(runId)}/logs`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error('logs');
        if (!controller.signal.aborted) {
          setContent(payload.data.content);
          setTruncated(payload.data.truncated);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [runId, status, retry]);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{t('logs')}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
          {t('refresh')}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('logsFailed')}
        </p>
      ) : (
        <pre
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs"
          data-testid="automation-run-logs"
        >
          {content === null ? t('loadingLogs') : content || t('noLogs')}
        </pre>
      )}
      {truncated ? <p className="text-xs text-muted-foreground">{t('logsTruncated')}</p> : null}
      <p className="text-sm font-medium">{t('metadata')}</p>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted/30 p-3 text-xs">
        {JSON.stringify(metadata || {}, null, 2)}
      </pre>
    </div>
  );
}
