export const WORKSPACE_MARKDOWN_LOCATION_EVENT = 'canvas:workspace-markdown-location';

export type WorkspaceMarkdownLocation = {
  blockId: string | null;
  heading: string | null;
  path: string;
  requestId: string;
  requestedAt: number;
};

const pendingLocations = new Map<string, WorkspaceMarkdownLocation>();
const LOCATION_MAX_AGE_MS = 15_000;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

export function requestWorkspaceMarkdownLocation(
  request: Pick<WorkspaceMarkdownLocation, 'blockId' | 'heading' | 'path'>,
): WorkspaceMarkdownLocation {
  const location: WorkspaceMarkdownLocation = {
    ...request,
    path: normalizePath(request.path),
    requestId: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    requestedAt: Date.now(),
  };
  pendingLocations.set(location.path, location);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WORKSPACE_MARKDOWN_LOCATION_EVENT, { detail: location }));
  }
  return location;
}

export function consumeWorkspaceMarkdownLocation(path: string): WorkspaceMarkdownLocation | null {
  const normalizedPath = normalizePath(path);
  const location = pendingLocations.get(normalizedPath);
  if (!location) return null;
  pendingLocations.delete(normalizedPath);
  return Date.now() - location.requestedAt <= LOCATION_MAX_AGE_MS ? location : null;
}

export function getWorkspaceMarkdownLocationFromEvent(event: Event): WorkspaceMarkdownLocation | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<WorkspaceMarkdownLocation> | null;
  if (!detail || typeof detail.path !== 'string' || typeof detail.requestId !== 'string') return null;
  return {
    blockId: typeof detail.blockId === 'string' ? detail.blockId : null,
    heading: typeof detail.heading === 'string' ? detail.heading : null,
    path: normalizePath(detail.path),
    requestId: detail.requestId,
    requestedAt: typeof detail.requestedAt === 'number' ? detail.requestedAt : Date.now(),
  };
}
