/**
 * WebSocket Client for Chat Sessions
 * 
 * - Auto-Reconnect mit Exponential Backoff
 * - Session Subscription
 * - Event Emitter Pattern
 * - Logging in Browser Console
 * 
 * Connection flow:
 * 1. TCP/WebSocket handshake completes → onopen fires
 * 2. Client waits for server auth_success before considering the connection usable
 * 3. Only after auth_success does connect() resolve, the 'connected' event fire,
 *    and queued messages get flushed
 */

import type { ChatRequestContext } from '@/app/lib/chat/types';

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WebSocketClient extends EventTarget {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseUrl: string;
  private subscribedSessions = new Set<string>();
  private isManualDisconnect = false;
  private messageQueue: Array<Record<string, unknown>> = [];
  private isConnecting = false;
  private isAuthenticated = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private refCount = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
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
   * Connect to WebSocket server.
   * Resolves only after the server has confirmed authentication (auth_success).
   */
  connect(): Promise<void> {
    this.refCount++;
    this.cancelDisconnectTimer();

    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.isConnecting) {
      return new Promise((resolve, reject) => {
        const checkAuthenticated = () => {
          if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
            resolve();
          } else if (!this.isConnecting) {
            reject(new Error('Connection failed during wait'));
          } else {
            setTimeout(checkAuthenticated, 100);
          }
        };
        checkAuthenticated();
      });
    }
    
    this.isConnecting = true;
    this.isAuthenticated = false;
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        this.ws = new WebSocket(this.baseUrl);

        this.ws.onopen = () => {
          console.log('[WebSocket] TCP connection established, waiting for auth...');
          this.reconnectAttempts = 0;
        };

        this.ws.onclose = (event) => {
          console.log(`[WebSocket] Disconnected: code=${event.code} reason=${event.reason || '(empty)'} wasClean=${event.wasClean}`);
          const wasConnecting = this.isConnecting;
          this.isAuthenticated = false;
          this.isConnecting = false;
          this.rejectPendingRequests(new Error('WebSocket disconnected'));

          if (wasConnecting && this.connectReject) {
            this.connectReject(new Error(`WebSocket closed before auth: code=${event.code}`));
            this.connectResolve = null;
            this.connectReject = null;
          }

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
          this.isAuthenticated = false;

          this.dispatchEvent(new CustomEvent('error', { detail: { error: 'Connection error', readyState } }));

          if (this.connectReject) {
            this.connectReject(new Error('WebSocket connection error'));
            this.connectResolve = null;
            this.connectReject = null;
          }
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
        this.isAuthenticated = false;
        reject(error);
        this.connectResolve = null;
        this.connectReject = null;
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.isManualDisconnect = true;
    this.refCount = 0;
    this.isAuthenticated = false;
    this.isConnecting = false;
    this.cancelDisconnectTimer();
    this.subscribedSessions.clear();

    this.connectResolve = null;
    this.connectReject = null;

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
   * Send message to server.
   * Queues the message if not yet authenticated; flushed after auth_success.
   */
  send(message: Record<string, unknown>): void {
    if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    
    console.log('[WebSocket] Not authenticated yet, queuing message:', message.type);
    this.messageQueue.push(message);
    
    if (!this.isConnecting && !this.isManualDisconnect) {
      this.connect().catch(err => {
        console.error('[WebSocket] Failed to auto-connect:', err);
      });
    }
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = 10000,
  ): Promise<T> {
    const requestId = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('WebSocket request timeout'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.send({ type, requestId, ...payload });
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }
  
  private flushMessageQueue(): void {
    if (this.messageQueue.length === 0) return;
    
    console.log('[WebSocket] Flushing', this.messageQueue.length, 'queued messages after auth');
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
  subscribe(sessionId: string): Promise<Record<string, unknown>> {
    this.subscribedSessions.add(sessionId);
    console.log(`[WebSocket] Subscribed to session ${sessionId}`);
    return this.request('subscribe_session', { sessionId });
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

  private completeAuth(success: boolean, error?: string): void {
    this.isConnecting = false;

    if (success) {
      this.isAuthenticated = true;

      for (const sessionId of this.subscribedSessions) {
        this.ws?.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
      }

      this.flushMessageQueue();

      this.dispatchEvent(new CustomEvent('connected'));

      if (this.connectResolve) {
        this.connectResolve();
        this.connectResolve = null;
        this.connectReject = null;
      }
    } else {
      this.isAuthenticated = false;
      this.isManualDisconnect = true;
      this.rejectPendingRequests(new Error(error || 'WebSocket authentication failed'));

      this.dispatchEvent(new CustomEvent('error', { detail: { error: error || 'Authentication failed', code: 'AUTH_ERROR' } }));

      if (this.connectReject) {
        this.connectReject(new Error(error || 'WebSocket authentication failed'));
        this.connectResolve = null;
        this.connectReject = null;
      }

      this.ws?.close(4001, 'Unauthorized');
    }
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: Record<string, unknown>): void {
    const { type } = message;
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;

    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);

      if (message.success === false) {
        pending.reject(new Error(typeof message.error === 'string' ? message.error : 'WebSocket request failed'));
      } else {
        pending.resolve(message);
      }
      return;
    }

    switch (type) {
      case 'auth_success':
        console.log('[WebSocket] Authenticated as user:', message.userId);
        this.completeAuth(true);
        break;

      case 'auth_error':
        console.error('[WebSocket] Auth error:', message.error);
        this.completeAuth(false, typeof message.error === 'string' ? message.error : 'Authentication failed');
        break;

      case 'subscribe_result':
      case 'send_message_result':
      case 'control_result':
      case 'status_result':
        if (message.success === false) {
          console.error('[WebSocket] Request result error:', message.error);
          this.dispatchEvent(new CustomEvent<{ error: string; code?: string }>('error', {
            detail: { error: message.error as string, code: type as string },
          }));
        }
        break;

      case 'agent_event': {
        const agentEvent = {
          sessionId: message.sessionId as string,
          event: message.event as Record<string, unknown>,
        };
        this.dispatchEvent(new CustomEvent<{ sessionId: string; event: Record<string, unknown> }>('agent_event', {
          detail: agentEvent,
        }));
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
          lastMessageAt: message.lastMessageAt as string | undefined,
          timestamp: message.timestamp as number | undefined,
        };
        console.log('[WebSocket Client] Received notification:', notificationEvent.notificationType, 'session:', notificationEvent.sessionId, 'title:', notificationEvent.sessionTitle, 'preview:', notificationEvent.messagePreview?.slice(0, 60));
        this.dispatchEvent(new CustomEvent<{ sessionId: string; sessionTitle: string; notificationType: string; messagePreview?: string; lastMessageAt?: string; timestamp?: number }>('notification', {
          detail: notificationEvent,
        }));
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
        console.log('[WebSocket Client] Received session_updated:', 'session:', sessionUpdate.sessionId, 'lastMessageAt:', sessionUpdate.lastMessageAt, 'title:', sessionUpdate.title);
        this.dispatchEvent(new CustomEvent<{ sessionId: string; lastMessageAt: string; title?: string }>('session_updated', {
          detail: sessionUpdate,
        }));
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
        if (type !== 'subscribe_result' || !this.isAuthenticated) {
          console.warn('[WebSocket] Unknown message type:', type);
        }
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
   * Reset manual disconnect flag so the client can reconnect.
   * Called after a successful login to re-enable connection attempts.
   */
  resetForReconnect(): void {
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Check if connected AND authenticated
   */
  isConnected(): boolean {
    return this.isAuthenticated && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
