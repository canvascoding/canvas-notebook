import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { StandaloneReleaseResolver } from '../cli/src/core/standaloneUpdateRelease';

async function main() {
  let signal: AbortSignal | undefined;
  const resolver = new StandaloneReleaseResolver({ fetch: async (_url, options) => {
    signal = options?.signal as AbortSignal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
    } }));
  } });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const request = assert.rejects(resolver.resolve('stable'), /timed out/);
    // Let fetch resolve and the body reader block before advancing the clock.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    mock.timers.tick(15_001);
    assert.equal(signal?.aborted, true);
    await request;
  } finally { mock.timers.reset(); }

  let canceled = false;
  const oversized = new StandaloneReleaseResolver({ fetch: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
    cancel() { canceled = true; },
  })) });
  await assert.rejects(oversized.resolve('stable'), /too large/);
  assert.equal(canceled, true);
  console.log('system-update-download-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
