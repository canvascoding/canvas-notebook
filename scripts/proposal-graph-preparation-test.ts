import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';

import * as agentOperations from '../app/lib/collaboration/agent-operations';
import type * as EditModule from '../app/lib/collaboration/agent-file-edits';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { applyAgentBlockEdit } from '../app/lib/collaboration/agent-block-edits';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { applyExactTextEdits, type ExactTextEdit } from '../app/lib/files/exact-text-patch';
import { applyAgentMarkdownEdit } from '../app/lib/markdown/agent-markdown-edit';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type State = Pick<PersistedCollaborationState, 'documentId' | 'path' | 'representation' | 'lifecycleGeneration'
  | 'schemaVersion' | 'documentSequence' | 'checkpointSequence'>;
type Prepared = EditModule.PreparedCollaborationTextEdit & { sourceUpdate?: Uint8Array };
type ContentInput = {
  documentId: string; workspace: WorkspaceContext; path: string; groupId: string; expectedSha256?: string | null;
  state: State; doc: Y.Doc;
  plan: (content: string) => { edits: ExactTextEdit[]; proposedContent: string; richMode: 'exact_text' | 'markdown_structure' };
};
type Helpers = typeof EditModule & {
  prepareCollaborationContentEditInDocument(input: ContentInput): Prepared;
  prepareCollaborationBlockEditInDocument(input: Parameters<typeof EditModule.prepareCollaborationBlockEdit>[0] & { state: State; doc: Y.Doc }): Prepared;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const workspace: WorkspaceContext = {
  workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization', rootPath: '/unused', legacy: false,
  permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false },
};
const sourceRoot = process.env.PROPOSAL_PREPARATION_SOURCE_ROOT || process.cwd();
const filename = path.resolve(sourceRoot, 'app/lib/collaboration/agent-file-edits.ts');
const sourcePromise = readFile(filename, 'utf8');

async function harness(live: Y.Doc, representation: State['representation']) {
  let reads = 0; let loads = 0;
  const state = { documentId: 'document', workspaceId: workspace.workspaceId, path: 'notes.md', status: 'active',
    representation, lifecycleGeneration: 2, schemaVersion: 1, documentSequence: 5, checkpointSequence: 3 };
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await sourcePromise, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  const requireMock = (name: string) => {
    if (name === 'server-only') return {};
    if (name === './server-runtime') return { Y };
    if (name === './agent-operations') return agentOperations;
    if (name === './persistence') return { loadCollaborationState: async () => { loads++; return state; } };
    if (name === './document-access') return { readCurrentCollaborationDocument: async (input: {
      documentId: string; workspaceId: string; read: (doc: Y.Doc) => unknown;
    }) => {
      reads++;
      assert.equal(input.documentId, state.documentId); assert.equal(input.workspaceId, state.workspaceId);
      return input.read(live);
    } };
    return load(name);
  };
  new Function('require', 'module', 'exports', compiled)(requireMock, { exports }, exports);
  const api = exports as Helpers;
  assert.equal(typeof api.prepareCollaborationContentEditInDocument, 'function', 'Test the refactored module, not an older helper-free checkout.');
  const common = { documentId: state.documentId, workspace, path: state.path, groupId: 'group' };
  const reference = { documentId: state.documentId, lifecycleGeneration: state.lifecycleGeneration, schemaVersion: state.schemaVersion };
  return { api, state, common, reference, reads: () => reads, loads: () => loads };
}
function plain(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false }); doc.getText('content').insert(0, value); return doc;
}
function clone(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false }); Y.applyUpdate(doc, Y.encodeStateAsUpdate(source)); return doc;
}
function exactPlan(edits: ExactTextEdit[]): ContentInput['plan'] {
  return (content) => ({ edits, proposedContent: applyExactTextEdits(content, edits, 'notes.md'), richMode: 'exact_text' });
}
function errorRecord(run: () => unknown): { message: string; code?: string } {
  try { run(); assert.fail('Expected preparation failure'); } catch (error) {
    assert(error instanceof Error); return { message: error.message, code: (error as Error & { code?: string }).code };
  }
}
const origin = { actorType: 'agent' as const, actorId: 'test', initiatedByUserId: 'test', operationId: 'test' };

test('plain child targets anchor to the supplied candidate, without reading or mutating authoritative current', async () => {
  const current = plain('Base'); const candidate = clone(current); candidate.getText('content').insert(4, ' Parent');
  const h = await harness(current, 'plain_text');
  const before = Y.encodeStateAsUpdate(candidate); const currentBefore = Y.encodeStateAsUpdate(current);
  try {
    const prepared = h.api.prepareCollaborationContentEditInDocument({ ...h.common, state: h.state, doc: candidate,
      plan: exactPlan([{ oldText: 'Parent', newText: 'Child' }]) });
    assert.equal(prepared.content, 'Base Parent'); assert.equal(prepared.proposedContent, 'Base Child');
    assert.deepEqual(prepared.sourceUpdate, before); assert.deepEqual(Y.encodeStateAsUpdate(candidate), before);
    assert.deepEqual(Y.encodeStateAsUpdate(current), currentBefore); assert.equal(h.reads(), 0); assert.equal(h.loads(), 0);
    const target = prepared.targets[0];
    const relative = Y.decodeRelativePosition(Buffer.from(target.startAnchor, 'base64'));
    assert.equal(Y.createAbsolutePositionFromRelativePosition(relative, current), null);
    assert.equal(Y.createAbsolutePositionFromRelativePosition(relative, candidate)?.index, 5);
    const applied = clone(candidate);
    try {
      assert.equal(agentOperations.applyAgentTextTargets({ doc: applied, targets: prepared.targets, origin }).status, 'applied_to_ydoc');
      assert.equal(applied.getText('content').toString(), 'Base Child');
    } finally { applied.destroy(); }
  } finally { candidate.destroy(); current.destroy(); }
});

test('plain live wrapper and pure helper preserve targets, hashes and revision-conflict errors', async () => {
  const doc = plain('One Two'); const h = await harness(doc, 'plain_text');
  const edits = [{ oldText: 'Two', newText: 'Three' }];
  try {
    const pure = h.api.prepareCollaborationContentEditInDocument({ ...h.common, state: h.state, doc, plan: exactPlan(edits) });
    const wrapped = await h.api.prepareCollaborationTextEdit({ ...h.common, edits });
    assert.deepEqual(wrapped, pure); assert.equal(h.loads(), 1); assert.equal(h.reads(), 1);
    const bad = { ...h.common, expectedSha256: hash('old state') };
    const expected = errorRecord(() => h.api.prepareCollaborationContentEditInDocument({ ...bad, state: h.state, doc, plan: exactPlan(edits) }));
    await assert.rejects(h.api.prepareCollaborationTextEdit({ ...bad, edits }), (error: unknown) => {
      assert(error instanceof Error); assert.equal(error.message, expected.message);
      assert.equal((error as Error & { code?: string }).code, 'FILE_REVISION_CONFLICT'); return true;
    });
    await assert.rejects(h.api.prepareCollaborationTextEdit({ ...h.common, edits: [] }), /No edits provided/u);
  } finally { doc.destroy(); }
});

test('Markdown block append prepares a parent-only candidate without mutating source or current', async () => {
  const current = createRichMarkdownYDoc('# Base\n\nCurrent', 'tiptap_blocks');
  const candidate = createRichMarkdownYDoc('# Base\n\nParent-only text', 'tiptap_blocks');
  const h = await harness(current, 'tiptap_blocks');
  const edit = { mode: 'append' as const, content: '\n\nChild paragraph' };
  const before = Y.encodeStateAsUpdate(candidate);
  try {
    const prepared = h.api.prepareCollaborationContentEditInDocument({ ...h.common, state: h.state, doc: candidate, plan: (content) => {
      const proposedContent = applyAgentMarkdownEdit(content, edit, 'notes.md');
      return { edits: [{ oldText: content, newText: proposedContent }], proposedContent, richMode: 'markdown_structure' };
    } });
    assert.match(prepared.proposedContent, /Parent-only text/u); assert.match(prepared.proposedContent, /Child paragraph/u);
    assert.equal(prepared.targets[0].kind, 'block_edit'); assert.equal(prepared.requestedMode, 'direct_apply');
    assert.deepEqual(prepared.sourceUpdate, before); assert.deepEqual(Y.encodeStateAsUpdate(candidate), before);
    assert.match(richMarkdownFromYDoc(current), /Current/u); assert.equal(h.reads(), 0);
    const applied = clone(candidate);
    try { applyAgentBlockEdit(applied, prepared.targets[0].blockEdit!, origin); assert.equal(richMarkdownFromYDoc(applied), prepared.proposedContent); }
    finally { applied.destroy(); }
  } finally { current.destroy(); candidate.destroy(); }
});

test('structured child can target blocks absent from authoritative current, with no mutation', async () => {
  const current = createRichMarkdownYDoc('Current', 'tiptap_blocks');
  const candidate = createRichMarkdownYDoc('Parent-only\n\nRetained', 'tiptap_blocks');
  const h = await harness(current, 'tiptap_blocks'); const block = readAgentBlockStructure(candidate)[0];
  const before = Y.encodeStateAsUpdate(candidate);
  try {
    const prepared = h.api.prepareCollaborationBlockEditInDocument({ ...h.common, document: h.reference,
      state: h.state, doc: candidate, operations: [{ kind: 'delete_block', blockId: block.id, subtreeHash: block.subtreeHash }] });
    assert.equal(prepared.proposedContent.trim(), 'Retained'); assert.deepEqual(prepared.sourceUpdate, before);
    assert.deepEqual(Y.encodeStateAsUpdate(candidate), before); assert.equal(h.reads(), 0); assert.equal(h.loads(), 0);
    await assert.rejects(h.api.prepareCollaborationBlockEdit({ ...h.common, document: h.reference,
      operations: [{ kind: 'delete_block', blockId: block.id, subtreeHash: block.subtreeHash }] }), /no longer|missing|changed|exist/iu);
  } finally { current.destroy(); candidate.destroy(); }
});

test('block-targeted text and live wrapper preserve exact targets and lifecycle gates', async () => {
  const doc = createRichMarkdownYDoc('Parent text\n\nOther', 'tiptap_blocks'); const h = await harness(doc, 'tiptap_blocks');
  const block = readAgentBlockStructure(doc)[0]; const before = Y.encodeStateAsUpdate(doc);
  const input = { ...h.common, document: h.reference, textEdit: { blockId: block.id, oldText: 'Parent', newText: 'Child' } };
  try {
    const pure = h.api.prepareCollaborationBlockEditInDocument({ ...input, state: h.state, doc });
    const wrapped = await h.api.prepareCollaborationBlockEdit(input);
    // The pre-existing block text adapter deliberately allocates a fresh target
    // receipt ID per preparation; its anchors and content guards must match.
    assert.deepEqual({ ...wrapped, targets: wrapped.targets.map(({ targetId: _id, ...target }) => target) },
      { ...pure, targets: pure.targets.map(({ targetId: _id, ...target }) => target) });
    assert.match(pure.proposedContent, /Child text/u); assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    await assert.rejects(h.api.prepareCollaborationBlockEdit({ ...input, document: { ...h.reference, lifecycleGeneration: 3 } }), /stale or unavailable/u);
    await assert.rejects(h.api.prepareCollaborationBlockEdit({ ...input, workspace: { ...workspace, workspaceId: 'other' } }), /stale or unavailable/u);
    h.state.status = 'archived';
    await assert.rejects(h.api.prepareCollaborationBlockEdit(input), /stale or unavailable/u);
  } finally { doc.destroy(); }
});

test('legacy XML Markdown stays review-only and metadata-changing block edits remain rejected', async () => {
  const doc = createRichMarkdownYDoc('# Title\n\nBody', 'tiptap_xml'); const h = await harness(doc, 'tiptap_xml');
  const edit = { mode: 'append' as const, content: '\n\n## New heading' }; const before = Y.encodeStateAsUpdate(doc);
  try {
    const wrapped = await h.api.prepareCollaborationMarkdownEdit({ ...h.common, edit });
    assert.equal(wrapped.requestedMode, 'review'); assert.equal(wrapped.targets[0].kind, 'rich_markdown_patch');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before); assert.deepEqual((wrapped as Prepared).sourceUpdate, before);
  } finally { doc.destroy(); }
  const block = createRichMarkdownYDoc('Body', 'tiptap_blocks'); const b = await harness(block, 'tiptap_blocks');
  try {
    assert.throws(() => b.api.prepareCollaborationContentEditInDocument({ ...b.common, state: b.state, doc: block,
      plan: () => ({ edits: [], proposedContent: '---\ntitle: changed\n---\n\nBody', richMode: 'markdown_structure' }) }), /metadata or final line endings/u);
  } finally { block.destroy(); }
});

test('public live text and structure snapshots never expose internal sourceUpdate bytes', async () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const doc = representation === 'plain_text' ? plain('Public text') : createRichMarkdownYDoc('Public text', representation);
    const h = await harness(doc, representation);
    try {
      const snapshot = await h.api.readCurrentCollaborationTextSnapshot({ documentId: h.state.documentId, workspace,
        ...(representation === 'tiptap_blocks' ? { includeStructure: true } : {}) });
      assert.equal(Object.hasOwn(snapshot, 'sourceUpdate'), false);
      assert.doesNotMatch(JSON.stringify(snapshot), /sourceUpdate|yjsState|deltaBase64/u);
      assert.equal(snapshot.sha256, hash(snapshot.content));
    } finally { doc.destroy(); }
  }
});
