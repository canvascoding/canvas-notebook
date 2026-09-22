'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

export function NotebookLoadingSkeleton({ document = false }: { document?: boolean }) {
  const t = useTranslations('notebook');
  return <main className="flex min-h-0 flex-1 gap-6 overflow-hidden p-5" role="status" aria-label={t('loadingPreview')} data-testid="notebook-loading-skeleton">
    <div className="hidden w-52 shrink-0 space-y-4 md:block" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-4" style={{ width: `${65 + i % 3 * 10}%` }} />)}
    </div>
    <div className="mx-auto w-full max-w-3xl space-y-6" aria-hidden="true">
      <Skeleton className={document ? 'h-8 w-2/3' : 'ml-auto h-14 w-1/2'} />
      {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className={document ? 'h-4 w-full' : 'h-12 w-3/4'} />)}
    </div>
  </main>;
}
