import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CollaborationAdmissionError,
  admissionScopeContains,
  admissionScopesOverlap,
  captureCollaborationAdmissionRequest,
  collaborationAdmissionLockKey,
  isCanonicalAdmissionPath,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
} from '../app/lib/collaboration/room-admission-contract';

const REQUEST_ID = '2d607a15-c32c-41aa-b19f-425cde6ae803';
const ACTION_DIGEST = 'a'.repeat(64);

function scope(overrides: Partial<CollaborationAdmissionScope> = {}): CollaborationAdmissionScope {
  return {
    workspaceId: 'workspace-a',
    organizationId: 'org-a',
    path: 'folder',
    kind: 'subtree',
    ...overrides,
  };
}

function document(overrides: Partial<CollaborationAdmissionDocument> = {}): CollaborationAdmissionDocument {
  return {
    documentId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'workspace-a',
    organizationId: 'org-a',
    path: 'folder/file.txt',
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
    status: 'active',
    ...overrides,
  };
}

function request(overrides: Partial<CollaborationAdmissionRequest> = {}): CollaborationAdmissionRequest {
  return {
    requestId: REQUEST_ID,
    actorId: 'actor-a',
    action: 'rename',
    actionDigest: ACTION_DIGEST,
    scopes: [scope()],
    expectedDocuments: [document()],
    ...overrides,
  };
}

function assertAdmissionError(action: () => unknown, code: CollaborationAdmissionError['code']) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, code);
    return true;
  });
}

test('request capture canonicalizes scope/document/workspace ordering and digest', () => {
  const aScope = scope({ workspaceId: 'workspace-z', organizationId: null, path: 'z', kind: 'exact' });
  const bScope = scope({ workspaceId: 'workspace-a', organizationId: 'org-a', path: 'b', kind: 'subtree' });
  const docs = [
    document({ documentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: 'b/z.txt' }),
    document({ documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: 'b/a.txt' }),
  ];
  const first = captureCollaborationAdmissionRequest(request({ scopes: [aScope, bScope, bScope], expectedDocuments: docs }));
  const second = captureCollaborationAdmissionRequest(request({ scopes: [bScope, aScope], expectedDocuments: [...docs].reverse() }));

  assert.equal(first.intentText, second.intentText);
  assert.equal(first.requestDigest, second.requestDigest);
  assert.deepEqual(first.workspaceIds, ['workspace-a', 'workspace-z']);
  assert.deepEqual(first.request.expectedDocuments.map((value) => value.documentId), [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]);
  assert.equal(first.request.scopes.length, 2, 'identical scopes are deduplicated');
  assert.deepEqual(first.request.scopes, [...first.request.scopes].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(Object.isFrozen(first.request), true);
  assert.equal(Object.isFrozen(first.request.scopes), true);
  assert.equal(Object.isFrozen(first.request.expectedDocuments[0]), true);
  assert.match(collaborationAdmissionLockKey('workspace-a'), /^-?\d+$/u);
  assert.equal(collaborationAdmissionLockKey('workspace-a'), collaborationAdmissionLockKey('workspace-a'));
  assert.notEqual(collaborationAdmissionLockKey('workspace-a'), collaborationAdmissionLockKey('workspace-b'));
});

test('captured request is an immutable copy, not a retained caller object or arrays', () => {
  const mutableScope = { ...scope() };
  const mutableDocument = { ...document() };
  const input = {
    requestId: REQUEST_ID,
    actorId: 'actor-before',
    action: 'rename' as const,
    actionDigest: ACTION_DIGEST,
    scopes: [mutableScope],
    expectedDocuments: [mutableDocument],
  };
  const captured = captureCollaborationAdmissionRequest(input);
  const originalIntent = captured.intentText;
  const originalDigest = captured.requestDigest;

  input.actorId = 'actor-after';
  mutableScope.path = 'other';
  mutableDocument.path = 'other/file.txt';
  input.scopes.push(scope({ path: 'extra' }));
  input.expectedDocuments.splice(0, 1);

  assert.equal(captured.intentText, originalIntent);
  assert.equal(captured.requestDigest, originalDigest);
  assert.equal(captured.request.actorId, 'actor-before');
  assert.equal(captured.request.scopes[0]?.path, 'folder');
  assert.equal(captured.request.expectedDocuments[0]?.path, 'folder/file.txt');
  assert.equal(captured.request.scopes.length, 1);
  assert.equal(captured.request.expectedDocuments.length, 1);
});

test('canonical paths reject traversal and separators but preserve literal metacharacters and Unicode', () => {
  for (const invalidPath of ['../x', 'a/../x', './x', 'a//b', '/absolute', 'trailing/', 'a\\b', 'bad\u0000name', 'bad\u007fname']) {
    assert.equal(isCanonicalAdmissionPath(invalidPath), false, JSON.stringify(invalidPath));
  }
  for (const validPath of ['plain.txt', 'a/%_literal', '日記/é.txt', 'x/y']) {
    assert.equal(isCanonicalAdmissionPath(validPath), true, validPath);
  }
  assert.equal(isCanonicalAdmissionPath('', false), false);
  assert.equal(isCanonicalAdmissionPath('', true), true);
  assert.equal(isCanonicalAdmissionPath('', true) && isCanonicalAdmissionPath('', false), false);
  assert.equal(isCanonicalAdmissionPath('x'.repeat(4096)), true);
  assert.equal(isCanonicalAdmissionPath('x'.repeat(4097)), false);
});

test('exact and subtree overlap are segment-aware, workspace-scoped, and literal for %, _, and Unicode', () => {
  const subtreeA = scope({ path: 'a', kind: 'subtree' });
  const exactChild = scope({ path: 'a/child', kind: 'exact' });
  const exactSiblingPrefix = scope({ path: 'ab/child', kind: 'exact' });
  assert.equal(admissionScopeContains(subtreeA, 'workspace-a', 'a'), true);
  assert.equal(admissionScopeContains(subtreeA, 'workspace-a', 'a/child'), true);
  assert.equal(admissionScopeContains(subtreeA, 'workspace-a', 'ab/child'), false);
  assert.equal(admissionScopesOverlap(subtreeA, exactChild), true);
  assert.equal(admissionScopesOverlap(subtreeA, exactSiblingPrefix), false);
  assert.equal(admissionScopesOverlap(scope({ path: 'a', kind: 'exact' }), exactChild), false);
  assert.equal(admissionScopesOverlap(scope({ path: 'a', kind: 'exact' }), scope({ path: 'a', kind: 'exact' })), true);
  assert.equal(admissionScopesOverlap(subtreeA, scope({ workspaceId: 'workspace-b', path: 'a/x' })), false);
  const workspaceRoot = scope({ path: '', kind: 'subtree' });
  assert.equal(admissionScopeContains(workspaceRoot, 'workspace-a', ''), true);
  assert.equal(admissionScopeContains(workspaceRoot, 'workspace-a', 'any/nested/path'), true);
  assert.equal(admissionScopesOverlap(workspaceRoot, scope({ path: 'unrelated/file', kind: 'exact' })), true);

  const percentScope = scope({ path: '100%_done', kind: 'subtree' });
  assert.equal(admissionScopeContains(percentScope, 'workspace-a', '100%_done/日.txt'), true);
  assert.equal(admissionScopeContains(percentScope, 'workspace-a', '100x_done/日.txt'), false);
  assert.equal(admissionScopesOverlap(scope({ path: '日記', kind: 'subtree' }), scope({ path: '日記/é', kind: 'exact' })), true);
});

test('organization drift does not bypass scope overlap, but conflicting orgs in one request are invalid', () => {
  const oldOrg = scope({ organizationId: 'org-old', path: 'folder', kind: 'subtree' });
  const newOrg = scope({ organizationId: 'org-new', path: 'folder/file.txt', kind: 'exact' });
  assert.equal(admissionScopesOverlap(oldOrg, newOrg), true,
    'workspace/path identity overlaps even when organization metadata drifted');

  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: [oldOrg, newOrg], expectedDocuments: [],
  })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: [oldOrg], expectedDocuments: [document({ organizationId: 'org-new' })],
  })), 'ADMISSION_INVALID_REQUEST');
});

test('capture rejects duplicate documents and malformed IDs, digests, actions, and paths', () => {
  const sameDocument = document();
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    expectedDocuments: [sameDocument, { ...sameDocument }],
  })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({ requestId: REQUEST_ID.toUpperCase() })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({ actorId: `bad\u0001id` })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({ actorId: 'a'.repeat(257) })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: [scope({ workspaceId: '' })], expectedDocuments: [],
  })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: [scope({ workspaceId: 'w'.repeat(257) })], expectedDocuments: [],
  })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({ actionDigest: ACTION_DIGEST.toUpperCase() })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({ action: 'unknown' as CollaborationAdmissionRequest['action'] })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({ scopes: [scope({ path: 'a/../b' })] })), 'ADMISSION_INVALID_REQUEST');
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: [scope({ kind: 'exact', path: '' })], expectedDocuments: [],
  })), 'ADMISSION_INVALID_REQUEST');
});

test('capture enforces scope, workspace, and document count limits at their boundaries', () => {
  const repeatedScope = scope();
  const atScopeLimit = captureCollaborationAdmissionRequest(request({
    scopes: Array.from({ length: 64 }, () => ({ ...repeatedScope })),
    expectedDocuments: [],
  }));
  assert.equal(atScopeLimit.request.scopes.length, 1);
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: Array.from({ length: 65 }, () => ({ ...repeatedScope })), expectedDocuments: [],
  })), 'ADMISSION_INVALID_REQUEST');

  const scopesAtWorkspaceLimit = Array.from({ length: 16 }, (_, index) => scope({
    workspaceId: `workspace-${String(index).padStart(2, '0')}`, path: 'tree', organizationId: null,
  }));
  const atWorkspaceLimit = captureCollaborationAdmissionRequest(request({
    scopes: scopesAtWorkspaceLimit, expectedDocuments: [],
  }));
  assert.equal(atWorkspaceLimit.workspaceIds.length, 16);
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    scopes: [...scopesAtWorkspaceLimit, scope({ workspaceId: 'workspace-16', organizationId: null })],
    expectedDocuments: [],
  })), 'ADMISSION_INVALID_REQUEST');

  const documentsAtLimit = Array.from({ length: 1024 }, (_, index) => document({
    documentId: `doc-${String(index).padStart(4, '0')}`, path: `folder/${index}.txt`,
  }));
  const atDocumentLimit = captureCollaborationAdmissionRequest(request({ expectedDocuments: documentsAtLimit }));
  assert.equal(atDocumentLimit.request.expectedDocuments.length, 1024);
  assertAdmissionError(() => captureCollaborationAdmissionRequest(request({
    expectedDocuments: [...documentsAtLimit, document({ documentId: 'doc-over-limit', path: 'folder/extra.txt' })],
  })), 'ADMISSION_INVALID_REQUEST');
});
