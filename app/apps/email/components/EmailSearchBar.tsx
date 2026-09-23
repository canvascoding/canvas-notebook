'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { HelpCircle, Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function EmailSearchBar({ query, submittedQuery, scope, disabled, refreshing, placeholder, notice, onChange, onSubmit, onApply, onReset, onScopeChange }: {
  query: string; submittedQuery: string; scope: 'folder' | 'all'; disabled: boolean; refreshing: boolean;
  placeholder: string; notice?: string | null;
  onChange(value: string): void; onSubmit(event: FormEvent<HTMLFormElement>): void;
  onApply(value: string): void; onReset(): void; onScopeChange(value: 'folder' | 'all'): void;
}) {
  const t = useTranslations('emailSearch');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fields, setFields] = useState({ terms: '', from: '', to: '', subject: '', body: '' });
  const [match, setMatch] = useState('all');
  const applyFields = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const terms = (fields.terms.match(/"(?:\\.|[^"\\])*"|\S+/gu) || []).map(value => {
      if (value.startsWith('"') && value.endsWith('"')) {
        try { return JSON.stringify(JSON.parse(value)); } catch { /* Treat malformed quotes as literal text. */ }
      }
      return JSON.stringify(value);
    });
    const text = terms.length ? `(${terms.join(match === 'all' ? ' AND ' : ' OR ')})` : '';
    const expression = [text, ...(['from', 'to', 'subject', 'body'] as const).map(key => {
      const value = fields[key].trim();
      return value ? `${key}:${JSON.stringify(value)}` : '';
    })].filter(Boolean).join(' AND ');
    onChange(expression);
    onApply(expression);
    setOptionsOpen(false);
  };
  return <div className="min-w-0 space-y-1.5">
    <form onSubmit={onSubmit} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <div className="relative min-w-0 flex-1 basis-40">
        <Input ref={inputRef} data-testid="email-search-input" aria-label={t('inputLabel')} value={query} onChange={event => onChange(event.target.value)} placeholder={placeholder} className="h-9 pr-9" />
        {(query || submittedQuery) && <Button data-testid="email-search-reset" type="button" size="icon-sm" variant="ghost" className="absolute right-0 top-0 h-9 w-9" aria-label={t('reset')} onClick={() => { onReset(); inputRef.current?.focus(); }}><X className="size-4" /></Button>}
      </div>
      <select data-testid="email-search-scope" aria-label={t('scope')} className="h-9 max-w-40 rounded-md border border-input bg-background px-2 text-xs" value={scope} onChange={event => onScopeChange(event.target.value as 'folder' | 'all')} disabled={disabled}>
        <option value="folder">{t('currentFolder')}</option><option value="all">{t('allFolders')}</option>
      </select>
      <Button data-testid="email-search-submit" type="submit" size="icon-sm" className="h-9 w-9 shrink-0" disabled={disabled} aria-label={t('search')} title={t('search')}>{refreshing ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}</Button>
      <Popover open={optionsOpen} onOpenChange={open => {
        if (open) { setFields({ terms: '', from: '', to: '', subject: '', body: '' }); setMatch('all'); }
        setOptionsOpen(open);
      }}>
        <PopoverTrigger asChild><Button data-testid="email-search-options" type="button" variant="outline" size="icon-sm" className="h-9 w-9" aria-label={t('options')} title={t('options')}><SlidersHorizontal className="size-4" /></Button></PopoverTrigger>
        <PopoverContent align="end" className="max-h-[70dvh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto">
          <form onSubmit={applyFields} className="space-y-3">
            <p className="font-medium">{t('options')}</p><p className="text-xs text-muted-foreground">{t('optionsHint')}</p>
            {(['terms', 'from', 'to', 'subject', 'body'] as const).map(key => <div key={key} className="space-y-1"><Label htmlFor={`email-search-${key}`}>{t(key)}</Label><Input id={`email-search-${key}`} value={fields[key]} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} /></div>)}
            <Label htmlFor="email-search-match">{t('match')}</Label><select id="email-search-match" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={match} onChange={event => setMatch(event.target.value)}><option value="all">{t('matchAll')}</option><option value="any">{t('matchAny')}</option></select>
            <Button type="submit" disabled={disabled} className="w-full">{t('apply')}</Button>
          </form>
        </PopoverContent>
      </Popover>
      <Popover open={helpOpen} onOpenChange={setHelpOpen}><PopoverTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label={t('help')} title={t('help')}><HelpCircle className="size-4" /></Button></PopoverTrigger><PopoverContent onCloseAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }} align="end" className="max-h-[70dvh] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto space-y-3 text-sm">
        <p className="font-medium">{t('help')}</p><p>{t('helpText')}</p>
        {['rechnung september', 'rechnung OR angebot', 'from:anna@example.de AND subject:rechnung', 'subject:"Projekt Alpha"', '(rechnung OR angebot) AND september'].map(example => <button key={example} type="button" className="block w-full break-words rounded border p-2 text-left font-mono text-xs hover:bg-muted" onClick={() => { onChange(example); setHelpOpen(false); }}>{example}</button>)}
        <p className="text-xs text-muted-foreground">{t('providerHint')}</p>
      </PopoverContent></Popover>
    </form>
    {(submittedQuery || query.trim() !== submittedQuery || refreshing) && <p data-testid="email-search-status" role="status" className="break-words text-xs text-muted-foreground">{refreshing ? t('loading') : submittedQuery ? t('active', { query: submittedQuery }) : t('notApplied')}{query.trim() !== submittedQuery && submittedQuery ? ` · ${t('notApplied')}` : ''}</p>}
    {notice && <p role="status" className="break-words text-xs text-muted-foreground">{notice}</p>}
  </div>;
}
