import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CollaborationAdmissionError,
  type CollaborationAdmissionDocument,
} from '../app/lib/collaboration/room-admission-contract';
import type { CollaborationAdmissionTarget } from '../app/lib/collaboration/room-admission';
import {
  admissionDrainTicketForTarget,
  captureCollaborationAdmissionDrainTicket,
  captureCollaborationAdmissionOwnerFence,
  matchesCollaborationAdmissionDrainFence,
  sameCollaborationAdmissionDrainTicket,
  type CollaborationAdmissionDrainTicket,
} from '../app/lib/collaboration/room-admission-drain';
import type { CollaborationRoomOwnerFence, CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';

const REQUEST_ID = '2d607a15-c32c-41aa-b19f-425cde6ae803';
const OTHER_REQUEST_ID = '3e718b26-d43d-42bb-92a0-536d7fbf9014';
const REQUEST_DIGEST = 'a'.repeat(64);
const OTHER_REQUEST_DIGEST = 'b'.repeat(64);

function ownerScope(overrides: Partial<CollaborationRoomOwnerScope> = {}): CollaborationRoomOwnerScope {
  return {
    documentId: 'doc-a',
    workspaceId: 'workspace-a',
    organizationId: 'org-a',
    path: 'folder/a.txt',
    representation: 'plain_text',
    lifecycleGeneration: 2,
    schemaVersion: 3,
    ...overrides,
  };
}

function ownerFence(overrides: Partial<CollaborationRoomOwnerFence> = {}): CollaborationRoomOwnerFence {
  return {
    scope: ownerScope(),
    epoch: 5,
    token: 'owner-token',
    backendPid: 4567,
    backendStart: '1727370000.12345',
    ...overrides,
  };
}

function target(input: {
  document?: Partial<CollaborationAdmissionDocument>;
  ownerEpoch?: number;
  ownerToken?: string | null;
  ownerBackendPid?: number | null;
  ownerBackendStart?: string | null;
} = {}): CollaborationAdmissionTarget {
  return {
    document: {
      ...ownerScope(),
      status: 'active',
      ...input.document,
    },
    ownerEpoch: input.ownerEpoch ?? 5,
    ownerToken: input.ownerToken === undefined ? 'owner-token' : input.ownerToken,
    ownerBackendPid: input.ownerBackendPid === undefined ? 4567 : input.ownerBackendPid,
    ownerBackendStart: input.ownerBackendStart === undefined ? '1727370000.12345' : input.ownerBackendStart,
    documentSequence: 12,
  };
}

function assertAdmissionError(action: () => unknown, code: CollaborationAdmissionError['code']) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, code);
    return true;
  });
}

function ticketFor(requestId = REQUEST_ID, requestDigest = REQUEST_DIGEST, value = target()) {
  return admissionDrainTicketForTarget(requestId, requestDigest, value);
}

test('active target creates a valid deterministic release ticket with a canonical owner fence', () => {
  const value = target();
  const ticket = admissionDrainTicketForTarget(REQUEST_ID, REQUEST_DIGEST, value);
  const captured = captureCollaborationAdmissionDrainTicket(ticket);

  assert.equal(captured.requestId, REQUEST_ID);
  assert.equal(captured.requestDigest, REQUEST_DIGEST);
  assert.match(captured.releaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(captured.fence.scope, ownerScope());
  assert.equal(captured.fence.epoch, value.ownerEpoch);
  assert.equal(captured.fence.token, value.ownerToken);
  assert.equal(captured.fence.backendPid, value.ownerBackendPid);
  assert.equal(captured.fence.backendStart, value.ownerBackendStart);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.fence), true);
  assert.equal(Object.isFrozen(captured.fence.scope), true);
  assert.equal('status' in captured.fence.scope, false, 'target status is not copied into the owner fence scope');
});

test('release IDs are stable and distinct across request ID, request digest, and document ID', () => {
  const base = ticketFor();
  assert.equal(ticketFor().releaseId, base.releaseId);
  const byRequest = ticketFor(OTHER_REQUEST_ID, REQUEST_DIGEST);
  const byDigest = ticketFor(REQUEST_ID, OTHER_REQUEST_DIGEST);
  const byDocument = ticketFor(REQUEST_ID, REQUEST_DIGEST, target({ document: { documentId: 'doc-b' } }));

  assert.notEqual(byRequest.releaseId, base.releaseId);
  assert.notEqual(byDigest.releaseId, base.releaseId);
  assert.notEqual(byDocument.releaseId, base.releaseId);
  assert.equal(new Set([base.releaseId, byRequest.releaseId, byDigest.releaseId, byDocument.releaseId]).size, 4);
});

test('ticket capture copies nested fence fields and strips target-only aliases', () => {
  const mutableScope = { ...ownerScope(), status: 'active' as const };
  const mutableFence = {
    scope: mutableScope,
    epoch: 5,
    token: 'owner-token',
    backendPid: 4567,
    backendStart: '1727370000.12345',
  };
  const input = {
    requestId: REQUEST_ID,
    requestDigest: REQUEST_DIGEST,
    releaseId: ticketFor().releaseId,
    fence: mutableFence,
  };
  const captured = captureCollaborationAdmissionDrainTicket(input);

  mutableScope.path = 'changed.txt';
  mutableFence.token = 'replaced-token';
  input.requestDigest = OTHER_REQUEST_DIGEST;
  input.releaseId = '00000000-0000-8000-a000-000000000000';

  assert.equal(captured.requestDigest, REQUEST_DIGEST);
  assert.equal(captured.releaseId, ticketFor().releaseId);
  assert.equal(captured.fence.scope.path, 'folder/a.txt');
  assert.equal(captured.fence.token, 'owner-token');
  assert.equal('status' in captured.fence.scope, false);
  assert.equal(Object.isFrozen(captured.fence.scope), true);
});

test('fence matching detects changes to epoch, token, backend identity, scope, and generation', () => {
  const ticket = ticketFor();
  const baseline = ticket.fence;
  assert.equal(matchesCollaborationAdmissionDrainFence(ticket, baseline), true);

  const changedFences: CollaborationRoomOwnerFence[] = [
    { ...baseline, epoch: baseline.epoch + 1 },
    { ...baseline, token: 'new-token' },
    { ...baseline, backendPid: baseline.backendPid + 1 },
    { ...baseline, backendStart: '1727370001.00000' },
    { ...baseline, scope: { ...baseline.scope, documentId: 'doc-b' } },
    { ...baseline, scope: { ...baseline.scope, workspaceId: 'workspace-b' } },
    { ...baseline, scope: { ...baseline.scope, path: 'folder/renamed.txt' } },
    { ...baseline, scope: { ...baseline.scope, organizationId: 'org-b' } },
    { ...baseline, scope: { ...baseline.scope, lifecycleGeneration: baseline.scope.lifecycleGeneration + 1 } },
    { ...baseline, scope: { ...baseline.scope, schemaVersion: baseline.scope.schemaVersion + 1 } },
  ];
  for (const fence of changedFences) assert.equal(matchesCollaborationAdmissionDrainFence(ticket, fence), false);
});

test('vacant owners and archived targets cannot start a drain', () => {
  assertAdmissionError(() => ticketFor(REQUEST_ID, REQUEST_DIGEST, target({
    ownerToken: null, ownerBackendPid: null, ownerBackendStart: null,
  })), 'ADMISSION_STATE_CHANGED');
  assertAdmissionError(() => ticketFor(REQUEST_ID, REQUEST_DIGEST, target({ document: { status: 'archived' } })),
    'ADMISSION_STATE_CHANGED');
});

test('invalid bounds, fence fields, path, ticket UUID, digest, and release ID are rejected', () => {
  const valid = ticketFor();
  const invalidFences: CollaborationRoomOwnerFence[] = [
    ownerFence({ epoch: 0 }),
    ownerFence({ token: '' }),
    ownerFence({ backendPid: 0 }),
    ownerFence({ backendStart: '' }),
    ownerFence({ scope: ownerScope({ lifecycleGeneration: 0 }) }),
    ownerFence({ scope: ownerScope({ schemaVersion: Number.MAX_SAFE_INTEGER + 1 }) }),
    ownerFence({ scope: ownerScope({ path: 'folder/../secret.txt' }) }),
    ownerFence({ scope: ownerScope({ path: '' }) }),
    ownerFence({ scope: ownerScope({ documentId: 'd'.repeat(257) }) }),
  ];
  for (const fence of invalidFences) {
    assertAdmissionError(() => captureCollaborationAdmissionOwnerFence(fence), 'ADMISSION_INVALID_REQUEST');
  }

  const badTickets: CollaborationAdmissionDrainTicket[] = [
    { ...valid, requestId: REQUEST_ID.toUpperCase() },
    { ...valid, requestDigest: 'a'.repeat(63) },
    { ...valid, releaseId: '00000000-0000-8000-a000-000000000000' },
    { ...valid, fence: ownerFence({ scope: ownerScope({ path: 'x//y' }) }) },
  ];
  for (const badTicket of badTickets) {
    assertAdmissionError(() => captureCollaborationAdmissionDrainTicket(badTicket), 'ADMISSION_INVALID_REQUEST');
  }
});

test('same-ticket comparison canonicalizes equivalent object key order and detects field changes', () => {
  const base = ticketFor();
  const reordered = {
    fence: {
      backendStart: base.fence.backendStart,
      backendPid: base.fence.backendPid,
      token: base.fence.token,
      epoch: base.fence.epoch,
      scope: {
        schemaVersion: base.fence.scope.schemaVersion,
        lifecycleGeneration: base.fence.scope.lifecycleGeneration,
        representation: base.fence.scope.representation,
        path: base.fence.scope.path,
        organizationId: base.fence.scope.organizationId,
        workspaceId: base.fence.scope.workspaceId,
        documentId: base.fence.scope.documentId,
      },
    },
    releaseId: base.releaseId,
    requestDigest: base.requestDigest,
    requestId: base.requestId,
  };
  assert.equal(sameCollaborationAdmissionDrainTicket(base, reordered), true);
  assert.equal(sameCollaborationAdmissionDrainTicket(base, ticketFor(REQUEST_ID, OTHER_REQUEST_DIGEST)), false);
  assert.equal(sameCollaborationAdmissionDrainTicket(base, {
    ...base,
    fence: { ...base.fence, scope: { ...base.fence.scope, path: 'elsewhere' } },
  }), false);
});
