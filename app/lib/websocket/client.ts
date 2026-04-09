/**
 * WebSocket Client for Chat Sessions
 *
 * - Auth-aware connection lifecycle
 * - Auto-reconnect with exponential backoff for transient failures
 * - Session subscription tracking
 * - EventTarget interface for React consumers
 */

type WebSocketErrorDetail = {
  error: string;
  code?: string;
};

type WebSocketConnectionState = 'idle' | 'connecting' | 'connected' | 'unauthorized';

type WebSocketMessage = Record<string, unknown> & {
  type?: string;
};

function createWebSocketError(message: string, code?: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

export class WebSocketClient extends EventTarget {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectPromiseHandlers: {
    resolve: () => void;
    reject: (error: Error & { code?: string }) => void;
  } | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseUrl: string;
  private readonly subscribedSessions = new Set<string>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect = false;
  private connectionState: WebSocketConnectionState = 'idle';
  private lastError: WebSocketErrorDetail | null = null;

  constructor(baseUrl?: string) {
    super();
    this.baseUrl = baseUrl || this.getDefaultWebSocketUrl();
  }

  private getDefaultWebSocketUrl(): string {
    if (typeof window === 'undefined') {
      return 'ws://localhost:3000/ws/chat';
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    return `${protocol}//${host}/ws/chat`;
  }

  connect(options: { force?: boolean } = {}): Promise<void> {
    const { force = false } = options;

    if (this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (!force && this.connectionState === 'unauthorized') {
      return Promise.reject(createWebSocketError(this.lastError?.error || 'Authentication failed', 'AUTH_ERROR'));
    }

    if (this.connectionState === 'connecting' && this.connectPromise) {
      return this.connectPromise;
    }

    this.clearReconnectTimeout();
    this.stopPing();
    this.isManualDisconnect = false;
    this.connectionState = 'connecting';
    this.lastError = null;

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectPromiseHandlers = { resolve, reject };
    });

    try {
      const ws = new WebSocket(this.baseUrl);
      this.ws = ws;

      ws.onopen = () => {
        console.log('[WebSocket] Connected, awaiting authentication');
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) {
          return;
        }

        this.stopPing();
        this.ws = null;

        if (this.connectionState !== 'unauthorized') {
          this.connectionState = 'idle';
        }

        this.dispatchEvent(new CustomEvent('disconnected', {
          detail: { reason: event.reason, code: event.code },
        }));

        if (this.connectionState === 'unauthorized') {
          console.warn('[WebSocket] Authentication rejected, staying disconnected');
          this.rejectPendingConnect(createWebSocketError(this.lastError?.error || 'Authentication failed', 'AUTH_ERROR'));
          return;
        }

        console.log('[WebSocket] Disconnected:', event.code, event.reason);
        this.rejectPendingConnect(createWebSocketError(event.reason || 'Connection closed', event.code === 4001 ? 'AUTH_ERROR' : 'DISCONNECTED'));

        if (!this.isManualDisconnect) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) {
          return;
        }

        const detail = { error: 'Connection error', code: 'CONNECTION_ERROR' } as WebSocketErrorDetail;
        this.lastError = detail;
        if (this.connectionState !== 'unauthorized') {
          this.dispatchError(detail);
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('[WebSocket] Error parsing message:', error);
        }
      };
    } catch (error) {
      const connectionError = createWebSocketError(
        error instanceof Error ? error.message : 'Connection error',
        'CONNECTION_ERROR',
      );
      this.connectionState = 'idle';
      this.rejectPendingConnect(connectionError);
      this.dispatchError({ error: connectionError.message, code: connectionError.code });
      return Promise.reject(connectionError);
    }

    return this.connectPromise;
  }

  disconnect(): void {
    this.isManualDisconnect = true;
    this.subscribedSessions.clear();
    this.clearReconnectTimeout();
    this.stopPing();
    this.connectionState = 'idle';
    this.lastError = null;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.rejectPendingConnect(createWebSocketError('Disconnected manually', 'MANUAL_DISCONNECT'));
    console.log('[WebSocket] Disconnected manually');
  }

  resetUnauthorizedState(): void {
    if (this.connectionState === 'unauthorized') {
      this.connectionState = 'idle';
      this.lastError = null;
    }
  }

  send(message: Record<string, unknown>): boolean {
    const type = typeof message.type === 'string' ? message.type : 'unknown';
    const isInteractiveMessage = type === 'send_message';

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectionState !== 'connected') {
      if (isInteractiveMessage) {
        console.warn('[WebSocket] Cannot send message - socket not ready');
      }
      return false;
    }

    this.ws.send(JSON.stringify(message));
    return true;
  }

  subscribe(sessionId: string): boolean {
    this.subscribedSessions.add(sessionId);
    const sent = this.send({ type: 'subscribe_session', sessionId });

    if (sent) {
      console.log(`[WebSocket] Subscribed to session ${sessionId}`);
    }

    return sent;
  }

  unsubscribe(sessionId: string): boolean {
    this.subscribedSessions.delete(sessionId);
    const sent = this.send({ type: 'unsubscribe_session', sessionId });

    if (sent) {
      console.log(`[WebSocket] Unsubscribed from session ${sessionId}`);
    }

    return sent;
  }

  sendMessage(
    sessionId: string,
    message: Record<string, unknown>,
    context?: {
      activeFilePath?: string | null;
      userTimeZone?: string;
      currentTime?: string;
      workingDirectory?: string;
    }
  ): boolean {
    return this.send({
      type: 'send_message',
      sessionId,
      message,
      ...(context || {}),
    });
  }

  markAsRead(sessionId: string): boolean {
    return this.send({ type: 'mark_read', sessionId });
  }

  getStatus(sessionId: string): boolean {
    return this.send({ type: 'get_status', sessionId });
  }

  isConnected(): boolean {
    return this.connectionState === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  isUnauthorized(): boolean {
    return this.connectionState === 'unauthorized';
  }

  getLastError(): WebSocketErrorDetail | null {
    return this.lastError;
  }

  getReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  private handleMessage(message: WebSocketMessage): void {
    const { type } = message;

    switch (type) {
      case 'auth_success':
        this.connectionState = 'connected';
        this.reconnectAttempts = 0;
        this.lastError = null;
        console.log('[WebSocket] Authenticated as user:', message.userId);
        this.startPing();
        this.dispatchEvent(new CustomEvent('connected'));

        for (const sessionId of this.subscribedSessions) {
          this.send({ type: 'subscribe_session', sessionId });
        }

        this.resolvePendingConnect();
        break;

      case 'auth_error': {
        const detail = {
          error: String(message.error || 'Authentication failed'),
          code: 'AUTH_ERROR',
        } as WebSocketErrorDetail;
        this.connectionState = 'unauthorized';
        this.lastError = detail;
        console.warn('[WebSocket] Auth error:', detail.error);
        this.dispatchError(detail);
        this.rejectPendingConnect(createWebSocketError(detail.error, detail.code));
        break;
      }

      case 'agent_event':
        this.dispatchCustomEvent('agent_event', {
          sessionId: message.sessionId as string,
          event: message.event as Record<string, unknown>,
        }, true);
        break;

      case 'runtime_status':
        this.dispatchCustomEvent('runtime_status', {
          sessionId: message.sessionId as string,
          status: message.status as Record<string, unknown>,
        }, true);
        break;

      case 'notification':
        this.dispatchCustomEvent('notification', {
          sessionId: message.sessionId as string,
          sessionTitle: message.sessionTitle as string,
          notificationType: message.notificationType as string,
          messagePreview: message.messagePreview as string | undefined,
        }, true);
        break;

      case 'session_updated':
        this.dispatchCustomEvent('session_updated', {
          sessionId: message.sessionId as string,
          lastMessageAt: message.lastMessageAt as string,
        }, true);
        break;

      case 'session_read':
        this.dispatchCustomEvent('session_read', {
          sessionId: message.sessionId as string,
        }, true);
        break;

      case 'pong':
        break;

      case 'error': {
        const detail = {
          error: String(message.error || 'Unknown WebSocket error'),
          code: message.code as string | undefined,
        };
        console.error('[WebSocket] Server error:', detail.error);
        this.dispatchError(detail);
        break;
      }

      default:
        console.warn('[WebSocket] Unknown message type:', type);
    }
  }

  private dispatchError(detail: WebSocketErrorDetail): void {
    this.lastError = detail;
    this.dispatchEvent(new CustomEvent<WebSocketErrorDetail>('error', { detail }));
  }

  private dispatchCustomEvent<T>(name: string, detail: T, mirrorToWindow = false): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail }));

    if (mirrorToWindow && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  private scheduleReconnect(): void {
    if (this.connectionState === 'unauthorized') {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const detail = {
        error: `Failed to reconnect after ${this.maxReconnectAttempts} attempts`,
        code: 'MAX_RECONNECT_ATTEMPTS',
      };
      console.error(`[WebSocket] ${detail.error}`);
      this.dispatchError(detail);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts += 1;

    console.log(`[WebSocket] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.clearReconnectTimeout();
    this.reconnectTimeout = setTimeout(() => {
      console.log(`[WebSocket] Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      this.resetUnauthorizedState();
      this.connect().catch((error) => {
        if ((error as { code?: string })?.code !== 'AUTH_ERROR') {
          console.error('[WebSocket] Reconnect failed:', error);
        }
      });
    }, delay);
  }

  private startPing(): void {
    this.stopPing();

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.connectionState === 'connected') {
        this.send({ type: 'ping', timestamp: Date.now() });
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private resolvePendingConnect(): void {
    this.connectPromiseHandlers?.resolve();
    this.connectPromiseHandlers = null;
    this.connectPromise = null;
  }

  private rejectPendingConnect(error: Error & { code?: string }): void {
    if (!this.connectPromiseHandlers) {
      return;
    }

    this.connectPromiseHandlers.reject(error);
    this.connectPromiseHandlers = null;
    this.connectPromise = null;
  }
}

let globalWebSocketClient: WebSocketClient | null = null;

export function getWebSocketClient(): WebSocketClient {
  if (!globalWebSocketClient) {
    globalWebSocketClient = new WebSocketClient();
  }
  return globalWebSocketClient;
}

export function disconnectWebSocketClient(): void {
  if (globalWebSocketClient) {
    globalWebSocketClient.disconnect();
    globalWebSocketClient = null;
  }
}
