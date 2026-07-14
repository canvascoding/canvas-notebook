'use client';

import { useWorkspaceStore } from '@/app/store/workspace-store';

export const STUDIO_WORKSPACE_HEADER = 'x-canvas-workspace-id';

export function getActiveStudioWorkspaceId(): string | null {
  return useWorkspaceStore.getState().activeWorkspaceId;
}

export function isStudioWorkspaceActive(workspaceId: string | null): boolean {
  return getActiveStudioWorkspaceId() === workspaceId;
}

export function studioApiUrl(url: string, workspaceId = getActiveStudioWorkspaceId()): string {
  if (!workspaceId || /^https?:\/\//i.test(url)) return url;
  const parsed = new URL(url, 'http://canvas.local');
  parsed.searchParams.set('workspaceId', workspaceId);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function studioApiFetch(
  input: string,
  init: RequestInit = {},
  workspaceId = getActiveStudioWorkspaceId(),
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (workspaceId) headers.set(STUDIO_WORKSPACE_HEADER, workspaceId);
  return fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? 'include',
  });
}
