'use client';

import { Loader2 } from 'lucide-react';

interface OutputProcessingSkeletonProps {
  mode: 'image' | 'video';
}

export function OutputProcessingSkeleton({ mode }: OutputProcessingSkeletonProps) {
  const estimate = mode === 'video' ? 'Video · ~2m' : 'Image · ~12s';

  return (
    <div className="relative aspect-square overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm">
      <div className="absolute inset-0 animate-pulse bg-[linear-gradient(115deg,rgba(255,255,255,0.03),rgba(255,255,255,0.16),rgba(255,255,255,0.03))]" />
      <div className="relative flex h-full flex-col justify-between p-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-border/70 bg-background/75 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {mode}
          </span>
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <div className="h-3 w-32 rounded-full bg-muted" />
          <div className="h-3 w-24 rounded-full bg-muted/80" />
          <p className="pt-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{estimate}</p>
        </div>
      </div>
    </div>
  );
}
