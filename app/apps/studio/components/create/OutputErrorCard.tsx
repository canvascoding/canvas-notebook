'use client';

import { AlertCircle, RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface OutputErrorCardProps {
  mode: 'image' | 'video';
  message?: string | null;
}

export function OutputErrorCard({ mode, message }: OutputErrorCardProps) {
  return (
    <div className="flex aspect-square flex-col justify-between rounded-3xl border border-red-500/40 bg-red-500/5 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700 dark:text-red-300">
          {mode}
        </span>
        <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-300" />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Generation failed</h3>
        <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">
          {message || 'The output could not be created. Try again with a simplified prompt or a different preset.'}
        </p>
      </div>

      <Button type="button" variant="outline" className="w-full justify-center gap-2" disabled>
        <RefreshCcw className="h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}
