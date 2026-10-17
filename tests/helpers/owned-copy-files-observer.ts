import type { Page } from '@playwright/test';

/** Passive protocol observation only: never opens a socket, sends a frame or refreshes UI. */
export function observeOwnedCopyFiles(page: Page, workspaceId: string, relativePath: string) {
  let subscriptions = 0, opened = 0, heartbeats = 0, navigations = 0, treeRequests = 0;
  const events: { type: string; workspaceId: string; relativePath: string }[] = [], errors: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/files/tree' && request.method() === 'GET'
      && request.headers()['x-canvas-workspace-id'] === workspaceId) treeRequests++;
  });
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws/live-events') return;
    const ids = new Set<string>();
    const decode = (payload: string | Buffer): Record<string, unknown> | null => {
      if (Buffer.byteLength(payload) > 2 * 1024 * 1024) { errors.push('oversized-frame'); return null; }
      try { const value: unknown = JSON.parse(payload.toString()); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
      catch { errors.push('invalid-json'); return null; }
    };
    socket.on('framesent', ({ payload }) => {
      const value = decode(payload);
      if (value?.type === 'subscribe' && value.channel === 'files' && value.workspaceId === workspaceId && typeof value.id === 'string') {
        ids.add(value.id); subscriptions++;
      }
    });
    socket.on('framereceived', ({ payload }) => {
      const value = decode(payload); if (!value || typeof value.id !== 'string' || !ids.has(value.id)) return;
      if (value.type === 'open') opened++;
      if (value.type === 'error') errors.push('files-stream-error');
      if (value.type !== 'event' || !value.event || typeof value.event !== 'object') return;
      const event = value.event as { event?: string; data?: string };
      if (event.event === 'heartbeat') heartbeats++;
      if (event.event !== 'filechange' || typeof event.data !== 'string') return;
      const file = decode(event.data);
      if (file?.workspaceId === workspaceId && file.relativePath === relativePath && typeof file.type === 'string') {
        if (events.length >= 64) { errors.push('too-many-target-events'); return; }
        events.push({ type: file.type, workspaceId, relativePath });
      }
    });
  });
  return { snapshot: () => ({ subscriptions, opened, heartbeats, navigations, treeRequests,
    adds: events.filter(event => event.type === 'add').length, events: structuredClone(events), errors: [...errors] }) };
}
