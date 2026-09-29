'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';

import type { TeamLicenseEmailReviewDecision } from '@/app/lib/license/team-license-email-review';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

type Review = {
  id: string;
  eventKind: string;
  recipient: string;
  attempts: number;
  createdAt: string;
  reviewAt: string;
  issue: string;
};

export function TeamLicenseEmailReview({ count, onReload }: { count: number; onReload?: () => void | Promise<void> }) {
  const german = useLocale().toLowerCase().startsWith('de');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ job: Review; decision: TeamLicenseEmailReviewDecision } | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/license/team/email-review', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error();
      const payload = await response.json() as { data?: Review[] };
      setReviews(payload.data ?? []);
      setError(null);
    } catch {
      setError(german ? 'Die Prüfaufträge konnten nicht geladen werden.' : 'Could not load email review jobs.');
    }
  }, [german]);

  useEffect(() => {
    if (count < 1) return;
    const timer = window.setTimeout(() => { void reload(); }, 0);
    return () => window.clearTimeout(timer);
  }, [count, reload]);

  async function resolve() {
    if (!pending) return;
    setSaving(true);
    try {
      const response = await fetch('/api/license/team/email-review', {
        method: 'PATCH', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: pending.job.id, decision: pending.decision }),
      });
      if (!response.ok) throw new Error();
      setPending(null);
      await reload();
      await onReload?.();
    } catch {
      setError(german ? 'Entscheidung fehlgeschlagen. Bitte neu laden.' : 'Review failed. Reload and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (count < 1) return null;
  const decisionLabel = (decision: TeamLicenseEmailReviewDecision) => decision === 'confirmed_delivered'
    ? german ? 'Zustellung bestätigt' : 'Confirm delivered'
    : decision === 'confirmed_not_delivered'
      ? german ? 'Nicht zugestellt – erneut senden' : 'Not delivered – queue retry'
      : german ? 'Nicht mehr senden' : 'Do not send';

  return (
    <section className="space-y-3 border border-border p-3" aria-label={german ? 'Lizenz-E-Mail-Prüfung' : 'License email review'}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider">{german ? 'Unklare E-Mail-Zustellung' : 'Uncertain email delivery'}</h3>
        <Button variant="outline" size="sm" onClick={() => void reload()}>{german ? 'Aktualisieren' : 'Refresh'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {german ? 'Prüfe zuerst beim Mail-Provider, ob die Nachricht angenommen wurde. Nur „Nicht zugestellt“ gibt sie erneut frei.'
          : 'Check the mail provider first. Only “Not delivered” releases the message for another send.'}
      </p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {reviews.map((job) => (
        <div key={job.id} className="space-y-2 border-t border-border pt-3 text-xs">
          <p className="font-medium">{job.eventKind.replaceAll('_', ' ')} · {job.recipient}</p>
          <p className="text-muted-foreground">{new Date(job.reviewAt).toLocaleString()} · {job.attempts} {german ? 'Versuche' : 'attempts'} · {job.issue}</p>
          <p className="break-all font-mono text-muted-foreground">{job.id}</p>
          <div className="flex flex-wrap gap-2">
            {(['confirmed_delivered', 'confirmed_not_delivered', 'do_not_send'] as const).map((decision) => (
              <Button key={decision} type="button" variant="outline" size="sm"
                onClick={() => setPending({ job, decision })}>{decisionLabel(decision)}</Button>
            ))}
          </div>
        </div>
      ))}
      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !saving) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? decisionLabel(pending.decision) : ''}</AlertDialogTitle>
            <AlertDialogDescription>
              {german ? 'Bestätige diese Entscheidung erst nach Prüfung beim Mail-Provider. Ein erneuter Versand kann sonst eine doppelte E-Mail erzeugen.'
                : 'Confirm only after checking the mail provider. A retry can otherwise send a duplicate email.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{german ? 'Abbrechen' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void resolve(); }}>
              {german ? 'Entscheidung speichern' : 'Save decision'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
