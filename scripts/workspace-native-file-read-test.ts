import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { Y } from '../app/lib/collaboration/server-runtime';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import { readNativeWorkspaceFile, withNativeWorkspaceFileRead } from '../app/lib/collaboration/workspace-native-file-read';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { SqlConnection } from '../app/lib/db';

const workspace: WorkspaceContext = { workspaceId: 'native-read-workspace', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-native-read-disk', legacy: false, status: 'active', permissions: { canRead: true, canWrite: false,
    canDelete: false, canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
function stateFor(doc: InstanceType<typeof Y.Doc>, representation: PersistedCollaborationState['representation'] = 'plain_text'): PersistedCollaborationState {
  return { documentId: 'native-read-doc', workspaceId: workspace.workspaceId, organizationId: null, path: 'note.md',
    lifecycleGeneration: 1, schemaVersion: 1, representation, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 0, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active' };
}
function fixture(state: PersistedCollaborationState, authority: WorkspaceDocumentCatalogueEntry['authority'] = 'initialized') {
  const row: WorkspaceDocumentCatalogueEntry = { id: state.documentId, lineage_id: 'read-lineage', path: state.path,
    workspace_id: state.workspaceId, organization_id: null, status: 'active', state_version: 0,
    yjs_state_lifecycle: authority === 'pristine' ? 'never_initialized' : 'initialized',
    has_persisted_state: authority === 'initialized', has_state_history: false, lifecycle_generation: 1,
    state_status: 'active', state_path: state.path, state_workspace_id: state.workspaceId, state_organization_id: null, authority };
  let active = false; const commands: string[] = [];
  const connection: SqlConnection = { run: async sql => {
    commands.push(sql); if (sql.startsWith('BEGIN')) active = true; if (['COMMIT', 'ROLLBACK'].includes(sql)) active = false;
    assert(!/^(INSERT|UPDATE|DELETE)/u.test(sql), 'reads must never mutate storage');
  }, get: async sql => { assert(active); assert(sql.includes('pg_advisory_xact_lock_shared')); return undefined; },
  all: async () => [], close: async () => { assert(!active); commands.push('CLOSE'); } };
  return { commands, get active() { return active; }, dependencies: { openConnection: async () => connection,
    readCatalogue: async () => [row], loadState: async () => state } };
}
const input = { workspace, path: 'note.md', mode: 'export' as const, maxBytes: 5 * 1024 * 1024 };

test('native-only sequence-zero reads export native bytes with BOM/CRLF without filesystem or history', async () => {
  const doc = createPlainTextYDoc('First\nSecond\n'); const f = fixture(stateFor(doc));
  try {
    const read = await readNativeWorkspaceFile(input, f.dependencies);
    assert.equal(read?.content?.toString('utf8'), '\uFEFFFirst\r\nSecond\r\n');
    assert.equal(read?.source, 'persisted_yjs'); assert.equal(read?.documentSequence, 0); assert.equal(read?.modifiedAt, 100);
    assert.deepEqual(f.commands.slice(-2), ['COMMIT', 'CLOSE']);
    assert.equal(JSON.stringify(read).includes('yjsState'), false);
  } finally { doc.destroy(); }
});

test('native export observes current room text and never stamps the last durable time on pending edits', async () => {
  const doc = createPlainTextYDoc('Original'); const f = fixture(stateFor(doc)); doc.getText('content').insert(0, 'Fresh ');
  const uninstall = installCollaborationDocumentReader(async (id, _workspace, read, loadState) => read(doc, await loadState!(id) ?? undefined));
  try {
    const read = await readNativeWorkspaceFile(input, f.dependencies);
    assert.equal(read?.content?.toString('utf8'), '\uFEFFFresh Original');
    assert.equal(read?.source, 'live_yjs'); assert.equal(read?.modifiedAt, null);
  } finally { uninstall(); doc.destroy(); }
});

test('native bootstrap remains available through lossy Markdown export and explicit quarantine without fabricating text', async () => {
  const doc = createRichMarkdownYDoc('| A |\n| --- |\n| B |', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
  for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
    (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [123]);
  }
  const state = stateFor(doc, 'tiptap_blocks'); const f = fixture(state);
  try {
    const metadata = await readNativeWorkspaceFile({ ...input, mode: 'metadata' }, f.dependencies);
    assert.equal(metadata?.contentUnavailable, true); assert.equal(metadata?.content, null);
    await assert.rejects(readNativeWorkspaceFile(input, f.dependencies), /roundtrip_unstable/u);
    state.degraded = true;
    assert.equal((await readNativeWorkspaceFile({ ...input, mode: 'metadata' }, f.dependencies))?.contentUnavailable, true);
    await assert.rejects(readNativeWorkspaceFile(input, f.dependencies), /quarantined/u);
  } finally { doc.destroy(); }
});

test('missing native authority never invokes physical fallback; pristine fallback retains the same read fence', async () => {
  const doc = createPlainTextYDoc('Native'); const state = stateFor(doc); let consumes = 0;
  try {
    const missing = fixture(state, 'missing-state');
    await assert.rejects(withNativeWorkspaceFileRead(input, async () => { consumes++; }, missing.dependencies), /state is unavailable/u);
    assert.equal(consumes, 0);
    const pristine = fixture(state, 'pristine');
    const result = await withNativeWorkspaceFileRead(input, async native => {
      assert.equal(native, null); assert.equal(pristine.active, true); return 'physical snapshot';
    }, pristine.dependencies);
    assert.equal(result, 'physical snapshot'); assert.equal(pristine.active, false);
  } finally { doc.destroy(); }
});

test('native reader enforces scope, generation, permissions and byte budgets without unsafe fallback', async () => {
  for (const patch of [{ workspaceId: 'foreign' }, { organizationId: 'foreign' }, { path: 'moved.md' },
    { lifecycleGeneration: 2 }, { schemaVersion: 9 }]) {
    const doc = createPlainTextYDoc('Protected'); const state = stateFor(doc); const f = fixture(state);
    Object.assign(state, patch);
    try { await assert.rejects(readNativeWorkspaceFile(input, f.dependencies)); } finally { doc.destroy(); }
  }
  const doc = createPlainTextYDoc('Protected'); const f = fixture(stateFor(doc));
  try {
    await assert.rejects(readNativeWorkspaceFile({ ...input, maxBytes: 1 }, f.dependencies), { status: 413 });
    const before = f.commands.length;
    await assert.rejects(readNativeWorkspaceFile({ ...input,
      workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } } }, f.dependencies), { status: 403 });
    assert.equal(f.commands.length, before);
  } finally { doc.destroy(); }
});
