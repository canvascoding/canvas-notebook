'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatLoadingSkeleton } from '@/app/components/canvas-agent-chat/ChatLoadingSkeleton';
import { DocumentLoadingSkeleton } from '@/app/components/editor/DocumentLoadingSkeleton';
import { NOTEBOOK_EXPLORER_DEFAULT_WIDTH } from '@/app/lib/notebook/layout-state';

export function NotebookLoadingSkeleton({ document = false }: { document?: boolean }) {
  const t = useTranslations('notebook');
  const label = t('loadingPreview');
  return <main className="flex min-h-0 flex-1 overflow-hidden" role="status" aria-label={label} data-testid="notebook-loading-skeleton">
    <aside className="hidden shrink-0 space-y-4 border-r border-border bg-card p-4 md:block"
      style={{ width: NOTEBOOK_EXPLORER_DEFAULT_WIDTH }} aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-4" style={{ width: `${65 + i % 3 * 10}%` }} />)}
    </aside>
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden" aria-hidden="true">
      {document ? <DocumentLoadingSkeleton label={label} showHeader /> : (
        <div className="flex h-full min-h-0 flex-col bg-card">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
            <Skeleton className="h-5 w-40" /><Skeleton className="h-8 w-20" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-4"><ChatLoadingSkeleton label={label} /></div>
          <div className="shrink-0 border-t border-border p-3"><Skeleton className="h-20 w-full rounded-xl" /></div>
        </div>
      )}
    </div>
  </main>;
}
