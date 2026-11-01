import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type InstalledSdkRpc = Readonly<{ method?: string; params?: Readonly<{ name?: string; arguments?: Record<string, unknown> }> }>;
export type InstalledSdkProbeEvent = Record<string, unknown> & { event: string };
type Options = Readonly<{
  python: string; wheel: string; probe: string; key: string; config: Record<string, unknown>;
  event: (value: InstalledSdkProbeEvent, send: (reply: unknown) => void) => Promise<void>;
  exchange?: (rpc: InstalledSdkRpc | null, response: Response, body: Buffer) => Promise<'drop' | void>;
}>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Real installed Python process -> loopback HTTP -> genuine MCP handler.
 * Hooks observe actual events/responses and may drop an acknowledgement; they
 * never replace RPC arguments, credential authority, SQL or response contents.
 * The child receives no database URL, Session/OAuth material or PYTHONPATH. */
export async function withInstalledApiKeySdkMcpFixture(options: Options) {
  assert(path.isAbsolute(options.python) && path.isAbsolute(options.wheel) && options.wheel.endsWith('.whl'));
  const wheelStat = await lstat(options.wheel); assert(wheelStat.isFile() && !wheelStat.isSymbolicLink());
  const wheelSha256 = sha(await readFile(options.wheel)), probeSha256 = sha(await readFile(options.probe));
  const sourceHashes: Record<string, string> = {}, root = path.resolve('packages/canvas-notebook-python/src/canvas_notebook');
  for (const item of await readdir(root, { withFileTypes: true })) if (item.isFile() && (item.name.endsWith('.py') || item.name === 'py.typed')) {
    sourceHashes[`canvas_notebook/${item.name}`] = sha(await readFile(path.join(root, item.name)));
  }
  const { handleDirectMcpPost, handleDirectMcpOptions, handleDirectMcpUnsupportedMethod } = await import('../../app/lib/mcp/server/streamable-http');
  const errors: unknown[] = [], requests = new Set<Promise<void>>(), statuses: number[] = [], deniedMethods: string[] = [];
  const calls: Record<string, number> = {};
  const server = http.createServer(); server.requestTimeout = 40000; server.headersTimeout = 10000;
  let origin = '', keyHeaders = 0, drops = 0;
  server.on('request', (incoming, outgoing) => {
    const operation = (async () => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) { size += chunk.length; assert(size <= 65536); chunks.push(chunk); }
      assert.equal(incoming.url, '/mcp'); const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      assert(headers.has('x-canvas-api-key') && !headers.has('authorization') && !headers.has('cookie')); keyHeaders++;
      const body = Buffer.concat(chunks), rpc = incoming.method === 'POST' ? JSON.parse(body.toString()) as InstalledSdkRpc : null;
      if (rpc?.method === 'tools/call' && rpc.params?.name === 'copy_knowledge_source') {
        const args = rpc.params.arguments, id = args?.operation_id;
        if (typeof id === 'string' && typeof args?.action === 'string') {
          const key = `${id}:${args.action}`; calls[key] = (calls[key] ?? 0) + 1;
        }
      }
      const request = new Request(`${origin}/mcp`, { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? { body } : {}) });
      const response = incoming.method === 'POST' ? await handleDirectMcpPost(request)
        : incoming.method === 'OPTIONS' ? await handleDirectMcpOptions(request) : await handleDirectMcpUnsupportedMethod(request);
      statuses.push(response.status); if (response.status === 401) deniedMethods.push(String(rpc?.method));
      const responseBody = Buffer.from(await response.arrayBuffer());
      if (await options.exchange?.(rpc, response, responseBody) === 'drop') { drops++; outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(responseBody);
    })().catch(error => { errors.push(error); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); });
    requests.add(operation); void operation.finally(() => requests.delete(operation));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject); resolve(); }); });
  const address = server.address(); assert(address && typeof address === 'object'); origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(options.python, ['-I', options.probe], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let chain = Promise.resolve(), remainder = '', stdoutBytes = 0, stderrBytes = 0, complete = false, verified = false;
  const send = (reply: unknown) => { assert(!child.stdin.destroyed); child.stdin.write(JSON.stringify(reply) + '\n'); };
  const handle = async (line: string) => {
    assert(Buffer.byteLength(line) <= 8192); const value = JSON.parse(line) as InstalledSdkProbeEvent;
    assert(value && typeof value === 'object' && typeof value.event === 'string');
    if (value.event === 'probe_failed') {
      assert(typeof value.stage === 'string' && /^[a-z_]{1,64}$/u.test(value.stage));
      assert(typeof value.kind === 'string' && /^[A-Za-z_]{1,64}$/u.test(value.kind));
      console.error(JSON.stringify({ suite: 'installed-sdk-probe-failure', stage: value.stage, kind: value.kind }));
      throw new Error('Installed SDK probe failed.');
    }
    if (value.event === 'wheel_verified') {
      assert(!verified); assert.equal(value.sha256, wheelSha256); assert(typeof value.python === 'string'); verified = true;
    } else {
      assert(verified && !complete); await options.event(value, send);
      if (value.event === 'complete') complete = true;
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length; if (stdoutBytes > 32768) { errors.push(new Error('SDK stdout exceeds bound.')); child.kill('SIGTERM'); return; }
    remainder += chunk.toString('utf8'); let newline = remainder.indexOf('\n');
    while (newline !== -1) { const line = remainder.slice(0, newline); remainder = remainder.slice(newline + 1);
      chain = chain.then(() => handle(line)); void chain.catch(error => { errors.push(error); child.kill('SIGTERM'); }); newline = remainder.indexOf('\n'); }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) child.kill('SIGTERM'); });
  child.stdin.on('error', error => { errors.push(error); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const timeout = setTimeout(() => { errors.push(new Error('Installed SDK probe deadline exceeded.')); child.kill('SIGKILL'); }, 240000);
  try {
    send({ ...options.config, key: options.key, endpoint: `${origin}/mcp`, wheelUri: pathToFileURL(options.wheel).href, wheelSha256, sourceHashes });
    const result = await closed; await chain; await Promise.all([...requests]);
    assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(remainder, ''); assert(complete && verified);
    assert.equal(errors.length, 0); assert.equal(keyHeaders, statuses.length);
    assert.equal(sha(await readFile(options.probe)), probeSha256); assert.equal(sha(await readFile(options.wheel)), wheelSha256);
    return { wheelSha256, keyHeaderOnlyRequests: keyHeaders, deniedMethods, calls, droppedAcknowledgements: drops, stderrBytes };
  } finally {
    clearTimeout(timeout);
    if (!complete || errors.length) console.error(JSON.stringify({ suite: 'installed-api-key-sdk-mcp-fixture', complete, verified,
      keyHeaders, drops, stderrBytes, errors: errors.map(error => error instanceof Error ? error.name : 'UnknownError') }));
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed.catch(() => undefined); }
    child.stdin.destroy(); await Promise.allSettled([...requests]);
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    assert.equal(server.listening, false);
  }
}
