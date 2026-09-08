'use client';

export type DesktopFileDragRequest = {
  workspaceId: string;
  paths: string[];
};

export type CanvasDesktopFileDragBridge = {
  prepareFileDrag: (request: DesktopFileDragRequest) => Promise<void>;
  startFileDrag: (request: DesktopFileDragRequest) => void;
};

type PreventableFileDragEvent = {
  preventDefault: () => void;
};

export function getCanvasDesktopFileDragPreparationKey(
  workspaceId: string,
  path: string,
): string {
  return `${workspaceId}\0${path}`;
}

export function isCanvasDesktopFileDragPrepared(
  preparedAtByKey: ReadonlyMap<string, number>,
  request: DesktopFileDragRequest,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  return request.paths.length > 0 && request.paths.every((path) => {
    const preparedAt = preparedAtByKey.get(
      getCanvasDesktopFileDragPreparationKey(request.workspaceId, path),
    );
    return preparedAt !== undefined && now - preparedAt < maxAgeMs;
  });
}

export function startCanvasDesktopFileDrag(
  event: PreventableFileDragEvent,
  bridge: CanvasDesktopFileDragBridge | null,
  request: DesktopFileDragRequest,
): boolean {
  if (!bridge) return false;
  event.preventDefault();
  bridge.startFileDrag(request);
  return true;
}

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
