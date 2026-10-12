export type PackageWorkspaceQuery = Record<string, string | number | boolean | null | undefined>;

export class PackageWorkspaceRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = 'The package request could not be completed.') {
    super(message);
    this.name = 'PackageWorkspaceRequestError';
  }
}

/** Selection/context transport only; the API supplies current authority. */
export function packageWorkspacePath(path: string, workspaceId: string | null, query: PackageWorkspaceQuery = {}): string {
  if (!path.startsWith('/api/') || /[\\\u0000-\u001f\u007f]/u.test(path)) {
    throw new PackageWorkspaceRequestError(400, 'PACKAGE_REQUEST_INVALID');
  }
  const url = new URL(path, 'http://canvas.invalid');
  if (url.origin !== 'http://canvas.invalid' || !url.pathname.startsWith('/api/')) throw new PackageWorkspaceRequestError(400, 'PACKAGE_REQUEST_INVALID');
  for (const [key, value] of Object.entries(query)) {
    if (key === 'workspaceId') continue;
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.delete('workspaceId');
  if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
  return `${url.pathname}${url.searchParams.size ? `?${url.searchParams}` : ''}`;
}

/** Shared envelope handling; callers retain their own abort/generation and render identity fences. */
export async function workspaceRequest<T>(path: string, workspaceId: string | null, init: RequestInit = {}, query: PackageWorkspaceQuery = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.delete('x-canvas-workspace-id');
  if (workspaceId) headers.set('x-canvas-workspace-id', workspaceId);
  let response: Response;
  try { response = await fetch(packageWorkspacePath(path, workspaceId, query), { ...init, headers, cache: 'no-store', credentials: 'same-origin' }); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof PackageWorkspaceRequestError) throw error;
    throw new PackageWorkspaceRequestError(0, 'PACKAGE_WORKSPACE_UNAVAILABLE');
  }
  let payload: { success?: boolean; data?: T; code?: unknown; error?: unknown };
  try { payload = await response.json(); }
  catch { throw new PackageWorkspaceRequestError(response.status || 502, 'PACKAGE_WORKSPACE_RESPONSE_INVALID'); }
  if (!response.ok || payload?.success !== true || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    const code = typeof payload?.code === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/u.test(payload.code) ? payload.code : 'PACKAGE_WORKSPACE_UNAVAILABLE';
    // APIs return public static errors; do not render arbitrary response bodies or exception details.
    throw new PackageWorkspaceRequestError(response.ok ? 502 : response.status, code);
  }
  return payload.data as T;
}
