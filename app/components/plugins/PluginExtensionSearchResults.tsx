'use client';

import { ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PluginExtensionCoverage, PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { PluginExtensionSearchData } from './usePluginExtensionSearch';
import { PluginExtensionAvatar } from './PluginExtensionAvatar';

export function PluginExtensionSearchResults({ data, workspaceId, onOpen, onMore, onRetry }: { data: PluginExtensionSearchData; workspaceId?: string | null;
  onOpen: (item: PluginExtensionItem, button: HTMLButtonElement) => void; onMore: (cursor: string) => void;
  onRetry: (source?: PluginExtensionCoverage['source']) => void }) {
  const t = useTranslations('skills.workspace.catalog');
  const busy = data.status === 'loading' || data.updating;
  const incomplete = data.response?.coverage.some(source => source.status === 'partial' || source.status === 'unavailable') ?? false;
  const status = (item: PluginExtensionItem) => {
    if (item.kind === 'integration' || item.kind === 'mcp') {
      if (item.kind === 'integration' && item.toolkit.noAuth && !item.connections.length) return 'statusNoAuth';
      if (!item.connections.length) return 'statusAvailable';
      if (item.connections.every(connection => !connection.enabled)) return 'statusDisabled';
      if (item.connections.every(connection => !connection.access.canUse)) return 'statusRestricted';
      if (item.connections.some(connection => connection.enabled && connection.authorization === 'authorized' && connection.health !== 'unavailable')) return 'statusConnected';
      if (item.connections.some(connection => connection.health === 'unavailable')) return 'statusUnavailable';
      if (item.connections.some(connection => connection.authorization === 'required')) return 'statusAuthRequired';
      if (item.connections.some(connection => connection.authorization === 'not_required')) return 'statusNoAuth';
      return 'statusUnknown';
    }
    return item.package?.activation?.enabled === false ? 'statusDisabled' : item.stock === 'installed' ? 'statusInstalled' : 'statusAvailable';
  };
  return <section className="min-w-0 space-y-4" data-testid="plugin-extension-results" aria-busy={busy}>
    {data.status === 'ready' && data.error ? <InlineNotice size="compact" variant="warning" data-testid="plugin-extension-page-error"
      actions={<Button type="button" variant="outline" size="sm" onClick={() => onRetry()} disabled={busy} data-testid="plugin-extension-retry">{t('retry')}</Button>}>
      {t('sourceUnavailable', { source: t('title') })}
    </InlineNotice> : null}
    {data.response?.coverage.filter(source => source.status !== 'complete').map(source => {
      const sourceName = t(`source_${source.source === 'packages' ? 'local' : source.source}`);
      return <InlineNotice key={source.source} size="compact" variant={source.status === 'not_configured' ? 'info' : 'warning'}
        data-testid="plugin-extension-coverage" data-source={source.source} data-status={source.status}
        actions={source.error?.retryable ? <Button type="button" size="sm" variant="outline" onClick={() => onRetry(source.source)}
          disabled={data.pendingSources?.includes(source.source)} data-testid="plugin-extension-retry"><RefreshCw className="size-3.5" aria-hidden="true" />{t('retry')}</Button> : undefined}>
        {t(source.status === 'partial' ? 'partialSource' : source.status === 'not_configured' ? 'sourceNotConfigured' : 'sourceUnavailable', { source: sourceName })}
      </InlineNotice>;
    })}
    {data.status === 'loading' || data.status === 'ready' && data.updating && !data.items.length ? <div className="space-y-3" role="status" data-testid="plugin-extension-loading"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t('loading')}</span>
      {[0, 1, 2].map(index => <div key={index} className="h-24 animate-pulse rounded-lg border bg-muted/40" />)}</div>
      : data.status === 'error' ? <InlineNotice size="compact" variant="warning" actions={<Button type="button" variant="outline" size="sm" onClick={() => onRetry()} disabled={busy} data-testid="plugin-extension-retry">{t('retry')}</Button>}>
        {t('sourceUnavailable', { source: t('title') })}</InlineNotice> : <>
        {data.items.length ? <ul className="divide-y rounded-lg border bg-background">
          {data.items.map(item => {
            const state = status(item), hasConnections = item.kind === 'integration' || item.kind === 'mcp';
            const parentRef = item.kind === 'plugin' || item.kind === 'skill' ? item.package?.parentResourceRef : undefined;
            const parentName = parentRef ? data.items.find(candidate => candidate.id === parentRef)?.displayName : undefined;
            return <li key={item.id} data-testid="plugin-extension-row" data-kind={item.kind} data-extension-id={item.id}>
              <button type="button" className="group flex w-full min-w-0 items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:gap-4 sm:p-5"
                data-testid="plugin-extension-row-open" data-extension-id={item.id} aria-label={t('open', { name: item.displayName })} onClick={event => onOpen(item, event.currentTarget)}>
                <PluginExtensionAvatar name={item.displayName} identity={JSON.stringify([item.id, workspaceId ?? ''])} icon={item.icon} />
                <span className="min-w-0 flex-1 space-y-1.5">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="min-w-0 break-words font-medium">{item.displayName}</span><span className="text-xs text-muted-foreground">{t(state)}</span></span>
                  {item.description ? <span className="block line-clamp-2 break-words text-sm text-muted-foreground">{item.description}</span> : null}
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t(`kind_${item.kind}`)}</span><span>{t(`source_${item.source}`)}</span>
                    {item.ownershipLabel ? <span className="max-w-full break-words">{item.ownershipLabel}</span> : null}
                    {hasConnections && item.connections.length > 1 ? <span>{t('connectionsCount', { count: item.connections.length })}</span> : null}
                    {parentRef ? <span>{parentName ? t('fromPlugin', { name: parentName }) : t('includedInPlugin')}</span> : null}
                    {!item.access.canManage && item.stock === 'installed' ? <span>{t('readOnly')}</span> : null}
                  </span>
                </span>
                <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>;
          })}
        </ul> : <p className="rounded-lg border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">{t(incomplete ? 'emptyPartial' : 'empty')}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground" aria-live="polite">
          <span>{data.updating ? t('updating') : t(data.response?.pagination.totalItems === undefined ? 'loadedCount' : 'totalCount', { count: data.response?.pagination.totalItems ?? data.items.length })}</span>
          {data.response?.pagination.nextCursor ? <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="plugin-extension-more"
            onClick={() => onMore(data.response!.pagination.nextCursor!)}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{t('more')}</Button> : null}
        </div>
      </>}
  </section>;
}
