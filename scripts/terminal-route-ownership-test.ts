import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

import { NextRequest } from 'next/server';

type LoadFn = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const moduleInternals = Module as typeof Module & { _load: LoadFn };
const originalLoad = moduleInternals._load;
const ownerId = 'terminal-owner';
let authenticated = true;
const calls: Array<{ method: string; args: unknown[] }> = [];
const protocolMessages: Array<{ method: string; params: Record<string, unknown> }> = [];

function matches(request: string, suffix: string): boolean {
  return request === `@/app/lib/${suffix}` || request.endsWith(`/app/lib/${suffix}`);
}

class MockSocket extends EventEmitter {
  destroyed = false;

  connect(): this {
    queueMicrotask(() => this.emit('connect'));
    return this;
  }

  write(payload: string): boolean {
    for (const line of payload.trim().split('\n')) {
      const message = JSON.parse(line) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      protocolMessages.push({ method: message.method, params: message.params });
      if (message.method === 'auth') {
        queueMicrotask(() => this.emit('data', Buffer.from(`${JSON.stringify({
          id: message.id,
          result: { success: true },
        })}\n`)));
      } else if (message.method === 'attach') {
        queueMicrotask(() => this.emit('data', Buffer.from(`${JSON.stringify({
          id: message.id,
          result: { success: true },
        })}\n`)));
      }
    }
    return true;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
    }
    return this;
  }
}

const terminalClient = {
  createSession: async (...args: unknown[]) => {
    calls.push({ method: 'create', args });
    return { success: true };
  },
  sendInput: async (...args: unknown[]) => {
    calls.push({ method: 'input', args });
    return { success: true };
  },
  resize: async (...args: unknown[]) => {
    calls.push({ method: 'resize', args });
    return { success: true };
  },
  terminate: async (...args: unknown[]) => {
    calls.push({ method: 'terminate', args });
    return { success: true };
  },
  terminateAll: async (...args: unknown[]) => {
    calls.push({ method: 'terminateAll', args });
    return { success: true, closed: 1 };
  },
};

moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === 'net') return { Socket: MockSocket };
  if (matches(request, 'auth')) {
    return {
      auth: {
        api: {
          getSession: async () => authenticated
            ? { user: { id: ownerId, email: 'owner@example.test' } }
            : null,
        },
      },
    };
  }
  if (matches(request, 'terminal-client')) {
    return { getTerminalClient: () => terminalClient };
  }
  if (matches(request, 'pi/session-workspace-context')) {
    return {
      resolveAgentSessionWorkspaceForUser: async () => ({
        rootPath: '/data/workspaces/terminal-owner',
      }),
    };
  }
  if (matches(request, 'terminal-transport')) {
    return {
      resolveTerminalTransport: () => ({
        useUnixSocket: true,
        socketPath: '/tmp/terminal-test.sock',
        tcpHost: '127.0.0.1',
        tcpPort: 3457,
      }),
    };
  }
  return originalLoad(request, parent, isMain);
};

async function main() {
  try {
    const [createRoute, inputRoute, resizeRoute, deleteRoute, streamRoute, killRoute] = await Promise.all([
      import('../app/api/terminal/create/route'),
      import('../app/api/terminal/[id]/input/route'),
      import('../app/api/terminal/[id]/resize/route'),
      import('../app/api/terminal/[id]/route'),
      import('../app/api/terminal/[id]/stream/route'),
      import('../app/api/terminal/kill/route'),
    ]);

    const sessionId = 'terminal-session';
    const createResponse = await createRoute.POST(new NextRequest('http://localhost:3000/api/terminal/create', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }));
    assert.equal(createResponse.status, 200);

    const inputResponse = await inputRoute.POST(new NextRequest(`http://localhost:3000/api/terminal/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 'id' }),
    }), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(inputResponse.status, 200);

    const resizeResponse = await resizeRoute.POST(new NextRequest(`http://localhost:3000/api/terminal/${sessionId}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols: 120, rows: 40 }),
    }), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(resizeResponse.status, 200);

    const deleteResponse = await deleteRoute.DELETE(new NextRequest(`http://localhost:3000/api/terminal/${sessionId}`, {
      method: 'DELETE',
    }), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(deleteResponse.status, 200);

    const killResponse = await killRoute.POST(new NextRequest('http://localhost:3000/api/terminal/kill', {
      method: 'POST',
    }));
    assert.equal(killResponse.status, 200);

    const streamRequest = new NextRequest(`http://localhost:3000/api/terminal/${sessionId}/stream`);
    const streamResponse = await streamRoute.GET(streamRequest, {
      params: Promise.resolve({ id: sessionId }),
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body?.getReader();
    assert(reader);
    await reader.read();
    streamRequest.signal.dispatchEvent(new Event('abort'));

    assert.deepEqual(calls, [
      { method: 'create', args: [sessionId, ownerId, '/data/workspaces/terminal-owner'] },
      { method: 'input', args: [sessionId, ownerId, 'id'] },
      { method: 'resize', args: [sessionId, ownerId, 120, 40] },
      { method: 'terminate', args: [sessionId, ownerId] },
      { method: 'terminateAll', args: [ownerId] },
    ]);
    assert.deepEqual(
      protocolMessages.find((message) => message.method === 'attach')?.params,
      { sessionId, ownerId }
    );

    authenticated = false;
    const unauthorizedResponse = await inputRoute.POST(new NextRequest(`http://localhost:3000/api/terminal/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 'whoami' }),
    }), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(calls.length, 5);

    console.log('terminal-route-ownership-test: ok');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
