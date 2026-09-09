import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

function startFixture(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server did not expose an address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

async function expectRejects(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => pattern.test(error instanceof Error ? error.message : String(error)));
}

async function main() {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPrivateNetwork = process.env.MCP_ALLOW_PRIVATE_NETWORK;
  const originalInsecureHttp = process.env.MCP_ALLOW_INSECURE_HTTP;
  const env = process.env as Record<string, string | undefined>;
  const { assertMcpHttpUrlAllowed } = await import('../app/lib/mcp/network-policy');
  const { fetchMcpHttp } = await import('../app/lib/mcp/http');

  try {
    env.NODE_ENV = 'production';
    delete process.env.MCP_ALLOW_PRIVATE_NETWORK;
    delete process.env.MCP_ALLOW_INSECURE_HTTP;

    for (const rawUrl of [
      'https://127.0.0.1:443',
      'https://localhost:443',
      'https://[::1]:443',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:169.254.169.254]/',
    ]) {
      await expectRejects(
        () => assertMcpHttpUrlAllowed(rawUrl, 'production private-network test'),
        /private|local|loopback|blocked|forbidden/i,
      );
    }
    const publicUrl = await assertMcpHttpUrlAllowed('https://1.1.1.1/', 'public-IP test');
    assert.equal(publicUrl.hostname, '1.1.1.1');

    env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
    env.MCP_ALLOW_INSECURE_HTTP = 'true';

    let fixtureUrl = '';
    let otherUrl = '';
    let otherHits = 0;
    let postTargetHits = 0;
    const fixture = await startFixture((request, response) => {
      const path = new URL(request.url || '/', fixtureUrl || 'http://127.0.0.1').pathname;
      if (path === '/same-origin-start') {
        response.writeHead(302, { location: '/final' }).end();
        return;
      }
      if (path === '/manual-redirect') {
        response.writeHead(302, { location: '/final' }).end();
        return;
      }
      if (path === '/cross-origin') {
        response.writeHead(302, { location: `${otherUrl}/final` }).end();
        return;
      }
      if (path === '/final') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (path === '/loop-a') {
        response.writeHead(302, { location: '/loop-b' }).end();
        return;
      }
      if (path === '/loop-b') {
        response.writeHead(302, { location: '/loop-a' }).end();
        return;
      }
      if (path === '/post-redirect') {
        response.writeHead(302, { location: '/post-target' }).end();
        return;
      }
      if (path === '/post-target') {
        postTargetHits += 1;
        response.writeHead(200).end('unexpected replay');
        return;
      }
      if (path === '/upload') {
        request.resume();
        request.once('end', () => response.writeHead(200).end('uploaded'));
        return;
      }
      if (path === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('0123456789');
        return;
      }
      if (path === '/declared-large') {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' }).end('0123456789');
        return;
      }
      if (path === '/chunked-large') {
        response.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
        response.write('0123');
        setTimeout(() => response.end('456789'), 5);
        return;
      }
      if (path === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        let event = 0;
        response.write(`data: ${event++}\n\n`);
        const interval = setInterval(() => response.write(`data: ${event++}\n\n`), 10);
        setTimeout(() => {
          clearInterval(interval);
          response.end();
        }, 60);
        return;
      }
      if (path === '/events-stall') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: initial\n\n');
        setTimeout(() => response.end(), 60);
        return;
      }
      if (path === '/slow') {
        setTimeout(() => response.writeHead(200).end('late'), 150);
        return;
      }
      response.writeHead(404).end('missing');
    });
    fixtureUrl = fixture.url;

    try {
      const valid = await fetchMcpHttp(`${fixture.url}/same-origin-start`, { headers: { accept: 'text/plain' } });
      assert.equal(valid.status, 200);
      assert.equal(await valid.text(), 'ok');

      const manual = await fetchMcpHttp(`${fixture.url}/manual-redirect`, { redirect: 'manual' });
      assert.equal(manual.status, 302);
      assert.equal(manual.headers.get('location'), '/final');

      await expectRejects(
        () => fetchMcpHttp(`${fixture.url}/loop-a`, undefined, { maxRedirects: 1 }),
        /redirect/i,
      );

      const other = await startFixture((_request, response) => {
        otherHits += 1;
        response.writeHead(200).end('other-origin');
      });
      try {
        otherUrl = other.url;
        await expectRejects(
          () => fetchMcpHttp(`${fixture.url}/cross-origin`, { headers: { authorization: 'Bearer test' } }),
          /cross-origin|credential|header|redirect/i,
        );
        assert.equal(otherHits, 0, 'credentialed cross-origin redirect must not reach its target');
        await expectRejects(
          () => fetchMcpHttp(`${fixture.url}/post-redirect`, { method: 'POST', body: 'payload' }),
          /redirect|POST|replay/i,
        );
        assert.equal(postTargetHits, 0, 'POST redirect must not replay the request at its target');
        assert.notEqual(new URL(other.url).port, new URL(fixture.url).port);
      } finally {
        await other.close();
      }

      for (const path of ['/large', '/declared-large', '/chunked-large']) {
        await expectRejects(
          async () => {
            const response = await fetchMcpHttp(`${fixture.url}${path}`, undefined, { maxBytes: 5 });
            await response.text();
          },
          /size|bytes|large|limit/i,
        );
      }
      const streamingEvents = await fetchMcpHttp(
        `${fixture.url}/events`,
        undefined,
        { timeoutMs: 20, streamingIdleTimeoutMs: 100 },
      );
      assert.match(await streamingEvents.text(), /data: 0/);
      await expectRejects(
        async () => {
          const response = await fetchMcpHttp(
            `${fixture.url}/events-stall`,
            undefined,
            { timeoutMs: 100, streamingIdleTimeoutMs: 20 },
          );
          await response.text();
        },
        /idle|timeout|abort|stream/i,
      );
      await expectRejects(
        () => fetchMcpHttp(`${fixture.url}/slow`, undefined, { timeoutMs: 20 }),
        /timeout|abort|timed out/i,
      );
      const controller = new AbortController();
      controller.abort();
      await expectRejects(
        () => fetchMcpHttp(`${fixture.url}/slow`, { signal: controller.signal }, { timeoutMs: 1000 }),
        /abort|cancel/i,
      );

      const unboundedBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
      });
      await expectRejects(
        () => fetchMcpHttp(
          `${fixture.url}/upload`,
          { method: 'POST', body: unboundedBody, duplex: 'half' } as RequestInit & { duplex: 'half' },
          { maxBytes: 5, timeoutMs: 1000 },
        ),
        /size|bytes|large|limit|abort/i,
      );

      const abortController = new AbortController();
      const abortBody = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          streamController.enqueue(new Uint8Array([5, 6, 7, 8]));
        },
      });
      const abortTimer = setTimeout(() => abortController.abort(), 20);
      try {
        await expectRejects(
          () => fetchMcpHttp(
            `${fixture.url}/upload`,
            { method: 'POST', body: abortBody, signal: abortController.signal, duplex: 'half' } as RequestInit & { duplex: 'half' },
            { timeoutMs: 1000 },
          ),
          /abort|cancel|timeout/i,
        );
      } finally {
        clearTimeout(abortTimer);
      }
    } finally {
      await fixture.close();
    }
    console.log('mcp-network-test: ok');
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalPrivateNetwork === undefined) delete process.env.MCP_ALLOW_PRIVATE_NETWORK;
    else env.MCP_ALLOW_PRIVATE_NETWORK = originalPrivateNetwork;
    if (originalInsecureHttp === undefined) delete process.env.MCP_ALLOW_INSECURE_HTTP;
    else env.MCP_ALLOW_INSECURE_HTTP = originalInsecureHttp;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
