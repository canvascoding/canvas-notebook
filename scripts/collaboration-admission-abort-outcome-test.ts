import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionRequest,
  collaborationAdmissionActionDigest,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';
import {
  COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES,
  collaborationAdmissionOutcomeDigest,
  readCollaborationAdmissionOutcome,
  serializeCollaborationAdmissionOutcome,
  type CollaborationAdmissionOutcome,
} from '../app/lib/collaboration/room-admission-outcome';
import type { SqlConnection } from '../app/lib/db';

const REQUEST_ID = '0c74c9ec-8d04-4aec-a7e6-95cb5239a124';
const PAYLOAD = '{"version":1,"documentId":"abort-doc","expectedLifecycleGeneration":3}';

function document(overrides: Partial<CollaborationAdmissionDocument> = {}): CollaborationAdmissionDocument {
  return { documentId: 'abort-doc', workspaceId: 'abort-workspace', organizationId: 'abort-org', path: 'notes/abort.md',
    representation: 'plain_text', lifecycleGeneration: 3, schemaVersion: 1, status: 'active', ...overrides };
}

function capturedRequest(): ReturnType<typeof captureCollaborationAdmissionRequest> {
  const input: CollaborationAdmissionRequest = {
    requestId: REQUEST_ID,
    actorId: 'abort-outcome-test',
    action: 'move',
    actionPayloadText: PAYLOAD,
    actionDigest: collaborationAdmissionActionDigest('move', PAYLOAD),
    scopes: [{ workspaceId: 'abort-workspace', organizationId: 'abort-org', path: 'notes/abort.md', kind: 'exact' }],
    expectedDocuments: [document()],
  };
  return captureCollaborationAdmissionRequest(input);
}

function snapshotText(target: CollaborationAdmissionDocument = document(), overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    document: target,
    ownerEpoch: 0,
    ownerToken: null,
    ownerBackendPid: null,
    ownerBackendStart: null,
    documentSequence: 4,
    persistedUpdateHash: 'a'.repeat(64),
    persistedVectorHash: 'b'.repeat(64),
    ...overrides,
  });
}

function proofText(captured: ReturnType<typeof captureCollaborationAdmissionRequest>, inputSnapshotText: string,
  currentSnapshotText: string, overrides: Record<string, unknown> = {}, kind = 'vacant'): string {
  return JSON.stringify({
    version: 1,
    requestId: captured.request.requestId,
    requestDigest: captured.requestDigest,
    snapshotDigest: createHashForSnapshot(inputSnapshotText),
    kind,
    current: JSON.parse(currentSnapshotText),
    ...overrides,
  });
}

function createHashForSnapshot(text: string): string {
  return createHash('sha256').update('canvas.admission-quiescence.snapshot.v1\0').update(text).digest('hex');
}

function fixture(options: {
  outcomeVersion?: 1 | 2;
  reasonCode?: string;
  disposition?: string;
  result?: Record<string, string>;
  proofRequestId?: string;
  proofRequestDigest?: string;
  proofCurrentText?: string;
  outcomeSnapshotText?: string;
  inputSnapshotText?: string;
  proofKind?: string;
  proofTextOverride?: string;
  targetDigestOverride?: string;
  headerStatus?: string;
  outcomeTextOverride?: string;
} = {}) {
  const captured = capturedRequest();
  const inputSnapshot = options.inputSnapshotText ?? snapshotText();
  const currentSnapshot = options.proofCurrentText ?? snapshotText();
  const proof = options.proofTextOverride ?? proofText(captured, inputSnapshot, currentSnapshot, {
    ...(options.proofRequestId === undefined ? {} : { requestId: options.proofRequestId }),
    ...(options.proofRequestDigest === undefined ? {} : { requestDigest: options.proofRequestDigest }),
  }, options.proofKind ?? 'vacant');
  const proofDigest = collaborationAdmissionOutcomeDigest('input', proof);
  const targetSnapshot = options.outcomeSnapshotText ?? currentSnapshot;
  const snapshotDigest = collaborationAdmissionOutcomeDigest('snapshot', targetSnapshot);
  const outcomeTarget = { documentId: 'abort-doc', proofDigest, snapshotText: targetSnapshot,
    snapshotDigest: options.targetDigestOverride ?? snapshotDigest };
  const outcome: CollaborationAdmissionOutcome = options.outcomeVersion === 1
    ? { version: 1, requestId: REQUEST_ID, requestDigest: captured.requestDigest,
      result: options.result ?? { path: 'notes/abort.md' }, targets: [outcomeTarget] }
    : { version: 2, disposition: (options.disposition ?? 'aborted') as 'aborted',
      reasonCode: (options.reasonCode ?? 'user_cancelled') as 'user_cancelled', requestId: REQUEST_ID,
      requestDigest: captured.requestDigest, result: options.result ?? {}, targets: [outcomeTarget] };
  const outcomeText = options.outcomeTextOverride ?? JSON.stringify(outcome);
  const targetRow = {
    document_id: 'abort-doc', status: 'completed', active: false,
    quiescence_kind: options.proofKind ?? 'vacant', quiescence_text: proof, snapshot_text: inputSnapshot,
    outcome_snapshot_text: targetSnapshot, outcome_snapshot_digest: snapshotDigest,
  };
  const db: SqlConnection = {
    get: async () => ({ request_digest: captured.requestDigest, intent_text: captured.intentText,
      status: options.headerStatus ?? 'committed', outcome_text: outcomeText }),
    all: async () => [targetRow],
    run: async () => ({ changes: 0 }),
    close: async () => undefined,
  };
  return { captured, outcome, outcomeText, targetRow, db };
}

test('v1 remains readable unchanged and v2 aborted outcome validates unchanged proof/current', async () => {
  const v1 = fixture({ outcomeVersion: 1 });
  assert.equal(JSON.stringify(await readCollaborationAdmissionOutcome(v1.db, v1.captured)), JSON.stringify(v1.outcome));
  assert.equal(serializeCollaborationAdmissionOutcome(v1.outcome), v1.outcomeText);

  const v2 = fixture();
  const decoded = await readCollaborationAdmissionOutcome(v2.db, v2.captured);
  assert.equal(JSON.stringify(decoded), JSON.stringify(v2.outcome));
  assert.equal(decoded?.version, 2);
  assert.equal(serializeCollaborationAdmissionOutcome(v2.outcome), v2.outcomeText);

  const preconditionFailure = fixture({ reasonCode: 'precondition_failed' });
  assert.equal(JSON.stringify(await readCollaborationAdmissionOutcome(preconditionFailure.db, preconditionFailure.captured)),
    JSON.stringify(preconditionFailure.outcome));
});

test('v2 requires the known abort disposition, reason, version, and empty result', async () => {
  const invalid = [
    fixture({ reasonCode: 'unknown' }),
    fixture({ disposition: 'committed' }),
    fixture({ result: { path: 'notes/changed.md' } }),
    fixture({ outcomeTextOverride: JSON.stringify({ ...fixture().outcome, version: 3 }) }),
  ];
  for (const item of invalid) await assert.rejects(readCollaborationAdmissionOutcome(item.db, item.captured),
    (error: unknown) => {
      assert.ok(error instanceof CollaborationAdmissionError);
      assert.equal(error.code, 'ADMISSION_RECOVERY_REQUIRED');
      return true;
    });
});

test('v2 proof must match request identity and unchanged current snapshot including raw hashes and sequence', async () => {
  const captured = capturedRequest();
  const originalCurrent = snapshotText();
  const invalid = [
    fixture({ proofRequestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    fixture({ proofRequestDigest: 'f'.repeat(64) }),
    fixture({ proofCurrentText: snapshotText(document({ documentId: 'other-doc' })) }),
    fixture({ proofCurrentText: snapshotText(document(), { persistedUpdateHash: 'c'.repeat(64) }), outcomeSnapshotText: originalCurrent }),
    fixture({ proofCurrentText: snapshotText(document(), { documentSequence: 5 }), outcomeSnapshotText: originalCurrent }),
    fixture({ proofCurrentText: JSON.stringify({ ...JSON.parse(originalCurrent), extra: true }) }),
  ];
  for (const item of invalid) await assert.rejects(readCollaborationAdmissionOutcome(item.db, item.captured),
    (error: unknown) => {
      assert.ok(error instanceof CollaborationAdmissionError);
      assert.ok(['ADMISSION_RECOVERY_REQUIRED', 'ADMISSION_SCOPE_CHANGED'].includes(error.code));
      return true;
    });

  // A target with an otherwise valid proof cannot substitute another stored hash.
  const targetHashMismatch = fixture({ targetDigestOverride: 'f'.repeat(64) });
  await assert.rejects(readCollaborationAdmissionOutcome(targetHashMismatch.db, targetHashMismatch.captured),
    (error: unknown) => error instanceof CollaborationAdmissionError && error.code === 'ADMISSION_RECOVERY_REQUIRED');
  assert.equal(captured.request.requestId, REQUEST_ID);
});

test('v2 binds an unchanged or vacant current snapshot to the original reservation snapshot', async () => {
  const originalReservation = snapshotText();
  const tamperedPostStates = [
    snapshotText(document(), { ownerEpoch: 1 }),
    snapshotText(document(), { documentSequence: 5 }),
    snapshotText(document(), { persistedUpdateHash: 'c'.repeat(64) }),
  ];
  for (const tampered of tamperedPostStates) {
    // Both the proof's current value and the stored outcome agree with the tampered
    // value; only comparison to the original reservation detects the substitution.
    const item = fixture({ inputSnapshotText: originalReservation,
      proofCurrentText: tampered, outcomeSnapshotText: tampered });
    await assert.rejects(readCollaborationAdmissionOutcome(item.db, item.captured),
      (error: unknown) => error instanceof CollaborationAdmissionError
        && error.code === 'ADMISSION_RECOVERY_REQUIRED');
  }

  const wrongReservedGeneration = fixture({
    inputSnapshotText: snapshotText(document({ lifecycleGeneration: 4 })),
  });
  await assert.rejects(readCollaborationAdmissionOutcome(wrongReservedGeneration.db, wrongReservedGeneration.captured),
    (error: unknown) => error instanceof CollaborationAdmissionError
      && error.code === 'ADMISSION_SCOPE_CHANGED');
});

test('v2 owner-drain snapshot permits tokenless release at same epoch and nonregressing sequence', async () => {
  const reserved = snapshotText(document(), { ownerEpoch: 7, ownerToken: 'owner-token-7',
    ownerBackendPid: 4242, ownerBackendStart: '2026-09-27T12:00:00.000Z', documentSequence: 10 });
  const released = snapshotText(document(), { ownerEpoch: 7, documentSequence: 11 });
  const accepted = fixture({ proofKind: 'owner_drain', inputSnapshotText: reserved,
    proofCurrentText: released, outcomeSnapshotText: released });
  assert.equal(JSON.stringify(await readCollaborationAdmissionOutcome(accepted.db, accepted.captured)),
    JSON.stringify(accepted.outcome));

  const regressions = [
    snapshotText(document(), { ownerEpoch: 8, documentSequence: 11 }),
    snapshotText(document(), { ownerEpoch: 7, documentSequence: 9 }),
  ];
  for (const current of regressions) {
    const item = fixture({ proofKind: 'owner_drain', inputSnapshotText: reserved,
      proofCurrentText: current, outcomeSnapshotText: current });
    await assert.rejects(readCollaborationAdmissionOutcome(item.db, item.captured),
      (error: unknown) => error instanceof CollaborationAdmissionError
        && error.code === 'ADMISSION_RECOVERY_REQUIRED');
  }
});

test('reader rejects noncanonical outcome text, extra fields, and non-committed header state', async () => {
  const valid = fixture();
  const object = valid.outcome as unknown as Record<string, unknown>;
  const withExtra = { ...object, unexpected: true };
  const reordered = {
    requestId: object.requestId,
    version: object.version,
    disposition: object.disposition,
    reasonCode: object.reasonCode,
    requestDigest: object.requestDigest,
    result: object.result,
    targets: object.targets,
  };
  const invalid = [
    fixture({ outcomeTextOverride: JSON.stringify(withExtra) }),
    fixture({ outcomeTextOverride: JSON.stringify(reordered) }),
    fixture({ headerStatus: 'aborted' }),
    fixture({ headerStatus: 'reserved' }),
  ];
  for (const item of invalid) await assert.rejects(readCollaborationAdmissionOutcome(item.db, item.captured),
    (error: unknown) => {
      assert.ok(error instanceof CollaborationAdmissionError);
      return true;
    });
});

test('v1 and v2 share the same serialized outcome-size limit', () => {
  for (const item of [fixture({ outcomeVersion: 1 }), fixture()]) {
    assert.ok(Buffer.byteLength(item.outcomeText, 'utf8') <= COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES);
    const tooLarge = { ...item.outcome, result: { oversized: 'x'.repeat(COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES) } };
    assert.throws(() => serializeCollaborationAdmissionOutcome(tooLarge), (error: unknown) => {
      assert.ok(error instanceof CollaborationAdmissionError);
      assert.equal(error.code, 'ADMISSION_INVALID_REQUEST');
      return true;
    });
  }
});
