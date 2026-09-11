import type http from 'node:http';
import type net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { GET as files } from '../app/api/files/watch/route';
import { GET as presence } from '../app/api/files/presence/route';
import { GET as terminal } from '../app/api/terminal/availability/route';
import { isConfiguredTrustedOrigin } from '../app/lib/security/trusted-origins';
import { LIVE_EVENTS_PATH, LIVE_EVENTS_PROTOCOL } from '../app/lib/live-events/protocol';
import { attachLiveEventConnection } from './live-events-connection';

export function isLiveEventsWebSocketRequest(requestUrl?: string): boolean {
  try { const url = new URL(requestUrl ?? '', 'http://localhost'); return url.pathname === LIVE_EVENTS_PATH && !url.search; }
  catch { return false; }
}

export function createLiveEventsServer(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192,
    handleProtocols: protocols => protocols.has(LIVE_EVENTS_PROTOCOL) ? LIVE_EVENTS_PROTOCOL : false });
  const alive = new WeakSet<WebSocket>();
  const upgrade = (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (!isLiveEventsWebSocketRequest(request.url)) return;
    if (!isConfiguredTrustedOrigin(request.headers.origin) || wss.clients.size >= 256
      || !request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()).includes(LIVE_EVENTS_PROTOCOL)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      attachLiveEventConnection(ws, request, { files, presence, terminal });
    });
  };
  server.on('upgrade', upgrade);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws); ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  return {
    close: () => new Promise<void>(resolve => {
      clearInterval(heartbeat); server.off('upgrade', upgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}
