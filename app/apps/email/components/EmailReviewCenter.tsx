'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Inbox, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { loadEmailReviewQueue, type EmailReviewEntry } from '@/app/lib/email/review-client';
import { openEmailReview } from '@/app/store/email-review-store';

/** The email application is an entry point; review state lives in the root host. */
export function EmailReviewCenter({ focusRequestKey }: { focusRequestKey?: string }) {
  const t = useTranslations('emailReview');
  const [queue, setQueue] = useState<EmailReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const handledFocus = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await loadEmailReviewQueue();
      if (request !== generation.current) return;
      setQueue(result.queue);
      setError(result.warnings.join(' ') || null);
    } catch (failure) {
      if (request !== generation.current) return;
      setQueue([]);
      setError(failure instanceof Error ? failure.message : t('reloadRequired'));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    const refresh = () => { void load(); };
    window.addEventListener('email_review_updated', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      generation.current += 1;
      window.clearTimeout(timeout);
      window.removeEventListener('email_review_updated', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [load]);

  useEffect(() => {
    if (!focusRequestKey || handledFocus.current === focusRequestKey) return;
    handledFocus.current = focusRequestKey;
    void openEmailReview();
  }, [focusRequestKey]);

  const failedCount = queue.filter((entry) => entry.status === 'send_failed' || entry.status === 'send_uncertain').length;
  return <section className="shrink-0 border-b bg-card" aria-label={t('queue')} aria-busy={loading}>
    <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <Button data-testid="email-app-review-open" variant="ghost" size="sm" className="min-w-0 justify-start gap-2 px-1.5" onClick={() => void openEmailReview()}>
        <Inbox className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{t('openOutbox')}</span>
        <span className="rounded bg-muted px-1.5 text-xs tabular-nums">{queue.length}</span>
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
      </Button>
      {failedCount > 0 && <Button data-testid="email-app-review-failed" variant="ghost" size="sm" className="shrink-0 text-destructive" onClick={() => void openEmailReview(undefined, { filter: 'failed' })}><AlertCircle className="size-4" /><span className="tabular-nums">{failedCount}</span> {t('failed')}</Button>}
      <Button className="ml-auto shrink-0" variant="ghost" size="icon" disabled={loading} aria-label={t('refresh')} onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>
    </div>
    {error && <p role="alert" className="border-t bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</p>}
  </section>;
}
