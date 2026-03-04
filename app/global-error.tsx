'use client';

import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-background text-foreground">
        <div className="flex min-h-screen flex-col items-center justify-center gap-4">
          <h1 className="text-2xl font-semibold">Unexpected error</h1>
          <p className="text-sm text-muted-foreground">Try reloading the page.</p>
          <button
            onClick={reset}
            className="border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-accent"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
