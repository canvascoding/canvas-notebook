import { Suspense } from 'react';
import { requirePageSession } from '@/app/lib/auth-guards';
import { CreateView } from '@/app/apps/studio/components/create/CreateView';

function StudioCreateFallback() {
  return (
    <div className="flex h-full min-h-[520px] items-center justify-center p-6">
      <div className="grid w-full max-w-5xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, index) => (
          <div
            key={index}
            className="aspect-square animate-pulse rounded-2xl border border-border/70 bg-muted"
          />
        ))}
      </div>
    </div>
  );
}

export default async function StudioCreatePage() {
  await requirePageSession();

  return (
    <Suspense fallback={<StudioCreateFallback />}>
      <CreateView />
    </Suspense>
  );
}
