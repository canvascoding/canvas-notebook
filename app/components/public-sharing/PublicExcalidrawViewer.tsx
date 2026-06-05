'use client';

import { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { Excalidraw, Footer, MainMenu } from '@excalidraw/excalidraw';

import { parseExcalidrawContent } from '@/app/lib/excalidraw-scene';

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
          <span className="shrink-0 text-xs text-muted-foreground">Read-only</span>
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
          <p className="truncate text-xs text-muted-foreground">Public Excalidraw preview</p>
        </div>
        <span className="shrink-0 border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
          Read-only
        </span>
      </header>
      <section className="min-h-0 flex-1 overflow-hidden">
        <Excalidraw
          initialData={session.initialData}
          viewModeEnabled
          name={fileName}
          isCollaborating={false}
          aiEnabled={false}
          UIOptions={{
            dockedSidebarBreakpoint: 880,
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveAsImage: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
            tools: {
              image: false,
            },
            welcomeScreen: false,
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.Help />
          </MainMenu>
          <Footer>
            <div className="pointer-events-none select-none bg-background/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
              Public read-only preview
            </div>
          </Footer>
        </Excalidraw>
      </section>
    </main>
  );
}
