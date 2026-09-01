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
import { initializeWebSocketBridge } from './chat-event-bridge';
import { checkWsRateLimit } from './websocket-rate-limit';
import { runWebSocketSessionAction } from './websocket-session-queue';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { db } from '@/app/lib/db';
import { piSessions } from '@/app/lib/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { WEB_CHANNEL_ID, webChannelSessionKey } from '@/app/lib/channels/constants';
import { getLicenseStatus } from '@/app/lib/license';
import { isOnboardingComplete, isOnboardingEnabled } from '@/app/lib/onboarding/status';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';
import { createOperationTiming } from '@/app/lib/observability/operation-timing';
import { PiSessionRuntimeAccessError } from '@/app/lib/pi/session-runtime-access';
import { getChannelRouter, getRuntimeService } from './agent-runtime-loader';
import {
  hasPendingMobileChatTicket,
  MOBILE_CHAT_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/ws-ticket';
import {
  CHAT_WEBSOCKET_CLOSE_CODES,
  CHAT_WEBSOCKET_PATH,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@/app/lib/websocket/protocol';

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

function getClientError(error: unknown): { code: string; message: string } {
  if (error instanceof PiSessionRuntimeAccessError && error.code === 'SESSION_AMBIGUOUS') {
    return {
      code: 'SESSION_DATA_CONFLICT',
      message: 'This chat has conflicting session data. Refresh the app and try again.',
    };
  }
  return { code: 'RUNTIME_ERROR', message: getErrorMessage(error) };
}

// Initialize WebSocket bridge on module load
initializeWebSocketBridge();

function shouldSerializeSessionAction(message: ClientMessage): message is Extract<ClientMessage, {
  type: 'send_message' | 'control';
}> {
  return (
    (message.type === 'send_message' || message.type === 'control') &&
    typeof message.sessionId === 'string' &&
    message.sessionId.length > 0
  );
}

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
    agentId?: unknown;
    clientMessageId?: unknown;
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
  if (typeof input.agentId === 'string') summary.agentId = input.agentId;
  if (typeof input.clientMessageId === 'string') summary.clientMessageId = input.clientMessageId;
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
function sendWs(ws: WebSocket, msg: ServerMessage): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    console.warn('[WebSocket] server_send skipped socket_not_open', {
      connectionId: connections.get(ws)?.id ?? 'preauth',
      readyState: ws.readyState,
      type: msg.type,
    });
    return false;
  }
  if (!QUIET_SERVER_MESSAGE_TYPES.has(msg.type)) {
    console.log('[WebSocket] server_send', {
      connectionId: connections.get(ws)?.id ?? 'preauth',
      ...summarizeServerMessage(msg),
    });
  }
  ws.send(JSON.stringify(msg));
  return true;
}

async function findSessionIdentity(sessionId: string): Promise<{
  userId: string;
  agentId: string;
  workspaceId: string | null;
} | null> {
  const session = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, sessionId),
    columns: { userId: true, agentId: true, workspaceId: true },
  });
  return session ?? null;
}

async function userOwnsSession(
  sessionId: string,
  userId: string,
  workspace?: NonNullable<ChatRequestContext['workspace']>,
): Promise<boolean> {
  const ownedSession = await db.query.piSessions.findFirst({
    where: and(
      eq(piSessions.sessionId, sessionId),
      eq(piSessions.userId, userId),
      workspace
        ? workspace.workspaceType === 'personal'
          ? or(eq(piSessions.workspaceId, workspace.workspaceId), isNull(piSessions.workspaceId))
          : eq(piSessions.workspaceId, workspace.workspaceId)
        : undefined,
    ),
    columns: { id: true },
  });
  return Boolean(ownedSession);
}

function subscribeConnectionToSession(connection: WebSocketConnection, sessionId: string): boolean {
  const isNew = subscribeToSession(sessionId, connection.ws);
  connection.sessionIds.add(sessionId);
  return isNew;
}

// Connection State
interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  userId: string;
  workspace?: NonNullable<ChatRequestContext['workspace']>;
  sessionIds: Set<string>;
  isAlive: boolean;
  lastActivity: number;
  connectedAt: number;
}

const connections = new Map<WebSocket, WebSocketConnection>();
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const LOG_HEARTBEAT_SUCCESS = process.env.WS_HEARTBEAT_LOGS === '1';
const MAX_INBOUND_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_PREAUTH_BUFFERED_MESSAGES = 20;
const MAX_PREAUTH_BUFFERED_BYTES = 512 * 1024;
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

function rejectWebSocketUpgrade(socket: net.Socket): void {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

/**
 * Create WebSocket Server attached to HTTP server
 */
export function createWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    path: CHAT_WEBSOCKET_PATH,
    maxPayload: MAX_INBOUND_MESSAGE_BYTES,
    handleProtocols: (protocols) => (
      protocols.has(MOBILE_CHAT_WEBSOCKET_PROTOCOL)
        ? MOBILE_CHAT_WEBSOCKET_PROTOCOL
        : protocols.values().next().value || false
    ),
  });

  wss.on('connection', handleConnection);

  const upgradedSockets = new WeakSet<net.Socket>();

  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const normalizedUrl = normalizeChatWebSocketPath(request.url);

    if (normalizedUrl) {
      const origin = getHeaderValue(request.headers, 'origin');
      const hasMobileTicket = hasPendingMobileChatTicket(request.headers);
      if (!isConfiguredTrustedOrigin(origin) && !hasMobileTicket) {
        console.warn('[WebSocket] upgrade rejected untrusted_origin', {
          origin: truncateForLog(origin),
        });
        rejectWebSocketUpgrade(socket);
        return;
      }

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
  let pendingMessageBytes = 0;
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
        subscribedSessions: connection.sessionIds.size,
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
      bufferedBytes: pendingMessageBytes,
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
    const authenticatedConnection = connection;

    try {
      const parsedMessage = parseClientMessage(JSON.parse(data.toString()));
      if (!parsedMessage.ok) {
        console.warn('[WebSocket] invalid client message', {
          connectionId,
          userId: authenticatedConnection.userId,
          code: parsedMessage.code,
          error: parsedMessage.error,
        });
        sendWs(ws, { type: 'error', error: parsedMessage.error, code: parsedMessage.code });
        return;
      }
      const message = parsedMessage.message;
      console.log('[WebSocket] server_receive', {
        connectionId,
        userId: authenticatedConnection.userId,
        ...summarizeClientMessage(message),
      });
      const messageHandler = shouldSerializeSessionAction(message)
        ? runWebSocketSessionAction(authenticatedConnection.userId, message.sessionId, () => handleMessage(authenticatedConnection, message))
        : handleMessage(authenticatedConnection, message);
      void messageHandler.catch((error) => {
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
    if (data.length > MAX_INBOUND_MESSAGE_BYTES) {
      console.warn('[WebSocket] inbound message rejected too_large', {
        connectionId,
        bytes: data.length,
        maxBytes: MAX_INBOUND_MESSAGE_BYTES,
        authenticated: Boolean(connection),
      });
      sendWs(ws, { type: 'error', error: 'WebSocket message too large', code: 'MESSAGE_TOO_LARGE' });
      ws.close(1009, 'Message too large');
      return;
    }

    if (!connection) {
      // Auth not yet complete — buffer the message
      if (
        pendingMessages.length >= MAX_PREAUTH_BUFFERED_MESSAGES ||
        pendingMessageBytes + data.length > MAX_PREAUTH_BUFFERED_BYTES
      ) {
        console.warn('[WebSocket] preauth buffer rejected too_large', {
          connectionId,
          bufferedMessages: pendingMessages.length,
          bufferedBytes: pendingMessageBytes,
          incomingBytes: data.length,
          maxMessages: MAX_PREAUTH_BUFFERED_MESSAGES,
          maxBytes: MAX_PREAUTH_BUFFERED_BYTES,
        });
        sendWs(ws, { type: 'error', error: 'WebSocket authentication buffer exceeded', code: 'PREAUTH_BUFFER_EXCEEDED' });
        ws.close(1009, 'Pre-auth buffer exceeded');
        return;
      }

      pendingMessages.push(data);
      pendingMessageBytes += data.length;
      console.log('[WebSocket] buffered_pre_auth_message', {
        connectionId,
        bufferedMessages: pendingMessages.length,
        bufferedBytes: pendingMessageBytes,
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

  if (cleanupDone || ws.readyState !== WebSocket.OPEN) {
    console.log('[WebSocket] auth_aborted socket_closed', {
      connectionId,
      stage: 'identity',
      readyState: ws.readyState,
    });
    return;
  }

  if (!authResult.isAuthenticated) {
    console.error('[WebSocket] auth_failed', {
      connectionId,
      error: authResult.error,
      bufferedMessages: pendingMessages.length,
    });
    sendWs(ws, { type: 'auth_error', error: authResult.error || 'Authentication failed' });
    ws.close(CHAT_WEBSOCKET_CLOSE_CODES.unauthorized, 'Unauthorized');
    return;
  }

  const isLicensed = await isLicensedForRuntime();
  if (cleanupDone || ws.readyState !== WebSocket.OPEN) {
    console.log('[WebSocket] auth_aborted socket_closed', {
      connectionId,
      stage: 'license',
      readyState: ws.readyState,
    });
    return;
  }

  if (!isLicensed) {
    console.warn('[WebSocket] auth_rejected_license_required', {
      connectionId,
      userId: authResult.userId,
    });
    sendWs(ws, { type: 'auth_error', error: 'License activation required' });
    ws.close(CHAT_WEBSOCKET_CLOSE_CODES.licenseRequired, 'License activation required');
    return;
  }

  console.log('[WebSocket] auth_success', {
    connectionId,
    userId: authResult.userId,
    bufferedMessages: pendingMessages.length,
    bufferedBytes: pendingMessageBytes,
  });

  // Create connection state
  connection = {
    id: connectionId,
    ws,
    userId: authResult.userId!,
    workspace: authResult.workspace,
    sessionIds: new Set(),
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
    pendingMessages.length = 0;
    pendingMessageBytes = 0;
  }

  // Handle pong (heartbeat response)
  ws.on('pong', () => {
    if (!connection || cleanupDone) return;
    connection.isAlive = true;
    connection.lastActivity = Date.now();
    if (LOG_HEARTBEAT_SUCCESS) {
      console.log('[WebSocket] heartbeat_pong', {
        connectionId,
        userId: connection.userId,
        subscribedSessions: connection.sessionIds.size,
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

      if (!(await userOwnsSession(message.sessionId, userId, connection.workspace))) {
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
      void getRuntimeService()
        .then((runtimeService) => runtimeService.prewarmSessionRuntime(message.sessionId, userId))
        .then((status) => {
          console.log('[WebSocket] subscribe runtime_prewarmed', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
            phase: status.phase,
          });
        })
        .catch((error) => {
          console.warn('[WebSocket] subscribe runtime_prewarm_failed', {
            connectionId: connection.id,
            userId,
            requestId: message.requestId,
            sessionId: message.sessionId,
            error: getErrorMessage(error),
          });
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
        connection.sessionIds.delete(message.sessionId);
        console.log('[WebSocket] unsubscribe completed', {
          connectionId: connection.id,
          userId,
          sessionId: message.sessionId,
        });
      }
      break;
    }

    case 'send_message': {
      const dispatchTiming = createOperationTiming();
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
      dispatchTiming.mark('runtimeServiceImport');
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
      const existingSession = await findSessionIdentity(message.sessionId);
      dispatchTiming.mark('sessionAuthorization');
      if (existingSession && existingSession.userId !== userId) {
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
      if (
        connection.workspace &&
        (!existingSession || (
          existingSession.workspaceId !== connection.workspace.workspaceId &&
          !(connection.workspace.workspaceType === 'personal' && existingSession.workspaceId === null)
        ))
      ) {
        console.warn('[WebSocket] send_message rejected workspace_mismatch', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
        });
        sendWs(ws, { type: 'error', error: 'Session not found', code: 'UNAUTHORIZED' });
        sendWs(ws, { type: 'send_message_result', requestId: message.requestId, success: false, error: 'Session not found' });
        return;
      }
      const requestedAgentId = typeof message.agentId === 'string'
        ? message.agentId.trim() || undefined
        : undefined;
      const agentId = existingSession?.agentId || requestedAgentId;
      if (existingSession && requestedAgentId && requestedAgentId !== existingSession.agentId) {
        console.warn('[WebSocket] send_message corrected stale agent', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          requestedAgentId,
          sessionAgentId: existingSession.agentId,
        });
      }

      const context = connection.workspace
        ? {
            ...message.context,
            channelId: 'mobile',
            currentPage: '/chat',
            workspace: connection.workspace,
          }
        : message.context;
      const agentMessageTimestamp = typeof (message.message as { timestamp?: unknown }).timestamp === 'number'
        ? (message.message as { timestamp: number }).timestamp
        : undefined;

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
        dispatchTiming.mark('channelRouterImport');
        const status = await handleInboundChannelMessage({
          channelId: WEB_CHANNEL_ID,
          channelSessionKey: webChannelSessionKey(userId),
          requestedSessionId: message.sessionId,
          agentId,
          ...(typeof message.clientMessageId === 'string' ? { clientMessageId: message.clientMessageId } : {}),
          ...(agentMessageTimestamp ? { agentMessageTimestamp } : {}),
          userId,
          text: typeof message.message.content === 'string' ? message.message.content : '',
          contentParts: Array.isArray(message.message.content) ? message.message.content : undefined,
          metadata: { displayName: 'Web Chat' },
        }, context);
        dispatchTiming.mark('runtimeDispatch');
        console.log('[WebSocket] send_message runtime_started', {
          connectionId: connection.id,
          userId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          resolvedSessionId: status.sessionId,
          phase: status.status.phase,
          canAbort: status.status.canAbort,
          timing: dispatchTiming.snapshot(),
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
          timing: dispatchTiming.snapshot(),
        });
        const clientError = getClientError(error);
        sendWs(ws, {
          type: 'error',
          error: clientError.message,
          code: clientError.code,
        });
        sendWs(ws, {
          type: 'send_message_result',
          requestId: message.requestId,
          success: false,
          error: clientError.message,
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

      if (!(await userOwnsSession(message.sessionId, userId, connection.workspace))) {
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
        const status = await runtimeService.control(
          message.sessionId,
          userId,
          message.action,
          message.message,
          message.queueItemId,
          message.context,
          message.focusTopic,
        );
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

      if (!(await userOwnsSession(message.sessionId, userId, connection.workspace))) {
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
  const { id, ws, userId, sessionIds } = connection;

  if (!connections.has(ws)) {
    console.log('[WebSocket] disconnect cleanup skipped already removed', {
      connectionId: id,
      userId,
      subscribedSessions: sessionIds.size,
    });
    return;
  }

  for (const sessionId of sessionIds) {
    unsubscribeFromSession(sessionId, ws);
  }
  sessionIds.clear();

  removeUserConnection(userId, ws);
  connections.delete(ws);

  // Clean up user connections
  const allRemainingUserConnections = Array.from(connections.values())
    .filter(c => c.userId === userId);

  console.log('[WebSocket] disconnect cleanup complete', {
    connectionId: id,
    userId,
    subscribedSessions: 0,
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
const heartbeatIntervals = new WeakMap<WebSocketServer, ReturnType<typeof setInterval>>();

function startHeartbeat(wss: WebSocketServer): void {
  const existingInterval = heartbeatIntervals.get(wss);
  if (existingInterval) {
    clearInterval(existingInterval);
  }
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket) => {
      const connection = connections.get(ws);
      
      if (!connection) {
        return;
      }

      if (!connection.isAlive) {
        console.log('[WebSocket] heartbeat stale terminating connection', {
          connectionId: connection.id,
          userId: connection.userId,
          subscribedSessions: connection.sessionIds.size,
          idleMs: Date.now() - connection.lastActivity,
        });
        ws.terminate();
        return;
      }

      connection.isAlive = false;
      if (LOG_HEARTBEAT_SUCCESS) {
        console.log('[WebSocket] heartbeat_ping', {
          connectionId: connection.id,
          userId: connection.userId,
          subscribedSessions: connection.sessionIds.size,
        });
      }
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);
  heartbeatIntervals.set(wss, heartbeatInterval);
  heartbeatInterval.unref?.();

  console.log('[WebSocket] Heartbeat started (30s interval)');
}

/** Stop accepting chat sockets and ask connected clients to reconnect elsewhere. */
export async function closeWebSocketServer(
  wss: WebSocketServer,
  code = CHAT_WEBSOCKET_CLOSE_CODES.serviceRestart,
  reason = 'Service restart',
): Promise<void> {
  const heartbeatInterval = heartbeatIntervals.get(wss);
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatIntervals.delete(wss);
  }

  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const forceCloseTimer = setTimeout(() => {
      for (const ws of wss.clients) {
        ws.terminate();
      }
    }, 2_000);
    forceCloseTimer.unref?.();

    wss.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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
  lastMessageAt?: string,
  workspaceId?: string,
): void {
  console.log('[WebSocket] broadcast_notification', {
    userId,
    sessionId,
    notificationType,
    hasPreview: Boolean(messagePreview),
    workspaceId,
  });
  broadcastToUser(userId, {
    type: 'notification',
    sessionId,
    sessionTitle,
    workspaceId,
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
  title?: string,
  workspaceId?: string,
): void {
  console.log('[WebSocket] broadcast_session_update', {
    userId,
    sessionId,
    lastMessageAt,
    hasTitle: Boolean(title),
    workspaceId,
  });
  broadcastToUser(userId, {
    type: 'session_updated',
    sessionId,
    workspaceId,
    lastMessageAt,
    title,
  });
}

/** Broadcast a title-only change without affecting unread-response state. */
export function broadcastSessionTitleUpdateToUser(
  userId: string,
  sessionId: string,
  title: string,
  titleGenerationState?: string | null,
): void {
  console.log('[WebSocket] broadcast_session_title_update', {
    userId,
    sessionId,
    hasTitle: Boolean(title),
    titleGenerationState,
  });
  broadcastToUser(userId, {
    type: 'session_title_updated',
    sessionId,
    title,
    titleGenerationState,
  });
}
