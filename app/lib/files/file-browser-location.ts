import { normalizeWorkspacePathParam } from './path-utils';

/** The full-screen preview is a workspace-scoped location, including on reload. */
export function buildFileBrowserLocationHref(input: {
  search: string;
  workspaceId: string | null;
  path: string | null;
}): string | null {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) return null;
  const params = new URLSearchParams(input.search);
  const requestedWorkspaceId = params.get('workspaceId')?.trim();
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceId) return null;
  params.set('workspaceId', workspaceId);
  if (input.path === null) params.delete('path');
  else {
    const path = normalizeWorkspacePathParam(input.path);
    if (!path) return null;
    params.set('path', path);
  }
  return `/files?${params.toString()}`;
}
