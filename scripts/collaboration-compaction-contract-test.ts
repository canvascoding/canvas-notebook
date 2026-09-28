import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CollaborationAdmissionError,
  collaborationAdmissionActionDigest,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
} from '../app/lib/collaboration/room-admission-contract';
import { captureCollaborationCompactionRequest } from '../app/lib/collaboration/compaction-contract';

const PAYLOAD = (documentId: string, expectedLifecycleGeneration: number, extras: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, documentId, expectedLifecycleGeneration, ...extras });

function document(overrides: Partial<CollaborationAdmissionDocument> = {}): CollaborationAdmissionDocument {
  return {
    documentId: 'compact-doc', workspaceId: 'compact-workspace', organizationId: 'compact-org',
    path: 'notes/compact.md', representation: 'plain_text', lifecycleGeneration: 7,
    schemaVersion: 2, status: 'active', ...overrides,
  };
}

function scope(overrides: Partial<CollaborationAdmissionScope> = {}): CollaborationAdmissionScope {
  return { workspaceId: 'compact-workspace', organizationId: 'compact-org', path: 'notes/compact.md', kind: 'exact', ...overrides };
}

function request(input: {
  action?: CollaborationAdmissionRequest['action'];
  documents?: CollaborationAdmissionDocument[];
  scopes?: CollaborationAdmissionScope[];
  payload?: string;
  digest?: string;
} = {}): CollaborationAdmissionRequest {
  const action = input.action ?? 'compact';
  const firstDocument = input.documents?.[0] ?? document();
  const payload = input.payload ?? PAYLOAD(firstDocument.documentId, firstDocument.lifecycleGeneration);
  return {
    requestId: '03abcdf1-7a90-4db4-a7f6-7c668dc78021',
    actorId: 'compaction-contract-test',
    action,
    actionDigest: input.digest ?? collaborationAdmissionActionDigest(action, payload),
    actionPayloadText: payload,
    scopes: input.scopes ?? [scope()],
    expectedDocuments: input.documents ?? [document()],
  };
}

function assertInvalid(input: CollaborationAdmissionRequest) {
  assert.throws(() => captureCollaborationCompactionRequest(input), (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, 'ADMISSION_INVALID_REQUEST');
    return true;
  });
}

test('valid compaction request is captured canonically, frozen, and detached from caller mutation', () => {
  const mutableDocument = document();
  const mutableScope = scope();
  const mutablePayload = PAYLOAD(mutableDocument.documentId, mutableDocument.lifecycleGeneration);
  const input = request({ documents: [mutableDocument], scopes: [mutableScope], payload: mutablePayload });
  const captured = captureCollaborationCompactionRequest(input);

  assert.deepEqual(captured.document, mutableDocument);
  assert.equal(captured.request.action, 'compact');
  const canonicalPayload = '{"documentId":"compact-doc","expectedLifecycleGeneration":7,"version":1}';
  assert.equal(captured.request.actionPayloadText, canonicalPayload);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.request), true);
  assert.equal(Object.isFrozen(captured.document), true);
  assert.equal(Object.isFrozen(captured.request.scopes), true);
  assert.equal(Object.isFrozen(captured.request.expectedDocuments), true);

  Object.assign(mutableDocument, { path: 'changed.md', lifecycleGeneration: 99 });
  Object.assign(mutableScope, { path: 'changed.md' });
  Object.assign(input, { actionPayloadText: PAYLOAD('changed-doc', 99) });
  assert.equal(captured.document.path, 'notes/compact.md');
  assert.equal(captured.document.lifecycleGeneration, 7);
  assert.equal(captured.request.scopes[0].path, 'notes/compact.md');
  assert.equal(captured.request.actionPayloadText, canonicalPayload);
});

test('compaction requires exact compact action, one active document, and one exact matching scope', () => {
  assertInvalid(request({ action: 'move' }));
  assertInvalid(request({ documents: [] }));
  assertInvalid(request({ documents: [document(), document({ documentId: 'compact-doc-2', path: 'notes/second.md' })] }));
  assertInvalid(request({ scopes: [scope(), scope({ path: 'notes/other.md' })] }));
  assertInvalid(request({ scopes: [scope({ kind: 'subtree' })] }));
  assertInvalid(request({ documents: [document({ status: 'archived' })] }));
  assertInvalid(request({ scopes: [scope({ organizationId: 'other-org' })] }));
  assertInvalid(request({ scopes: [scope({ path: 'notes/other.md' })] }));
});

test('payload must contain exactly matching version, document ID, and lifecycle generation', () => {
  const doc = document();
  assertInvalid(request({ payload: '{}' }));
  assertInvalid(request({ payload: PAYLOAD(doc.documentId, doc.lifecycleGeneration, { extra: true }) }));
  assertInvalid(request({ payload: PAYLOAD(doc.documentId, doc.lifecycleGeneration + 1) }));
  assertInvalid(request({ payload: PAYLOAD('other-doc', doc.lifecycleGeneration) }));
  assertInvalid(request({ payload: PAYLOAD(doc.documentId, doc.lifecycleGeneration, { version: 2 }) }));
  assertInvalid(request({ digest: 'f'.repeat(64) }));
});

test('legacy requests without the required payload and malformed payload text are rejected', () => {
  const { actionPayloadText: _payload, ...legacy } = request();
  assertInvalid(legacy);
  const malformed = request();
  Object.assign(malformed, { actionPayloadText: '{not-json' });
  assertInvalid(malformed);
});
