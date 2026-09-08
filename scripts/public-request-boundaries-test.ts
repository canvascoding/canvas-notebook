import assert from 'node:assert/strict';
import { readBoundedJson } from '../app/lib/api/bounded-json';
import { coalescePublicExport } from '../app/lib/exports/coalesce-public-export';

async function main() {
  const parsed = await readBoundedJson(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify({ token: 'fixture' }) }));
  assert.deepEqual(parsed.body, { token: 'fixture' });
  assert.equal(parsed.response, null);
  let cancelled = false;
  const oversized = new Request('http://localhost/test', {
    method: 'POST', duplex: 'half', body: new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    }),
  } as RequestInit);
  assert.equal((await readBoundedJson(oversized, 2048)).response?.status, 413);
  assert.equal(cancelled, true, 'oversized chunked input must stop being consumed');
  assert.equal((await readBoundedJson(new Request('http://localhost/test', { method: 'POST', body: 'broken json' }))).body, null);

  let renders = 0;
  let finish!: (value: Buffer) => void;
  const render = () => { renders++; return new Promise<Buffer>(resolve => { finish = resolve; }); };
  const first = coalescePublicExport('same-document', render);
  const second = coalescePublicExport('same-document', render);
  await Promise.resolve();
  assert.equal(renders, 1);
  finish(Buffer.from('fixture PDF'));
  assert.deepEqual(await first, await second);
  const fresh = await coalescePublicExport('same-document', async () => { renders++; return Buffer.from('updated PDF'); });
  assert.equal(fresh.toString(), 'updated PDF');
  assert.equal(renders, 2, 'completed results must not outlive share/document validation');
  await assert.rejects(coalescePublicExport('error', async () => { throw new Error('renderer failed'); }));
  assert.equal((await coalescePublicExport('error', async () => Buffer.from('retry'))).toString(), 'retry');
  console.log('public-request-boundaries-test: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
