'use client';

import type { FormEvent } from 'react';
import { Inbox, Loader2, PenLine, RefreshCw, Settings, Star, Focus } from 'lucide-react';

import type { EmailAccount } from '@/app/apps/email/components/email-client-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmailSearchBar } from './EmailSearchBar';
import { useTranslations } from 'next-intl';

export type EmailMailboxHeaderLabels = {
  account: string;
  compose: string;
  mainEmail: string;
  refresh: string;
  search: string;
  searchPlaceholder: string;
  title: string;
};

export function EmailMailboxHeader({
  accounts,
  activeAccount,
  canRead,
  isLoadingMessages,
  isRefreshingMessages,
  labels,
  onAccountChange,
  onCompose,
  onManageAccounts,
  onQueryChange,
  onRefresh,
  onSearch,
  query, submittedQuery, scope, searchNotice, onSearchQuery, onResetSearch, onScopeChange, focused, onFocus,
}: {
  accounts: EmailAccount[];
  activeAccount: EmailAccount | null;
  canRead: boolean;
  isLoadingMessages: boolean;
  isRefreshingMessages: boolean;
  labels: EmailMailboxHeaderLabels;
  onAccountChange(accountId: string): void;
  onCompose(): void;
  onManageAccounts(): void;
  onQueryChange(value: string): void;
  onRefresh(): void;
  onSearch(event: FormEvent<HTMLFormElement>): void;
  query: string;
  submittedQuery: string;
  scope: 'folder' | 'all';
  searchNotice: string | null;
  onSearchQuery(value: string): void;
  onResetSearch(): void;
  onScopeChange(value: 'folder' | 'all'): void;
  focused: boolean;
  onFocus(): void;
}) {
  const tSearch = useTranslations('emailSearch');
  const tm = useTranslations('emailMailboxes');
  const groups = Array.from(new Set(accounts.map(account => account.workspaceId || 'personal')));
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight">{labels.title}</h2>
            {activeAccount ? (
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{activeAccount.emailAddress}</span>
                <Badge data-testid="email-mailbox-scope" title={activeAccount.workspaceName || tm('personal')} variant="outline" className="max-w-full whitespace-normal break-words">{activeAccount.workspaceId ? activeAccount.workspaceName || tm('workspace') : tm('personal')}</Badge>
                {activeAccount.isPrimary ? (
                  <Badge variant="secondary" className="hidden gap-1 sm:inline-flex">
                    <Star className="h-3 w-3" />
                    {labels.mainEmail}
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button data-testid="email-focus-toggle" type="button" variant={focused ? 'secondary' : 'ghost'} size="icon-sm" aria-pressed={focused} aria-label={tSearch(focused ? 'exitFocus' : 'focus')} title={tSearch(focused ? 'exitFocus' : 'focus')} onClick={onFocus}><Focus className="size-4" /></Button>
          {accounts.length > 1 || !activeAccount ? (
            <>
              <label className="sr-only" htmlFor="email-account-header-switcher">{labels.account}</label>
              <select
                id="email-account-header-switcher"
                className="h-9 min-w-0 max-w-[min(18rem,calc(100vw-2rem))] border border-input bg-background px-2 text-sm"
                value={activeAccount ? (activeAccount.workspaceId ? `${activeAccount.id}:${activeAccount.workspaceId}` : activeAccount.id) : ''}
                onChange={(event) => onAccountChange(event.target.value)}
                title={labels.account}
              >
                {!activeAccount && <option value="">{tm('selectMailbox')}</option>}
                {groups.map(group => <optgroup key={group} label={group === 'personal' ? tm('personal') : `${tm('workspace')}: ${accounts.find(account => account.workspaceId === group)?.workspaceName || group}`}>
                  {accounts.filter(account => (account.workspaceId || 'personal') === group).map(account => <option key={`${account.id}:${group}`} value={account.workspaceId ? `${account.id}:${account.workspaceId}` : account.id}>
                    {account.emailAddress}{account.connectionState === 'reconnect_required' ? ` · ${tm('reconnectTitle')}` : account.isPrimary && !account.workspaceId ? ` (${labels.mainEmail})` : ''}
                  </option>)}
                </optgroup>)}
              </select>
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            aria-label={labels.compose}
            title={labels.compose}
            onClick={onCompose}
            disabled={!activeAccount || activeAccount.capabilities?.canWrite === false}
          >
            <PenLine className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">{labels.compose}</span>
          </Button>
          <Button type="button" size="sm" variant="outline" aria-label={labels.account} title={labels.account} onClick={onManageAccounts}>
            <Settings className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">{labels.account}</span>
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={labels.refresh}
            title={labels.refresh}
            onClick={onRefresh}
            disabled={!canRead || isLoadingMessages || isRefreshingMessages}
          >
            {isLoadingMessages || isRefreshingMessages ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <EmailSearchBar query={query} submittedQuery={submittedQuery} scope={scope} disabled={!canRead} refreshing={isLoadingMessages || isRefreshingMessages} placeholder={labels.searchPlaceholder} notice={searchNotice} onChange={onQueryChange} onSubmit={onSearch} onApply={onSearchQuery} onReset={onResetSearch} onScopeChange={onScopeChange} />
    </>
  );
}
