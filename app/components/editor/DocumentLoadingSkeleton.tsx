import { Skeleton } from '@/components/ui/skeleton';

/** Shared document silhouette for the file read and editor module startup. */
export function DocumentLoadingSkeleton({ label, path, showHeader = false }: {
  label: string;
  path?: string | null;
  showHeader?: boolean;
}) {
  const fileName = path?.split('/').filter(Boolean).pop();
  return (
    <div data-testid="file-loading-skeleton" role="status" aria-label={label}
      className="flex h-full min-h-24 flex-col bg-background">
      <span className="sr-only">{label}</span>
      {showHeader ? (
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Skeleton className="h-4 w-10 shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-foreground">{fileName || label}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
            <Skeleton className="h-6 w-16" /><Skeleton className="h-6 w-6" />
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden p-4" aria-hidden="true">
        <div className="mx-auto flex h-full max-w-3xl flex-col gap-5">
          <div className="space-y-3">
            <Skeleton className="h-7 w-3/5" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-[92%]" />
              <Skeleton className="h-4 w-[96%]" /><Skeleton className="h-4 w-[84%]" />
            </div>
            <Skeleton className="hidden h-24 sm:block" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-[88%]" />
            <Skeleton className="h-4 w-[94%]" /><Skeleton className="h-4 w-[76%]" />
          </div>
          <div className="mt-auto grid grid-cols-3 gap-3">
            <Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" />
          </div>
        </div>
      </div>
    </div>
  );
}
