import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { readExcalidrawOperationApproval } from '@/app/lib/excalidraw-collaboration/review-route';

function request(body: unknown, raw = false) {
  return new NextRequest('https://canvas.test/api/files/excalidraw-collaboration/operations/operation/accept', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body),
  });
}

async function main() {
  for (const expectedCasVersion of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const parsed = await readExcalidrawOperationApproval(request({ idempotencyKey: '  trusted-key  ', expectedCasVersion }));
    assert.equal(parsed.response, null);
    assert.equal(parsed.expectedCasVersion, expectedCasVersion);
    assert.equal(parsed.idempotencyKey, 'trusted-key');
  }
  for (const body of [
    { idempotencyKey: 'old-client-key' },
    { idempotencyKey: 'key', expectedCasVersion: 1, actorId: 'untrusted-actor' },
    { idempotencyKey: 'key', expectedCasVersion: 1, lifecycleGeneration: 1 },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null, true].map(expectedCasVersion => ({ idempotencyKey: 'key', expectedCasVersion })),
    { idempotencyKey: '', expectedCasVersion: 1 },
    { idempotencyKey: 'x'.repeat(201), expectedCasVersion: 1 },
    null, [],
  ]) {
    const parsed = await readExcalidrawOperationApproval(request(body));
    assert(parsed.response, 'Approval must carry exactly the displayed CAS version and an idempotency key.');
    assert.equal(parsed.response.status, 400);
    assert.equal(parsed.expectedCasVersion, null);
  }
  const legacy = await readExcalidrawOperationApproval(request({ idempotencyKey: 'legacy' }));
  assert(legacy.response);
  assert.match((await legacy.response.json()).error, /Reload the current review/u);
  for (const raw of ['', '{"idempotencyKey":']) {
    const parsed = await readExcalidrawOperationApproval(request(raw, true));
    assert.equal(parsed.response?.status, 400);
  }
  const oversized = await readExcalidrawOperationApproval(request({ idempotencyKey: 'x'.repeat(5 * 1024), expectedCasVersion: 1 }));
  assert.equal(oversized.response?.status, 413);
  console.log('Excalidraw approval exact keys, displayed CAS version, legacy reload errors and bounded JSON verified.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
