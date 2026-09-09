import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fetchExternalResourceSafely } from '../app/lib/security/safe-external-fetch';

async function main() {
  const lookup = dns.lookup;
  const request = http.request;
  let privateRedirect = false;
  let stallDns = false;
  let requests = 0;
  dns.lookup = (async () => {
    if (stallDns) return new Promise(() => undefined);
    return [{ address: '93.184.216.34', family: 4 }];
  }) as unknown as typeof dns.lookup;
  http.request = ((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    requests++;
    assert.equal(options.hostname, '93.184.216.34', 'transport uses the validated public address');
    const emitter = new EventEmitter() as http.ClientRequest;
    emitter.setTimeout = () => emitter;
    emitter.end = (() => {
      const redirect = options.path === '/start';
      const response = Readable.from(redirect ? [] : [Buffer.from('Complete body')]) as http.IncomingMessage;
      response.statusCode = redirect ? 302 : 200;
      response.statusMessage = redirect ? 'Found' : 'OK';
      response.headers = redirect
        ? { location: privateRedirect ? 'http://127.0.0.1/secret' : 'http://public.fixture.test/end' }
        : { 'content-type': 'text/plain' };
      callback(response);
      return emitter;
    }) as typeof emitter.end;
    return emitter;
  }) as typeof http.request;
  try {
    const result = await fetchExternalResourceSafely('http://public.fixture.test/start', { maxBytes: 100, timeoutMs: 1_000 });
    assert.equal(result.finalUrl, 'http://public.fixture.test/end');
    assert.equal(result.buffer.toString(), 'Complete body');
    assert.equal(requests, 2);
    requests = 0; privateRedirect = true;
    await assert.rejects(() => fetchExternalResourceSafely('http://public.fixture.test/start'), /private|local/);
    assert.equal(requests, 1, 'redirect to a private address is blocked before a second HTTP request');
    stallDns = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('cancel during DNS')), 10);
    try {
      await assert.rejects(() => fetchExternalResourceSafely('http://public.fixture.test/start', { signal: abort.signal }), /cancel during DNS/);
      assert.equal(requests, 1, 'cancellation during DNS prevents HTTP dispatch');
    } finally { clearTimeout(timer); }
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await assert.rejects(() => fetchExternalResourceSafely('http://public.fixture.test/start', { timeoutMs: 10 }), error => error instanceof Error && error.name === 'TimeoutError');
    } finally { clearInterval(keepAlive); }
    console.log('web-fetch-boundaries-test: ok');
  } finally { dns.lookup = lookup; http.request = request; }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
