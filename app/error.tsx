'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('App error:', error);
  }, [error]);

  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 bg-slate-900 text-slate-100">
      <AlertCircle className="h-10 w-10 text-red-400" />
      <div className="text-center">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-slate-400">Please try again.</p>
      </div>
      <Button variant="secondary" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
