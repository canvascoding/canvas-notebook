import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runLocalAgentTool } from '../tests/helpers/local-agent-tool-client';

const GENERIC_FAILURE = 'Local agent tool call failed.';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type RequestHandler = (socket: Socket, request: unknown) => void;

async function startServer(onRequest: RequestHandler): Promise<{
  socketPath: string;
  connections(): number;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-agent-tool-client-'));
  const socketPath = path.join(directory, 'agent.sock');
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let requestBytes = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      requestBytes = Buffer.concat([requestBytes, chunk]);
      const newline = requestBytes.indexOf(0x0a);
      if (newline < 0) return;
      try {
        onRequest(socket, JSON.parse(requestBytes.subarray(0, newline).toString('utf8')) as unknown);
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    connections: () => connectionCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function rejectsGenerically(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, GENERIC_FAILURE);
    return true;
  });
}

test('round-trips exactly one JSONL request and returns the result value', async () => {
  let receivedRequest: unknown;
  const server = await startServer((socket, request) => {
    receivedRequest = request;
    socket.end(`${JSON.stringify({ result: { accepted: true, value: 42 } })}\n`);
  });
  try {
    const input = { tool: 'edit_file', arguments: { path: 'notes.md', text: 'updated' } };
    const result = await runLocalAgentTool(input, server.socketPath);
    assert.deepEqual(receivedRequest, { input });
    assert.deepEqual(result, { accepted: true, value: 42 });
    assert.equal(server.connections(), 1);
  } finally {
    await server.close();
  }
});

test('malformed response uses one generic error', async () => {
  const server = await startServer((socket) => socket.end('{not-json}\n'));
  try {
    await rejectsGenerically(() => runLocalAgentTool({ input: 'private text' }, server.socketPath));
  } finally {
    await server.close();
  }
});

test('disconnect uses one generic error and never retries', async () => {
  const server = await startServer((socket) => socket.destroy());
  try {
    await rejectsGenerically(() => runLocalAgentTool({ input: 'private text' }, server.socketPath));
    assert.equal(server.connections(), 1);
  } finally {
    await server.close();
  }
});

test('response above two MiB uses one generic error', async () => {
  const server = await startServer((socket) => socket.write(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x61)));
  try {
    await rejectsGenerically(() => runLocalAgentTool({}, server.socketPath));
  } finally {
    await server.close();
  }
});

test('timeout uses one generic error', async () => {
  const server = await startServer(() => {});
  try {
    await rejectsGenerically(() => runLocalAgentTool({}, server.socketPath, { timeoutMs: 25 }));
  } finally {
    await server.close();
  }
});

test('server error and busy responses never expose server details', async () => {
  const secretDetails = 'busy /private/socket path=notes.md api-key=do-not-leak';
  const server = await startServer((socket) => socket.end(`${JSON.stringify({ error: secretDetails })}\n`));
  try {
    await rejectsGenerically(() => runLocalAgentTool({ secret: 'caller input' }, server.socketPath));
  } finally {
    await server.close();
  }
});

test('relative paths and non-socket network URLs are rejected without a connection', async () => {
  const server = await startServer((socket) => socket.end(`${JSON.stringify({ result: null })}\n`));
  try {
    await rejectsGenerically(() => runLocalAgentTool({}, 'relative.sock'));
    await rejectsGenerically(() => runLocalAgentTool({}, 'tcp://127.0.0.1:1234'));
    assert.equal(server.connections(), 0);
  } finally {
    await server.close();
  }
});

test('request above 256 KiB is rejected before opening the socket', async () => {
  const server = await startServer((socket) => socket.end(`${JSON.stringify({ result: null })}\n`));
  try {
    await rejectsGenerically(() => runLocalAgentTool({ text: 'x'.repeat(256 * 1024) }, server.socketPath));
    assert.equal(server.connections(), 0);
  } finally {
    await server.close();
  }
});
