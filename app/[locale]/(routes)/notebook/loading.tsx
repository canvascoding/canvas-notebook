import { NotebookLoadingSkeleton } from '@/app/components/notebook/NotebookLoadingSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

export default function NotebookLoading() {
  // Route loading boundaries cannot reliably read a document deep link before hydration.
  // Use the default chat surface; DashboardShell selects the document variant once it has the route intent.
  return <div className="flex h-dvh min-h-0 w-full flex-col bg-background">
    <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3 sm:px-4" aria-hidden="true">
      <div className="flex items-center gap-3"><Skeleton className="h-8 w-8" /><Skeleton className="hidden h-6 w-44 md:block" /></div>
      <div className="flex items-center gap-3"><Skeleton className="h-8 w-28" /><Skeleton className="h-8 w-8" /></div>
    </div>
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-muted/20 px-2" aria-hidden="true">
      <Skeleton className="h-8 w-8" /><Skeleton className="h-6 w-32" /><Skeleton className="h-6 w-20" />
    </div>
    <NotebookLoadingSkeleton />
  </div>;
}
