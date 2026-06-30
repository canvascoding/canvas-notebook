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
import { generateRandomId } from '@/app/lib/utils/random-id';

type PendingRequest = {
  type: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const QUIET_MESSAGE_TYPES = new Set(['agent_event', 'runtime_status']);
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const SUBSCRIBE_REQUEST_TIMEOUT_MS = 15000;
const REQUEST_CONNECT_TIMEOUT_MS = 15000;
const MAX_QUEUED_MESSAGES = 20;
const MAX_QUEUED_MESSAGE_BYTES = 512 * 1024;
const MAX_SINGLE_QUEUED_MESSAGE_BYTES = 4 * 1024 * 1024;

type QueuedMessage = {
  message: Record<string, unknown>;
  bytes: number;
};

function readyStateLabel(readyState: number | undefined): string {
  return readyState === WebSocket.CONNECTING ? 'CONNECTING'
    : readyState === WebSocket.OPEN ? 'OPEN'
    : readyState === WebSocket.CLOSING ? 'CLOSING'
    : readyState === WebSocket.CLOSED ? 'CLOSED'
    : `UNKNOWN(${readyState})`;
}

function safeWebSocketUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function summarizeMessageForLog(message: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    type: message.type,
  };

  if (typeof message.requestId === 'string') summary.requestId = message.requestId;
  if (typeof message.sessionId === 'string') summary.sessionId = message.sessionId;
  if (typeof message.action === 'string') summary.action = message.action;
  if (typeof message.success === 'boolean') summary.success = message.success;
  if (typeof message.error === 'string') summary.error = message.error;

  const event = message.event;
  if (event && typeof event === 'object' && 'type' in event) {
    summary.eventType = (event as { type?: unknown }).type;
  }

  return summary;
}

function estimateMessageBytes(message: Record<string, unknown>): number {
  try {
    const serialized = JSON.stringify(message);
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(serialized).byteLength;
    }
    return serialized.length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export class WebSocketClient extends EventTarget {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseUrl: string;
  private subscribedSessions = new Set<string>();
  private isManualDisconnect = false;
  private messageQueue: QueuedMessage[] = [];
  private queuedMessageBytes = 0;
  private isConnecting = false;
  private isAuthenticated = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private refCount = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private connectAttempt = 0;
  private activeConnectionId: string | null = null;
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
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;
    console.log('[WebSocket] connect() requested', {
      refCount: this.refCount,
      isConnecting: this.isConnecting,
      isAuthenticated: this.isAuthenticated,
      readyState: readyStateLabel(this.ws?.readyState),
      subscribedSessions: this.subscribedSessions.size,
      queuedMessages: this.messageQueue.length,
      queuedMessageBytes: this.queuedMessageBytes,
      pendingRequests: this.pendingRequests.size,
    });

    return this.openAuthenticatedConnection();
  }

  private openAuthenticatedConnection(): Promise<void> {
    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      console.log('[WebSocket] connect reused authenticated connection', {
        connectionId: this.activeConnectionId,
        readyState: readyStateLabel(this.ws.readyState),
      });
      return Promise.resolve();
    }

    if (this.isConnecting) {
      console.log('[WebSocket] connect waiting for in-flight connection', {
        connectionId: this.activeConnectionId,
        readyState: readyStateLabel(this.ws?.readyState),
      });
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
      this.connectAttempt += 1;
      const connectionId = `chat-ws-${this.connectAttempt}-${Date.now().toString(36)}`;
      this.activeConnectionId = connectionId;

      try {
        console.log('[WebSocket] connect_start', {
          connectionId,
          url: safeWebSocketUrl(this.baseUrl),
          reconnectAttempts: this.reconnectAttempts,
        });
        this.ws = new WebSocket(this.baseUrl);

        this.ws.onopen = () => {
          console.log('[WebSocket] socket_open waiting_for_auth', {
            connectionId,
            readyState: readyStateLabel(this.ws?.readyState),
          });
          this.reconnectAttempts = 0;
        };

        this.ws.onclose = (event) => {
          console.log('[WebSocket] socket_close', {
            connectionId,
            code: event.code,
            reason: event.reason || '(empty)',
            wasClean: event.wasClean,
            wasAuthenticated: this.isAuthenticated,
            wasConnecting: this.isConnecting,
            queuedMessages: this.messageQueue.length,
            queuedMessageBytes: this.queuedMessageBytes,
            pendingRequests: this.pendingRequests.size,
            subscribedSessions: this.subscribedSessions.size,
          });
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
          console.error('[WebSocket] socket_error', {
            connectionId,
            readyState: readyStateLabel(readyState),
            error,
          });
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
        console.error('[WebSocket] connect_throw', {
          connectionId,
          error,
        });
        this.isConnecting = false;
        this.isAuthenticated = false;
        reject(error);
        this.connectResolve = null;
        this.connectReject = null;
      }
    });
  }

  private waitForAuthenticatedConnection(type: string, timeoutMs: number): Promise<void> {
    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    this.cancelDisconnectTimer();
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;

    const connectTimeoutMs = Math.min(Math.max(timeoutMs, 5000), REQUEST_CONNECT_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | null = null;

    console.log('[WebSocket] request_connect_start', {
      connectionId: this.activeConnectionId,
      type,
      connectTimeoutMs,
      readyState: readyStateLabel(this.ws?.readyState),
      isConnecting: this.isConnecting,
      isAuthenticated: this.isAuthenticated,
    });

    return Promise.race([
      this.openAuthenticatedConnection(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          console.warn('[WebSocket] request_connect_timeout', {
            connectionId: this.activeConnectionId,
            type,
            connectTimeoutMs,
            readyState: readyStateLabel(this.ws?.readyState),
            isConnecting: this.isConnecting,
            isAuthenticated: this.isAuthenticated,
          });
          reject(new Error('WebSocket connection timeout before request'));
        }, connectTimeoutMs);
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
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
    this.clearMessageQueue();

    if (this.ws) {
      console.log('[WebSocket] disconnect() closing socket', {
        connectionId: this.activeConnectionId,
        readyState: readyStateLabel(this.ws.readyState),
        pendingRequests: this.pendingRequests.size,
        queuedMessages: this.messageQueue.length,
        queuedMessageBytes: this.queuedMessageBytes,
      });
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
   * Returns false when the queue guard rejects the message.
   */
  send(message: Record<string, unknown>): boolean {
    if (this.isAuthenticated && this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (!QUIET_MESSAGE_TYPES.has(String(message.type))) {
        console.log('[WebSocket] send', {
          connectionId: this.activeConnectionId,
          ...summarizeMessageForLog(message),
        });
      }
      this.ws.send(JSON.stringify(message));
      return true;
    }

    const messageBytes = estimateMessageBytes(message);
    if (
      messageBytes > MAX_SINGLE_QUEUED_MESSAGE_BYTES ||
      this.messageQueue.length >= MAX_QUEUED_MESSAGES ||
      this.queuedMessageBytes + messageBytes > MAX_QUEUED_MESSAGE_BYTES
    ) {
      console.warn('[WebSocket] send rejected queue_limit', {
        connectionId: this.activeConnectionId,
        readyState: readyStateLabel(this.ws?.readyState),
        messageBytes,
        queuedMessages: this.messageQueue.length,
        queuedMessageBytes: this.queuedMessageBytes,
        maxQueuedMessages: MAX_QUEUED_MESSAGES,
        maxQueuedBytes: MAX_QUEUED_MESSAGE_BYTES,
        maxSingleMessageBytes: MAX_SINGLE_QUEUED_MESSAGE_BYTES,
        ...summarizeMessageForLog(message),
      });
      this.dispatchEvent(new CustomEvent<{ error: string; code?: string }>('error', {
        detail: { error: 'WebSocket send queue limit exceeded', code: 'QUEUE_LIMIT_EXCEEDED' },
      }));
      return false;
    }
    
    console.log('[WebSocket] send queued before auth', {
      connectionId: this.activeConnectionId,
      readyState: readyStateLabel(this.ws?.readyState),
      isConnecting: this.isConnecting,
      isManualDisconnect: this.isManualDisconnect,
      messageBytes,
      queuedMessageBytes: this.queuedMessageBytes + messageBytes,
      ...summarizeMessageForLog(message),
    });
    this.messageQueue.push({ message, bytes: messageBytes });
    this.queuedMessageBytes += messageBytes;
    
    if (!this.isConnecting && !this.isManualDisconnect) {
      this.openAuthenticatedConnection().catch(err => {
        console.error('[WebSocket] Failed to auto-connect:', err);
      });
    }

    return true;
  }

  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.waitForAuthenticatedConnection(type, timeoutMs);

    const requestId = generateRandomId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.warn('[WebSocket] request_timeout', {
          connectionId: this.activeConnectionId,
          requestId,
          type,
          timeoutMs,
          readyState: readyStateLabel(this.ws?.readyState),
          isAuthenticated: this.isAuthenticated,
        });
        reject(new Error('WebSocket request timeout'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        type,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      console.log('[WebSocket] request_start', {
        connectionId: this.activeConnectionId,
        requestId,
        type,
        timeoutMs,
        ...summarizeMessageForLog(payload),
      });
      if (!this.send({ type, requestId, ...payload })) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new Error('WebSocket send queue limit exceeded'));
      }
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
    
    console.log('[WebSocket] flush_queue_after_auth', {
      connectionId: this.activeConnectionId,
      queuedMessages: this.messageQueue.length,
      queuedMessageBytes: this.queuedMessageBytes,
    });
    while (this.messageQueue.length > 0) {
      const queued = this.messageQueue.shift();
      if (queued) {
        this.queuedMessageBytes = Math.max(0, this.queuedMessageBytes - queued.bytes);
      }
      if (queued?.message && this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.log('[WebSocket] send_queued', {
          connectionId: this.activeConnectionId,
          ...summarizeMessageForLog(queued.message),
        });
        this.ws.send(JSON.stringify(queued.message));
      }
    }
    this.queuedMessageBytes = 0;
  }

  private clearMessageQueue(): void {
    this.messageQueue = [];
    this.queuedMessageBytes = 0;
  }

  /**
   * Subscribe to a session
   */
  subscribe(sessionId: string): Promise<Record<string, unknown>> {
    this.subscribedSessions.add(sessionId);
    console.log('[WebSocket] subscribe requested', {
      connectionId: this.activeConnectionId,
      sessionId,
      subscribedSessions: this.subscribedSessions.size,
    });
    return this.request('subscribe_session', { sessionId }, SUBSCRIBE_REQUEST_TIMEOUT_MS);
  }

  /**
   * Unsubscribe from a session
   */
  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    this.send({ type: 'unsubscribe_session', sessionId });
    console.log('[WebSocket] unsubscribe requested', {
      connectionId: this.activeConnectionId,
      sessionId,
      subscribedSessions: this.subscribedSessions.size,
    });
  }

  /**
   * Send message to a session with context
   */
  sendMessage(
    sessionId: string,
    message: Record<string, unknown>,
    context?: ChatRequestContext
  ): void {
    console.log('[WebSocket] sendMessage requested', {
      connectionId: this.activeConnectionId,
      sessionId,
      hasContext: Boolean(context),
      contextPage: context?.currentPage,
      messageRole: typeof message.role === 'string' ? message.role : undefined,
      contentKind: Array.isArray(message.content) ? 'parts' : typeof message.content,
    });
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
      console.log('[WebSocket] auth_success', {
        connectionId: this.activeConnectionId,
        queuedMessages: this.messageQueue.length,
        resubscribeSessions: this.subscribedSessions.size,
      });

      for (const sessionId of this.subscribedSessions) {
        console.log('[WebSocket] resubscribe_after_auth', {
          connectionId: this.activeConnectionId,
          sessionId,
        });
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
      console.error('[WebSocket] auth_failed', {
        connectionId: this.activeConnectionId,
        error: error || 'Authentication failed',
      });
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
      console.log('[WebSocket] request_result', {
        connectionId: this.activeConnectionId,
        requestId,
        requestType: pending.type,
        ...summarizeMessageForLog(message),
      });

      if (message.success === false) {
        pending.reject(new Error(typeof message.error === 'string' ? message.error : 'WebSocket request failed'));
      } else {
        pending.resolve(message);
      }
      return;
    }

    switch (type) {
      case 'auth_success':
        console.log('[WebSocket] auth_success received', {
          connectionId: this.activeConnectionId,
          userId: message.userId,
        });
        this.completeAuth(true);
        break;

      case 'auth_error':
        console.error('[WebSocket] auth_error received', {
          connectionId: this.activeConnectionId,
          error: message.error,
        });
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
        console.error('[WebSocket] server_error received', {
          connectionId: this.activeConnectionId,
          ...summarizeMessageForLog(message),
        });
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

    console.log('[WebSocket] reconnect_scheduled', {
      connectionId: this.activeConnectionId,
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delay,
      subscribedSessions: this.subscribedSessions.size,
      queuedMessages: this.messageQueue.length,
    });

    setTimeout(() => {
      console.log('[WebSocket] reconnect_starting', {
        previousConnectionId: this.activeConnectionId,
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
      });
      this.isManualDisconnect = false;
      this.openAuthenticatedConnection().catch(console.error);
    }, delay);
  }

  /**
   * Reset manual disconnect flag so the client can reconnect.
   * Called after a successful login to re-enable connection attempts.
   */
  resetForReconnect(): void {
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;
    console.log('[WebSocket] resetForReconnect');
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
