/**
 * WebSocket Client for Chat Sessions
 * 
 * - Auto-Reconnect mit Exponential Backoff
 * - Session Subscription
 * - Event Emitter Pattern
 * - Logging in Browser Console
 */

type WebSocketEventMap = {
  'agent_event': CustomEvent<{ sessionId: string; event: Record<string, unknown> }>;
  'runtime_status': CustomEvent<{ sessionId: string; status: Record<string, unknown> }>;
  'notification': CustomEvent<{ sessionId: string; sessionTitle: string; notificationType: string }>;
  'session_updated': CustomEvent<{ sessionId: string; lastMessageAt: string }>;
  'session_read': CustomEvent<{ sessionId: string }>;
  'connected': CustomEvent<undefined>;
  'disconnected': CustomEvent<{ reason?: string }>;
  'error': CustomEvent<{ error: string; code?: string }>;
};

export class WebSocketClient extends EventTarget {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseUrl: string;
  private subscribedSessions = new Set<string>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private isManualDisconnect = false;

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

  /**
   * Connect to WebSocket server
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.baseUrl);

        this.ws.onopen = () => {
          console.log('[WebSocket] Connected');
          this.reconnectAttempts = 0;
          this.startPing();
          this.dispatchEvent(new CustomEvent('connected'));

          // Re-subscribe to sessions
          for (const sessionId of this.subscribedSessions) {
            this.send({ type: 'subscribe_session', sessionId });
          }

          resolve();
        };

        this.ws.onclose = (event) => {
          console.log('[WebSocket] Disconnected:', event.code, event.reason);
          this.stopPing();
          this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: event.reason } }));

          if (!this.isManualDisconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error);
          this.dispatchEvent(new CustomEvent('error', { detail: { error: 'Connection error' } }));
          reject(error);
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('[WebSocket] Error parsing message:', error);
          }
        };
      } catch (error) {
        console.error('[WebSocket] Connection error:', error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.isManualDisconnect = true;
    this.subscribedSessions.clear();
    this.stopPing();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    console.log('[WebSocket] Disconnected manually');
  }

  /**
   * Send message to server
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WebSocket] Cannot send message - not connected');
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Subscribe to a session
   */
  subscribe(sessionId: string): void {
    this.subscribedSessions.add(sessionId);
    this.send({ type: 'subscribe_session', sessionId });
    console.log(`[WebSocket] Subscribed to session ${sessionId}`);
  }

  /**
   * Unsubscribe from a session
   */
  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    this.send({ type: 'unsubscribe_session', sessionId });
    console.log(`[WebSocket] Unsubscribed from session ${sessionId}`);
  }

  /**
   * Send message to a session
   */
  sendMessage(sessionId: string, message: Record<string, unknown>): void {
    this.send({
      type: 'send_message',
      sessionId,
      message,
    });
  }

  /**
   * Mark session as read
   */
  markAsRead(sessionId: string): void {
    this.send({ type: 'mark_read', sessionId });
  }

  /**
   * Get runtime status for a session
   */
  getStatus(sessionId: string): void {
    this.send({ type: 'get_status', sessionId });
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: Record<string, unknown>): void {
    const { type } = message;

    switch (type) {
      case 'auth_success':
        console.log('[WebSocket] Authenticated as user:', message.userId);
        break;

      case 'auth_error':
        console.error('[WebSocket] Auth error:', message.error);
        this.dispatchEvent(new CustomEvent('error', { detail: { error: message.error as string, code: 'AUTH_ERROR' } }));
        break;

      case 'agent_event':
        this.dispatchEvent(new CustomEvent('agent_event', {
          detail: {
            sessionId: message.sessionId as string,
            event: message.event as Record<string, unknown>,
          },
        }));
        break;

      case 'runtime_status':
        this.dispatchEvent(new CustomEvent('runtime_status', {
          detail: {
            sessionId: message.sessionId as string,
            status: message.status as Record<string, unknown>,
          },
        }));
        break;

      case 'notification':
        this.dispatchEvent(new CustomEvent('notification', {
          detail: {
            sessionId: message.sessionId as string,
            sessionTitle: message.sessionTitle as string,
            notificationType: message.notificationType as string,
          },
        }));
        break;

      case 'session_updated':
        this.dispatchEvent(new CustomEvent('session_updated', {
          detail: {
            sessionId: message.sessionId as string,
            lastMessageAt: message.lastMessageAt as string,
          },
        }));
        break;

      case 'session_read':
        this.dispatchEvent(new CustomEvent('session_read', {
          detail: {
            sessionId: message.sessionId as string,
          },
        }));
        break;

      case 'pong':
        // Heartbeat response - ignore
        break;

      case 'error':
        console.error('[WebSocket] Server error:', message.error);
        this.dispatchEvent(new CustomEvent('error', {
          detail: { error: message.error as string, code: message.code as string },
        }));
        break;

      default:
        console.warn('[WebSocket] Unknown message type:', type);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[WebSocket] Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
      this.dispatchEvent(new CustomEvent('error', {
        detail: { error: `Failed to reconnect after ${this.maxReconnectAttempts} attempts`, code: 'MAX_RECONNECT_ATTEMPTS' },
      }));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[WebSocket] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    setTimeout(() => {
      console.log(`[WebSocket] Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      this.isManualDisconnect = false;
      this.connect().catch(console.error);
    }, delay);
  }

  /**
   * Start heartbeat (ping/pong)
   */
  private startPing(): void {
    this.stopPing();
    
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', timestamp: Date.now() });
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection state
   */
  getReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}

// Singleton instance for app-wide use
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
