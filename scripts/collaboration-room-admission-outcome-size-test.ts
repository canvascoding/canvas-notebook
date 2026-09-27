import assert from 'node:assert/strict';
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
  captureCollaborationAdmissionOutcomeResult,
  collaborationAdmissionOutcomeDigest,
  readCollaborationAdmissionOutcome,
  serializeCollaborationAdmissionOutcome,
  type CollaborationAdmissionOutcome,
} from '../app/lib/collaboration/room-admission-outcome';
import type { SqlConnection } from '../app/lib/db';

const REQUEST_ID = 'b12a4e67-8439-4a5e-93bc-71c957705d32';
const PAYLOAD = '{"operation":"move"}';
const WORKSPACE_ID = '"'.repeat(256);
const ORGANIZATION_ID = '"'.repeat(256);
const DOCUMENT_COUNT = 1024;

function documentId(index: number): string {
  return `${'"'.repeat(248)}${index.toString().padStart(8, '0')}`;
}

function document(index: number): CollaborationAdmissionDocument {
  return { documentId: documentId(index), workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID,
    path: `${'"'.repeat(4088)}${index.toString().padStart(8, '0')}`, representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, status: 'active' };
}

function request(documents: readonly CollaborationAdmissionDocument[]): CollaborationAdmissionRequest {
  const actionDigest = collaborationAdmissionActionDigest('move', PAYLOAD);
  return { requestId: REQUEST_ID, actorId: 'outcome-size-test', action: 'move', actionDigest, actionPayloadText: PAYLOAD,
    scopes: [{ workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID, path: '', kind: 'subtree' }],
    expectedDocuments: documents };
}

function snapshotText(doc: CollaborationAdmissionDocument): string {
  return JSON.stringify({
    document: doc,
    ownerEpoch: 0,
    ownerToken: null,
    ownerBackendPid: null,
    ownerBackendStart: null,
    documentSequence: 0,
    persistedUpdateHash: 'a'.repeat(64),
    persistedVectorHash: 'b'.repeat(64),
  });
}

function resultAtBound(): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let index = 0; index < 32; index += 1) {
    result[`value_${index.toString().padStart(2, '0')}`] = '"'.repeat(4096);
  }
  return captureCollaborationAdmissionOutcomeResult(result);
}

function makeOutcome(captured: ReturnType<typeof captureCollaborationAdmissionRequest>,
  documents: readonly CollaborationAdmissionDocument[]) {
  const proofText = '{"version":1,"kind":"owner_drain"}';
  const targets = documents.map((doc) => {
    const text = snapshotText(doc);
    const proofDigest = collaborationAdmissionOutcomeDigest('input', proofText);
    const snapshotDigest = collaborationAdmissionOutcomeDigest('snapshot', text);
    return { documentId: doc.documentId, proofDigest, snapshotText: text, snapshotDigest };
  });
  const outcome: CollaborationAdmissionOutcome = { version: 1, requestId: captured.request.requestId,
    requestDigest: captured.requestDigest, result: resultAtBound(), targets };
  const targetRows = targets.map((item) => ({ document_id: item.documentId, status: 'completed', active: false,
    quiescence_text: proofText, outcome_snapshot_text: item.snapshotText, outcome_snapshot_digest: item.snapshotDigest }));
  return { outcome, targetRows };
}

function databaseFor(captured: ReturnType<typeof captureCollaborationAdmissionRequest>, outcomeText: string,
  targetRows: Array<Record<string, unknown>>, onAll?: () => void): SqlConnection {
  return {
    get: async () => ({ request_digest: captured.requestDigest, intent_text: captured.intentText,
      status: 'committed', outcome_text: outcomeText }),
    all: async () => { onAll?.(); return targetRows; },
    run: async () => ({ changes: 0 }),
    close: async () => undefined,
  };
}

function assertAdmissionError(action: () => unknown, code: CollaborationAdmissionError['code']) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, code);
    return true;
  });
}

test('max-bounded 1024 escaped target snapshots serialize above legacy limit and read back canonically', async () => {
  const docs = Array.from({ length: DOCUMENT_COUNT }, (_, index) => document(index));
  const captured = captureCollaborationAdmissionRequest(request(docs));
  const { outcome, targetRows } = makeOutcome(captured, captured.request.expectedDocuments);
  const serialized = serializeCollaborationAdmissionOutcome(outcome);
  assert.ok(Buffer.byteLength(serialized, 'utf8') > 4 * 1024 * 1024, 'fixture exceeds the old 4 MiB reader cap');
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES);

  const decoded = await readCollaborationAdmissionOutcome(databaseFor(captured, serialized, targetRows), captured);
  assert.ok(decoded);
  assert.equal(decoded.targets.length, DOCUMENT_COUNT);
  assert.deepEqual(decoded, outcome);
});

test('writer refuses outcomes over the shared cap and reader fails closed without loading target rows', async () => {
  const captured = captureCollaborationAdmissionRequest(request([document(0)]));
  const { outcome, targetRows } = makeOutcome(captured, captured.request.expectedDocuments);
  const tooLarge: CollaborationAdmissionOutcome = { ...outcome,
    result: { oversized: 'x'.repeat(COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES) } };
  assertAdmissionError(() => serializeCollaborationAdmissionOutcome(tooLarge), 'ADMISSION_INVALID_REQUEST');

  const tooLargeStoredText = JSON.stringify(tooLarge);
  assert.ok(Buffer.byteLength(tooLargeStoredText, 'utf8') > COLLABORATION_ADMISSION_OUTCOME_MAX_BYTES);
  let queriedTargets = false;
  const db = databaseFor(captured, tooLargeStoredText, targetRows, () => { queriedTargets = true; });
  await assert.rejects(readCollaborationAdmissionOutcome(db, captured), (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, 'ADMISSION_RECOVERY_REQUIRED');
    return true;
  });
  assert.equal(queriedTargets, false, 'oversized header is rejected before target-row reads');
});
