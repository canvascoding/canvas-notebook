/**
 * WebSocket Client for Chat Sessions
 * 
 * - Auto-Reconnect mit Exponential Backoff
 * - Session Subscription
 * - Event Emitter Pattern
 * - Logging in Browser Console
 */

import type { ChatRequestContext } from '@/app/lib/chat/types';

export class WebSocketClient extends EventTarget {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseUrl: string;
  private subscribedSessions = new Set<string>();
  private isManualDisconnect = false;
  private messageQueue: Array<Record<string, unknown>> = [];
  private isConnecting = false;
  private refCount = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DISCONNECT_GRACE_MS = 3000;

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
    this.refCount++;
    this.cancelDisconnectTimer();

    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.isConnecting) {
      return new Promise((resolve) => {
        const checkConnected = () => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            resolve();
          } else {
            setTimeout(checkConnected, 100);
          }
        };
        checkConnected();
      });
    }
    
    this.isConnecting = true;
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.baseUrl);

        this.ws.onopen = () => {
          console.log('[WebSocket] Connected');
          this.reconnectAttempts = 0;
          this.isConnecting = false;
          this.dispatchEvent(new CustomEvent('connected'));

          // Re-subscribe to sessions
          for (const sessionId of this.subscribedSessions) {
            this.send({ type: 'subscribe_session', sessionId });
          }
          
          // Flush any queued messages
          this.flushMessageQueue();

          resolve();
        };

        this.ws.onclose = (event) => {
          console.log(`[WebSocket] Disconnected: code=${event.code} reason=${event.reason || '(empty)'} wasClean=${event.wasClean}`);
          this.dispatchEvent(new CustomEvent('disconnected', { detail: { code: event.code, reason: event.reason, wasClean: event.wasClean } }));

          if (!this.isManualDisconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          const readyState = this.ws?.readyState;
          const stateLabel = readyState === WebSocket.CONNECTING ? 'CONNECTING'
            : readyState === WebSocket.OPEN ? 'OPEN'
            : readyState === WebSocket.CLOSING ? 'CLOSING'
            : readyState === WebSocket.CLOSED ? 'CLOSED'
            : `UNKNOWN(${readyState})`;
          console.error(`[WebSocket] Error (readyState=${stateLabel}):`, error);
          this.isConnecting = false;
          this.dispatchEvent(new CustomEvent('error', { detail: { error: 'Connection error', readyState } }));
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
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.isManualDisconnect = true;
    this.refCount = 0;
    this.cancelDisconnectTimer();
    this.subscribedSessions.clear();

    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    
    console.log('[WebSocket] Disconnected manually');
  }

  releaseConnection(): void {
    if (this.refCount > 0) {
      this.refCount--;
    }

    console.log(`[WebSocket] releaseConnection: refCount=${this.refCount}`);

    if (this.refCount === 0 && !this.disconnectTimer) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.refCount === 0) {
          console.log('[WebSocket] No active consumers, disconnecting');
          this.disconnect();
        }
      }, WebSocketClient.DISCONNECT_GRACE_MS);
    }
  }

  private cancelDisconnectTimer(): void {
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  /**
   * Send message to server
   */
  send(message: Record<string, unknown>): void {
    // If connected, send immediately
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    
    // Queue message for later if not connected
    console.log('[WebSocket] Connection not ready, queuing message:', message.type);
    this.messageQueue.push(message);
    
    // Try to connect if not already connecting
    if (!this.isConnecting && !this.isManualDisconnect) {
      this.connect().catch(err => {
        console.error('[WebSocket] Failed to auto-connect:', err);
      });
    }
  }
  
  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;
    
    console.log('[WebSocket] Flushing', this.messageQueue.length, 'queued messages');
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      }
    }
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
   * Send message to a session with context
   */
  sendMessage(
    sessionId: string,
    message: Record<string, unknown>,
    context?: ChatRequestContext
  ): void {
    this.send({
      type: 'send_message',
      sessionId,
      message,
      context,
    });
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
        this.isManualDisconnect = true; // stop reconnect loop on auth errors
        this.dispatchEvent(new CustomEvent('error', { detail: { error: message.error as string, code: 'AUTH_ERROR' } }));
        break;

      case 'agent_event': {
        const agentEvent = {
          sessionId: message.sessionId as string,
          event: message.event as Record<string, unknown>,
        };
        this.dispatchEvent(new CustomEvent<{ sessionId: string; event: Record<string, unknown> }>('agent_event', {
          detail: agentEvent,
        }));
        // Also mirror to window for global listeners (WebSocketProvider, CanvasAgentChat)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('agent_event', { detail: agentEvent }));
        }
        break;
      }

      case 'runtime_status': {
        const runtimeStatus = {
          sessionId: message.sessionId as string,
          status: message.status as Record<string, unknown>,
        };
        this.dispatchEvent(new CustomEvent<{ sessionId: string; status: Record<string, unknown> }>('runtime_status', {
          detail: runtimeStatus,
        }));
        // Also mirror to window for global listeners
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('runtime_status', { detail: runtimeStatus }));
        }
        break;
      }

      case 'notification': {
        const notificationEvent = {
          sessionId: message.sessionId as string,
          sessionTitle: message.sessionTitle as string,
          notificationType: message.notificationType as string,
          messagePreview: message.messagePreview as string | undefined,
        };
        this.dispatchEvent(new CustomEvent<{ sessionId: string; sessionTitle: string; notificationType: string; messagePreview?: string }>('notification', {
          detail: notificationEvent,
        }));
        // Also mirror to window for global listeners
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('notification', { detail: notificationEvent }));
        }
        break;
      }

      case 'session_updated': {
        const sessionUpdate = {
          sessionId: message.sessionId as string,
          lastMessageAt: message.lastMessageAt as string,
          title: message.title as string | undefined,
        };
        this.dispatchEvent(new CustomEvent<{ sessionId: string; lastMessageAt: string; title?: string }>('session_updated', {
          detail: sessionUpdate,
        }));
        // Also mirror to window for global listeners
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('session_updated', { detail: sessionUpdate }));
        }
        break;
      }

      case 'error':
        console.error('[WebSocket] Server error:', message.error);
        this.dispatchEvent(new CustomEvent<{ error: string; code?: string }>('error', {
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
