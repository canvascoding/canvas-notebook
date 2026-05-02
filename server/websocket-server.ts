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
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { initializeWebSocketBridge } from './chat-event-bridge';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { and, eq } from 'drizzle-orm';

type ControlAction = 'follow_up' | 'steer' | 'abort' | 'replace' | 'compact';
type PiRuntimeStatus = Record<string, unknown>;

type RuntimeService = typeof import('@/app/lib/pi/runtime-service');

async function getRuntimeService(): Promise<RuntimeService> {
  return import('@/app/lib/pi/runtime-service');
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
  | { type: 'control'; requestId?: string; sessionId: string; action: ControlAction; message?: AgentMessage }
  | { type: 'get_status'; requestId?: string; sessionId: string };

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

/** Type-safe helper: serialise and send a ServerMessage over a WebSocket. */
function sendWs(ws: WebSocket, msg: ServerMessage): void {
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

function subscribeConnectionToSession(connection: WebSocketConnection, sessionId: string): void {
  if (connection.sessionId && connection.sessionId !== sessionId) {
    unsubscribeFromSession(connection.sessionId, connection.ws);
  }

  connection.sessionId = sessionId;
  subscribeToSession(sessionId, connection.ws);
}

// Connection State
interface WebSocketConnection {
  ws: WebSocket;
  userId: string;
  sessionId?: string;
  isAlive: boolean;
  lastActivity: number;
}

const connections = new Map<WebSocket, WebSocketConnection>();
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CHAT_WEBSOCKET_PATH = '/ws/chat';

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
  console.log('[WebSocket] New connection');

  // Buffer messages that arrive before authentication completes.
  // The message listener must be registered synchronously (before the async auth await)
  // so that early client messages (e.g. send_message flushed immediately on ws.onopen)
  // are not silently dropped by the Node.js EventEmitter.
  const pendingMessages: Buffer[] = [];
  let connection: WebSocketConnection | null = null;

  const dispatchMessage = (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      handleMessage(connection!, message);
    } catch (error) {
      console.error('[WebSocket] Error parsing message:', error);
      sendWs(ws, { type: 'error', error: 'Invalid message format', code: 'INVALID_MESSAGE' });
    }
  };

  ws.on('message', (data: Buffer) => {
    if (!connection) {
      // Auth not yet complete — buffer the message
      pendingMessages.push(data);
      return;
    }
    dispatchMessage(data);
  });

  // Authenticate connection
  const authResult = await authenticateWebSocketConnection(request.headers);

  if (!authResult.isAuthenticated) {
    console.error('[WebSocket] Authentication failed:', authResult.error);
    sendWs(ws, { type: 'auth_error', error: authResult.error || 'Authentication failed' });
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[WebSocket] Authenticated user:', authResult.userId);

  // Create connection state
  connection = {
    ws,
    userId: authResult.userId!,
    isAlive: true,
    lastActivity: Date.now(),
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
  });

  // Handle disconnect
  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`[WebSocket] Connection closed: code=${code} reason=${reason.toString() || '(empty)'}`);
    handleDisconnect(connection!);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
    handleDisconnect(connection!);
  });
}

/**
 * Handle incoming WebSocket messages
 */
async function handleMessage(connection: WebSocketConnection, message: ClientMessage): Promise<void> {
  const { ws, userId } = connection;

  switch (message.type) {
    case 'subscribe_session': {
      if (!message.sessionId) {
        sendWs(ws, { type: 'error', error: 'sessionId required', code: 'MISSING_SESSION_ID' });
        sendWs(ws, { type: 'subscribe_result', requestId: message.requestId, success: false, error: 'sessionId required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        console.warn(`[WebSocket] User ${userId} attempted to subscribe to unauthorized session ${message.sessionId}`);
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        sendWs(ws, { type: 'subscribe_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      subscribeConnectionToSession(connection, message.sessionId);

      console.log(`[WebSocket] User ${userId} subscribed to session ${message.sessionId}`);
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
        console.log(`[WebSocket] User ${userId} unsubscribed from session ${message.sessionId}`);
      }
      break;
    }

    case 'send_message': {
      if (!message.sessionId || !message.message) {
        sendWs(ws, { type: 'error', error: 'sessionId and message required', code: 'MISSING_PARAMS' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'sessionId and message required' });
        return;
      }

      const runtimeService = await getRuntimeService();
      if (!runtimeService.isValidUserMessage(message.message)) {
        sendWs(ws, { type: 'error', error: 'Message role must be "user"', code: 'INVALID_ROLE' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'Message role must be "user"' });
        return;
      }

      // Authorization: if session already exists, it must belong to this user.
      // Non-existent sessions are allowed (new-session create flow).
      const existingSessionOwner = await findSessionOwner(message.sessionId);
      if (existingSessionOwner && existingSessionOwner !== userId) {
        console.warn(`[WebSocket] User ${userId} attempted to send to unauthorized session ${message.sessionId}`);
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      const context = message.context;

      // Subscribe before starting the runtime so early runtime events cannot race
      // ahead of this connection's session subscription.
      subscribeConnectionToSession(connection, message.sessionId);

      try {
        const status = await runtimeService.sendMessage(message.sessionId, userId, message.message, context);
        console.log(`[WebSocket] Message sent to session ${message.sessionId} via PI Runtime with context:`, context);
        sendWs(ws, {
          type: 'send_message_result',
          requestId: message.requestId,
          success: true,
          status,
        });
      } catch (error) {
        console.error('[WebSocket] Error sending message:', error);
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
      if (!message.sessionId || !message.action) {
        sendWs(ws, { type: 'control_result', requestId: message.requestId, success: false, error: 'sessionId and action required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        console.warn(`[WebSocket] User ${userId} attempted to control unauthorized session ${message.sessionId}`);
        sendWs(ws, { type: 'control_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      try {
        const runtimeService = await getRuntimeService();
        const status = await runtimeService.control(message.sessionId, userId, message.action, message.message);
        sendWs(ws, {
          type: 'control_result',
          requestId: message.requestId,
          success: true,
          status,
        });
      } catch (error) {
        sendWs(ws, {
          type: 'control_result',
          requestId: message.requestId,
          success: false,
          error: getErrorMessage(error),
        });
      }
      break;
    }

    case 'get_status': {
      if (!message.sessionId) {
        sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'sessionId required' });
        return;
      }

      if (!(await userOwnsSession(message.sessionId, userId))) {
        sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }

      try {
        const runtimeService = await getRuntimeService();
        const status = await runtimeService.getStatus(message.sessionId, userId);
        if (!status) {
          sendWs(ws, { type: 'status_result', requestId: message.requestId, success: false, error: 'Session not found' });
          return;
        }

        sendWs(ws, {
          type: 'status_result',
          requestId: message.requestId,
          success: true,
          status,
        });
      } catch (error) {
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
      console.warn('[WebSocket] Unknown message type:', unknownType);
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
  const { ws, userId, sessionId } = connection;

  if (sessionId) {
    unsubscribeFromSession(sessionId, ws);
  }

  removeUserConnection(userId, ws);
  connections.delete(ws);

  // Clean up user connections
  const allRemainingUserConnections = Array.from(connections.values())
    .filter(c => c.userId === userId);

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
        console.log('[WebSocket] Terminating stale connection');
        ws.terminate();
        handleDisconnect(connection);
        return;
      }

      connection.isAlive = false;
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
