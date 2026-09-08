import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

import { resolvePublicNetworkAddress } from '@/app/lib/security/safe-external-fetch';

const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_UPLOAD_BYTES = 1024 * 1024;

/** A job-owned forward proxy. DNS is resolved and pinned here, never in Chromium. */
export async function createPdfNetworkProxy() {
  const sockets = new Set<Duplex>();
  let closed = false;
  const track = (socket: Duplex) => {
    if (closed || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return false; }
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    return true;
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    request.on('error', () => response.destroy());
    response.on('error', () => request.destroy());
    void (async () => {
      const url = new URL(request.url || '');
      if (url.protocol !== 'http:') throw new Error('HTTP proxy URL required');
      const target = await resolvePublicNetworkAddress(url);
      if (closed || request.destroyed) return;
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
      for (const name of ['cookie', 'authorization', 'proxy-authorization', 'proxy-connection', 'connection', 'upgrade']) {
        delete headers[name];
      }
      // A client cannot nominate security-sensitive fields as hop-by-hop fields.
      for (const name of String(request.headers.connection || '').split(',')) delete headers[name.trim().toLowerCase()];
      headers.host = url.host;
      const upstream = http.request({
        hostname: target.address, family: target.family, port: Number(url.port || 80),
        method: request.method, path: url.pathname + url.search, headers, agent: false,
      }, (incoming) => {
        const responseHeaders = { ...incoming.headers };
        delete responseHeaders['set-cookie'];
        delete responseHeaders.connection;
        delete responseHeaders['proxy-authenticate'];
        response.writeHead(incoming.statusCode || 502, responseHeaders);
        incoming.on('error', () => response.destroy());
        incoming.pipe(response);
      });
      upstream.on('socket', track);
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.setTimeout(REQUEST_TIMEOUT_MS, () => upstream.destroy());
      response.once('close', () => upstream.destroy());
      let uploaded = 0;
      request.on('data', (chunk: Buffer) => {
        uploaded += chunk.length;
        if (uploaded > MAX_UPLOAD_BYTES) { upstream.destroy(); request.destroy(); }
      });
      request.pipe(upstream);
    })().catch(() => { response.writeHead(403); response.end(); });
  });
  server.on('connection', (socket) => {
    if (track(socket)) socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  // Plain WS upgrade is unnecessary for a static export. Secure WebSockets use
  // CONNECT and receive the same pinned public-address policy as HTTPS.
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (request, client, head) => {
    void (async () => {
      if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):(?:80|443)$/iu.test(request.url || '')) throw new Error('Invalid tunnel target');
      const url = new URL(`https://${request.url}`);
      const target = await resolvePublicNetworkAddress(url);
      if (closed || client.destroyed) return;
      const upstream = net.connect({ host: target.address, family: target.family, port: Number(url.port || 443) });
      if (!track(upstream)) { client.destroy(); return; }
      upstream.setTimeout(REQUEST_TIMEOUT_MS, () => upstream.destroy());
      upstream.once('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    })().catch(() => { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as net.AddressInfo;
  return {
    contextOptions: { proxyServer: `http://127.0.0.1:${address.port}`, proxyBypassList: ['<-loopback>'] },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
