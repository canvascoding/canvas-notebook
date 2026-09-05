import { workspaceHeaders } from './client';
import type { QuickAccessResult, QuickAccessView } from './quick-access';

export async function loadQuickAccessFiles(workspaceId: string, view: QuickAccessView, query: string, limit: number, signal: AbortSignal): Promise<QuickAccessResult> {
  const params = new URLSearchParams({ view, q: query, limit: String(limit) });
  const response = await fetch(`/api/files/quick-access?${params}`, {
    headers: workspaceHeaders(workspaceId), credentials: 'include', cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error('Failed to load quick access files');
  const payload = await response.json();
  if (!payload.success || !payload.data) throw new Error('Invalid quick access response');
  return payload.data;
}

export async function recordOpenedWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  try {
    await fetch('/api/files/quick-access', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) },
      credentials: 'include', body: JSON.stringify({ path }), keepalive: true,
    });
  } catch {
    // History is optional; a failed update must never prevent opening a document.
  }
}
