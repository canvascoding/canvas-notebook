import assert from 'node:assert/strict';
import Module from 'node:module';
import { readBoundedResponseBody } from '../app/lib/security/safe-external-fetch';

async function main() {
  let cancelled = false;
  const tooLarge = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1_024)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(() => readBoundedResponseBody(tooLarge, 1_500), /byte limit/);
  assert.equal(cancelled, true, 'oversized streams stop without reading the whole response');
  assert.equal((await readBoundedResponseBody(new Response('😀 東京'), 16)).toString(), '😀 東京');
  const abort = new AbortController();
  const never = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const waiting = readBoundedResponseBody(never, 1_000, abort.signal);
  abort.abort(new Error('test abort'));
  await assert.rejects(() => waiting, /test abort/);

  const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const original = modules._load;
  const requests: Array<{ maxBytes: number; timeoutMs: number; signal?: AbortSignal }> = [];
  modules._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/security/safe-external-fetch') return {
      fetchExternalResourceSafely: async (_url: string, options: typeof requests[number]) => {
        requests.push(options);
        return { buffer: Buffer.from('plain text without HTML should remain readable'), contentType: 'text/plain', finalUrl: 'https://example.test/target', statusCode: 200 };
      },
    };
    return original(request, parent, isMain);
  };
  try {
    const { extractWebContent, cleanWebText, fetchReadableWebContent } = await import('../app/lib/integrations/web-content-service');
    const html = '<html><head><title>Source title</title></head><body><main><p>Text before.</p><img src="data:image/png;base64,AAAA"/><p>Text after.</p></main></body></html>';
    const parsed = extractWebContent(html, 'https://example.test', 'text/html');
    assert.equal(parsed.title, 'Source title');
    assert.match(parsed.content, /Text before/);
    assert.match(parsed.content, /Text after/);
    assert.doesNotMatch(parsed.content, /data:image|base64/);
    assert.match(cleanWebText('data:image/png;base64,AAAA words after image.'), /words after image/);
    const signal = new AbortController().signal;
    const fetched = await fetchReadableWebContent('https://example.test', { timeoutSeconds: 500, signal });
    assert.equal(fetched.success, true);
    assert.equal(fetched.finalUrl, 'https://example.test/target');
    assert.match(fetched.content!, /without HTML/);
    assert.deepEqual(requests[0], { maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000, signal });
    console.log('web-content-service-test: ok');
  } finally { modules._load = original; }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
