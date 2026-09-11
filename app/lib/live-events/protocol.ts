export const LIVE_EVENTS_PATH = '/ws/live-events';
export const LIVE_EVENTS_PROTOCOL = 'canvas-live-events-v1';
export const LIVE_EVENT_ROUTES = {
  files: '/api/files/watch',
  presence: '/api/files/presence',
  terminal: '/api/terminal/availability',
} as const;
export type LiveEventChannel = keyof typeof LIVE_EVENT_ROUTES;
export type LiveEventSubscription = { id: string; channel: LiveEventChannel; workspaceId?: string; lastEventId?: string };
export type LiveEventFrame = { event?: string; data?: string; id?: string; retry?: number };
export type LiveEventServerMessage =
  | { type: 'open'; id: string }
  | { type: 'event'; id: string; event: LiveEventFrame }
  | { type: 'error'; id: string; status: number }
  | { type: 'end'; id: string }
  | { type: 'refresh'; id: string };

export function isLiveEventSubscription(value: unknown): value is LiveEventSubscription & { type: 'subscribe' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => ['type', 'id', 'channel', 'workspaceId', 'lastEventId'].includes(key))
    && input.type === 'subscribe' && typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(input.id)
    && typeof input.channel === 'string' && Object.hasOwn(LIVE_EVENT_ROUTES, input.channel)
    && (input.workspaceId === undefined || (typeof input.workspaceId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input.workspaceId)))
    && (input.channel === 'terminal' ? input.workspaceId === undefined : input.channel === 'files' || typeof input.workspaceId === 'string')
    && (input.lastEventId === undefined || (typeof input.lastEventId === 'string' && input.lastEventId.length <= 1024
      && !/[\r\n\0]/.test(input.lastEventId)));
}
