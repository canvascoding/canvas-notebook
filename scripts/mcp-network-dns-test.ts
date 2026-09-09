import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https, { type RequestOptions } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { mock } from 'node:test';

async function expectRejects(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => pattern.test(error instanceof Error ? error.message : String(error)));
}

async function main() {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPrivateNetwork = process.env.MCP_ALLOW_PRIVATE_NETWORK;
  const originalInsecureHttp = process.env.MCP_ALLOW_INSECURE_HTTP;
  mutableEnv.NODE_ENV = 'production';
  delete mutableEnv.MCP_ALLOW_PRIVATE_NETWORK;
  delete mutableEnv.MCP_ALLOW_INSECURE_HTTP;
  // The production timeout is deliberately unref'd; keep this standalone test
  // alive long enough to observe its rejection while the mock DNS promise hangs.
  const keepAlive = setInterval(() => undefined, 1_000);

  let rebindingLookups = 0;
  const socketOptions: RequestOptions[] = [];
  mock.method(dns, 'lookup', async (hostname: string) => {
    if (hostname === 'rebind.test') {
      rebindingLookups += 1;
      return rebindingLookups === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    }
    if (hostname === 'mixed.test') {
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ];
    }
    if (hostname === 'timeout.test') {
      return new Promise<never>(() => undefined);
    }
    throw new Error(`Unexpected lookup for ${hostname}`);
  });
  mock.method(https, 'request', (options: RequestOptions, callback?: (response: unknown) => void) => {
    socketOptions.push(options);
    const response = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
    });
    const request = Object.assign(new EventEmitter(), {
      end: () => callback?.(response),
    });
    return request as never;
  });
  syncBuiltinESMExports();

  try {
    const { resolveMcpHttpTarget } = await import('../app/lib/mcp/network-policy');
    const { fetchMcpHttp } = await import('../app/lib/mcp/http');

    const response = await fetchMcpHttp('https://rebind.test/mcp');
    await response.body?.cancel();
    assert.equal(socketOptions.length, 1, 'one lookup result must produce one socket request');
    assert.equal(socketOptions[0].hostname, '93.184.216.34');
    assert.equal(socketOptions[0].family, 4);
    assert.equal(socketOptions[0].servername, 'rebind.test');
    assert.equal(socketOptions[0].agent, false);

    // A later private DNS answer is rejected rather than replacing the address
    // that was used by the already-open socket above.
    await expectRejects(
      () => resolveMcpHttpTarget('https://rebind.test/mcp', 'DNS rebinding test'),
      /blocked|private/i,
    );
    assert.equal(rebindingLookups, 2);

    await expectRejects(
      () => resolveMcpHttpTarget('https://mixed.test/mcp', 'mixed DNS test'),
      /blocked|private/i,
    );

    await expectRejects(
      () => fetchMcpHttp('https://timeout.test/mcp', undefined, { timeoutMs: 20 }),
      /timed out|abort/i,
    );

    console.log('mcp-network-dns-test: ok');
  } finally {
    clearInterval(keepAlive);
    mock.restoreAll();
    syncBuiltinESMExports();
    if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = originalNodeEnv;
    if (originalPrivateNetwork === undefined) delete mutableEnv.MCP_ALLOW_PRIVATE_NETWORK;
    else mutableEnv.MCP_ALLOW_PRIVATE_NETWORK = originalPrivateNetwork;
    if (originalInsecureHttp === undefined) delete mutableEnv.MCP_ALLOW_INSECURE_HTTP;
    else mutableEnv.MCP_ALLOW_INSECURE_HTTP = originalInsecureHttp;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
