'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { AlertCircle, Loader2 } from 'lucide-react';

import { parseExcalidrawContent } from '@/app/lib/excalidraw-scene';

const PublicExcalidrawCanvas = dynamic(
  () => import('./PublicExcalidrawCanvas').then(mod => mod.PublicExcalidrawCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

interface PublicExcalidrawViewerProps {
  fileName: string;
  content: string;
}

export function PublicExcalidrawViewer({ fileName, content }: PublicExcalidrawViewerProps) {
  const session = useMemo(() => parseExcalidrawContent(content), [content]);

  if (session.invalid) {
    return (
      <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <h1 className="truncate text-sm font-medium">{fileName}</h1>
          <span className="shrink-0 text-xs text-muted-foreground">Public preview</span>
        </header>
        <section className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="flex max-w-md flex-col items-center gap-2">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h2 className="text-base font-semibold">Preview unavailable</h2>
            <p className="text-sm text-muted-foreground">
              This public Excalidraw file does not contain valid Excalidraw JSON.
            </p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium">{fileName}</h1>
          <p className="truncate text-xs text-muted-foreground">Public Excalidraw preview · local edits only</p>
        </div>
        <span className="shrink-0 border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
          Local edits only
        </span>
      </header>
      <section className="min-h-0 flex-1 overflow-hidden">
        <PublicExcalidrawCanvas initialData={session.initialData} fileName={fileName} />
      </section>
    </main>
  );
}
