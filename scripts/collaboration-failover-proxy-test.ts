import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import net from 'node:net';

import { startCollaborationFailoverProxy } from '../tests/helpers/collaboration-failover-proxy';

async function backend(port: number, label: string) {
  const server = http.createServer((_request, response) => response.end(label));
  server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
    socket.end(label);
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function get(): Promise<string> {
  return await (await fetch('http://127.0.0.1:3000/probe', { headers: { connection: 'close' } })).text();
}

async function upgrade(): Promise<string> {
  const socket = net.createConnection({ host: '127.0.0.1', port: 3000 });
  socket.write('GET /socket HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
  let value = '';
  socket.on('data', data => { value += data.toString('utf8'); });
  await once(socket, 'close');
  return value;
}

async function main() {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    crash: process.env.CANVAS_PROPOSAL_CRASH_TEST,
    multiprocess: process.env.CANVAS_COLLABORATION_MULTIPROCESS_TEST,
  };
  const mutableEnv = process.env as Record<string, string | undefined>;
  let first: http.Server | undefined;
  let second: http.Server | undefined;
  let proxy: Awaited<ReturnType<typeof startCollaborationFailoverProxy>> | undefined;
  try {
    Object.assign(process.env, { NODE_ENV: 'development', CANVAS_PROPOSAL_CRASH_TEST: '1',
      CANVAS_COLLABORATION_MULTIPROCESS_TEST: '1' });
    first = await backend(3101, 'process-a');
    second = await backend(3102, 'process-b');
    proxy = await startCollaborationFailoverProxy(3101);
    assert.equal(await get(), 'process-a');
    assert.match(await upgrade(), /process-a/u);
    proxy.switchBackend(3102);
    assert.equal(await get(), 'process-b');
    assert.match(await upgrade(), /process-b/u);
    console.log('Same-origin failover proxy sends new HTTP and WebSocket transports to the selected app process.');
  } finally {
    await proxy?.stop().catch(() => undefined);
    for (const server of [first, second]) if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries({ NODE_ENV: original.nodeEnv,
      CANVAS_PROPOSAL_CRASH_TEST: original.crash,
      CANVAS_COLLABORATION_MULTIPROCESS_TEST: original.multiprocess })) {
      if (value === undefined) delete process.env[key];
      else mutableEnv[key] = value;
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Failover proxy test failed.');
  process.exitCode = 1;
});
