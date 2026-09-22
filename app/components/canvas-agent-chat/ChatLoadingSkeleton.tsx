'use client';

import { Skeleton } from '@/components/ui/skeleton';

export function ChatLoadingSkeleton({ label, variant = 'messages' }: {
  label: string;
  variant?: 'messages' | 'history';
}) {
  return <div role="status" aria-label={label} className="space-y-5 p-3" data-testid={`chat-${variant}-skeleton`}>
    {Array.from({ length: variant === 'history' ? 6 : 4 }, (_, index) => (
      <div key={index} aria-hidden="true" className={variant === 'history' ? 'flex items-center gap-3' : 'space-y-2'}>
        {variant === 'history' ? <Skeleton className="size-8 shrink-0 rounded-md" /> : null}
        <Skeleton className={variant === 'history' ? 'h-5 w-3/4' : index % 2 === 0 ? 'ml-auto h-12 w-1/2' : 'h-20 w-4/5'} />
      </div>
    ))}
  </div>;
}
