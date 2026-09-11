'use client';

import { LIVE_EVENTS_PATH, LIVE_EVENTS_PROTOCOL, LIVE_EVENT_ROUTES, type LiveEventChannel,
  type LiveEventServerMessage, type LiveEventSubscription } from './protocol';

export type LiveEventSourceLike = Pick<LiveEventSource, 'onopen' | 'onerror' | 'onmessage' | 'addEventListener' | 'removeEventListener' | 'close'>;
export type LiveEventSourceFactory = (url: string) => LiveEventSourceLike;

/** The three existing event consumers share one socket per browser page. */
export class LiveEventTransport {
  private socket: WebSocket | null = null;
  private sources = new Map<string, LiveEventSource>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  constructor(private readonly createSocket: () => WebSocket = () => {
    const url = new URL(LIVE_EVENTS_PATH, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(url, LIVE_EVENTS_PROTOCOL);
  }) {}

  add(source: LiveEventSource): void {
    if (this.sources.size >= 8) { source.failed(429); source.close(); return; }
    this.sources.set(source.subscription.id, source);
    if (this.socket?.readyState === 1) this.subscribe(source);
    else this.connect();
  }
  remove(source: LiveEventSource): void {
    if (this.sources.get(source.subscription.id) !== source) return;
    this.sources.delete(source.subscription.id);
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'unsubscribe', id: source.subscription.id }));
    if (this.sources.size === 0) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      const socket = this.socket; this.socket = null;
      socket?.close();
      this.attempts = 0;
    }
  }
  private subscribe(source: LiveEventSource): void {
    if (source.retryTimer) clearTimeout(source.retryTimer);
    source.retryTimer = null;
    this.socket?.send(JSON.stringify({ type: 'subscribe', ...source.subscription }));
  }
  private connect(): void {
    if (this.socket || this.retryTimer || !this.sources.size) return;
    let socket: WebSocket;
    try { socket = this.createSocket(); } catch { this.disconnected(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      for (const source of this.sources.values()) this.subscribe(source);
    };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return;
      let message: LiveEventServerMessage;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.id !== 'string') return;
      this.sources.get(message.id)?.receive(message);
    };
    socket.onerror = () => { /* onclose performs the single cleanup/retry. */ };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.disconnected();
    };
  }
  private disconnected(): void {
    for (const source of [...this.sources.values()]) source.failed(0);
    if (!this.sources.size || this.retryTimer) return;
    const delay = Math.min(30_000, Math.max(1000 * 2 ** Math.min(this.attempts++, 5),
      ...[...this.sources.values()].map(source => source.retryMs)));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }
  restart(source: LiveEventSource, status = 0, silent = false): void {
    if (this.sources.get(source.subscription.id) !== source) return;
    if (source.retryTimer) clearTimeout(source.retryTimer);
    source.retryTimer = null;
    if (!silent) source.failed(status);
    if (!this.sources.has(source.subscription.id)) return;
    source.retryTimer = setTimeout(() => {
      source.retryTimer = null;
      if (this.sources.get(source.subscription.id) === source && this.socket?.readyState === 1) this.subscribe(source);
    }, silent ? 0 : source.retryMs);
  }
}

let transport: LiveEventTransport | null = null;
function defaultTransport() { return transport ??= new LiveEventTransport(); }

/** EventSource's used surface, carried over the neutral authenticated WS bridge. */
export class LiveEventSource extends EventTarget {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event & { status?: number }) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly subscription: LiveEventSubscription;
  readyState = 0;
  retryMs = 1000;
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(url: string, private readonly owner = defaultTransport()) {
    super();
    const parsed = new URL(url, window.location.origin);
    const channel = (Object.keys(LIVE_EVENT_ROUTES) as LiveEventChannel[]).find(key => LIVE_EVENT_ROUTES[key] === parsed.pathname);
    if (!channel || parsed.origin !== window.location.origin) throw new Error('Unsupported live event source.');
    const workspaceId = parsed.searchParams.get('workspaceId') || undefined;
    this.subscription = { id: crypto.randomUUID(), channel, ...(channel !== 'terminal' ? { workspaceId } : {}) };
    queueMicrotask(() => { if (!this.closed) this.owner.add(this); });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.readyState = 2;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.owner.remove(this);
  }
  failed(status: number): void {
    if (this.closed) return;
    this.readyState = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const event = Object.assign(new Event('error'), { status });
    this.onerror?.(event); this.dispatchEvent(event);
  }
  receive(message: LiveEventServerMessage): void {
    if (this.closed) return;
    if (message.type === 'open') {
      this.readyState = 1;
      const event = new Event('open'); this.onopen?.(event); this.dispatchEvent(event);
    } else if (message.type === 'event' && message.event && typeof message.event === 'object') {
      const frame = message.event;
      if (typeof frame.id === 'string') this.subscription.lastEventId = frame.id;
      if (Number.isSafeInteger(frame.retry) && (frame.retry ?? -1) >= 0) this.retryMs = Math.min(30_000, Math.max(1000, frame.retry!));
      if (typeof frame.data !== 'string') return;
      const event = new MessageEvent(typeof frame.event === 'string' && frame.event ? frame.event : 'message',
        { data: frame.data, lastEventId: this.subscription.lastEventId ?? '' });
      if (event.type === 'message') this.onmessage?.(event);
      this.dispatchEvent(event);
    } else if (message.type === 'error') {
      if ([400, 401, 403, 404].includes(message.status)) { this.failed(message.status); this.close(); }
      else this.owner.restart(this, message.status);
    } else if (message.type === 'end') this.owner.restart(this);
    else if (message.type === 'refresh') this.owner.restart(this, 0, true);
  }
}
