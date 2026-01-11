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
      <body className="bg-slate-900 text-slate-100">
        <div className="flex min-h-screen flex-col items-center justify-center gap-4">
          <h1 className="text-2xl font-semibold">Unexpected error</h1>
          <p className="text-sm text-slate-400">Try reloading the page.</p>
          <button
            onClick={reset}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
