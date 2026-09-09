import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { handleHttpRequestSafely } from '../server/http-request-boundary';

async function main() {
  let began!: () => void;
  let abortSettled!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const settled = new Promise<void>(resolve => { abortSettled = resolve; });
  const server = createServer((req, res) => handleHttpRequestSafely(req, res, async () => {
    if (req.url === '/throw') throw new Error('internal detail must not reach the response');
    if (req.url === '/replaced') {
      // Model Next's replacement of the middleware body and its event table.
      req.removeAllListeners('error');
      res.end('replaced');
      res.once('finish', () => process.nextTick(() => req.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))));
      return;
    }
    if (req.url === '/abort') {
      began();
      try { for await (const _chunk of req) { /* Wait for the incomplete body. */ } }
      finally { abortSettled(); }
      return;
    }
    res.end('healthy');
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const abort = request(`${origin}/abort`, { method: 'POST', headers: { 'Content-Length': '10000' } });
    abort.on('error', () => undefined);
    abort.write('incomplete');
    await started;
    abort.destroy();
    await settled;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await fetch(origin).then(r => r.text()), 'healthy', 'aborted bodies must not kill the HTTP process');
    const failure = await fetch(`${origin}/throw`);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { success: false, error: 'Request failed' });
    assert.equal(await fetch(origin).then(r => r.text()), 'healthy', 'a rejected route must remain request-local');
    assert.equal(await fetch(`${origin}/replaced`).then(r => r.text()), 'replaced');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await fetch(origin).then(r => r.text()), 'healthy', 'middleware body replacement must retain abort handling');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  console.log('http-request-boundary-test: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
