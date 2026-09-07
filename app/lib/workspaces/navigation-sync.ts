export type WorkspaceNavigationSyncAction = 'ignore' | 'accept' | 'switch' | 'clear';

export function getWorkspaceNavigationSyncAction(input: {
  requestedWorkspaceId: string | null;
  activeWorkspaceId: string | null;
  requestKey: string | null;
  handledRequestKey: string | null;
}): WorkspaceNavigationSyncAction {
  if (!input.requestedWorkspaceId || !input.requestKey) return 'ignore';
  if (input.requestedWorkspaceId === input.activeWorkspaceId) return 'accept';
  if (input.requestKey === input.handledRequestKey) return 'clear';
  return 'switch';
}

export function clearWorkspaceScopedNavigationParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('workspaceId');
  params.delete('session');
  params.delete('path');
  return params.toString();
}

export function workspaceScopedNavigationMatches(
  requestedWorkspaceId: string | null,
  activeWorkspaceId: string | null,
) {
  return !requestedWorkspaceId || requestedWorkspaceId === activeWorkspaceId;
}
