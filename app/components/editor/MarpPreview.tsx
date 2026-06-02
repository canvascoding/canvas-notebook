'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

interface MarpPreviewProps {
  path: string;
  content: string;
  refreshKey: number;
}

const RENDER_DEBOUNCE_MS = 350;

export function MarpPreview({ path, content, refreshKey }: MarpPreviewProps) {
  const t = useTranslations('notebook');
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const lastRequestRef = useRef(0);

  useEffect(() => {
    const requestId = lastRequestRef.current + 1;
    lastRequestRef.current = requestId;
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      setError('');

      try {
        const response = await fetch('/api/files/marp-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => null);
          throw new Error(errorData?.error || t('marpPreviewFailed'));
        }

        const nextHtml = await response.text();
        if (lastRequestRef.current === requestId) {
          setHtml(nextHtml);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }

        const message = err instanceof Error ? err.message : t('marpPreviewFailed');
        if (lastRequestRef.current === requestId) {
          setError(message);
        }
      } finally {
        if (lastRequestRef.current === requestId) {
          setLoading(false);
        }
      }
    }, RENDER_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [content, path, refreshKey, retryKey, t]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <AlertCircle className="h-7 w-7 text-destructive" />
        <div className="max-w-md space-y-1">
          <p className="text-sm font-medium text-foreground">{t('marpPreviewError')}</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRetryKey((key) => key + 1)}>
          <RefreshCw className="h-4 w-4" />
          {t('refreshPreview')}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative h-full bg-slate-950">
      {loading && !html ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950 text-slate-200">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('loadingPreview')}
          </div>
        </div>
      ) : null}
      {loading && html ? (
        <div className="absolute right-3 top-3 z-10 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('refreshingPreview')}
          </span>
        </div>
      ) : null}
      <iframe
        key={`${path}-${refreshKey}`}
        srcDoc={html}
        sandbox="allow-scripts"
        className="h-full w-full border-0 bg-slate-950"
        title={t('marpPreviewTitle', { fileName: path.split('/').pop() || path })}
      />
    </div>
  );
}
