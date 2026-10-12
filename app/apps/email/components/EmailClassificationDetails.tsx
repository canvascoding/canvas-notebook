'use client';

import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, ChevronDown, Loader2, Pencil, RotateCcw } from 'lucide-react';
import type { EmailClassificationFeedItem } from '@/app/lib/email/classification/feed-types';
import type { EmailClassificationMessageDetail } from '@/app/lib/email/classification/state-service';
import type { EmailCategory, EmailClassification, EmailClassificationOverride, EmailPriority } from '@/app/lib/email/classification/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { EmailClassificationClientError, setEmailPersonalFocusDone } from './email-classification-client';

export interface EmailClassificationDetailsProps {
  item: EmailClassificationFeedItem | null;
  userId: string;
  onItemChange(detail: EmailClassificationMessageDetail): void;
  onUnavailable?(messageRef: string): void;
}

const CATEGORIES: readonly EmailCategory[] = ['correspondence', 'finance', 'support', 'sales', 'security', 'newsletter', 'marketing', 'notification', 'other'];
const PRIORITIES: readonly EmailPriority[] = ['low', 'normal', 'high', 'urgent'];
type BooleanChoice = 'auto' | 'yes' | 'no';
type CorrectionDraft = { category: EmailCategory | 'auto'; priority: EmailPriority | 'auto'; isSpam: BooleanChoice; needsReply: BooleanChoice };
type DetailError = 'loadError' | 'mutationError' | 'refreshError' | 'invalidCorrection' | null;
type Reason = 'highPriority' | 'needsReply' | 'answered' | 'uncertain' | 'pending' | 'failed' | 'stale' | 'not_selected' | 'spam' | 'done' | 'ordinary';

function selectionIdentity(userId: string, item: EmailClassificationFeedItem | null): string {
  return JSON.stringify([userId, item?.messageRef, item?.selectionKey, item?.origin.mailboxRef,
    item?.origin.accountSource, item?.origin.accountOwnerId, item?.origin.accountId,
    item?.origin.workspaceId, item?.origin.capabilities.canRead, item?.origin.capabilities.canWrite, Boolean(item?.classification)]);
}

function correctionDraft(classification: EmailClassification | null): CorrectionDraft {
  const overrides = classification?.overrides;
  const choice = (value: boolean | undefined): BooleanChoice => value === undefined ? 'auto' : value ? 'yes' : 'no';
  return { category: overrides?.category ?? 'auto', priority: overrides?.priority ?? 'auto',
    isSpam: choice(overrides?.isSpam), needsReply: choice(overrides?.needsReply) };
}

function readableReasons(item: EmailClassificationFeedItem): Reason[] {
  if (item.personalFocus.done) return ['done'];
  const classification = item.classification;
  if (!classification) return ['pending'];
  if (classification.status === 'pending' || classification.status === 'failed' || classification.status === 'stale' || classification.status === 'not_selected') return [classification.status];
  const reasons: Reason[] = [];
  if (classification.isSpam === true) reasons.push('spam');
  if (classification.priority === 'high' || classification.priority === 'urgent') reasons.push('highPriority');
  if (classification.replyStatus === 'answered') reasons.push('answered');
  else if (classification.needsReply === true) reasons.push('needsReply');
  if (classification.status === 'uncertain') reasons.push('uncertain');
  return reasons.length ? reasons.slice(0, 2) : ['ordinary'];
}

function validProbability(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isDetail(value: unknown): value is EmailClassificationMessageDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<EmailClassificationMessageDetail>;
  return typeof detail.messageRef === 'string' && typeof detail.selectionKey === 'string'
    && typeof detail.origin?.capabilities?.canRead === 'boolean'
    && typeof detail.origin?.capabilities?.canWrite === 'boolean'
    && Number.isSafeInteger(detail.personalFocus?.version) && (detail.personalFocus?.version ?? -1) >= 0
    && typeof detail.personalFocus?.done === 'boolean' && 'assessment' in detail
    && (detail.classification === null || Boolean(detail.classification?.states && detail.classification?.overrides)
      && Number.isSafeInteger(detail.classification?.version)) && Boolean(detail.message);
}

/** A changed actor or mailbox source discards the entire previous reader state. */
export function EmailClassificationDetails(props: EmailClassificationDetailsProps) {
  const identity = selectionIdentity(props.userId, props.item);
  const currentIdentity = useRef(identity);
  useLayoutEffect(() => { currentIdentity.current = identity; }, [identity]);
  if (!props.item?.origin.capabilities.canRead) return null;
  return <ClassificationDetailsContent key={identity} {...props} item={props.item}
    identity={identity} isSelectionCurrent={() => currentIdentity.current === identity} />;
}

function ClassificationDetailsContent({ item, onItemChange, onUnavailable, identity, isSelectionCurrent }: EmailClassificationDetailsProps & {
  item: EmailClassificationFeedItem; identity: string; isSelectionCurrent(): boolean;
}) {
  const t = useTranslations('emailFocus');
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<EmailClassificationMessageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutation, setMutation] = useState<'focus' | 'override' | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<DetailError>(null);
  const [conflict, setConflict] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft>(() => correctionDraft(item.classification));
  const mounted = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const callbacks = useRef({ onItemChange, onUnavailable });
  useLayoutEffect(() => { callbacks.current = { onItemChange, onUnavailable }; }, [onItemChange, onUnavailable]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readController.current?.abort();
      mutationController.current?.abort();
    };
  }, []);

  const current = (controller: AbortController) => mounted.current && isSelectionCurrent() && !controller.signal.aborted;
  const visible = detail ?? item;
  const classification = visible.classification;
  const canCorrect = item.origin.capabilities.canWrite && visible.origin.capabilities.canWrite;
  const percent = (value: number | null | undefined) => validProbability(value)
    ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value) : '—';

  function clearUnavailable() {
    readController.current?.abort();
    mutationController.current?.abort();
    setDetail(null);
    setEditing(false);
    setOpen(false);
    setLoading(false);
    setMutation(null);
    setError(null);
    setUnavailable(true);
    callbacks.current.onUnavailable?.(item.messageRef);
  }

  function acceptDetail(data: unknown): EmailClassificationMessageDetail | null {
    if (!isDetail(data)) return null;
    if (data.messageRef !== item.messageRef || data.selectionKey !== item.selectionKey
      || data.origin.mailboxRef !== item.origin.mailboxRef
      || data.origin.accountSource !== item.origin.accountSource
      || data.origin.accountOwnerId !== item.origin.accountOwnerId
      || data.origin.accountId !== item.origin.accountId
      || data.origin.workspaceId !== item.origin.workspaceId
      || !data.origin.capabilities.canRead) {
      clearUnavailable();
      return null;
    }
    return data;
  }

  async function loadDetail(refresh = false) {
    if (mutation || unavailable || !isSelectionCurrent()) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const sequence = ++readSequence.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/email/classification/message?${new URLSearchParams({ messageRef: item.messageRef })}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (!current(controller) || sequence !== readSequence.current) return;
      if ([401, 403, 404].includes(response.status)) { clearUnavailable(); return; }
      if (!response.ok) { setError(refresh ? 'refreshError' : 'loadError'); return; }
      const payload: unknown = await response.json();
      if (!current(controller) || sequence !== readSequence.current) return;
      const data = payload && typeof payload === 'object' && 'success' in payload && payload.success === true
        && 'data' in payload ? acceptDetail(payload.data) : null;
      if (!data) { if (current(controller)) setError(refresh ? 'refreshError' : 'loadError'); return; }
      setDetail(data);
      if (refresh) {
        setConflict(false);
        callbacks.current.onItemChange(data);
      }
    } catch {
      if (current(controller) && sequence === readSequence.current) setError(refresh ? 'refreshError' : 'loadError');
    } finally {
      if (current(controller) && sequence === readSequence.current) setLoading(false);
    }
  }

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next && !detail) void loadDetail();
    if (!next) {
      readController.current?.abort();
      readSequence.current += 1;
      setLoading(false);
    }
  }

  async function save(kind: 'focus' | 'override', overrides?: EmailClassificationOverride) {
    if (mutation || loading || unavailable || conflict || !isSelectionCurrent()) return;
    if (kind === 'override' && (!canCorrect || !classification)) return;
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    readController.current?.abort();
    setMutation(kind);
    setError(null);
    try {
      if (kind === 'focus') {
        const result = await setEmailPersonalFocusDone(visible, !visible.personalFocus.done, controller.signal);
        if (!current(controller)) return;
        const data = acceptDetail(result);
        if (!data) return;
        setDetail(data);
        callbacks.current.onItemChange(data);
        return;
      }
      const body = { messageRef: item.messageRef, expectedVersion: classification!.version, overrides };
      const response = await fetch('/api/email/classification/override', {
        method: 'PATCH', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!current(controller)) return;
      if ([401, 403, 404].includes(response.status)) { clearUnavailable(); return; }
      if (response.status === 409) { setConflict(true); return; }
      if (!response.ok) { setError(response.status === 400 ? 'invalidCorrection' : 'mutationError'); return; }
      const payload: unknown = await response.json();
      if (!current(controller)) return;
      const data = payload && typeof payload === 'object' && 'success' in payload && payload.success === true
        && 'data' in payload ? acceptDetail(payload.data) : null;
      if (!data) { if (current(controller)) setError('mutationError'); return; }
      setDetail(data);
      setEditing(false);
      callbacks.current.onItemChange(data);
    } catch (failure) {
      if (!current(controller)) return;
      if (failure instanceof EmailClassificationClientError) {
        if ([401, 403, 404].includes(failure.status)) { clearUnavailable(); return; }
        if (failure.status === 409) { setConflict(true); return; }
      }
      setError('mutationError');
    } finally {
      if (current(controller)) setMutation(null);
    }
  }

  function saveCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const overrides: EmailClassificationOverride = {};
    if (draft.category !== 'auto') overrides.category = draft.category;
    if (draft.priority !== 'auto') overrides.priority = draft.priority;
    if (draft.isSpam !== 'auto') overrides.isSpam = draft.isSpam === 'yes';
    if (draft.needsReply !== 'auto') overrides.needsReply = draft.needsReply === 'yes';
    void save('override', overrides);
  }

  if (unavailable) return <InlineNotice size="compact" data-testid="email-classification-unavailable">{t('details.accessError')}</InlineNotice>;

  const selectClass = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const busy = loading || Boolean(mutation);
  const distributions = [
    { title: t('details.category'), keys: CATEGORIES, values: detail?.assessment?.categoryProbabilities, namespace: 'categories' },
    { title: t('details.priority'), keys: PRIORITIES, values: detail?.assessment?.priorityProbabilities, namespace: 'priorities' },
  ] as const;
  const metrics = [
    { label: 'spamProbability', value: classification?.spamProbability },
    { label: 'replyProbability', value: classification?.replyProbability },
    { label: 'categoryConfidence', value: detail?.assessment?.categoryConfidence },
    { label: 'priorityConfidence', value: detail?.assessment?.priorityConfidence },
  ] as const;

  return (
    <section aria-labelledby={`${id}-title`} className="border-b border-border bg-muted/20 px-4 py-3" data-testid="email-classification-details" data-selection={identity}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h3 id={`${id}-title`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('details.title')}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {classification?.category && <Badge variant="outline" className="font-normal">{t(`categories.${classification.category}`)}</Badge>}
            {classification?.priority && <Badge variant="outline" className={cn('font-normal',
              (classification.priority === 'high' || classification.priority === 'urgent') && 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200')}>{t(`priorities.${classification.priority}`)}</Badge>}
          </div>
          <div className="space-y-1 text-sm text-muted-foreground">
            {readableReasons(visible).map(reason => <p key={reason}>{t(`reasons.${reason}`)}</p>)}
          </div>
        </div>
        <Button type="button" variant={visible.personalFocus.done ? 'outline' : 'secondary'} size="sm"
          className="min-h-9 max-w-full whitespace-normal max-sm:min-h-11" disabled={busy || conflict}
          title={t('details.doneHint')} onClick={() => void save('focus')} data-testid="email-classification-done">
          {mutation === 'focus' ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : visible.personalFocus.done ? <RotateCcw className="size-4" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
          {t(visible.personalFocus.done ? 'details.undoDone' : 'details.done')}
        </Button>
      </div>
      {conflict && <InlineNotice variant="warning" size="compact" className="mt-3" data-testid="email-classification-conflict"
        actions={<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void loadDetail(true)}>{t('details.refresh')}</Button>}>
        {t('details.conflict')}
      </InlineNotice>}
      {error && <InlineNotice variant="destructive" size="compact" className="mt-3" data-testid="email-classification-error"
        actions={(error === 'loadError' || error === 'refreshError') && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void loadDetail(conflict)}>{t('details.refresh')}</Button>}>
        {t(`details.${error}`)}
      </InlineNotice>}
      <Collapsible open={open} onOpenChange={changeOpen} className="mt-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2 min-h-9 max-w-full justify-start whitespace-normal text-muted-foreground max-sm:min-h-11" data-testid="email-classification-expand">
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />{t('details.assessmentDetails')}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t('details.loading')}</p>}
          {detail && <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              {metrics.map(({ label, value }) => <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t(`details.${label}`)}</dt><dd className="mt-1 font-medium tabular-nums">{percent(value)}</dd>
              </div>)}
            </dl>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('details.probabilityHint')}</p>
            {classification?.bodyWasTruncated && <p className="text-xs text-muted-foreground">{t('details.truncatedHint')}</p>}
            {classification && Object.keys(classification.overrides).length > 0 && <p className="text-xs text-muted-foreground">{t('details.correctedHint')}</p>}
            <div className="space-y-3">
              <h4 className="text-xs font-medium text-muted-foreground">{t('details.distributions')}</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                {distributions.map(distribution => <div key={distribution.namespace} className="min-w-0">
                  <h5 className="mb-2 text-xs font-medium">{distribution.title}</h5>
                  <dl className="space-y-1.5">
                    {distribution.keys.map(key => {
                      const value = distribution.values?.[key];
                      return <div key={key} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-x-2 text-xs">
                        <dt className="min-w-0 text-muted-foreground">{t(`${distribution.namespace}.${key}`)}</dt>
                        <dd className="text-right tabular-nums">{percent(value)}</dd>
                        {validProbability(value) && <div className="col-span-2 mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-foreground/25" style={{ width: `${value * 100}%` }} /></div>}
                      </div>;
                    })}
                  </dl>
                </div>)}
              </div>
            </div>
            {!canCorrect && <p className="text-xs text-muted-foreground">{t('details.readOnlyHint')}</p>}
            {canCorrect && classification && !editing && <Button type="button" variant="outline" size="sm" disabled={busy || conflict}
              className="min-h-9 max-w-full whitespace-normal max-sm:min-h-11" onClick={() => { setDraft(correctionDraft(classification)); setEditing(true); setError(null); }} data-testid="email-classification-correct">
              <Pencil className="size-3.5" aria-hidden="true" />{t('details.correctAssessment')}
            </Button>}
            {canCorrect && classification && editing && <form onSubmit={saveCorrection} className="space-y-3 border-t border-border pt-4" data-testid="email-classification-correction">
              <div><h4 className="text-sm font-medium">{t('details.correctionTitle')}</h4><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('details.correctionHint')}</p></div>
              <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label htmlFor={`${id}-category`}>{t('details.category')}</Label>
                  <select id={`${id}-category`} value={draft.category} className={selectClass} onChange={event => setDraft(previous => ({ ...previous, category: event.target.value as CorrectionDraft['category'] }))}>
                    <option value="auto">{t('details.autoValue')}</option>{CATEGORIES.map(value => <option key={value} value={value}>{t(`categories.${value}`)}</option>)}
                  </select></div>
                <div className="space-y-1.5"><Label htmlFor={`${id}-priority`}>{t('details.priority')}</Label>
                  <select id={`${id}-priority`} value={draft.priority} className={selectClass} onChange={event => setDraft(previous => ({ ...previous, priority: event.target.value as CorrectionDraft['priority'] }))}>
                    <option value="auto">{t('details.autoValue')}</option>{PRIORITIES.map(value => <option key={value} value={value}>{t(`priorities.${value}`)}</option>)}
                  </select></div>
                {(['isSpam', 'needsReply'] as const).map(field => <div key={field} className="space-y-1.5"><Label htmlFor={`${id}-${field}`}>{t(`details.${field}`)}</Label>
                  <select id={`${id}-${field}`} value={draft[field]} className={selectClass} onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value as BooleanChoice }))}>
                    <option value="auto">{t('details.autoValue')}</option><option value="yes">{t('details.yes')}</option><option value="no">{t('details.no')}</option>
                  </select></div>)}
              </fieldset>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy || conflict} className="min-h-9 max-w-full whitespace-normal max-sm:min-h-11" data-testid="email-classification-save">
                  {mutation === 'override' && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{t(mutation === 'override' ? 'details.saving' : 'details.saveCorrection')}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={Boolean(mutation)} className="min-h-9 max-w-full whitespace-normal max-sm:min-h-11" onClick={() => { setEditing(false); setError(null); }}>{t('details.cancelCorrection')}</Button>
              </div>
            </form>}
          </>}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
