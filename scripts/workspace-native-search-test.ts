import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import type * as YTypes from 'yjs';
import { Y } from '../app/lib/collaboration/server-runtime';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { listWorkspaceSearchDocuments, readWorkspaceSearchText, WorkspaceSearchReadError } from '../app/lib/collaboration/workspace-search-reader';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { SqlConnection } from '../app/lib/db';

const workspace: WorkspaceContext = {
  workspaceId: 'search-workspace', organizationId: null, workspaceType: 'personal', rootPath: '/no-search-projections',
  legacy: false, status: 'active', permissions: { canRead: true, canWrite: false, canDelete: false,
    canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
};
function stateFor(doc: YTypes.Doc, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'search-document', workspaceId: workspace.workspaceId, organizationId: null, path: 'note.md',
    representation, lifecycleGeneration: 2, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 6, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}
function entry(authority: WorkspaceDocumentCatalogueEntry['authority'] = 'initialized'): WorkspaceDocumentCatalogueEntry {
  return { id: 'search-document', lineage_id: 'search-lineage', path: 'note.md', workspace_id: workspace.workspaceId,
    organization_id: null, status: 'active', state_version: authority === 'pristine' ? 0 : 6,
    has_persisted_state: authority === 'initialized', has_state_history: authority !== 'pristine',
    lifecycle_generation: authority === 'initialized' ? 2 : null, authority,
    state_status: authority === 'initialized' ? 'active' : null, state_path: authority === 'initialized' ? 'note.md' : null,
    state_workspace_id: authority === 'initialized' ? workspace.workspaceId : null, state_organization_id: null };
}
function seams(entries: WorkspaceDocumentCatalogueEntry[]) {
  const calls: string[] = [];
  const connection: SqlConnection = { run: async sql => { calls.push(sql); }, get: async sql => { calls.push(sql); },
    all: async () => [], close: async error => { calls.push(error ? 'discard' : 'close'); } };
  return { calls, dependencies: { openConnection: async () => connection,
    readCatalogue: async () => entries } };
}

test('native-only table is searchable with read permission and no projection or Markdown serialization', async () => {
  const doc = createRichMarkdownYDoc('---\ntitle: NativeSearch\n---\n\n| Name |\n| --- |\n| Target phrase |', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
  for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
    (record.get('attributes') as YTypes.Map<unknown>).set('colwidth', [121]);
  }
  assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
  const state = stateFor(doc, 'tiptap_blocks');
  state.projectionError = { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 6, permanent: false };
  const before = Buffer.from(state.yjsState);
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  const { calls, dependencies } = seams([entry()]);
  try {
    const result = await readWorkspaceSearchText(workspace, 'note.md', 4096, { ...dependencies,
      readPhysical: async () => { assert.fail('An initialized document must not read its projection.'); } });
    assert.match(result.content, /NativeSearch/u); assert.match(result.content, /Target phrase/u);
    assert.equal(result.source, 'persisted_yjs'); assert.equal(result.modifiedAt, 100);
    assert.deepEqual(result.nativeIdentity, { documentId: 'search-document', lineageId: 'search-lineage', path: 'note.md' });
    assert.equal(Object.isFrozen(result.nativeIdentity), true);
    assert.deepEqual(Buffer.from(state.yjsState), before);
    assert.ok(calls.includes('SELECT pg_advisory_xact_lock_shared($1::bigint)'));
    assert.deepEqual(calls.slice(-2), ['COMMIT', 'close']);
  } finally { installed(); doc.destroy(); }
});

test('live native text is read without stamping an older durable timestamp', async () => {
  const doc = createPlainTextYDoc('Before'); const state = stateFor(doc, 'plain_text');
  doc.getText('content').insert(6, ' fresh live edit');
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  try {
    const result = await readWorkspaceSearchText(workspace, 'note.md', 4096, seams([entry()]).dependencies);
    assert.equal(result.content, 'Before fresh live edit'); assert.equal(result.source, 'live_yjs');
    assert.equal(result.modifiedAt, null);
    assert.deepEqual(result.nativeIdentity, { documentId: 'search-document', lineageId: 'search-lineage', path: 'note.md' });
  } finally { installed(); doc.destroy(); }
});

test('historical missing state, wrong lifecycle and offline catalogue never fall back to disk', async () => {
  let physicalReads = 0;
  const readPhysical = async () => { physicalReads++; return { content: 'stale', source: 'file' as const, modifiedAt: 10, nativeIdentity: null }; };
  const missing = seams([entry('missing-state')]);
  await assert.rejects(readWorkspaceSearchText(workspace, 'note.md', 4096, { ...missing.dependencies, readPhysical }), WorkspaceSearchReadError);
  assert.deepEqual(missing.calls.slice(-2), ['ROLLBACK', 'close']);
  const doc = createPlainTextYDoc('Native'); const state = stateFor(doc, 'plain_text'); state.lifecycleGeneration = 3;
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  try { await assert.rejects(readWorkspaceSearchText(workspace, 'note.md', 4096, { ...seams([entry()]).dependencies, readPhysical }), /changed or is unavailable/u); }
  finally { installed(); doc.destroy(); }
  await assert.rejects(readWorkspaceSearchText(workspace, 'note.md', 4096, {
    ...seams([]).dependencies, readCatalogue: async () => { throw new Error('offline'); }, readPhysical }), /offline/u);
  assert.equal(physicalReads, 0);
});

test('pristine and unregistered text use bounded strict UTF-8 physical reads without initialization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-search-'));
  const physicalWorkspace = { ...workspace, rootPath: root };
  try {
    const content = '\uFEFF# Pristine\r\nExact\tcharacters 😀\r\n';
    await fs.writeFile(path.join(root, 'note.md'), content);
    const original = await fs.readFile(path.join(root, 'note.md'));
    for (const catalogue of [[entry('pristine')], []]) {
      const read = await readWorkspaceSearchText(physicalWorkspace, 'note.md', 4096, seams(catalogue).dependencies);
      assert.equal(read.content, content); assert.equal(read.source, 'file');
      assert.equal(read.nativeIdentity, null, 'Physical text does not acquire a later native path identity.');
      assert.deepEqual(await fs.readFile(path.join(root, 'note.md')), original);
    }
    await assert.rejects(readWorkspaceSearchText(physicalWorkspace, 'note.md', 4, seams([]).dependencies),
      (error: unknown) => error instanceof WorkspaceSearchReadError && error.code === 'SOURCE_TOO_LARGE');
    await fs.writeFile(path.join(root, 'note.md'), Buffer.from([0xc3, 0x28]));
    await assert.rejects(readWorkspaceSearchText(physicalWorkspace, 'note.md', 4096, seams([]).dependencies),
      (error: unknown) => error instanceof WorkspaceSearchReadError && error.code === 'SOURCE_BINARY');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('native size limit applies to current content instead of an empty projection', async () => {
  const doc = createPlainTextYDoc('😀'.repeat(8)); const state = stateFor(doc, 'plain_text');
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  try { await assert.rejects(readWorkspaceSearchText(workspace, 'note.md', 12, seams([entry()]).dependencies),
    (error: unknown) => error instanceof WorkspaceSearchReadError && error.code === 'SOURCE_TOO_LARGE'); }
  finally { installed(); doc.destroy(); }
});

test('persisted fallback uses the held read connection instead of opening another pool checkout', async () => {
  const doc = createPlainTextYDoc('Current persisted text'); const state = stateFor(doc, 'plain_text');
  const fixture = seams([entry()]); let loads = 0;
  try {
    const result = await readWorkspaceSearchText(workspace, 'note.md', 4096, { ...fixture.dependencies,
      loadState: async (connection, documentId) => {
        loads++; assert.equal(documentId, state.documentId);
        assert.ok(fixture.calls.includes('SELECT pg_advisory_xact_lock_shared($1::bigint)'));
        assert.equal(fixture.calls.includes('close'), false);
        assert.equal(typeof connection.get, 'function'); return state;
      } });
    assert.equal(result.content, 'Current persisted text'); assert.equal(loads, 1);
    assert.deepEqual(result.nativeIdentity, { documentId: 'search-document', lineageId: 'search-lineage', path: 'note.md' });
  } finally { doc.destroy(); }
});

test('a reused catalogue object and a replacement D2 at the same path cannot change captured D1 identity', async () => {
  const original = createPlainTextYDoc('Original D1 target');
  const replacement = createPlainTextYDoc('Replacement D2 target');
  const registered = entry();
  let currentDoc = original;
  let currentState = stateFor(original, 'plain_text');
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(currentDoc, currentState));
  const fixture = seams([registered]);
  try {
    const first = await readWorkspaceSearchText(workspace, 'note.md', 4096, fixture.dependencies);
    assert.equal(first.content, 'Original D1 target');
    assert.deepEqual(first.nativeIdentity, { documentId: 'search-document', lineageId: 'search-lineage', path: 'note.md' });
    assert.equal(Object.isFrozen(first.nativeIdentity), true);
    Object.assign(registered, { id: 'search-document-D2', lineage_id: 'search-lineage-D2', lifecycle_generation: 1 });
    currentDoc = replacement;
    currentState = { ...stateFor(replacement, 'plain_text'), documentId: 'search-document-D2', lifecycleGeneration: 1 };
    const second = await readWorkspaceSearchText(workspace, 'note.md', 4096, fixture.dependencies);
    assert.equal(second.content, 'Replacement D2 target');
    assert.deepEqual(second.nativeIdentity, { documentId: 'search-document-D2', lineageId: 'search-lineage-D2', path: 'note.md' });
    assert.notEqual(first.nativeIdentity, second.nativeIdentity);
    assert.deepEqual(first.nativeIdentity, { documentId: 'search-document', lineageId: 'search-lineage', path: 'note.md' },
      'The first actual Yjs read keeps its own copied identity after the catalogue is reused.');
    assert.equal(first.content, 'Original D1 target');
    assert.deepEqual(fixture.calls.slice(-2), ['COMMIT', 'close']);
  } finally { installed(); original.destroy(); replacement.destroy(); }
});

test('registry-only paths remain discoverable and denied scope opens no connection', async () => {
  const { dependencies } = seams([entry()]);
  assert.deepEqual(await listWorkspaceSearchDocuments(workspace, '.', dependencies), ['note.md']);
  const denied = { ...workspace, permissions: { ...workspace.permissions, canRead: false } };
  const openConnection = async (): Promise<SqlConnection> => assert.fail('No connection for denied access.');
  await assert.rejects(readWorkspaceSearchText(denied, 'note.md', 4096, { openConnection }), WorkspaceSearchReadError);
  await assert.rejects(listWorkspaceSearchDocuments(workspace, '../escape', { openConnection }), WorkspaceSearchReadError);
});
