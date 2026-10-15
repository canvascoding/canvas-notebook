import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Y } from '../app/lib/collaboration/server-runtime';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { assertNativeCollaborationUpdateComplete, CollaborationIncomingUpdatePreflightError } from '../app/lib/collaboration/incoming-update-preflight';

function unchanged(document: InstanceType<typeof Y.Doc>, update: Uint8Array, reason?: CollaborationIncomingUpdatePreflightError['reason'], scratchCount = 1) {
  const before = Y.encodeStateAsUpdate(document), vector = Y.encodeStateVector(document);
  const proof = collaborationStateProof(document, Y), payload = new Uint8Array(update);
  const destroy = Y.Doc.prototype.destroy;
  let scratches = 0, liveUpdates = 0;
  const observe = () => { liveUpdates++; };
  document.on('update', observe);
  Y.Doc.prototype.destroy = function () { if (this !== document) scratches++; return destroy.call(this); };
  try {
    if (reason) assert.throws(() => assertNativeCollaborationUpdateComplete(document, update),
      error => error instanceof CollaborationIncomingUpdatePreflightError && error.reason === reason);
    else assertNativeCollaborationUpdateComplete(document, update);
  } finally { Y.Doc.prototype.destroy = destroy; document.off('update', observe); }
  assert.equal(scratches, scratchCount, 'every allocated scratch document is destroyed');
  assert.equal(liveUpdates, 0);
  assert.deepEqual(Y.encodeStateAsUpdate(document), before);
  assert.deepEqual(Y.encodeStateVector(document), vector);
  assert.equal(collaborationStateProof(document, Y), proof);
  assert.deepEqual(new Uint8Array(update), payload);
}

for (const kind of ['structures', 'deletions'] as const) {
  test(`missing ${kind} is rejected, while its delta is legal with the actual basis`, () => {
    const source = new Y.Doc({ gc: false }), empty = new Y.Doc({ gc: false }), basis = new Y.Doc({ gc: false });
    try {
      source.getText('content').insert(0, 'A');
      Y.applyUpdate(basis, Y.encodeStateAsUpdate(source));
      const vector = Y.encodeStateVector(source);
      if (kind === 'structures') source.getText('content').insert(1, 'B');
      else source.getText('content').delete(0, 1);
      const delta = Y.encodeStateAsUpdate(source, vector);
      unchanged(empty, delta, 'missing_dependencies');
      unchanged(basis, delta);
      unchanged(empty, Y.encodeStateAsUpdate(source));
    } finally { source.destroy(); empty.destroy(); basis.destroy(); }
  });
  test(`an already incomplete ${kind} basis is rejected without pretending to repair it`, () => {
    const source = new Y.Doc({ gc: false }), live = new Y.Doc({ gc: false });
    try {
      source.getText('content').insert(0, 'A');
      const vector = Y.encodeStateVector(source);
      if (kind === 'structures') source.getText('content').insert(1, 'B');
      else source.getText('content').delete(0, 1);
      Y.applyUpdate(live, Y.encodeStateAsUpdate(source, vector));
      assert(live.store.pendingStructs || live.store.pendingDs, 'fixture must actually be incomplete');
      unchanged(live, Y.encodeStateAsUpdate(source), 'basis_incomplete', 0);
    } finally { source.destroy(); live.destroy(); }
  });
}

test('malformed and truncated binary updates cannot change a complete live basis', () => {
  const live = new Y.Doc({ gc: false }), source = new Y.Doc({ gc: false });
  try {
    live.getText('content').insert(0, 'existing'); source.getText('content').insert(0, 'new');
    const full = Y.encodeStateAsUpdate(source);
    for (const bad of [new Uint8Array(), new Uint8Array([255]), full.slice(0, -1)]) unchanged(live, bad, 'invalid_update');
  } finally { live.destroy(); source.destroy(); }
});

test('Buffer deltas and idempotent full states keep caller-owned bytes intact', () => {
  const live = new Y.Doc({ gc: true });
  try {
    live.getText('content').insert(0, 'complete');
    unchanged(live, Buffer.from(Y.encodeStateAsUpdate(live)));
    unchanged(live, new Uint8Array([0, 0]));
  } finally { live.destroy(); }
});

test('the fixed 64 MiB ceiling rejects an oversized basis before allocating a scratch', () => {
  const live = new Y.Doc({ gc: false });
  try {
    live.getText('content').insert(0, 'x'.repeat(64 * 1024 * 1024));
    assert(Y.encodeStateAsUpdate(live).byteLength > 64 * 1024 * 1024);
    unchanged(live, new Uint8Array([0, 0]), 'state_limit', 0);
  } finally { live.destroy(); }
});

test('the fixed ceiling also rejects an oversized basis plus small legal delta', () => {
  const live = new Y.Doc({ gc: false }), source = new Y.Doc({ gc: false });
  try {
    live.getText('content').insert(0, 'x'.repeat(64 * 1024 * 1024 - 128));
    Y.applyUpdate(source, Y.encodeStateAsUpdate(live));
    const vector = Y.encodeStateVector(source);
    source.getText('content').insert(source.getText('content').length, 'y'.repeat(256));
    assert(Y.encodeStateAsUpdate(live).byteLength < 64 * 1024 * 1024);
    unchanged(live, Y.encodeStateAsUpdate(source, vector), 'state_limit');
  } finally { live.destroy(); source.destroy(); }
});
