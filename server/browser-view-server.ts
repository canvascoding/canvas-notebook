import type http from 'node:http';
import type net from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import { assertUnambiguousOwnedPiSessionForRuntime } from '@/app/lib/pi/session-runtime-access';
import { resolveAgentExecutionContextForSession } from '@/app/lib/pi/session-workspace-context';
import { assertBrowserRuntimeAvailable } from '@/app/lib/pi/browser/settings-service';
import { isBrowserLabAllowed } from '@/app/lib/pi/browser/view-access';
import { browserViewFailure } from '@/app/lib/pi/browser/view-errors';
import { resolveBrowserViewResourceBudget } from '@/app/lib/pi/browser/view-resource-budget';
import {
  allowBrowserViewMessage,
  createBrowserViewRateLimitState,
  type BrowserViewRateLimitState,
} from '@/app/lib/pi/browser/view-rate-limit';
import { BrowserViewService, type BrowserViewServerMessage } from '@/app/lib/pi/browser/view-service';
import { verifyBrowserViewTicket } from '@/app/lib/pi/browser/view-ticket';
import type { BrowserViewControlMode, BrowserViewFailure } from '@/app/lib/pi/browser/types';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';

import { authenticateWebSocketConnection } from './websocket-auth';

const BROWSER_VIEW_PATH = '/ws/browser';
const MAX_INBOUND_BYTES = 16 * 1024;
const MAX_BUFFERED_FRAME_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

type ClientMessage =
  | { type: 'view_subscribe'; ticket?: string }
  | { type: 'control_request'; mode?: BrowserViewControlMode }
  | { type: 'navigate'; url?: string }
  | { type: 'tab_select'; tabId?: string }
  | { type: 'input_mouse'; action?: 'move' | 'down' | 'up' | 'click'; x?: number; y?: number; button?: 'left' | 'middle' | 'right' }
  | { type: 'input_key'; key?: string; text?: string; modifiers?: string[] }
  | { type: 'input_scroll'; deltaX?: number; deltaY?: number }
  | { type: 'dialog_resolve'; accept?: boolean; promptText?: string }
  | { type: 'file_upload'; paths?: string[] }
  | { type: 'file_cancel' }
  | { type: 'frame_ack'; sequence?: number }
  | { type: 'heartbeat' };

type BrowserConnection = {
  ws: WebSocket;
  userId: string;
  authSessionId: string;
  service: BrowserViewService | null;
  isAlive: boolean;
  rateLimit: BrowserViewRateLimitState;
  operationQueue: Promise<void>;
};

const activeServices = new Set<BrowserViewService>();
const activeViewIds = new Set<string>();
const connections = new Set<BrowserConnection>();

function normalizeBrowserViewPath(requestUrl?: string): string | null {
  const [requestPath, query = ''] = (requestUrl || '').split('?', 2);
  if (requestPath === BROWSER_VIEW_PATH) return query ? `${BROWSER_VIEW_PATH}?${query}` : BROWSER_VIEW_PATH;
  if (/^\/[a-z]{2}(?:-[A-Z]{2})?\/ws\/browser$/u.test(requestPath)) {
    return query ? `${BROWSER_VIEW_PATH}?${query}` : BROWSER_VIEW_PATH;
  }
  return null;
}

export function isBrowserViewWebSocketRequest(requestUrl?: string): boolean {
  return normalizeBrowserViewPath(requestUrl) !== null;
}

function reject(socket: net.Socket, status = '403 Forbidden'): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sendJson(ws: WebSocket, message: BrowserViewServerMessage | { type: 'auth_success' }): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (message.type === 'frame' && ws.bufferedAmount > MAX_BUFFERED_FRAME_BYTES) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function sendError(ws: WebSocket, failure: BrowserViewFailure): void {
  sendJson(ws, { type: 'error', ...failure });
}

function isInputMessage(message: ClientMessage): boolean {
  return message.type === 'input_mouse' || message.type === 'input_key' || message.type === 'input_scroll';
}

async function subscribe(connection: BrowserConnection, token: string): Promise<void> {
  if (connection.service) throw new Error('Browser view is already subscribed.');
  const claims = verifyBrowserViewTicket(token);
  if (claims.userId !== connection.userId || claims.authSessionId !== connection.authSessionId) {
    throw new Error('Browser view ticket does not match the authenticated session.');
  }
  if (activeViewIds.has(claims.viewId)) {
    throw new Error('Browser view ticket is already connected.');
  }

  const session = await assertUnambiguousOwnedPiSessionForRuntime({
    sessionId: claims.agentSessionId,
    userId: connection.userId,
    agentId: claims.agentId,
  });
  const executionContext = await resolveAgentExecutionContextForSession({
    sessionId: session.sessionId,
    userId: connection.userId,
    agentId: session.agentId,
  });
  if (
    executionContext.workspaceId !== claims.workspaceId
    || executionContext.workspaceType !== claims.workspaceType
    || (executionContext.organizationId ?? null) !== claims.organizationId
  ) {
    throw new Error('Browser view workspace scope changed.');
  }

  await assertBrowserRuntimeAvailable();
  const budget = await resolveBrowserViewResourceBudget();
  if (!budget.allowed) throw new Error(budget.reason || 'Interactive browser view is unavailable.');
  if (activeServices.size >= budget.maxConcurrentViews) {
    throw new Error('Interactive browser view capacity is currently exhausted.');
  }

  const service = new BrowserViewService(claims, budget, (message) => sendJson(connection.ws, message));
  connection.service = service;
  activeServices.add(service);
  activeViewIds.add(claims.viewId);
  try {
    await service.start();
  } catch (error) {
    service.close();
    activeServices.delete(service);
    activeViewIds.delete(claims.viewId);
    connection.service = null;
    throw error;
  }
}

async function handleMessage(connection: BrowserConnection, message: ClientMessage): Promise<void> {
  const rateLimitedMessage = message.type !== 'frame_ack' && message.type !== 'heartbeat';
  if (rateLimitedMessage && !allowBrowserViewMessage(connection.rateLimit, isInputMessage(message))) {
    throw new Error('Browser view rate limit exceeded.');
  }
  if (message.type === 'view_subscribe') {
    if (typeof message.ticket !== 'string' || !message.ticket) throw new Error('Browser view ticket is required.');
    await subscribe(connection, message.ticket);
    return;
  }
  const service = connection.service;
  if (!service) throw new Error('Subscribe to a browser view first.');

  switch (message.type) {
    case 'control_request':
      if (message.mode !== 'view' && message.mode !== 'agent' && message.mode !== 'user') {
        throw new Error('Invalid browser control mode.');
      }
      await service.requestControl(message.mode);
      break;
    case 'navigate':
      if (typeof message.url !== 'string') throw new Error('A browser URL is required.');
      await service.navigate(message.url);
      break;
    case 'tab_select':
      if (typeof message.tabId !== 'string') throw new Error('A browser tab is required.');
      await service.selectTab(message.tabId);
      break;
    case 'input_mouse':
      if (!message.action || typeof message.x !== 'number' || typeof message.y !== 'number') {
        throw new Error('Valid mouse input is required.');
      }
      await service.mouse({ action: message.action, x: message.x, y: message.y, button: message.button });
      break;
    case 'input_key':
      if (typeof message.key !== 'string') throw new Error('Valid keyboard input is required.');
      await service.key({ key: message.key, text: message.text, modifiers: message.modifiers });
      break;
    case 'input_scroll':
      await service.scroll({ deltaX: message.deltaX, deltaY: message.deltaY });
      break;
    case 'dialog_resolve':
      await service.resolveDialog(message.accept === true, message.promptText);
      break;
    case 'file_upload':
      await service.uploadFiles(message.paths);
      break;
    case 'file_cancel':
      await service.cancelFileChooser();
      break;
    case 'frame_ack':
      if (typeof message.sequence === 'number') service.acknowledgeFrame(message.sequence);
      break;
    case 'heartbeat':
      service.heartbeat();
      await service.publishState(false);
      break;
  }
}

async function handleConnection(ws: WebSocket, request: http.IncomingMessage): Promise<void> {
  const authResult = await authenticateWebSocketConnection(request.headers);
  if (!authResult.isAuthenticated || !authResult.userId || !authResult.sessionId) {
    sendError(ws, { code: 'UNAUTHORIZED', error: 'Authentication required.', retryable: false, fatal: true });
    ws.close(4001, 'Unauthorized');
    return;
  }
  if (!isBrowserLabAllowed({ role: authResult.userRole, email: authResult.userEmail })) {
    sendError(ws, { code: 'FORBIDDEN', error: 'Browser Lab is restricted to development and administrators.', retryable: false, fatal: true });
    ws.close(4003, 'Forbidden');
    return;
  }

  const connection: BrowserConnection = {
    ws,
    userId: authResult.userId,
    authSessionId: authResult.sessionId,
    service: null,
    isAlive: true,
    rateLimit: createBrowserViewRateLimitState(),
    operationQueue: Promise.resolve(),
  };
  connections.add(connection);

  sendJson(ws, { type: 'auth_success' });
  ws.on('pong', () => {
    connection.isAlive = true;
    connection.service?.heartbeat();
  });
  ws.on('message', (raw) => {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (bytes.length > MAX_INBOUND_BYTES) {
      sendError(ws, { code: 'MESSAGE_TOO_LARGE', error: 'Browser view message is too large.', retryable: false, fatal: true });
      ws.close(1009, 'Message too large');
      return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(bytes.toString('utf8')) as ClientMessage;
    } catch {
      sendError(ws, { code: 'INVALID_MESSAGE', error: 'Invalid browser view message.', retryable: false, fatal: false });
      return;
    }
    connection.operationQueue = connection.operationQueue
      .then(() => handleMessage(connection, message))
      .catch((error) => {
        const context = message.type === 'view_subscribe'
          ? 'subscribe'
          : message.type === 'navigate'
            ? 'navigate'
            : 'operation';
        const failure = browserViewFailure(error, context);
        sendError(ws, failure);
        if (failure.fatal && ws.readyState === WebSocket.OPEN) ws.close(1011, failure.code);
      });
  });
  const cleanup = () => {
    connections.delete(connection);
    if (connection.service) {
      connection.service.close();
      activeServices.delete(connection.service);
      activeViewIds.delete(connection.service.claims.viewId);
      connection.service = null;
    }
  };
  ws.once('close', cleanup);
  ws.once('error', cleanup);
}

export function createBrowserViewServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, path: BROWSER_VIEW_PATH });
  wss.on('connection', (ws, request) => void handleConnection(ws, request));

  server.on('upgrade', (request, socket, head) => {
    const normalizedUrl = normalizeBrowserViewPath(request.url);
    if (!normalizedUrl) return;
    if (!isConfiguredTrustedOrigin(request.headers.origin)) return reject(socket as net.Socket);
    request.url = normalizedUrl;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.isAlive) {
        connection.ws.terminate();
        continue;
      }
      connection.isAlive = false;
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  wss.once('close', () => clearInterval(heartbeat));
  return wss;
}
