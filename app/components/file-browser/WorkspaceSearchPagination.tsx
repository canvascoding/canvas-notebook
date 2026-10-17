'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export function WorkspaceSearchPagination({ loaded, total, hasMore, isLoading, onLoadMore }: {
  loaded: number; total: number; hasMore: boolean; isLoading: boolean; onLoadMore: () => void;
}) {
  const t = useTranslations('workspaces.discovery');
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
    <span aria-live="polite">{t('showing', { loaded, total })}</span>
    {hasMore ? <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={onLoadMore}>
      {isLoading ? t('loadingMore') : t('loadMore')}
    </Button> : null}
  </div>;
}
