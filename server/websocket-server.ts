/**
 * WebSocket Server for Chat Sessions
 *
 * - JWT Authentication via better-auth cookies
 * - Multi-Session Support
 * - In-Memory Broadcasting (Phase 1, no Redis)
 * - Heartbeat via WS protocol-level ping/pong (server → client, 30 s interval)
 */

import type { IncomingMessage } from 'http';
import type http from 'http';
import type * as net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { authenticateWebSocketConnection } from './websocket-auth';
import {
  subscribeToSession,
  unsubscribeFromSession,
  trackUserConnection,
  removeUserConnection,
  broadcastToSession,
  broadcastToUser,
} from './websocket-broadcast';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { initializeWebSocketBridge } from './chat-event-bridge';
import { checkWsRateLimit } from './websocket-rate-limit';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { getLicenseStatus } from '@/app/lib/license';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';

type ControlAction = 'follow_up' | 'steer' | 'promote_queued_to_steer' | 'remove_queued_item' | 'abort' | 'replace' | 'compact';
type PiRuntimeStatus = Record<string, unknown>;

type RuntimeService = typeof import('@/app/lib/pi/runtime-service');
type ChannelRouter = typeof import('@/app/lib/channels/router');

async function getRuntimeService(): Promise<RuntimeService> {
  return import('@/app/lib/pi/runtime-service');
}

async function getChannelRouter(): Promise<ChannelRouter> {
  return import('@/app/lib/channels/router');
}

async function isLicensedForRuntime(): Promise<boolean> {
  if (!isOnboardingEnabled() || !(await isOnboardingComplete())) {
    return true;
  }
  const status = await getLicenseStatus();
  return status.licensed;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
}

// Initialize WebSocket bridge on module load
initializeWebSocketBridge();

// ── Message Types ─────────────────────────────────────────────────────────────

/** Messages sent from the browser client to this server. */
type ClientMessage =
  | { type: 'subscribe_session'; requestId?: string; sessionId: string }
  | { type: 'unsubscribe_session'; sessionId: string }
  | {
      type: 'send_message';
      requestId?: string;
      sessionId: string;
      message: AgentMessage;
      context?: ChatRequestContext;
    }
  | { type: 'control'; requestId?: string; sessionId: string; action: ControlAction; message?: AgentMessage; queueItemId?: string }
  | { type: 'get_status'; requestId?: string; sessionId: string }
  | { type: 'change_model'; requestId?: string; sessionId: string };

/**
 * Messages pushed from this server to connected browser clients.
 *
 * Event semantics:
 *   agent_event     — forwarded PI runtime event (tool call, text chunk, etc.)
 *   session_updated — new assistant message was saved → update unread badge in all tabs
 *   notification    — AI finished in a background session → show toast
 *   session_read    — (reserved) user marked session as read → clear unread badge in other tabs
 *                     Currently emitted server-side after HTTP PATCH /api/sessions marks the session.
 */
type ServerMessage =
  | { type: 'auth_success'; userId: string }
  | { type: 'auth_error'; error: string }
  | { type: 'subscribe_result'; requestId?: string; success: boolean; sessionId?: string; error?: string }
  | { type: 'send_message_result'; requestId?: string; success: boolean; status?: PiRuntimeStatus; error?: string }
  | { type: 'control_result'; requestId?: string; success: boolean; status?: PiRuntimeStatus; error?: string }
  | { type: 'change_model_result'; requestId?: string; success: boolean; error?: string }
  | { type: 'status_result'; requestId?: string; success: boolean; status?: PiRuntimeStatus; error?: string }
  | { type: 'agent_event'; sessionId: string; event: Record<string, unknown> }
  | { type: 'session_updated'; sessionId: string; lastMessageAt: string; title?: string }
  | { type: 'session_read'; sessionId: string; timestamp: number }
  | {
      type: 'notification';
      sessionId: string;
      sessionTitle: string;
      notificationType: 'new_response' | 'tool_complete' | 'error';
      messagePreview?: string;
      lastMessageAt?: string;
      timestamp: number;
    }
  | { type: 'error'; error: string; code: string };

const QUIET_SERVER_MESSAGE_TYPES = new Set(['agent_event']);

function getHeaderValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function truncateForLog(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function summarizeUpgradeRequest(request: IncomingMessage): Record<string, unknown> {
  const forwardedFor = getHeaderValue(request.headers, 'x-forwarded-for');
  return {
    url: request.url,
    origin: getHeaderValue(request.headers, 'origin'),
    remoteAddress: forwardedFor?.split(',')[0]?.trim() || request.socket.remoteAddress,
    userAgent: truncateForLog(getHeaderValue(request.headers, 'user-agent')),
  };
}

function summarizeClientMessage(message: ClientMessage | { type?: unknown }): Record<string, unknown> {
  const input = message as {
    type?: unknown;
    requestId?: unknown;
    sessionId?: unknown;
    action?: unknown;
    queueItemId?: unknown;
    message?: { role?: unknown; content?: unknown };
    context?: ChatRequestContext;
  };
  const summary: Record<string, unknown> = {
    type: input.type,
  };

  if (typeof input.requestId === 'string') summary.requestId = input.requestId;
  if (typeof input.sessionId === 'string') summary.sessionId = input.sessionId;
  if (typeof input.action === 'string') summary.action = input.action;
  if (typeof input.queueItemId === 'string') summary.queueItemId = input.queueItemId;
  if (input.message) {
    summary.messageRole = input.message.role;
    summary.contentKind = Array.isArray(input.message.content) ? 'parts' : typeof input.message.content;
  }
  if (input.context) {
    summary.contextPage = input.context.currentPage;
    summary.contextChannel = input.context.channelId;
    summary.hasStudioContext = Boolean(input.context.studioContext);
  }

  return summary;
}

function summarizeServerMessage(message: ServerMessage): Record<string, unknown> {
  const output = message as {
    type?: unknown;
    requestId?: unknown;
    sessionId?: unknown;
    success?: unknown;
    error?: unknown;
    code?: unknown;
    notificationType?: unknown;
  };
  const summary: Record<string, unknown> = {
    type: output.type,
  };

  if (typeof output.requestId === 'string') summary.requestId = output.requestId;
  if (typeof output.sessionId === 'string') summary.sessionId = output.sessionId;
  if (typeof output.success === 'boolean') summary.success = output.success;
  if (typeof output.error === 'string') summary.error = output.error;
  if (typeof output.code === 'string') summary.code = output.code;
  if (typeof output.notificationType === 'string') summary.notificationType = output.notificationType;

  return summary;
}

/** Type-safe helper: serialise and send a ServerMessage over a WebSocket. */
function sendWs(ws: WebSocket, msg: ServerMessage): void {
  if (!QUIET_SERVER_MESSAGE_TYPES.has(msg.type)) {
    console.log('[WebSocket] server_send', {
      connectionId: connections.get(ws)?.id ?? 'preauth',
      ...summarizeServerMessage(msg),
    });
  }
  ws.send(JSON.stringify(msg));
}

async function findSessionOwner(sessionId: string): Promise<string | null> {
  const session = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, sessionId),
    columns: { userId: true },
  });
  return session?.userId ?? null;
}

async function userOwnsSession(sessionId: string, userId: string): Promise<boolean> {
  const ownedSession = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId)
    ),
    columns: { id: true },
  });
  return Boolean(ownedSession);
}

function subscribeConnectionToSession(connection: WebSocketConnection, sessionId: string): boolean {
  if (connection.sessionId && connection.sessionId !== sessionId) {
    unsubscribeFromSession(connection.sessionId, connection.ws);
  }

  connection.sessionId = sessionId;
  return subscribeToSession(sessionId, connection.ws);
}

// Connection State
interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  userId: string;
  sessionId?: string;
  isAlive: boolean;
  lastActivity: number;
  connectedAt: number;
}

const connections = new Map<WebSocket, WebSocketConnection>();
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CHAT_WEBSOCKET_PATH = '/ws/chat';
const LOG_HEARTBEAT_SUCCESS = process.env.WS_HEARTBEAT_LOGS === '1';
let nextConnectionId = 1;

function normalizeChatWebSocketPath(requestUrl?: string): string | null {
  const [requestPath, query = ''] = (requestUrl || '').split('?', 2);

  if (requestPath === CHAT_WEBSOCKET_PATH) {
    return query ? `${CHAT_WEBSOCKET_PATH}?${query}` : CHAT_WEBSOCKET_PATH;
  }

  if (/^\/[a-z]{2}(?:-[A-Z]{2})?\/ws\/chat$/u.test(requestPath)) {
    return query ? `${CHAT_WEBSOCKET_PATH}?${query}` : CHAT_WEBSOCKET_PATH;
  }

  return null;
}

export function isChatWebSocketRequest(requestUrl?: string): boolean {
  return normalizeChatWebSocketPath(requestUrl) !== null;
}

/**
 * Create WebSocket Server attached to HTTP server
 */
export function createWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    path: CHAT_WEBSOCKET_PATH,
  });

  wss.on('connection', handleConnection);

  const upgradedSockets = new WeakSet<net.Socket>();

  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const normalizedUrl = normalizeChatWebSocketPath(request.url);

    if (normalizedUrl) {
      if (upgradedSockets.has(socket)) {
        console.warn('[WebSocket] Duplicate upgrade on same socket — skipping');
        return;
      }
      upgradedSockets.add(socket);
      request.url = normalizedUrl;
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  // Start heartbeat
  startHeartbeat(wss);

  return wss;
}

/**
 * Handle new WebSocket connection
 */
async function handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
  const connectionId = `chat-${nextConnectionId++}-${Date.now().toString(36)}`;
  const connectedAt = Date.now();
  console.log('[WebSocket] upgrade_accepted', {
    connectionId,
    ...summarizeUpgradeRequest(request),
  });

  // Buffer messages that arrive before authentication completes.
  // The message listener must be registered synchronously (before the async auth await)
  // so that early client messages (e.g. send_message flushed immediately on ws.onopen)
  // are not silently dropped by the Node.js EventEmitter.
  const pendingMessages: Buffer[] = [];
  let connection: WebSocketConnection | null = null;
  let cleanupDone = false;

  const cleanupConnection = (source: 'close' | 'error', details: Record<string, unknown> = {}) => {
    if (cleanupDone) return;
    cleanupDone = true;

    if (connection) {
      console.log('[WebSocket] cleanup_connection', {
        connectionId,
        source,
        userId: connection.userId,
        sessionId: connection.sessionId,
        uptimeMs: Date.now() - connection.connectedAt,
        ...details,
      });
      handleDisconnect(connection);
      return;
    }

    console.log('[WebSocket] cleanup_preauth_connection', {
      connectionId,
      source,
      uptimeMs: Date.now() - connectedAt,
      bufferedMessages: pendingMessages.length,
      ...details,
    });
  };

  const dispatchMessage = (data: Buffer) => {
    if (!connection) {
      console.warn('[WebSocket] dispatch skipped without authenticated connection', {
        connectionId,
        bytes: data.length,
      });
      return;
    }

    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      console.log('[WebSocket] server_receive', {
        connectionId,
        userId: connection.userId,
        ...summarizeClientMessage(message),
      });
      void handleMessage(connection, message).catch((error) => {
        console.error('[WebSocket] handleMessage failed', {
          connectionId,
          userId: connection?.userId,
          message: summarizeClientMessage(message),
          error,
        });
        sendWs(ws, { type: 'error', error: getErrorMessage(error), code: 'MESSAGE_HANDLER_ERROR' });
      });
    } catch (error) {
      console.error('[WebSocket] Error parsing message:', {
        connectionId,
        bytes: data.length,
        error,
      });
      sendWs(ws, { type: 'error', error: 'Invalid message format', code: 'INVALID_MESSAGE' });
    }
  };

  ws.on('message', (data: Buffer) => {
    if (!connection) {
      // Auth not yet complete — buffer the message
      pendingMessages.push(data);
      console.log('[WebSocket] buffered_pre_auth_message', {
        connectionId,
        bufferedMessages: pendingMessages.length,
        bytes: data.length,
      });
      return;
    }
    dispatchMessage(data);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    cleanupConnection('close', {
      code,
      reason: reason.toString() || '(empty)',
    });
  });

  ws.on('error', (error) => {
    console.error('[WebSocket] socket_error', {
      connectionId,
      error,
    });
    cleanupConnection('error');
  });

  // Authenticate connection
  console.log('[WebSocket] auth_start', {
    connectionId,
    bufferedMessages: pendingMessages.length,
  });
  const authResult = await authenticateWebSocketConnection(request.headers);

  if (!authResult.isAuthenticated) {
    console.error('[WebSocket] auth_failed', {
      connectionId,
      error: authResult.error,
      bufferedMessages: pendingMessages.length,
    });
    sendWs(ws, { type: 'auth_error', error: authResult.error || 'Authentication failed' });
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (!(await isLicensedForRuntime())) {
    console.warn('[WebSocket] auth_rejected_license_required', {
      connectionId,
      userId: authResult.userId,
    });
    sendWs(ws, { type: 'auth_error', error: 'License activation required' });
    ws.close(4003, 'License activation required');
    return;
  }

  console.log('[WebSocket] auth_success', {
    connectionId,
    userId: authResult.userId,
    bufferedMessages: pendingMessages.length,
  });

  // Create connection state
  connection = {
    id: connectionId,
    ws,
    userId: authResult.userId!,
    isAlive: true,
    lastActivity: Date.now(),
    connectedAt,
  };

  connections.set(ws, connection);
  trackUserConnection(authResult.userId!, ws);

  // Send auth success
  sendWs(ws, { type: 'auth_success', userId: authResult.userId! });

  // Replay any messages that arrived before auth completed
  if (pendingMessages.length > 0) {
    console.log(`[WebSocket] Replaying ${pendingMessages.length} buffered message(s) for user ${authResult.userId}`);
    for (const data of pendingMessages) {
      dispatchMessage(data);
    }
  }

  // Handle pong (heartbeat response)
  ws.on('pong', () => {
    connection!.isAlive = true;
    connection!.lastActivity = Date.now();
    if (LOG_HEARTBEAT_SUCCESS) {
      console.log('[WebSocket] heartbeat_pong', {
        connectionId,
        userId: connection!.userId,
        sessionId: connection!.sessionId,
      });
    }
  });
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(connection: WebSocketConnection, message: ClientMessage): Promise<void> {
  const { ws, userId } = connection;

  switch (message.type) {
    case 'subscribe_session': {
      {
        const rl = checkWsRateLimit('subscribe_session', userId);
        if (!rl.ok) {
          console.warn('[WebSocket] subscribe rate_limited', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
          });
          sendWs(ws, { type: 'subscribe_result', requestId: message.requestId, success: false, error: 'Rate limit exceeded' });
          return;
        }
      }

      if (!message.sessionId) {
        console.warn('[WebSocket] subscribe rejected missing_session', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
        });
        sendWs(ws, { type: 'error', error: 'sessionId required', code: 'MISSING_SESSION_ID' });
        sendWs(ws, { type: 'subscribe_result', requestId: message.requestId, success: false, error: 'sessionId required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        console.warn('[WebSocket] subscribe rejected unauthorized', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        sendWs(ws, { type: 'subscribe_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      const isNew = subscribeConnectionToSession(connection, message.sessionId);

      console.log('[WebSocket] subscribe completed', {
        connectionId: connection.id,
        userId,
        requestId: message.requestId,
        sessionId: message.sessionId,
        isNew,
      });
      sendWs(ws, {
        type: 'subscribe_result',
        requestId: message.requestId,
        success: true,
        sessionId: message.sessionId,
      });
      break;
    }

    case 'unsubscribe_session': {
      if (message.sessionId) {
        unsubscribeFromSession(message.sessionId, ws);
        if (connection.sessionId === message.sessionId) {
          connection.sessionId = undefined;
        }
        console.log('[WebSocket] unsubscribe completed', {
          connectionId: connection.id,
          userId,
          sessionId: message.sessionId,
        });
      }
      break;
    }

    case 'send_message': {
      {
        const rl = checkWsRateLimit('send_message', userId);
        if (!rl.ok) {
          console.warn('[WebSocket] send_message rate_limited', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
          });
          sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'Rate limit exceeded' });
          return;
        }
      }

      if (!message.sessionId || !message.message) {
        console.warn('[WebSocket] send_message rejected missing_params', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'error', error: 'sessionId and message required', code: 'MISSING_PARAMS' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'sessionId and message required' });
        return;
      }

      const runtimeService = await getRuntimeService();
      if (!runtimeService.isValidUserMessage(message.message)) {
        console.warn('[WebSocket] send_message rejected invalid_role', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'error', error: 'Message role must be "user"', code: 'INVALID_ROLE' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'Message role must be "user"' });
        return;
      }

      // Authorization: if session already exists, it must belong to this user.
      // Non-existent sessions are allowed (new-session create flow).
      const existingSessionOwner = await findSessionOwner(message.sessionId);
      if (existingSessionOwner && existingSessionOwner !== userId) {
        console.warn('[WebSocket] send_message rejected unauthorized', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      const context = message.context;

      // Subscribe before starting the runtime so early runtime events cannot race
      // ahead of this connection's session subscription.
      const subscribed = subscribeConnectionToSession(connection, message.sessionId);

      try {
        console.log('[WebSocket] send_message starting_runtime', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          subscribed,
          contextPage: context?.currentPage,
          contextChannel: context?.channelId,
        });
        const { handleInboundChannelMessage } = await getChannelRouter();
        const status = await handleInboundChannelMessage({
          channelId: WEB_CHANNEL_ID,
          channelSessionKey: webChannelSessionKey(userId),
          requestedSessionId: message.sessionId,
          userId,
          text: typeof message.message.content === 'string' ? message.message.content : '',
          contentParts: Array.isArray(message.message.content) ? message.message.content : undefined,
          metadata: { displayName: 'Web Chat' },
        }, context);
        console.log('[WebSocket] send_message runtime_started', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          resolvedSessionId: status.sessionId,
          phase: status.status.phase,
          canAbort: status.status.canAbort,
        });
        sendWs(ws, {
          type: 'send_message_result',
          requestId: message.requestId,
          success: true,
          status: status.status,
        });
      } catch (error) {
        console.error('[WebSocket] send_message failed', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          error,
        });
        const errorMessage = getErrorMessage(error);
        sendWs(ws, {
          type: 'error',
          error: errorMessage,
          code: 'RUNTIME_ERROR',
        });
        sendWs(ws, {
          type: 'send_message_result',
          requestId: message.requestId,
          success: false,
          error: errorMessage,
        });
      }
      break;
    }

    case 'control': {
      {
        const rl = checkWsRateLimit('control', userId);
        if (!rl.ok) {
          console.warn('[WebSocket] control rate_limited', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
            action: message.action,
          });
          sendWs(ws, { type: 'control_result', requestId: message.requestId, success: false, error: 'Rate limit exceeded' });
          return;
        }
      }

      if (!message.sessionId || !message.action) {
        console.warn('[WebSocket] control rejected missing_params', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          action: message.action,
        });
        sendWs(ws, { type: 'control_result', requestId: message.requestId, success: false, error: 'sessionId and action required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        console.warn('[WebSocket] control rejected unauthorized', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          action: message.action,
        });
        sendWs(ws, { type: 'control_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      try {
        console.log('[WebSocket] control starting', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          action: message.action,
          queueItemId: message.queueItemId,
        });
        const runtimeService = await getRuntimeService();
        const status = await runtimeService.control(message.sessionId, userId, message.action, message.message, message.queueItemId);
        console.log('[WebSocket] control completed', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          action: message.action,
          phase: status.phase,
          canAbort: status.canAbort,
        });
        sendWs(ws, {
          type: 'control_result',
          requestId: message.requestId,
          success: true,
          status,
        });
      } catch (error) {
        console.error('[WebSocket] control failed', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          action: message.action,
          error,
        });
        sendWs(ws, {
          type: 'control_result',
          requestId: message.requestId,
          success: false,
          error: getErrorMessage(error),
        });
      }
      break;
    }

    case 'change_model': {
      if (!message.sessionId) {
        console.warn('[WebSocket] change_model rejected missing_session', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
        });
        sendWs(ws, { type: 'change_model_result', requestId: message.requestId, success: false, error: 'sessionId required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        console.warn('[WebSocket] change_model rejected unauthorized', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'change_model_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      try {
        console.log('[WebSocket] change_model invalidating_runtime', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        const runtimeService = await getRuntimeService();
        await runtimeService.invalidateRuntime(message.sessionId, userId);
        sendWs(ws, { type: 'change_model_result', requestId: message.requestId, success: true });
      } catch (error) {
        console.error('[WebSocket] change_model failed', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          error,
        });
        sendWs(ws, {
          type: 'change_model_result',
          requestId: message.requestId,
          success: false,
          error: getErrorMessage(error),
        });
      }
      break;
    }

    case 'get_status': {
      {
        const rl = checkWsRateLimit('get_status', userId);
        if (!rl.ok) {
          console.warn('[WebSocket] get_status rate_limited', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
          });
          sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'Rate limit exceeded' });
          return;
        }
      }

      if (!message.sessionId) {
        console.warn('[WebSocket] get_status rejected missing_session', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
        });
        sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'sessionId required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        console.warn('[WebSocket] get_status rejected unauthorized', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      try {
        const runtimeService = await getRuntimeService();
        const status = await runtimeService.getStatus(message.sessionId, userId);
        if (!status) {
          console.warn('[WebSocket] get_status runtime_missing', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
          });
          sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'Session not found' });
          return;
        }

        console.log('[WebSocket] get_status completed', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          phase: status.phase,
          canAbort: status.canAbort,
        });
        sendWs(ws, {
          type: 'status_result',
          requestId: message.requestId,
          success: true,
          status,
        });
      } catch (error) {
        console.error('[WebSocket] get_status failed', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          error,
        });
        sendWs(ws, {
          type: 'status_result',
          requestId: message.requestId,
          success: false,
          error: getErrorMessage(error),
        });
      }
      break;
    }

    default: {
      // Defensive: message.type is 'never' here — guard for unknown messages from clients
      const unknownType = String((message as { type: unknown }).type);
      console.warn('[WebSocket] unknown message type', {
        connectionId: connection.id,
        userId,
        type: unknownType,
      });
      sendWs(ws, { type: 'error', error: `Unknown message type: ${unknownType}`, code: 'UNKNOWN_MESSAGE_TYPE' });
      break;
    }
  }

  // Update last activity
  connection.lastActivity = Date.now();
}

/**
 * Handle WebSocket disconnect
 */
function handleDisconnect(connection: WebSocketConnection): void {
  const { id, ws, userId, sessionId } = connection;

  if (!connections.has(ws)) {
    console.log('[WebSocket] disconnect cleanup skipped already removed', {
      connectionId: id,
      userId,
      sessionId,
    });
    return;
  }

  if (sessionId) {
    unsubscribeFromSession(sessionId, ws);
  }

  removeUserConnection(userId, ws);
  connections.delete(ws);

  // Clean up user connections
  const allRemainingUserConnections = Array.from(connections.values())
    .filter(c => c.userId === userId);

  console.log('[WebSocket] disconnect cleanup complete', {
    connectionId: id,
    userId,
    sessionId,
    remainingUserConnections: allRemainingUserConnections.length,
    trackedConnections: connections.size,
  });

  if (allRemainingUserConnections.length === 0) {
    console.log(`[WebSocket] User ${userId} has no more connections`);
  }
}

/**
 * Start heartbeat to detect stale connections
 */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(wss: WebSocketServer): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const connection = connections.get(ws);
      
      if (!connection) {
        return;
      }

      if (!connection.isAlive) {
        console.log('[WebSocket] heartbeat stale terminating connection', {
          connectionId: connection.id,
          userId: connection.userId,
          sessionId: connection.sessionId,
          idleMs: Date.now() - connection.lastActivity,
        });
        ws.terminate();
        handleDisconnect(connection);
        return;
      }

      connection.isAlive = false;
      if (LOG_HEARTBEAT_SUCCESS) {
        console.log('[WebSocket] heartbeat_ping', {
          connectionId: connection.id,
          userId: connection.userId,
          sessionId: connection.sessionId,
        });
      }
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);
  heartbeatInterval.unref?.();

  console.log('[WebSocket] Heartbeat started (30s interval)');
}

/**
 * Broadcast agent event to session subscribers
 */
export function broadcastAgentEvent(
  sessionId: string,
  event: Record<string, unknown>
): void {
  broadcastToSession(sessionId, {
    type: 'agent_event',
    sessionId,
    event,
  });
}

/**
 * Broadcast notification to user's connected clients
 */
export function broadcastNotification(
  userId: string,
  sessionId: string,
  sessionTitle: string,
  notificationType: 'new_response' | 'tool_complete' | 'error',
  messagePreview?: string,
  lastMessageAt?: string
): void {
  console.log(`[WS Server] broadcastNotification: userId=${userId}, sessionId=${sessionId}, type=${notificationType}, title="${sessionTitle}", preview="${messagePreview?.slice(0, 50) ?? '(none)'}"`);
  broadcastToUser(userId, {
    type: 'notification',
    sessionId,
    sessionTitle,
    notificationType,
    messagePreview,
    lastMessageAt,
    timestamp: Date.now(),
  });
}

/**
 * Broadcast session update (lastMessageAt changed)
 */
export function broadcastSessionUpdate(
  sessionId: string,
  lastMessageAt: string
): void {
  broadcastToSession(sessionId, {
    type: 'session_updated',
    sessionId,
    lastMessageAt,
  });
}

/**
 * Broadcast session update to all of user's connections (all tabs/devices)
 */
export function broadcastSessionUpdateToUser(
  userId: string,
  sessionId: string,
  lastMessageAt: string,
  title?: string
): void {
  console.log(`[WS Server] broadcastSessionUpdateToUser: userId=${userId}, sessionId=${sessionId}, lastMessageAt=${lastMessageAt}, title="${title ?? '(none)'}"`);
  broadcastToUser(userId, {
    type: 'session_updated',
    sessionId,
    lastMessageAt,
    title,
  });
}
