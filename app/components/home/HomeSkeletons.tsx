'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

export function HomeSkeleton({ className }: { className: string }) {
  return <Skeleton aria-hidden="true" className={`bg-muted motion-reduce:animate-none ${className}`} />;
}

export function HomeFileRowsSkeleton({ count = 5 }: { count?: number }) {
  const t = useTranslations('home.start');
  return (
    <div role="status" aria-label={t('loading')}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-16 items-center gap-3 px-3">
          <HomeSkeleton className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <HomeSkeleton className={index % 2 ? 'h-4 w-2/5' : 'h-4 w-3/5'} />
            <HomeSkeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HomeNotificationRowsSkeleton() {
  const t = useTranslations('notifications');
  return (
    <div role="status" aria-label={t('loading')} className="divide-y divide-border/60 px-4">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex h-28 items-start gap-3 py-5">
          <HomeSkeleton className="h-4 w-4 shrink-0" />
          <div className="flex-1 space-y-2">
            <HomeSkeleton className="h-4 w-full" />
            <HomeSkeleton className="h-4 w-3/4" />
            <HomeSkeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
