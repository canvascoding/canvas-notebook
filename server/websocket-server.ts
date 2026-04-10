/**
 * WebSocket Server for Chat Sessions
 * 
 * - JWT Authentication via better-auth cookies
 * - Multi-Session Support
 * - In-Memory Broadcasting (Phase 1, no Redis)
 * - Heartbeat/Ping-Pong
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
import { subscribeToPiRuntimeEvents, sendMessageViaRuntime, initializeWebSocketBridge, setUserActiveSession } from './websocket-runtime-bridge';

// Initialize WebSocket bridge on module load
// USE_SSE_FALLBACK: When set to 'true', don't initialize WebSocket bridge (use SSE instead)
// Standard is WebSocket-only mode, so bridge is always initialized.
if (typeof process !== 'undefined' && process.env.USE_SSE_FALLBACK !== 'true') {
  initializeWebSocketBridge();
}

// Message Types
interface ClientMessage {
  type: string;
  sessionId?: string;
  message?: AgentMessage;
  timestamp?: number;
  activeFilePath?: string | null;
  userTimeZone?: string;
  currentTime?: string;
  workingDirectory?: string;
}

interface ServerMessage {
  type: string;
  userId?: string;
  sessionId?: string;
  event?: Record<string, unknown>;
  status?: Record<string, unknown>;
  lastMessageAt?: string;
  sessionTitle?: string;
  error?: string;
  code?: string;
  timestamp?: number;
  latency?: number;
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

  // Handle WebSocket upgrade
  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    
    if (url.pathname === '/ws/chat') {
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

  // Authenticate connection
  const authResult = await authenticateWebSocketConnection(request.headers);

  if (!authResult.isAuthenticated) {
    console.error('[WebSocket] Authentication failed:', authResult.error);
    ws.send(JSON.stringify({
      type: 'auth_error',
      error: authResult.error || 'Authentication failed',
    } as ServerMessage));
    ws.close(4001, 'Unauthorized');
    return;
  }

  console.log('[WebSocket] Authenticated user:', authResult.userId);

  // Create connection state
  const connection: WebSocketConnection = {
    ws,
    userId: authResult.userId!,
    isAlive: true,
    lastActivity: Date.now(),
  };

  connections.set(ws, connection);
  trackUserConnection(authResult.userId!, ws);

  // Send auth success
  ws.send(JSON.stringify({
    type: 'auth_success',
    userId: authResult.userId,
  } as ServerMessage));

  // Handle messages
  ws.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      handleMessage(connection, message);
    } catch (error) {
      console.error('[WebSocket] Error parsing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format',
        code: 'INVALID_MESSAGE',
      } as ServerMessage));
    }
  });

  // Handle pong (heartbeat response)
  ws.on('pong', () => {
    connection.isAlive = true;
  });

  // Handle disconnect
  ws.on('close', () => {
    console.log('[WebSocket] Connection closed');
    handleDisconnect(connection);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
    handleDisconnect(connection);
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
        ws.send(JSON.stringify({
          type: 'error',
          error: 'sessionId required',
          code: 'MISSING_SESSION_ID',
        } as ServerMessage));
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

      // Track user's active session
      setUserActiveSession(userId, message.sessionId);

      // Subscribe to PI Runtime events for this session (async)
      subscribeToPiRuntimeEvents(message.sessionId, userId).catch((error) => {
        console.error('[WebSocket] Error subscribing to PI Runtime events:', error);
      });

      break;
    }

    case 'unsubscribe_session': {
      if (message.sessionId) {
        unsubscribeFromSession(message.sessionId, ws);
        if (connection.sessionId === message.sessionId) {
          connection.sessionId = undefined;
          // Clear user's active session
          setUserActiveSession(userId, null);
        }
        console.log(`[WebSocket] User ${userId} unsubscribed from session ${message.sessionId}`);
      }
      break;
    }

    case 'mark_read': {
      if (!message.sessionId) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'sessionId required',
          code: 'MISSING_SESSION_ID',
        } as ServerMessage));
        return;
      }

      // Update lastViewedAt in database
      try {
        const { db } = await import('@/app/lib/db');
        const { piSessions } = await import('@/app/lib/db/schema');
        const { and, eq } = await import('drizzle-orm');

        await db.update(piSessions)
          .set({ lastViewedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(piSessions.sessionId, message.sessionId),
            eq(piSessions.userId, userId)
          ));

        console.log(`[WebSocket] Session ${message.sessionId} marked as read`);

        // Broadcast to other tabs/devices
        broadcastToUser(userId, {
          type: 'session_read',
          sessionId: message.sessionId,
          timestamp: Date.now(),
        }, ws);
      } catch (error) {
        console.error('[WebSocket] Error marking session as read:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Failed to mark session as read',
          code: 'DB_ERROR',
        } as ServerMessage));
      }
      break;
    }

    case 'send_message': {
      if (!message.sessionId || !message.message) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'sessionId and message required',
          code: 'MISSING_PARAMS',
        } as ServerMessage));
        return;
      }

      // Validate message is user message
      const userMessage = message.message as Extract<AgentMessage, { role: 'user' }>;
      if (userMessage.role !== 'user') {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Message role must be "user"',
          code: 'INVALID_ROLE',
        } as ServerMessage));
        return;
      }

      // Extract context from message
      const context = {
        activeFilePath: message.activeFilePath as string | null | undefined,
        userTimeZone: message.userTimeZone as string | undefined,
        currentTime: message.currentTime as string | undefined,
        workingDirectory: message.workingDirectory as string | undefined,
      };

      // Send message via PI Runtime bridge with context
      try {
        await sendMessageViaRuntime(message.sessionId, userId, userMessage, context);
        console.log(`[WebSocket] Message sent to session ${message.sessionId} via PI Runtime with context:`, context);
      } catch (error) {
        console.error('[WebSocket] Error sending message:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : 'Failed to send message',
          code: 'RUNTIME_ERROR',
        } as ServerMessage));
      }
      break;
    }

    case 'ping': {
      const latency = Date.now() - (message.timestamp || Date.now());
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: Date.now(),
        latency: Math.abs(latency),
      } as ServerMessage));
      break;
    }

    case 'get_status': {
      if (!message.sessionId) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'sessionId required',
          code: 'MISSING_SESSION_ID',
        } as ServerMessage));
        return;
      }

      // Runtime status will be sent via PI Runtime events
      // This is just a placeholder for future implementation
      console.log('[WebSocket] Status request for session:', message.sessionId);
      break;
    }

    default:
      console.warn('[WebSocket] Unknown message type:', message.type);
      ws.send(JSON.stringify({
        type: 'error',
        error: `Unknown message type: ${message.type}`,
        code: 'UNKNOWN_MESSAGE_TYPE',
      } as ServerMessage));
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
    // Clear user's active session if this was their last connection
    const remainingUserConnections = Array.from(connections.values())
      .filter(c => c.userId === userId && c !== connection);
    
    if (remainingUserConnections.length === 0) {
      setUserActiveSession(userId, null);
    }
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
  messagePreview?: string
): void {
  broadcastToUser(userId, {
    type: 'notification',
    sessionId,
    sessionTitle,
    notificationType,
    messagePreview,
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
  lastMessageAt: string
): void {
  broadcastToUser(userId, {
    type: 'session_updated',
    sessionId,
    lastMessageAt,
  });
}
