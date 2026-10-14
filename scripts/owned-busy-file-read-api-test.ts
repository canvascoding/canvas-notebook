/** Real Playwright API transport against an owned ephemeral HTTP fixture; no browser or app host. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { revalidateOwnedBusyFileRead } from '../tests/helpers/owned-busy-file-read';

async function main(): Promise<void> {
  const counts = new Map<string, number>();
  const expectedData = { path: 'Targets/A|B.md', content: '# Exact target\r\n\r\näöü 😀\r\n' };
  const success = JSON.stringify({ success: true, data: expectedData });
  const busy = (attempt: number) => JSON.stringify({ success: false, code: 'ROOM_OWNER_BUSY', error: 'Temporary owned read contention.', attempt });
  const server = http.createServer((incoming, response) => {
    const pathname = new URL(incoming.url ?? '/', 'http://fixture.test').pathname;
    const count = (counts.get(pathname) ?? 0) + 1; counts.set(pathname, count);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Owned-Adapter', 'preserved');
    response.setHeader('Set-Cookie', ['fixture-a=one; Path=/', 'fixture-b=two; Path=/']);
    if (pathname === '/recover' && count > 1) { response.statusCode = 200; response.end(success); }
    else if (pathname === '/forbidden') { response.statusCode = 403; response.end(JSON.stringify({ success: false, code: 'FORBIDDEN' })); }
    else if (pathname === '/other-unavailable') { response.statusCode = 503; response.end(JSON.stringify({ success: false, code: 'OTHER_UNAVAILABLE' })); }
    else { response.statusCode = 503; response.setHeader('Retry-After', '1'); response.end(busy(count)); }
  });
  let context: APIRequestContext | undefined, listening = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    listening = true;
    const address = server.address(); assert(address && typeof address === 'object'); assert.equal(address.address, '127.0.0.1');
    context = await request.newContext({ baseURL: `http://127.0.0.1:${address.port}`, timeout: 5000 });
    const read = async (pathname: string, signal?: AbortSignal, onReceived?: () => void) => {
      const responses: APIResponse[] = [];
      let last: { body: Buffer; status: number; statusText: string; headers: [string, string][] } | undefined;
      const result = await revalidateOwnedBusyFileRead(async () => {
        const actual = await context!.get(pathname); responses.push(actual);
        last = { body: await actual.body(), status: actual.status(), statusText: actual.statusText(),
          headers: actual.headersArray().map(({ name, value }) => [name, value]) };
        onReceived?.(); return actual;
      }, signal);
      assert(last);
      assert.equal(result.status, last.status); assert.equal(result.statusText, last.statusText);
      assert.deepEqual([...result.headers], [...new Headers(last.headers)]);
      assert.deepEqual(Buffer.from(await result.clone().arrayBuffer()), last.body);
      assert.deepEqual(result.headers.getSetCookie(), ['fixture-a=one; Path=/', 'fixture-b=two; Path=/']);
      for (const actual of responses) await assert.rejects(actual.body(), /Response has been disposed/u);
      return result;
    };
    const recovered = await read('/recover');
    assert.equal(counts.get('/recover'), 2); assert.equal(recovered.ok, true);
    assert.equal(await recovered.clone().text(), success); assert.deepEqual((await recovered.json()).data, expectedData);
    console.log('ok 1 - real APIResponse Busy then exact successful native Response, headers and disposal');

    const exhausted = await read('/exhaust');
    assert.equal(counts.get('/exhaust'), 4); assert.equal(exhausted.ok, false); assert.equal(exhausted.status, 503);
    assert.equal(await exhausted.clone().text(), busy(4)); assert.deepEqual(await exhausted.json(), JSON.parse(busy(4)));
    console.log('ok 2 - four genuine Busy GETs preserve the final failure body and status');

    for (const [pathname, status, code] of [['/forbidden', 403, 'FORBIDDEN'], ['/other-unavailable', 503, 'OTHER_UNAVAILABLE']] as const) {
      const denied = await read(pathname); assert.equal(counts.get(pathname), 1); assert.equal(denied.status, status);
      assert.equal(denied.ok, false); assert.equal((await denied.json()).code, code);
    }
    console.log('ok 3 - forbidden and unrelated unavailable responses never retry');

    const before = new AbortController(), reason = new Error('Owned fixture cancellation'); before.abort(reason);
    await assert.rejects(read('/pre-aborted', before.signal), error => error === reason); assert.equal(counts.has('/pre-aborted'), false);
    const waiting = new AbortController(); let captured: APIResponse | undefined;
    await assert.rejects(revalidateOwnedBusyFileRead(async () => {
      captured = await context!.get('/abort-after-busy'); waiting.abort(reason); return captured;
    }, waiting.signal), error => error === reason);
    assert.equal(counts.get('/abort-after-busy'), 1); assert(captured);
    await assert.rejects(captured.body(), /Response has been disposed/u);
    console.log('ok 4 - abort prevents fresh starts and still disposes the received Busy response');
  } finally {
    try { await context?.dispose(); }
    finally {
      if (listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      assert.equal(server.listening, false);
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
