import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import { Y } from '../app/lib/collaboration/server-runtime';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readCurrentCollaborationTextSnapshot } from '../app/lib/collaboration/agent-file-edits';
import { installCollaborationDocumentReader } from '../app/lib/collaboration/document-access';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions } from '../app/lib/collaboration/markdown-state';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = { workspaceId: 'text-read-workspace', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-text-read-files', legacy: false, status: 'active', permissions: { canRead: true, canWrite: false,
    canDelete: false, canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
function stateFor(doc: InstanceType<typeof Y.Doc>, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  return { documentId: 'text-read-document', workspaceId: workspace.workspaceId, organizationId: null, path: 'note.md',
    lifecycleGeneration: 2, schemaVersion: 1, representation, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 8, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}
const input = { documentId: 'text-read-document', workspace, path: 'note.md', lifecycleGeneration: 2 };

test('real common text reader uses metadata from the same room read and separates pending live content', async () => {
  const doc = createPlainTextYDoc('Before\r\n😀'); const state = stateFor(doc, 'plain_text');
  const persistedProof = collaborationStateProof(doc, Y);
  doc.getText('content').insert(0, 'Fresh ');
  let reads = 0;
  const installed = installCollaborationDocumentReader(async (id, workspaceId, read) => {
    reads++; assert.equal(id, input.documentId); assert.equal(workspaceId, workspace.workspaceId); return read(doc, state);
  });
  try {
    const result = await readCurrentCollaborationTextSnapshot(input);
    assert.equal(reads, 1); assert.equal(result.content, 'Fresh Before\r\n😀');
    assert.equal(result.documentSequence, 8); assert.equal(result.checkpointSequence, 0);
    assert.equal(result.currency?.durable, false); assert.equal(result.currency?.source, 'live_yjs');
    assert.equal(result.currency?.persistedStateProof, persistedProof);
    assert.equal(result.currency?.observedStateProof, collaborationStateProof(doc, Y));
    assert.notEqual(result.currency?.observedStateProof, result.currency?.persistedStateProof);
  } finally { installed(); doc.destroy(); }
});

test('real common reader rejects lossy rich Markdown instead of exposing normalized native content', async () => {
  const doc = createRichMarkdownYDoc('| Name |\n| --- |\n| Native |', 'tiptap_blocks');
  const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
  for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
    (record.get('attributes') as InstanceType<typeof Y.Map>).set('colwidth', [123]);
  }
  const state = stateFor(doc, 'tiptap_blocks'); const before = Y.encodeStateAsUpdate(doc);
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  try {
    await assert.rejects(readCurrentCollaborationTextSnapshot(input), /roundtrip_unstable/u);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  } finally { installed(); doc.destroy(); }
});

test('native structure pagination remains available with a proven lossless rich text snapshot', async () => {
  const doc = createRichMarkdownYDoc('First\n\nSecond', 'tiptap_blocks'); const state = stateFor(doc, 'tiptap_blocks');
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, state));
  try {
    const result = await readCurrentCollaborationTextSnapshot({ ...input, includeStructure: true, structureLimit: 1 });
    assert.equal(result.currency?.durable, true); assert.equal(result.structure?.blocks.length, 1);
    assert.equal(result.structure?.nextOffset, 1); assert.equal(result.structure?.totalBlocks, 2);
    assert.equal(Object.hasOwn(result, 'sourceUpdate'), false);
  } finally { installed(); doc.destroy(); }
});

test('common reader binds organization, path, generation and durable schema without stale metadata fallback', async () => {
  const doc = createPlainTextYDoc('Protected'); const state = stateFor(doc, 'plain_text');
  for (const change of [{ organizationId: 'foreign' }, { path: 'moved.md' }, { lifecycleGeneration: 3 }, { schemaVersion: 9 }]) {
    const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc, { ...state, ...change }));
    try { await assert.rejects(readCurrentCollaborationTextSnapshot(input)); } finally { installed(); }
  }
  const legacy = installCollaborationDocumentReader(async (_id, _workspaceId, read) => read(doc));
  try { await assert.rejects(readCurrentCollaborationTextSnapshot(input), /changed or is unavailable/u); }
  finally { legacy(); doc.destroy(); }
});

test('common reader rejects invalid live plain structure and honors denied permissions before room access', async () => {
  const doc = createPlainTextYDoc('Protected'); const state = stateFor(doc, 'plain_text');
  doc.getText('content').format(0, 3, { unsupported: 'mark' });
  let reads = 0;
  const installed = installCollaborationDocumentReader(async (_id, _workspaceId, read) => { reads++; return read(doc, state); });
  try {
    await assert.rejects(readCurrentCollaborationTextSnapshot(input), /schema_invalid/u);
    assert.equal(reads, 1);
    await assert.rejects(readCurrentCollaborationTextSnapshot({ ...input,
      workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } } }),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 403);
    assert.equal(reads, 1);
  } finally { installed(); doc.destroy(); }
});

test('scoped fallback reads native state on the supplied transaction connection without a second metadata lookup', async () => {
  const doc = createPlainTextYDoc('Scoped'); const state = stateFor(doc, 'plain_text'); let loads = 0;
  try {
    const result = await readCurrentCollaborationTextSnapshot({ ...input, loadState: async id => {
      loads++; assert.equal(id, state.documentId); return state;
    } });
    assert.equal(result.content, 'Scoped'); assert.equal(loads, 1); assert.equal(result.currency?.durable, true);
  } finally { doc.destroy(); }
});
