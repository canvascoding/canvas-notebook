'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Inbox, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { emailReviewTarget, loadEmailReviewQueue, type EmailReviewEntry } from '@/app/lib/email/review-client';
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

  const next = queue[0];
  const failedCount = queue.filter((entry) => entry.status === 'send_failed' || entry.status === 'send_uncertain').length;
  return <section className="shrink-0 border bg-card" aria-label={t('queue')} aria-busy={loading}>
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Inbox className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{t('title')}</h2><p className="text-xs text-muted-foreground">{t('description')}</p></div>
      <Badge variant="secondary">{queue.length}</Badge>
      <Button variant="ghost" size="icon" disabled={loading} aria-label={t('refresh')} onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} /></Button>
      <Button data-testid="email-app-review-open" size="sm" onClick={() => void openEmailReview()}>{t('openOutbox')}<ArrowRight className="size-4" /></Button>
    </div>
    {error && <p role="alert" className="border-t bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
      {next ? <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void openEmailReview(emailReviewTarget(next))}>
        <p className="truncate text-sm font-medium">{next.subject || t('noSubject')}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{next.senderAddress || t('unknownSender')} → {next.to.join(', ') || t('noRecipients')}</p>
      </button> : <p className="flex-1 text-sm text-muted-foreground">{loading ? t('loading') : t('empty')}</p>}
      <Button data-testid="email-app-review-failed" variant="outline" size="sm" onClick={() => void openEmailReview(undefined, { filter: 'failed' })}><AlertCircle className="size-4" />{t('failed')} <span className="tabular-nums">{failedCount}</span></Button>
    </div>
  </section>;
}
