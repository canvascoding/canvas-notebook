import assert from 'node:assert/strict';
import { readNativeDocumentRequestJson } from '../app/lib/documents/request-json';

const invalid = new Error('invalid-request'), tooLarge = new Error('too-large');
const options = { maxBytes: 8, invalidRequest: () => invalid, tooLarge: () => tooLarge };
async function main() {
  assert.deepEqual(await readNativeDocumentRequestJson(new Request('http://localhost', { method: 'POST', body: '{"a":1}' }), options), { a: 1 });
  await assert.rejects(readNativeDocumentRequestJson(new Request('http://localhost'), options), error => error === invalid);
  for (const bytes of [Buffer.from('{'), Buffer.from([0x22, 0xc3, 0x28, 0x22])]) {
    await assert.rejects(readNativeDocumentRequestJson(new Request('http://localhost', { method: 'POST', body: bytes }), options), error => error === invalid);
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } });
  const request = new Request('http://localhost', { method: 'POST', body, duplex: 'half', headers: { 'Content-Length': '1' } } as RequestInit);
  await assert.rejects(readNativeDocumentRequestJson(request, options), error => error === tooLarge);
  assert(cancelled); assert.equal(body.locked, false);
  const failure = new Error('stream-failed'), failedBody = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
  await assert.rejects(readNativeDocumentRequestJson(new Request('http://localhost', { method: 'POST', body: failedBody, duplex: 'half' } as RequestInit), options), error => error === failure);
  assert.equal(failedBody.locked, false);
  console.log('Native document request JSON: strict UTF-8, missing/malformed bodies, actual streamed cap/cancel and reader cleanup passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
