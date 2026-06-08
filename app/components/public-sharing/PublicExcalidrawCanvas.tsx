'use client';

import { Excalidraw, Footer, MainMenu } from '@excalidraw/excalidraw';
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';

interface PublicExcalidrawCanvasProps {
  fileName: string;
  initialData: ExcalidrawInitialDataState | null;
}

export function PublicExcalidrawCanvas({ fileName, initialData }: PublicExcalidrawCanvasProps) {
  return (
    <Excalidraw
      initialData={initialData}
      name={fileName}
      isCollaborating={false}
      aiEnabled={false}
      UIOptions={{
        dockedSidebarBreakpoint: 880,
        canvasActions: {
          changeViewBackgroundColor: true,
          clearCanvas: true,
          export: {
            saveFileToDisk: true,
          },
          loadScene: false,
          saveAsImage: true,
          saveToActiveFile: false,
          toggleTheme: false,
        },
        tools: {
          image: true,
        },
        welcomeScreen: false,
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
      <Footer>
        <div className="pointer-events-none select-none bg-background/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          Changes stay in this browser until you export or save to disk.
        </div>
      </Footer>
    </Excalidraw>
  );
}
