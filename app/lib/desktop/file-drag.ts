'use client';

export type DesktopFileDragRequest = {
  workspaceId: string;
  paths: string[];
};

type CanvasDesktopFileDragBridge = {
  prepareFileDrag: (request: DesktopFileDragRequest) => Promise<void>;
  startFileDrag: (request: DesktopFileDragRequest) => void;
};

function isCanvasDesktopFileDragBridge(value: unknown): value is CanvasDesktopFileDragBridge {
  return Boolean(
    value
    && typeof value === 'object'
    && 'prepareFileDrag' in value
    && typeof value.prepareFileDrag === 'function'
    && 'startFileDrag' in value
    && typeof value.startFileDrag === 'function',
  );
}

export function getCanvasDesktopFileDragBridge(): CanvasDesktopFileDragBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as typeof window & { canvasDesktop?: unknown }).canvasDesktop;
  return isCanvasDesktopFileDragBridge(candidate) ? candidate : null;
}
