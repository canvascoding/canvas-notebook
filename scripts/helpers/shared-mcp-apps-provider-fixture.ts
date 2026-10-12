import http from 'node:http';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

/** Own loopback protocol provider; counters record actual MCP requests only. */
export async function createSharedMcpAppsProviderFixture(options: { html?: string; controlToken?: string; allowModelVerification?: boolean } = {}) {
  const resourceUri = 'ui://shared-app-fixture/design.html';
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const resourceReads: string[] = [];
  const requests: string[] = [];
  let origin = '';
  let listHook: (() => Promise<void>) | null = null;
  let resourceHook: (() => Promise<void>) | null = null;
  let sourceResourceUri = resourceUri;
  let targetVisible = true;
  let verificationProbes = 0;
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'shared-app-fixture', version: '1.0.0' }, {
      capabilities: { tools: { listChanged: true }, resources: {} },
    });
    server.setRequestHandler('tools/list', async () => {
      const hook = listHook; listHook = null; await hook?.();
      return { tools: [
        { name: 'app_view', description: 'Open the shared design app', inputSchema: { type: 'object', additionalProperties: false },
          annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: sourceResourceUri, visibility: ['model', 'app'] } } },
        { name: 'app_action', description: 'Read the selected design', inputSchema: { type: 'object',
          properties: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false },
          annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri, visibility: targetVisible ? ['app'] : ['model'] } } },
        { name: 'model_only', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true },
          _meta: { ui: { visibility: ['model'] } } },
      ] };
    });
    server.setRequestHandler('tools/call', async request => {
      calls.push({ name: request.params.name, arguments: request.params.arguments });
      return { content: [{ type: 'text', text: 'Shared fixture result' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEvkAAAAASUVORK5CYII=' }],
        structuredContent: { fixture: true }, _meta: { fixtureUiSecret: 'ui-only-shared-app' } };
    });
    server.setRequestHandler('resources/read', async request => {
      resourceReads.push(request.params.uri);
      const hook = resourceHook; resourceHook = null; await hook?.();
      return { contents: [{ uri: request.params.uri, mimeType: 'text/html;profile=mcp-app',
        text: options.html ?? '<!doctype html><title>Shared design fixture</title><h1>Shared design fixture</h1>' }] };
    });
    return server;
  }, { legacy: 'reject' });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/__fixture/state' && request.method === 'GET') {
        if (!options.controlToken || request.headers.authorization !== `Bearer ${options.controlToken}`) {
          response.writeHead(404).end(); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ requests, calls: calls.map(call => ({ name: call.name })), resourceReads, verificationProbes })); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.url?.startsWith('/v1/')) {
        if (!options.allowModelVerification || request.url !== '/v1/chat/completions' || request.method !== 'POST') {
          response.writeHead(404).end(); return;
        }
        if (Buffer.byteLength(body) > 65_536) { response.writeHead(413).end(); return; }
        const input = JSON.parse(body) as { model?: unknown; stream?: unknown };
        if (input.model !== 'shared-apps-fixture') { response.writeHead(404).end(); return; }
        verificationProbes += 1;
        const common = { id: 'fixture-model-verification', created: Math.floor(Date.now() / 1000), model: 'shared-apps-fixture' };
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        if (input.stream === true) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0,
            delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0,
            delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0,
            message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage }));
        }
        return;
      }
      if (body) requests.push(String(JSON.parse(body).method ?? 'unknown'));
      const result = await handler.fetch(new Request(`${origin}${request.url}`, { method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        ...(body ? { body } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end('Fixture protocol failure');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, url: `${origin}/mcp`, resourceUri, calls, resourceReads, requests,
    verificationProbes: () => verificationProbes,
    onList: (hook: () => Promise<void>) => { listHook = hook; },
    onResource: (hook: () => Promise<void>) => { resourceHook = hook; },
    setSourceResource: (uri: string) => { sourceResourceUri = uri; },
    setTargetVisible: (visible: boolean) => { targetVisible = visible; },
    close: async () => {
      await handler.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
