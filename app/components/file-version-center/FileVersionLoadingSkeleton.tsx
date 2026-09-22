'use client';

import { Skeleton } from '@/components/ui/skeleton';

export function FileVersionLoadingSkeleton({ label, timeline = false }: { label: string; timeline?: boolean }) {
  return <div role="status" aria-label={label} data-testid="file-version-loading-skeleton"
    className="grid size-full min-h-64 grid-cols-1 gap-6 p-5 md:grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
    <span className="sr-only">{label}</span>
    {timeline ? <div aria-hidden="true" className="space-y-4">
      {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-14 w-full" />)}
    </div> : <div aria-hidden="true" className="hidden md:block"><Skeleton className="h-8 w-full" /></div>}
    <div aria-hidden="true" className="space-y-5">
      <Skeleton className="h-8 w-2/3" />
      {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="h-5 w-full" />)}
    </div>
  </div>;
}
