'use client';

import type { FormEvent } from 'react';
import { Inbox, Loader2, PenLine, RefreshCw, Search, Settings, Star } from 'lucide-react';

import type { EmailAccount } from '@/app/apps/email/components/email-client-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
  query,
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
}) {
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
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{activeAccount.emailAddress}</span>
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
          {accounts.length > 1 ? (
            <>
              <label className="sr-only" htmlFor="email-account-header-switcher">{labels.account}</label>
              <select
                id="email-account-header-switcher"
                className="h-9 min-w-0 max-w-[min(18rem,calc(100vw-2rem))] border border-input bg-background px-2 text-sm"
                value={activeAccount?.id || ''}
                onChange={(event) => onAccountChange(event.target.value)}
                title={labels.account}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.isPrimary ? `${account.emailAddress} (${labels.mainEmail})` : account.emailAddress}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <Button
            type="button"
            size="sm"
            aria-label={labels.compose}
            title={labels.compose}
            onClick={onCompose}
            disabled={!activeAccount}
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

      <form onSubmit={onSearch} className="flex gap-2">
        <Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={labels.searchPlaceholder} className="h-9" />
        <Button type="submit" size="icon-sm" className="h-9 w-9 shrink-0" disabled={!canRead || isLoadingMessages} aria-label={labels.search} title={labels.search}>
          <Search className="h-4 w-4" />
        </Button>
      </form>
    </>
  );
}
