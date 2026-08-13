/** Shared authenticated chat WebSocket client for the browser application. */

import type { ChatRequestContext } from '@/app/lib/chat/types';
import {
  CHAT_WEBSOCKET_CLOSE_CODES,
  CHAT_WEBSOCKET_PROTOCOL,
} from '@/app/lib/websocket/protocol';
import { generateRandomId } from '@/app/lib/utils/random-id';

type PendingRequest = {
  type: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SessionSubscription = {
  references: number;
  confirmed: boolean;
  promise: Promise<Record<string, unknown>> | null;
};

type ConnectDeferred = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export type WebSocketClientOptions = {
  createSocket?: (url: string, protocol: string) => WebSocket;
  random?: () => number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  disconnectGraceMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SUBSCRIBE_REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_CONNECT_TIMEOUT_MS = 15_000;
const DEBUG_WEBSOCKET = process.env.NEXT_PUBLIC_WS_DEBUG === '1';

function debugLog(event: string, detail?: Record<string, unknown>): void {
  if (DEBUG_WEBSOCKET) {
    console.debug(`[WebSocket] ${event}`, detail ?? {});
  }
}

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
  const summary: Record<string, unknown> = { type: message.type };
  if (typeof message.requestId === 'string') summary.requestId = message.requestId;
  if (typeof message.sessionId === 'string') summary.sessionId = message.sessionId;
  if (typeof message.action === 'string') summary.action = message.action;
  if (typeof message.success === 'boolean') summary.success = message.success;
  if (typeof message.code === 'string') summary.code = message.code;

  const event = message.event;
  if (event && typeof event === 'object' && 'type' in event) {
    summary.eventType = (event as { type?: unknown }).type;
  }
  return summary;
}

function errorWithCode(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function calculateReconnectDelay(
  attempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = 30_000,
  random = Math.random,
): number {
  const exponentialDelay = Math.min(baseDelayMs * (2 ** Math.max(0, attempt)), maxDelayMs);
  const jitterFactor = 0.8 + (random() * 0.4);
  return Math.min(Math.round(exponentialDelay * jitterFactor), maxDelayMs);
}

function isTerminalCloseCode(code: number): boolean {
  return code === 1000
    || code === CHAT_WEBSOCKET_CLOSE_CODES.unauthorized
    || code === CHAT_WEBSOCKET_CLOSE_CODES.licenseRequired;
}

export class WebSocketClient extends EventTarget {
  private ws: WebSocket | null = null;
  private readonly baseUrl: string;
  private readonly createSocket: (url: string, protocol: string) => WebSocket;
  private readonly random: () => number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly disconnectGraceMs: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, SessionSubscription>();
  private pendingRequests = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private connectDeferred: ConnectDeferred | null = null;
  private consumerCount = 0;
  private isManualDisconnect = true;
  private isConnecting = false;
  private isAuthenticated = false;
  private connectionGeneration = 0;
  private connectionSequence = 0;
  private activeConnectionId: string | null = null;

  constructor(baseUrl?: string, options: WebSocketClientOptions = {}) {
    super();
    this.baseUrl = baseUrl || this.getDefaultWebSocketUrl();
    this.createSocket = options.createSocket ?? ((url, protocol) => new WebSocket(url, protocol));
    this.random = options.random ?? Math.random;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 3_000;
  }

  private getDefaultWebSocketUrl(): string {
    if (typeof window === 'undefined') {
      return 'ws://localhost:3000/ws/chat';
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    return `${protocol}//${host}/ws/chat`;
  }

  /** Acquire one connection lease. Every acquire must have one matching release. */
  acquireConnection(): Promise<void> {
    const wasUnused = this.consumerCount === 0;
    this.consumerCount += 1;
    this.cancelDisconnectTimer();
    this.isManualDisconnect = false;
    if (wasUnused) {
      this.reconnectAttempts = 0;
    }
    debugLog('connection_acquired', { consumerCount: this.consumerCount });
    return this.ensureConnected();
  }

  /** Ensure transport availability without changing connection ownership. */
  ensureConnected(): Promise<void> {
    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.cancelReconnectTimer();
    this.isConnecting = true;
    this.isAuthenticated = false;
    this.connectionSequence += 1;
    this.connectionGeneration += 1;
    const generation = this.connectionGeneration;
    const connectionId = `chat-ws-${this.connectionSequence}-${Date.now().toString(36)}`;
    this.activeConnectionId = connectionId;

    const promise = new Promise<void>((resolve, reject) => {
      this.connectDeferred = { resolve, reject };
    });
    this.connectPromise = promise;

    try {
      const socket = this.createSocket(this.baseUrl, CHAT_WEBSOCKET_PROTOCOL);
      this.ws = socket;
      debugLog('connect_start', {
        connectionId,
        url: safeWebSocketUrl(this.baseUrl),
        reconnectAttempt: this.reconnectAttempts,
      });

      socket.onopen = () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        debugLog('socket_open_waiting_for_auth', { connectionId });
      };

      socket.onmessage = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        try {
          const message = JSON.parse(String(event.data));
          if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw new Error('Message is not an object');
          }
          this.handleMessage(message as Record<string, unknown>, socket, generation);
        } catch {
          console.warn('[WebSocket] invalid_server_message', { connectionId });
        }
      };

      socket.onerror = () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        console.warn('[WebSocket] socket_error', {
          connectionId,
          readyState: readyStateLabel(socket.readyState),
        });
        this.dispatchEvent(new CustomEvent('error', {
          detail: { error: 'Connection error', code: 'CONNECTION_ERROR' },
        }));
      };

      socket.onclose = (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        const wasAuthenticated = this.isAuthenticated;
        this.ws = null;
        this.isAuthenticated = false;
        this.isConnecting = false;
        for (const subscription of this.subscriptions.values()) {
          subscription.confirmed = false;
        }

        this.rejectConnect(errorWithCode(
          `WebSocket closed before authentication: code=${event.code}`,
          'CONNECTION_CLOSED',
        ));
        this.rejectPendingRequests(errorWithCode('WebSocket disconnected', 'CONNECTION_CLOSED'));
        console.info('[WebSocket] disconnected', {
          connectionId,
          code: event.code,
          wasAuthenticated,
          wasClean: event.wasClean,
          desiredSubscriptions: this.subscriptions.size,
        });
        this.dispatchEvent(new CustomEvent('disconnected', {
          detail: { code: event.code, reason: event.reason, wasClean: event.wasClean },
        }));

        if (!this.isManualDisconnect && this.consumerCount > 0 && !isTerminalCloseCode(event.code)) {
          this.scheduleReconnect();
        }
      };
    } catch (error) {
      this.ws = null;
      this.isConnecting = false;
      this.isAuthenticated = false;
      this.rejectConnect(error instanceof Error ? error : new Error('WebSocket connection failed'));
    }

    return promise;
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.ws === socket && this.connectionGeneration === generation;
  }

  private resolveConnect(): void {
    const deferred = this.connectDeferred;
    this.connectDeferred = null;
    this.connectPromise = null;
    deferred?.resolve();
  }

  private rejectConnect(error: Error): void {
    const deferred = this.connectDeferred;
    this.connectDeferred = null;
    this.connectPromise = null;
    deferred?.reject(error);
  }

  private abortConnectingConnection(connectionId: string | null, error: Error): void {
    if (!this.isConnecting || this.activeConnectionId !== connectionId) return;
    const socket = this.ws;
    this.isConnecting = false;
    this.isAuthenticated = false;
    this.rejectConnect(error);
    console.warn('[WebSocket] connect_timeout', {
      connectionId,
      readyState: readyStateLabel(socket?.readyState),
    });
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close(4000, 'Connect timeout');
    }
  }

  private waitForAuthenticatedConnection(timeoutMs: number): Promise<void> {
    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    this.cancelDisconnectTimer();
    this.isManualDisconnect = false;
    const connectTimeoutMs = Math.min(Math.max(timeoutMs, 5_000), REQUEST_CONNECT_TIMEOUT_MS);
    const connectionPromise = this.ensureConnected();
    const timeoutConnectionId = this.activeConnectionId;
    let timer: ReturnType<typeof setTimeout> | null = null;

    return Promise.race([
      connectionPromise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          const error = errorWithCode('WebSocket connection timeout before request', 'CONNECT_TIMEOUT');
          this.abortConnectingConnection(timeoutConnectionId, error);
          reject(error);
        }, connectTimeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  releaseConnection(): void {
    if (this.consumerCount > 0) this.consumerCount -= 1;
    debugLog('connection_released', { consumerCount: this.consumerCount });
    if (this.consumerCount === 0 && !this.disconnectTimer) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.consumerCount === 0) this.disconnect();
      }, this.disconnectGraceMs);
    }
  }

  disconnect(): void {
    const wasConnected = this.isAuthenticated || this.isConnecting;
    const socket = this.ws;
    this.isManualDisconnect = true;
    this.consumerCount = 0;
    this.isAuthenticated = false;
    this.isConnecting = false;
    this.connectionGeneration += 1;
    this.ws = null;
    this.cancelDisconnectTimer();
    this.cancelReconnectTimer();
    this.subscriptions.clear();
    this.rejectConnect(errorWithCode('WebSocket disconnected by client', 'CLIENT_DISCONNECT'));
    this.rejectPendingRequests(errorWithCode('WebSocket disconnected by client', 'CLIENT_DISCONNECT'));

    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close(1000, 'Client disconnect');
      }
    }
    if (wasConnected) {
      this.dispatchEvent(new CustomEvent('disconnected', {
        detail: { code: 1000, reason: 'Client disconnect', wasClean: true },
      }));
    }
  }

  private cancelDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendNow(message: Record<string, unknown>): boolean {
    if (!this.isAuthenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    debugLog('send', { connectionId: this.activeConnectionId, ...summarizeMessageForLog(message) });
    this.ws.send(JSON.stringify(message));
    return true;
  }

  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.waitForAuthenticatedConnection(timeoutMs);
    const requestId = generateRandomId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(errorWithCode('WebSocket request timeout', 'REQUEST_TIMEOUT'));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        type,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      if (!this.sendNow({ type, requestId, ...payload })) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(errorWithCode('WebSocket is not authenticated', 'NOT_CONNECTED'));
      }
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  subscribe(sessionId: string): Promise<Record<string, unknown>> {
    const existing = this.subscriptions.get(sessionId);
    if (existing) {
      existing.references += 1;
    } else {
      this.subscriptions.set(sessionId, { references: 1, confirmed: false, promise: null });
    }
    debugLog('subscription_acquired', {
      sessionId,
      references: this.subscriptions.get(sessionId)?.references,
    });
    return this.ensureSessionSubscribed(sessionId);
  }

  private ensureSessionSubscribed(sessionId: string): Promise<Record<string, unknown>> {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) {
      return Promise.reject(errorWithCode('Subscription was released', 'SUBSCRIPTION_RELEASED'));
    }
    if (subscription.confirmed) {
      return Promise.resolve({ type: 'subscribe_result', success: true, sessionId, shared: true });
    }
    if (subscription.promise) return subscription.promise;

    const promise = this.request('subscribe_session', { sessionId }, SUBSCRIBE_REQUEST_TIMEOUT_MS)
      .then((payload) => {
        const current = this.subscriptions.get(sessionId);
        if (current === subscription) current.confirmed = true;
        return payload;
      })
      .finally(() => {
        const current = this.subscriptions.get(sessionId);
        if (current === subscription && current.promise === promise) current.promise = null;
      });
    subscription.promise = promise;
    return promise;
  }

  unsubscribe(sessionId: string): void {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription) return;
    subscription.references -= 1;
    if (subscription.references > 0) {
      debugLog('subscription_released_shared', { sessionId, references: subscription.references });
      return;
    }

    this.subscriptions.delete(sessionId);
    this.sendNow({ type: 'unsubscribe_session', sessionId });
    debugLog('subscription_released', { sessionId });
  }

  sendMessage(
    sessionId: string,
    message: Record<string, unknown>,
    context?: ChatRequestContext,
  ): Promise<Record<string, unknown>> {
    return this.request('send_message', { sessionId, message, context });
  }

  private completeAuth(
    success: boolean,
    socket: WebSocket,
    generation: number,
    error?: string,
  ): void {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.isConnecting = false;
    if (!success) {
      this.isAuthenticated = false;
      const authError = errorWithCode(error || 'WebSocket authentication failed', 'AUTH_ERROR');
      this.rejectConnect(authError);
      this.rejectPendingRequests(authError);
      this.dispatchEvent(new CustomEvent('error', {
        detail: { error: authError.message, code: authError.code },
      }));
      socket.close(CHAT_WEBSOCKET_CLOSE_CODES.unauthorized, 'Unauthorized');
      return;
    }

    this.isAuthenticated = true;
    this.reconnectAttempts = 0;
    this.cancelReconnectTimer();
    console.info('[WebSocket] connected', {
      connectionId: this.activeConnectionId,
      desiredSubscriptions: this.subscriptions.size,
    });
    this.resolveConnect();
    this.dispatchEvent(new CustomEvent('connected'));
    for (const sessionId of this.subscriptions.keys()) {
      void this.ensureSessionSubscribed(sessionId).catch((subscriptionError) => {
        console.warn('[WebSocket] resubscribe_failed', {
          sessionId,
          error: subscriptionError instanceof Error ? subscriptionError.message : 'Unknown error',
        });
      });
    }
  }

  private handleMessage(message: Record<string, unknown>, socket: WebSocket, generation: number): void {
    const type = message.type;
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;
    if (requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
        debugLog('request_result', {
          connectionId: this.activeConnectionId,
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
    }

    switch (type) {
      case 'auth_success':
        this.completeAuth(true, socket, generation);
        break;
      case 'auth_error':
        this.completeAuth(false, socket, generation, typeof message.error === 'string' ? message.error : undefined);
        break;
      case 'agent_event': {
        const detail = { sessionId: message.sessionId as string, event: message.event as Record<string, unknown> };
        this.dispatchApplicationEvent('agent_event', detail);
        break;
      }
      case 'runtime_status': {
        const detail = { sessionId: message.sessionId as string, status: message.status as Record<string, unknown> };
        this.dispatchApplicationEvent('runtime_status', detail);
        break;
      }
      case 'notification': {
        const detail = {
          sessionId: message.sessionId as string,
          sessionTitle: message.sessionTitle as string,
          workspaceId: message.workspaceId as string | undefined,
          notificationType: message.notificationType as string,
          messagePreview: message.messagePreview as string | undefined,
          lastMessageAt: message.lastMessageAt as string | undefined,
          timestamp: message.timestamp as number | undefined,
        };
        debugLog('notification_received', {
          sessionId: detail.sessionId,
          notificationType: detail.notificationType,
          hasPreview: Boolean(detail.messagePreview),
        });
        this.dispatchApplicationEvent('notification', detail);
        break;
      }
      case 'session_updated': {
        const detail = {
          sessionId: message.sessionId as string,
          workspaceId: message.workspaceId as string | undefined,
          lastMessageAt: message.lastMessageAt as string,
          title: message.title as string | undefined,
        };
        this.dispatchApplicationEvent('session_updated', detail);
        break;
      }
      case 'session_title_updated': {
        const detail = {
          sessionId: message.sessionId as string,
          title: message.title as string,
          titleGenerationState: message.titleGenerationState as string | null | undefined,
        };
        this.dispatchApplicationEvent('session_title_updated', detail);
        break;
      }
      case 'error':
        console.warn('[WebSocket] server_error', summarizeMessageForLog(message));
        this.dispatchEvent(new CustomEvent('error', {
          detail: { error: message.error as string, code: message.code as string },
        }));
        break;
      case 'subscribe_result':
      case 'send_message_result':
      case 'control_result':
      case 'status_result':
        if (message.success === false) {
          this.dispatchEvent(new CustomEvent('error', {
            detail: { error: message.error as string, code: type },
          }));
        }
        break;
      default:
        debugLog('unknown_server_message', { type });
    }
  }

  private dispatchApplicationEvent(type: string, detail: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isManualDisconnect || this.consumerCount === 0) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.dispatchEvent(new CustomEvent('error', {
        detail: {
          error: `Failed to reconnect after ${this.maxReconnectAttempts} attempts`,
          code: 'MAX_RECONNECT_ATTEMPTS',
        },
      }));
      return;
    }

    const attempt = this.reconnectAttempts;
    const delay = calculateReconnectDelay(
      attempt,
      this.reconnectBaseDelayMs,
      this.reconnectMaxDelayMs,
      this.random,
    );
    this.reconnectAttempts += 1;
    console.info('[WebSocket] reconnect_scheduled', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isManualDisconnect || this.consumerCount === 0) return;
      void this.ensureConnected().catch((error) => {
        debugLog('reconnect_attempt_failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    }, delay);
  }

  resetForReconnect(): void {
    this.isManualDisconnect = false;
    this.reconnectAttempts = 0;
    this.cancelReconnectTimer();
  }

  isConnected(): boolean {
    return this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  getReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}

let globalWebSocketClient: WebSocketClient | null = null;

export function getWebSocketClient(): WebSocketClient {
  if (!globalWebSocketClient) globalWebSocketClient = new WebSocketClient();
  return globalWebSocketClient;
}

export function disconnectWebSocketClient(): void {
  if (!globalWebSocketClient) return;
  globalWebSocketClient.disconnect();
  globalWebSocketClient = null;
}
