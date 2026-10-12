'use client';

import { useTranslations } from 'next-intl';
import { Maximize2, Minimize2, MoreHorizontal, Plus, RefreshCw, Search } from 'lucide-react';
import type { EmailFeedMode } from '@/app/lib/email/classification/feed-types';
import type { EmailMailboxScope } from '@/app/lib/email/classification/mailbox-types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface EmailFocusMailboxOption {
  mailboxRef: string; emailAddress: string; displayName: string | null; workspaceId: string | null; workspaceName: string | null;
}
export interface EmailFocusHeaderProps {
  scope: EmailMailboxScope; mode: EmailFeedMode; classificationEnabled: boolean; mailboxes: EmailFocusMailboxOption[];
  search: string; onScopeChange(scope: EmailMailboxScope): void; onModeChange(mode: EmailFeedMode): void;
  onSearchChange(search: string): void; onCompose(): void; onRefresh(): void;
  loading?: boolean; canCompose?: boolean; mailboxesLoading?: boolean; mailboxesError?: boolean;
  controlsOnly?: boolean; focused?: boolean; onDistractionFree?(): void;
}

export function EmailFocusHeader({ scope, mode, classificationEnabled, mailboxes, search, onScopeChange, onModeChange,
  onSearchChange, onCompose, onRefresh, loading = false, canCompose = true, mailboxesLoading = false,
  mailboxesError = false, controlsOnly = false, focused = false, onDistractionFree }: EmailFocusHeaderProps) {
  const t = useTranslations('emailFocus');
  return (
    <div className="space-y-3 border-b px-3 py-3 sm:px-4" data-testid="email-focus-header">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-52">
          <Label htmlFor="email-focus-scope" className="sr-only">{t('scopeLabel')}</Label>
          <select id="email-focus-scope" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-ring"
            value={scope.kind === 'mailbox' ? `mailbox:${scope.mailboxRef}` : scope.kind} disabled={mailboxesLoading}
            onChange={event => { const value = event.target.value; onScopeChange(value.startsWith('mailbox:') ? { kind: 'mailbox', mailboxRef: value.slice(8) } : { kind: value as 'all' | 'personal' | 'work' }); }}>
            <option value="all">{t('scopes.all')}</option><option value="personal">{t('scopes.personal')}</option><option value="work">{t('scopes.work')}</option>
            {(['personal', 'work'] as const).map(kind => <optgroup key={kind} label={t(`scopes.${kind}`)}>
              {mailboxes.filter(mailbox => kind === 'work' ? Boolean(mailbox.workspaceId) : !mailbox.workspaceId).map(mailbox => <option key={mailbox.mailboxRef} value={`mailbox:${mailbox.mailboxRef}`}>
                {mailbox.displayName ? `${mailbox.displayName} · ` : ''}{mailbox.emailAddress}{mailbox.workspaceName ? ` · ${mailbox.workspaceName}` : ''}
              </option>)}
            </optgroup>)}
          </select>
        </div>
        <div className="flex shrink-0 items-center rounded-md border p-0.5" role="group" aria-label={t('modeLabel')}>
          <Button type="button" size="sm" variant={mode === 'focus' ? 'secondary' : 'ghost'} aria-pressed={mode === 'focus'} disabled={!classificationEnabled} onClick={() => onModeChange('focus')}>{t('focus')}</Button>
          <Button type="button" size="sm" variant={mode === 'classic' ? 'secondary' : 'ghost'} aria-pressed={mode === 'classic'} onClick={() => onModeChange('classic')}>{t('classic')}</Button>
        </div>
        {!controlsOnly && <>
          <Button type="button" size="sm" disabled={!canCompose} onClick={onCompose}><Plus className="mr-1.5 h-4 w-4" />{t('compose')}</Button>
          <Button type="button" variant="ghost" size="icon" aria-label={t('refresh')} disabled={loading} onClick={onRefresh}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
          {onDistractionFree && <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={t('appearance')}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem onClick={onDistractionFree}>{focused ? <Minimize2 className="mr-2 h-4 w-4" /> : <Maximize2 className="mr-2 h-4 w-4" />}{t(focused ? 'exitDistractionFree' : 'distractionFree')}</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>}
        </>}
      </div>
      {mailboxesError && <p className="text-xs text-destructive" role="status">{t('sourceCatalogError')}</p>}
      {!classificationEnabled && <p className="text-xs text-muted-foreground">{t('classificationDisabled')}</p>}
      {!controlsOnly && <div className="space-y-1.5">
        <Label htmlFor="email-focus-search" className="sr-only">{t('searchLabel')}</Label>
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input id="email-focus-search" type="search" className="pl-9" value={search} maxLength={300} placeholder={t('searchPlaceholder')} onChange={event => onSearchChange(event.target.value)} />
        </div><p className="text-[11px] leading-relaxed text-muted-foreground">{t('searchHint')}</p>
      </div>}
    </div>
  );
}
