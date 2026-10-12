'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, X } from 'lucide-react';
import { appendComposeRecipients, composeRecipientExclusions, composeRecipientText, isValidComposeRecipient, splitRecipientInput } from './email-compose-utils';
import { parseEmailAddresses, splitEmailAddressText } from '@/app/lib/email/addresses';
import { findEmailRecipientSuggestions } from '@/app/lib/email/recipient-discovery-client';
import type { EmailRecipientCandidate, EmailRecipientDiscoveryResult } from '@/app/lib/email/recipient-discovery-types';
import { cn } from '@/lib/utils';

export function EmailRecipientSource({ candidate }: { candidate: EmailRecipientCandidate }) {
  const t = useTranslations('EmailRecipients');
  const locale = useLocale();
  const date = candidate.source.date ? new Date(candidate.source.date) : null;
  return <span className="block text-xs text-muted-foreground">
    {t(`roles.${candidate.source.role}`)}
    {date && !Number.isNaN(date.valueOf()) ? <> · {t('sourceDate', { date: date.toLocaleDateString(locale) })}</> : null}
  </span>;
}

export function EmailRecipientSourceDetails({ candidate }: { candidate: EmailRecipientCandidate }) {
  const t = useTranslations('EmailRecipients');
  const locale = useLocale();
  const date = candidate.source.date ? new Date(candidate.source.date) : null;
  return <details className="px-3 pb-2 text-xs text-muted-foreground">
    <summary className="cursor-pointer underline-offset-2 hover:underline">{t('sourceDetails')}</summary>
    <p className="mt-1 break-all">{t('sourceFolder', { folder: candidate.source.folder })}</p>
    {date && !Number.isNaN(date.valueOf()) ? <p>{t('sourceDateTime', { date: date.toLocaleString(locale) })}</p> : null}
  </details>;
}

export function EmailRecipientInput({ value, onChange, accountId, mailboxWorkspaceId, disabled = false, id, testId, exclude = [] }: {
  value: string;
  onChange(value: string): void;
  accountId?: string;
  mailboxWorkspaceId?: string | null;
  disabled?: boolean;
  id: string;
  testId?: string;
  exclude?: string[];
}) {
  const t = useTranslations('EmailRecipients');
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState('');
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const [lookup, setLookup] = useState<{ key: string; loading?: boolean; result?: EmailRecipientDiscoveryResult; error?: boolean } | null>(null);
  const generation = useRef(0);
  const recipients = useMemo(() => splitRecipientInput(value), [value]);
  const hasInvalidRecipients = recipients.some(recipient => !isValidComposeRecipient(recipient));
  const excluded = composeRecipientExclusions([...recipients, ...exclude]);
  const excludeKey = JSON.stringify(excluded);
  const query = pending.trim();
  const key = JSON.stringify([accountId, mailboxWorkspaceId || null, query, excludeKey, focused, disabled, dismissed]);
  const currentKey = useRef(key);
  useLayoutEffect(() => { currentKey.current = key; }, [key]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    if (!accountId || disabled || !focused || dismissed || query.length < 2 || query.length > 120 || parseEmailAddresses(query).length) return () => controller.abort();
    const timeout = window.setTimeout(() => {
      if (currentKey.current !== key) return;
      setLookup({ key, loading: true });
      void findEmailRecipientSuggestions({ accountId, mailboxWorkspaceId, query, exclude: JSON.parse(excludeKey).slice(0, 50) }, controller.signal)
        .then(result => {
          if (!controller.signal.aborted && generation.current === requestGeneration && currentKey.current === key) {
            setLookup({ key, result }); setActive(-1);
          }
        }).catch(() => {
          if (!controller.signal.aborted && generation.current === requestGeneration && currentKey.current === key) setLookup({ key, error: true });
        });
    }, 400);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [accountId, mailboxWorkspaceId, query, excludeKey, focused, disabled, dismissed, key]);

  const visibleLookup = lookup?.key === key ? lookup : null;
  const candidates = visibleLookup?.result?.candidates.filter(candidate => !excluded.includes(candidate.address.toLowerCase())).slice(0, 5) || [];
  const open = Boolean(visibleLookup);
  const commit = (raw = pending) => {
    if (disabled) return;
    const additions = splitRecipientInput(raw);
    if (!additions.length) return;
    onChange(composeRecipientText(appendComposeRecipients(recipients, additions)));
    setPending(''); setActive(-1); setLookup(null);
  };
  const select = (candidate: EmailRecipientCandidate) => {
    if (disabled || currentKey.current !== key || excluded.includes(candidate.address.toLowerCase()) || !parseEmailAddresses(candidate.address).length) return;
    onChange(composeRecipientText(appendComposeRecipients(recipients, [candidate.address])));
    setPending(''); setActive(-1); setLookup(null); inputRef.current?.focus();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && candidates.length) {
      event.preventDefault(); setActive(index => event.key === 'ArrowDown' ? (index + 1) % candidates.length : (index <= 0 ? candidates.length - 1 : index - 1)); return;
    }
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); setActive(-1); return; }
    if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0 && candidates[active]) { event.preventDefault(); select(candidates[active]); return; }
    if (event.key === 'Tab') return; // Focus may move to source details; external blur commits manual input.
    if ((event.key === ',' || event.key === ';') && splitEmailAddressText(`${pending}${event.key}`).at(-1) !== '') return;
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      if (pending.trim()) { event.preventDefault(); commit(); } return;
    }
    if (event.key === 'Backspace' && !pending && recipients.length) {
      event.preventDefault(); onChange(composeRecipientText(recipients.slice(0, -1)));
    }
  };

  return <div className="min-w-0 space-y-1" onBlur={event => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setFocused(false); setActive(-1);
    // Keep unresolved recipient intent in the form rather than silently ignoring it on Send.
    if (pending.trim()) commit();
  }}>
    <div className={cn('flex min-h-10 w-full flex-wrap items-center gap-1 border border-input bg-background px-2 py-1.5 text-sm focus-within:ring-1 focus-within:ring-ring', disabled && 'opacity-50')} onClick={() => inputRef.current?.focus()}>
      {recipients.map((recipient, index) => <span key={`${recipient}:${index}`} aria-invalid={!isValidComposeRecipient(recipient)} title={recipient}
        className={cn('inline-flex max-w-full items-center gap-1 border bg-muted/40 px-2 py-1 text-xs', isValidComposeRecipient(recipient) ? 'border-border text-foreground' : 'border-destructive/60 bg-destructive/10 text-destructive')}>
        <span className="min-w-0 break-all">{recipient}</span>
        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground disabled:pointer-events-none" disabled={disabled} aria-label={t('remove', { address: recipient })}
          onClick={event => { event.stopPropagation(); onChange(composeRecipientText(recipients.filter((_, i) => i !== index))); inputRef.current?.focus(); }}><X className="size-3" /></button>
      </span>)}
      <input ref={inputRef} id={id} data-testid={testId} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={active >= 0 && candidates[active] ? `${listId}-${active}` : undefined}
        aria-describedby={[visibleLookup ? `${listId}-status` : '', hasInvalidRecipients ? `${listId}-invalid` : ''].filter(Boolean).join(' ') || undefined}
        value={pending} placeholder={recipients.length ? '' : t('placeholder')} disabled={disabled}
        className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        onFocus={() => { setFocused(true); setDismissed(false); }}
        onChange={event => {
          const next = event.target.value; setDismissed(false); setActive(-1);
          if (/[,;\n]/u.test(next) && parseEmailAddresses(next).length && splitRecipientInput(next).every(isValidComposeRecipient)) commit(next);
          else setPending(next);
        }} onKeyDown={handleKeyDown} />
    </div>
    {hasInvalidRecipients ? <p id={`${listId}-invalid`} role="alert" className="text-xs text-destructive">{t('invalidRecipient')}</p> : null}
    {visibleLookup ? <div className="overflow-hidden rounded-md border bg-background shadow-sm">
      <p id={`${listId}-status`} role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        {visibleLookup.loading ? <><Loader2 className="size-3 animate-spin" />{t('loading')}</>
          : visibleLookup.error ? t('unavailable')
          : visibleLookup.result?.status === 'incomplete' || visibleLookup.result?.coverage.incomplete ? t('incomplete')
          : candidates.length ? t('choose') : t('noResults')}
      </p>
      <ul id={listId} role="listbox" aria-label={t('suggestions')}>
        {candidates.map((candidate, index) => <li key={candidate.address}>
          <button type="button" id={`${listId}-${index}`} role="option" aria-selected={active === index}
            className={cn('w-full px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active === index && 'bg-muted')}
            onMouseDown={event => event.preventDefault()} onClick={() => select(candidate)}>
            {candidate.name ? <span className="block text-sm font-medium">{candidate.name}</span> : null}
            <span className="block break-all text-sm">{candidate.address}</span><EmailRecipientSource candidate={candidate} />
          </button><EmailRecipientSourceDetails candidate={candidate} />
        </li>)}
      </ul>
      {visibleLookup.result?.omittedCount ? <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t('narrowQuery')}</p> : null}
    </div> : null}
  </div>;
}
