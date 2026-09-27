import http from 'node:http';
import net from 'node:net';

const ALLOWED_BACKENDS = new Set([3101, 3102]);

function requestHead(request: http.IncomingMessage): string {
  const lines = [`${request.method || 'GET'} ${request.url || '/'} HTTP/${request.httpVersion}`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** Stable browser origin whose new transports can be atomically sent to the surviving app process. */
export async function startCollaborationFailoverProxy(initialBackend: 3101 | 3102, port = 3000) {
  if (process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST !== '1'
    || process.env.CANVAS_PROPOSAL_CRASH_TEST !== '1'
    || process.env.NODE_ENV !== 'development'
    || port !== 3000 || !ALLOWED_BACKENDS.has(initialBackend)) {
    throw new Error('The failover proxy requires the explicit local multi-process acceptance harness.');
  }
  let activeBackend = initialBackend;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: activeBackend,
      method: request.method,
      path: request.url,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"backend_unavailable"}');
    });
    request.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: activeBackend });
    sockets.add(upstream);
    upstream.once('connect', () => {
      upstream.write(requestHead(request));
      if (head.byteLength) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.once('error', close);
    socket.once('error', close);
    upstream.once('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  let stopped = false;
  return {
    port,
    activeBackend: () => activeBackend,
    switchBackend(next: 3101 | 3102) {
      if (stopped || !ALLOWED_BACKENDS.has(next)) throw new Error('Invalid failover backend.');
      activeBackend = next;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
