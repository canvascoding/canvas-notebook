import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';

import * as admissionContract from '../app/lib/collaboration/room-admission-contract';
import type { CollaborationAdmissionDocument } from '../app/lib/collaboration/room-admission-contract';
import * as drain from '../app/lib/collaboration/room-admission-drain';
import type { CollaborationAdmissionTarget } from '../app/lib/collaboration/room-admission';
import type { CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';

type SnapshotModule = {
  captureCollaborationAdmissionTargetRow(row: Record<string, unknown>, expected: CollaborationAdmissionDocument): CollaborationAdmissionTarget;
  decodeCollaborationAdmissionTarget(text: string, expected: CollaborationAdmissionDocument): CollaborationAdmissionTarget;
};

let snapshotModule: SnapshotModule;
before(async () => {
  const compiledModule = { exports: {} as Record<string, unknown> };
  const sourcePath = path.resolve('app/lib/collaboration/room-admission.ts');
  const source = ts.transpileModule(await readFile(sourcePath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const runtimeRequire = createRequire(sourcePath);
  const mocks: Record<string, unknown> = {
    'server-only': {},
    './lifecycle-transaction': { executeLifecycleTransaction: async ({ execute }: { execute: (db: unknown) => Promise<unknown> }) => execute({}) },
    './room-owner-release': {
      collaborationRoomReleaseDigest: (kind: string, bytes: Uint8Array) => createHash('sha256')
        .update(`test:${kind}:`).update(bytes).digest('hex'),
    },
    './room-admission-drain': drain,
    './room-admission-contract': admissionContract,
  };
  const localRequire = (name: string) => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : runtimeRequire(name);
  new Function('require', 'module', 'exports', source)(localRequire, compiledModule, compiledModule.exports);
  snapshotModule = compiledModule.exports as SnapshotModule;
});
const captureCollaborationAdmissionTargetRow = (...args: Parameters<SnapshotModule['captureCollaborationAdmissionTargetRow']>) =>
  snapshotModule.captureCollaborationAdmissionTargetRow(...args);
const decodeCollaborationAdmissionTarget = (...args: Parameters<SnapshotModule['decodeCollaborationAdmissionTarget']>) =>
  snapshotModule.decodeCollaborationAdmissionTarget(...args);

function scope(overrides: Partial<CollaborationRoomOwnerScope> = {}): CollaborationRoomOwnerScope {
  return { documentId: 'doc-snapshot', workspaceId: 'workspace-snapshot', organizationId: 'org-snapshot',
    path: 'notes/snapshot.md', representation: 'plain_text', lifecycleGeneration: 4, schemaVersion: 2, ...overrides };
}

const expected: CollaborationAdmissionDocument = { ...scope(), status: 'active' };

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_id: expected.documentId,
    workspace_id: expected.workspaceId,
    organization_id: expected.organizationId,
    path: expected.path,
    representation: expected.representation,
    lifecycle_generation: expected.lifecycleGeneration,
    schema_version: expected.schemaVersion,
    status: expected.status,
    room_owner_epoch: 7,
    room_owner_token: 'snapshot-owner-token',
    room_owner_backend_pid: 9021,
    room_owner_backend_start: '1727370000.54321',
    document_sequence: 15,
    yjs_state: new Uint8Array([1, 2, 3]),
    state_vector: new Uint8Array([4, 5]),
    ...overrides,
  };
}

function assertScopeChanged(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof admissionContract.CollaborationAdmissionError);
    assert.equal(error.code, 'ADMISSION_SCOPE_CHANGED');
    return true;
  });
}

function makeYjsState() {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'persisted');
  const before = { yjs_state: Y.encodeStateAsUpdate(doc), state_vector: Y.encodeStateVector(doc) };
  doc.getText('content').delete(0, 1);
  const after = { yjs_state: Y.encodeStateAsUpdate(doc), state_vector: Y.encodeStateVector(doc) };
  return { doc, before, after };
}

test('captured database row round-trips canonically and does not retain caller-owned bytes', () => {
  const input = row();
  const captured = captureCollaborationAdmissionTargetRow(input, expected);
  const serialized = JSON.stringify(captured);
  const decoded = decodeCollaborationAdmissionTarget(serialized, expected);

  assert.deepEqual(decoded, captured);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.document), true);
  assert.equal('status' in captured, false);
  assert.equal('yjs_state' in captured, false);
  assert.equal('state_vector' in captured, false);
  input.yjs_state = new Uint8Array([9, 9, 9]);
  input.state_vector = new Uint8Array([8, 8]);
  assert.equal(JSON.stringify(decodeCollaborationAdmissionTarget(serialized, expected)), serialized);
});

test('raw update hash detects DeleteSet-only changes while the Yjs state vector remains unchanged', () => {
  const { before, after } = makeYjsState();
  assert.deepEqual(before.state_vector, after.state_vector);
  assert.notDeepEqual(before.yjs_state, after.yjs_state);
  const beforeTarget = captureCollaborationAdmissionTargetRow(row(before), expected);
  const afterTarget = captureCollaborationAdmissionTargetRow(row(after), expected);

  assert.notEqual(beforeTarget.persistedUpdateHash, afterTarget.persistedUpdateHash);
  assert.equal(beforeTarget.persistedVectorHash, afterTarget.persistedVectorHash);
});

test('strict snapshot decoder rejects missing and legacy persistence hashes', () => {
  const captured = captureCollaborationAdmissionTargetRow(row(), expected);
  const { persistedUpdateHash: _update, persistedVectorHash: _vector, ...legacy } = captured;
  assertScopeChanged(() => decodeCollaborationAdmissionTarget(JSON.stringify(legacy), expected));
  assertScopeChanged(() => decodeCollaborationAdmissionTarget(JSON.stringify({ ...captured, persistedUpdateHash: undefined }), expected));
  assertScopeChanged(() => decodeCollaborationAdmissionTarget(JSON.stringify({ ...captured, persistedVectorHash: 'legacy' }), expected));
});

test('row capture and decoder reject document, scope, status, schema, and representation drift', () => {
  const badRows = [
    row({ document_id: 'other-doc' }),
    row({ workspace_id: 'other-workspace' }),
    row({ organization_id: 'other-org' }),
    row({ path: 'notes/other.md' }),
    row({ status: 'archived' }),
    row({ schema_version: 3 }),
    row({ representation: 'tiptap_xml' }),
  ];
  for (const input of badRows) assertScopeChanged(() => captureCollaborationAdmissionTargetRow(input, expected));

  const captured = captureCollaborationAdmissionTargetRow(row(), expected);
  const badSnapshots = [
    { ...captured, document: { ...captured.document, documentId: 'other-doc' } },
    { ...captured, document: { ...captured.document, workspaceId: 'other-workspace' } },
    { ...captured, document: { ...captured.document, organizationId: 'other-org' } },
    { ...captured, document: { ...captured.document, path: 'notes/other.md' } },
    { ...captured, document: { ...captured.document, status: 'archived' } },
    { ...captured, document: { ...captured.document, schemaVersion: 3 } },
    { ...captured, document: { ...captured.document, representation: 'tiptap_xml' } },
  ];
  for (const snapshot of badSnapshots) assertScopeChanged(() => decodeCollaborationAdmissionTarget(JSON.stringify(snapshot), expected));
});

test('row capture rejects unsafe, negative, and null numeric fields', () => {
  const invalidRows = [
    row({ lifecycle_generation: -1 }),
    row({ lifecycle_generation: Number.MAX_SAFE_INTEGER + 1 }),
    row({ lifecycle_generation: null }),
    row({ schema_version: -1 }),
    row({ schema_version: Number.MAX_SAFE_INTEGER + 1 }),
    row({ schema_version: null }),
    row({ room_owner_epoch: -1 }),
    row({ room_owner_epoch: Number.MAX_SAFE_INTEGER + 1 }),
    row({ room_owner_epoch: null }),
    row({ document_sequence: -1 }),
    row({ document_sequence: Number.MAX_SAFE_INTEGER + 1 }),
    row({ document_sequence: null }),
  ];
  for (const input of invalidRows) assertScopeChanged(() => captureCollaborationAdmissionTargetRow(input, expected));
});

test('capture and decoder reject incoherent owner tuples', () => {
  const incoherentRows = [
    row({ room_owner_token: null, room_owner_backend_pid: 9021 }),
    row({ room_owner_token: null, room_owner_backend_start: '1727370000.54321' }),
    row({ room_owner_token: 'token', room_owner_backend_pid: null }),
    row({ room_owner_token: 'token', room_owner_backend_start: null }),
    row({ room_owner_token: '', room_owner_backend_pid: 9021 }),
    row({ room_owner_epoch: 0, room_owner_token: 'token' }),
  ];
  for (const input of incoherentRows) assertScopeChanged(() => captureCollaborationAdmissionTargetRow(input, expected));

  const captured = captureCollaborationAdmissionTargetRow(row(), expected);
  const incoherentSnapshots = [
    { ...captured, ownerToken: null },
    { ...captured, ownerBackendPid: null },
    { ...captured, ownerBackendStart: null },
    { ...captured, ownerEpoch: 0 },
    { ...captured, ownerToken: '' },
  ];
  for (const snapshot of incoherentSnapshots) assertScopeChanged(() => decodeCollaborationAdmissionTarget(JSON.stringify(snapshot), expected));
});

test('decoder rejects unsafe numbers, unknown or reordered fields, and noncanonical JSON text', () => {
  const captured = captureCollaborationAdmissionTargetRow(row(), expected);
  const badSnapshots = [
    { ...captured, ownerEpoch: -1 },
    { ...captured, ownerEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...captured, documentSequence: -1 },
    { ...captured, documentSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...captured, unexpected: true },
  ];
  for (const snapshot of badSnapshots) assertScopeChanged(() => decodeCollaborationAdmissionTarget(JSON.stringify(snapshot), expected));

  const canonicalText = JSON.stringify(captured);
  const reorderedText = JSON.stringify({
    document: captured.document,
    ownerToken: captured.ownerToken,
    ownerEpoch: captured.ownerEpoch,
    ownerBackendPid: captured.ownerBackendPid,
    ownerBackendStart: captured.ownerBackendStart,
    documentSequence: captured.documentSequence,
    persistedUpdateHash: captured.persistedUpdateHash,
    persistedVectorHash: captured.persistedVectorHash,
  });
  assert.notEqual(reorderedText, canonicalText);
  assertScopeChanged(() => decodeCollaborationAdmissionTarget(reorderedText, expected));
  assertScopeChanged(() => decodeCollaborationAdmissionTarget(`${canonicalText} `, expected));
});
