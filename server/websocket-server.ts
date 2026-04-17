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
  broadcastToSession,
  broadcastToUser,
} from './websocket-broadcast';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { sendMessageViaRuntime, initializeWebSocketBridge } from './chat-event-bridge';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { and, eq } from 'drizzle-orm';

// Initialize WebSocket bridge on module load
initializeWebSocketBridge();

// ── Message Types ─────────────────────────────────────────────────────────────

/** Messages sent from the browser client to this server. */
type ClientMessage =
  | { type: 'subscribe_session'; sessionId: string }
  | { type: 'unsubscribe_session'; sessionId: string }
  | {
      type: 'send_message';
      sessionId: string;
      message: AgentMessage;
      context?: ChatRequestContext;
    };

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

/**
 * Create WebSocket Server attached to HTTP server
 */
export function createWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    path: '/ws/chat',
  });

  wss.on('connection', handleConnection);

  const upgradedSockets = new WeakSet<net.Socket>();

  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/ws/chat') {
      if (upgradedSockets.has(socket)) {
        console.warn('[WebSocket] Duplicate upgrade on same socket — skipping');
        return;
      }
      upgradedSockets.add(socket);
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
        return;
      }

      // Authorization: session must belong to this user
      const ownedSession = await db.query.piSessions.findFirst({
        where: and(
          eq(piSessions.sessionId, message.sessionId),
          eq(piSessions.userId, userId)
        ),
        columns: { id: true },
      });

      if (!ownedSession) {
        console.warn(`[WebSocket] User ${userId} attempted to subscribe to unauthorized session ${message.sessionId}`);
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        return;
      }

      // Unsubscribe from previous session if any
      if (connection.sessionId) {
        unsubscribeFromSession(connection.sessionId, ws);
      }

      // Subscribe to new session
      connection.sessionId = message.sessionId;
      subscribeToSession(message.sessionId, ws);

      console.log(`[WebSocket] User ${userId} subscribed to session ${message.sessionId}`);
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
        return;
      }

      // Validate message is user message
      const userMessage = message.message as Extract<AgentMessage, { role: 'user' }>;
      if (userMessage.role !== 'user') {
        sendWs(ws, { type: 'error', error: 'Message role must be "user"', code: 'INVALID_ROLE' });
        return;
      }

      // Authorization: if session already exists, it must belong to this user.
      // Non-existent sessions are allowed (new-session create flow).
      const existingSession = await db.query.piSessions.findFirst({
        where: eq(piSessions.sessionId, message.sessionId),
        columns: { userId: true },
      });
      if (existingSession && existingSession.userId !== userId) {
        console.warn(`[WebSocket] User ${userId} attempted to send to unauthorized session ${message.sessionId}`);
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        return;
      }

      const context = message.context;

      // Send message via PI Runtime bridge with context
      try {
        await sendMessageViaRuntime(message.sessionId, userId, userMessage, context);
        console.log(`[WebSocket] Message sent to session ${message.sessionId} via PI Runtime with context:`, context);
      } catch (error) {
        console.error('[WebSocket] Error sending message:', error);
        sendWs(ws, {
          type: 'error',
          error: error instanceof Error ? error.message : 'Failed to send message',
          code: 'RUNTIME_ERROR',
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

  connections.delete(ws);

  // Clean up user connections
  const allRemainingUserConnections = Array.from(connections.values())
    .filter(c => c.userId === userId);

  if (allRemainingUserConnections.length === 0) {
    // No more connections for this user
    console.log(`[WebSocket] User ${userId} has no more connections`);
  }
}

/**
 * Start heartbeat to detect stale connections
 */
function startHeartbeat(wss: WebSocketServer): void {
  setInterval(() => {
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
  broadcastToUser(userId, {
    type: 'session_updated',
    sessionId,
    lastMessageAt,
    title,
  });
}
