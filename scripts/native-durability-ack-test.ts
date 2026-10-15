import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as encoding from 'lib0/encoding';
import { createNativeDurabilityAckLedger } from '../tests/helpers/native-durability-ack';

const identity = { documentId: 'collab-owned', lifecycleGeneration: 1 };
const candidate = { stateProof: `yjs-snapshot-sha256-v1:${'a'.repeat(64)}`, stateVector: 'AQID' };
const snapshot = { type: 'durability_snapshot', ...identity, ...candidate, documentSequence: 7 };
const ack = { type: 'durability_ack', ...identity, sequence: 7 };
function frame(value: object, address = identity.documentId) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, address); encoding.writeVarUint(encoder, 5);
  encoding.writeVarString(encoder, JSON.stringify(value));
  return Buffer.from(encoding.toUint8Array(encoder));
}

test('only a subsequent same-channel exact client acknowledgement certifies the snapshot', () => {
  const ledger = createNativeDurabilityAckLedger();
  ledger.record(1, 'sent', frame(ack));
  ledger.record(1, 'received', frame(snapshot));
  assert.equal(ledger.hasAcknowledged(identity, candidate), false);
  ledger.record(2, 'sent', frame(ack));
  assert.equal(ledger.hasAcknowledged(identity, candidate), false);
  ledger.record(1, 'sent', frame({ ...ack, sequence: 6 }));
  ledger.record(1, 'sent', frame({ ...ack, lifecycleGeneration: 2 }));
  assert.equal(ledger.hasAcknowledged(identity, candidate), false);
  ledger.record(1, 'sent', frame(ack));
  assert.equal(ledger.hasAcknowledged(identity, candidate), true);
  assert.equal(ledger.hasAcknowledged({ ...identity, documentId: 'another' }, candidate), false);
  assert.equal(ledger.hasAcknowledged({ ...identity, lifecycleGeneration: 2 }, candidate), false);
  assert.equal(ledger.hasAcknowledged(identity, { ...candidate, stateVector: 'old' }), false);
  assert.equal(ledger.hasAcknowledged(identity, { ...candidate, stateProof: `yjs-snapshot-sha256-v1:${'b'.repeat(64)}` }), false);
});

test('checkpoint messages use the durable document sequence rather than the projection sequence', () => {
  const ledger = createNativeDurabilityAckLedger();
  ledger.record(1, 'received', frame({ ...snapshot, type: 'checkpointed', sequence: 3 }));
  ledger.record(1, 'sent', frame({ ...ack, sequence: 3 }));
  assert.equal(ledger.hasAcknowledged(identity, candidate), false);
  ledger.record(1, 'sent', frame(ack));
  assert.equal(ledger.hasAcknowledged(identity, candidate), true);
});

test('malformed relevant frames fail the bounded observer instead of certifying partial evidence', () => {
  const cases: Array<{ direction: 'sent' | 'received'; payload: Buffer }> = [
    { direction: 'received', payload: frame({ ...snapshot, stateProof: '' }) },
    { direction: 'received', payload: frame({ ...snapshot, documentId: 'wrong' }) },
    { direction: 'received', payload: Buffer.concat([frame(snapshot), Buffer.of(0)]) },
    { direction: 'sent', payload: frame({ ...ack, sequence: -1 }) },
  ];
  for (const malformed of cases) {
    const ledger = createNativeDurabilityAckLedger();
    ledger.record(1, 'received', frame(snapshot)); ledger.record(1, 'sent', frame(ack));
    ledger.record(1, malformed.direction, malformed.payload);
    assert.throws(() => ledger.hasAcknowledged(identity, candidate), /malformed|bound/u);
  }
});

test('exceeding the receipt budget cannot certify an earlier subset', () => {
  const ledger = createNativeDurabilityAckLedger();
  for (let index = 0; index < 257; index++) ledger.record(1, 'received', frame(snapshot));
  assert.throws(() => ledger.hasAcknowledged(identity, candidate), /bound/u);
});

test('one immutable sequence cannot be paired with two different native proofs', () => {
  const ledger = createNativeDurabilityAckLedger();
  ledger.record(1, 'received', frame(snapshot));
  ledger.record(1, 'sent', frame(ack));
  ledger.record(1, 'received', frame({ ...snapshot, stateProof: `yjs-snapshot-sha256-v1:${'b'.repeat(64)}` }));
  assert.throws(() => ledger.hasAcknowledged(identity, candidate), /malformed/u);
});
