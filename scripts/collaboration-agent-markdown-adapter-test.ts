import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import ts from 'typescript';
import * as Y from 'yjs';

import * as blockEdits from '../app/lib/collaboration/agent-block-edits';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import type * as FileEdits from '../app/lib/collaboration/agent-file-edits';
import type * as Agent from '../app/lib/collaboration/agent-operations';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import * as markdown from '../app/lib/collaboration/markdown-state';
import { blockTreeTextScopes, readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const { applyAgentBlockEdit, prepareAgentBlockDocumentChange, previewAgentBlockEdit, AgentBlockEditError } = blockEdits;
const { createRichMarkdownYDoc, richMarkdownFromYDoc, richMarkdownSchemaExtensions } = markdown;
const schema = getSchema(richMarkdownSchemaExtensions());
const reopen = (doc: Y.Doc) => { const next = new Y.Doc(); Y.applyUpdate(next, Y.encodeStateAsUpdate(doc)); return next; };
const json = (source: string) => {
  const doc = createRichMarkdownYDoc(source, 'tiptap_blocks');
  try { return readRichDocumentJson(doc); } finally { doc.destroy(); }
};
const block = (doc: Y.Doc, text: string, type = 'paragraph') => {
  const found = readAgentBlockStructure(doc).find((entry) => entry.text === text && entry.type === type);
  assert.ok(found, `${type}: ${text}`); return found;
};
const humanText = (doc: Y.Doc, id: string, value: string) => {
  const tree = new CollaborationBlockTree(doc, schema);
  let node = tree.read().firstChild!;
  tree.read().descendants((entry) => { if (entry.attrs.id === id) node = entry; });
  tree.updateInlineContent(id, node.type.create(node.attrs, schema.text(value)), 'human');
};
const rejectedUnchanged = (doc: Y.Doc, action: () => unknown, code = 'target_changed') => {
  const bytes = Y.encodeStateAsUpdate(doc);
  assert.throws(action, (error: unknown) => error instanceof AgentBlockEditError && error.code === code);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
};

test('source adapter freezes identities and preserves unrelated edits through apply and persisted inverse', () => {
  const doc = createRichMarkdownYDoc('Keep\n\nNeedle\n\nOther', 'tiptap_blocks');
  let restored: Y.Doc | undefined;
  try {
    const other = block(doc, 'Other'); const keep = block(doc, 'Keep');
    const before = Y.encodeStateAsUpdate(doc);
    const plan = prepareAgentBlockDocumentChange(doc, json('Keep\n\n# Changed\n\nOther'));
    const footprint = previewAgentBlockEdit(doc, plan).footprintHash;
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.ok(!plan.beforeText.includes('"text": "Other"'));
    humanText(doc, other.id, 'Human before approval');
    assert.equal(previewAgentBlockEdit(doc, plan).footprintHash, footprint);
    let updates = 0; doc.on('update', () => { updates++; });
    const { reverse } = applyAgentBlockEdit(doc, JSON.parse(JSON.stringify(plan)), 'agent');
    assert.ok(reverse); assert.equal(updates, 1);
    assert.equal(richMarkdownFromYDoc(doc), 'Keep\n\n# Changed\n\nHuman before approval');
    assert.ok(!JSON.stringify(reverse).includes('Human before approval'));
    restored = reopen(doc);
    humanText(restored, keep.id, 'Human after apply');
    applyAgentBlockEdit(restored, JSON.parse(JSON.stringify(reverse)), 'revert');
    assert.equal(richMarkdownFromYDoc(restored), 'Human after apply\n\nNeedle\n\nHuman before approval');
    assert.equal(block(restored, 'Human before approval').id, other.id);
  } finally { doc.destroy(); restored?.destroy(); }
});

test('deleted original text is never retargeted to a matching foreign paragraph', () => {
  const doc = createRichMarkdownYDoc('Keep\n\nNeedle\n\nOther', 'tiptap_blocks');
  try {
    const target = block(doc, 'Needle'); const other = block(doc, 'Other');
    const plan = prepareAgentBlockDocumentChange(doc, json('Keep\n\n# Changed\n\nOther'));
    new CollaborationBlockTree(doc, schema).delete(target.id, 'human-delete', 'human');
    humanText(doc, other.id, 'Needle');
    rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, plan));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, plan, 'agent'));
  } finally { doc.destroy(); }
});

test('identical Markdown with entirely replaced node IDs is still a changed target', () => {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_blocks');
  try {
    const plan = prepareAgentBlockDocumentChange(doc, json('# A\n\nB'));
    const tree = new CollaborationBlockTree(doc, schema);
    tree.applyDocumentChange(tree.read(), schema.nodeFromJSON(json('A\n\nB')), 'human-replace');
    assert.equal(richMarkdownFromYDoc(doc), 'A\n\nB');
    rejectedUnchanged(doc, () => previewAgentBlockEdit(doc, plan));
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, plan, 'agent'));
  } finally { doc.destroy(); }
});

test('source content changes are guarded locally and never overwrite later same-block work on revert', () => {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_blocks');
  try {
    const a = block(doc, 'A'); const b = block(doc, 'B');
    const plan = prepareAgentBlockDocumentChange(doc, json('**A**\n\nB'));
    humanText(doc, b.id, 'Foreign B');
    const { reverse } = applyAgentBlockEdit(doc, plan, 'agent');
    assert.ok(reverse);
    assert.equal(block(doc, 'A').id, a.id);
    humanText(doc, a.id, 'Human changed A');
    rejectedUnchanged(doc, () => applyAgentBlockEdit(doc, reverse, 'revert'));
    assert.equal(richMarkdownFromYDoc(doc), 'Human changed A\n\nForeign B');
  } finally { doc.destroy(); }
});

test('source-only moves allow newer moved-block text and retain it on inverse', () => {
  const doc = createRichMarkdownYDoc('A\n\nB\n\nC', 'tiptap_blocks');
  try {
    const a = block(doc, 'A');
    const plan = prepareAgentBlockDocumentChange(doc, json('B\n\nC\n\nA'));
    humanText(doc, a.id, 'Human A');
    const { reverse } = applyAgentBlockEdit(doc, plan, 'agent');
    assert.ok(reverse);
    assert.equal(richMarkdownFromYDoc(doc), 'B\n\nC\n\nHuman A');
    applyAgentBlockEdit(doc, reverse, 'revert');
    assert.equal(richMarkdownFromYDoc(doc), 'Human A\n\nB\n\nC');
  } finally { doc.destroy(); }
});

test('frozen body delta never rewrites independently edited metadata roots', () => {
  const doc = createRichMarkdownYDoc('---\ntitle: Before\n---\n\nA\n\nB\n', 'tiptap_blocks');
  try {
    const plan = prepareAgentBlockDocumentChange(doc, json('# A\n\nB'));
    const prefix = doc.getText('frontmatter');
    const ending = doc.getText('bodyFinalLineEnding');
    doc.transact(() => {
      prefix.delete(0, prefix.length); prefix.insert(0, '---\ntitle: Human\n---\n\n');
      ending.insert(ending.length, '\n');
    }, 'human');
    const expectedPrefix = prefix.toString(); const expectedEnding = ending.toString();
    const { reverse } = applyAgentBlockEdit(doc, plan, 'agent'); assert.ok(reverse);
    assert.equal(prefix.toString(), expectedPrefix); assert.equal(ending.toString(), expectedEnding);
    applyAgentBlockEdit(doc, reverse, 'revert');
    assert.equal(prefix.toString(), expectedPrefix); assert.equal(ending.toString(), expectedEnding);
  } finally { doc.destroy(); }
});

for (const [before, after] of [
  ['A\n\nB\n\nTail', '- A\n- B\n\nTail'],
  ['| A | B |\n| --- | --- |\n| C | D |\n\nTail', '| A | B | E |\n| --- | --- | --- |\n| C | D | F |\n\nTail'],
]) test('source container/table diff shares schema rules and persists selective inverse', () => {
  const doc = createRichMarkdownYDoc(before, 'tiptap_blocks');
  let restored: Y.Doc | undefined;
  try {
    const tail = block(doc, 'Tail');
    const canonicalBefore = richMarkdownFromYDoc(doc);
    const plan = prepareAgentBlockDocumentChange(doc, json(after));
    humanText(doc, tail.id, 'Human tail');
    const { reverse } = applyAgentBlockEdit(doc, plan, 'agent'); assert.ok(reverse);
    assert.ok(richMarkdownFromYDoc(doc).endsWith('Human tail'));
    restored = reopen(doc);
    applyAgentBlockEdit(restored, JSON.parse(JSON.stringify(reverse)), 'revert');
    assert.equal(richMarkdownFromYDoc(restored), canonicalBefore.replace('Tail', 'Human tail'));
  } finally { doc.destroy(); restored?.destroy(); }
});

test('document adapter rejects invalid Unicode/schema and oversized proposals without live mutation', () => {
  const doc = createRichMarkdownYDoc('A', 'tiptap_blocks');
  try {
    for (const next of [
      { type: 'doc', content: [{ type: 'not_a_node' }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '\ud800' }] }] },
    ]) rejectedUnchanged(doc, () => prepareAgentBlockDocumentChange(doc, next), 'schema_invalid');
    rejectedUnchanged(doc, () => prepareAgentBlockDocumentChange(doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'X'.repeat(512 * 1024) }] }] }), 'limit_exceeded');
    rejectedUnchanged(doc, () => prepareAgentBlockDocumentChange(doc, { type: 'doc', content: Array.from({ length: 257 }, (_, i) => ({ type: 'horizontalRule', attrs: { id: `untrusted-${i}` } })) }), 'limit_exceeded');
  } finally { doc.destroy(); }
});

test('a small source delta in a document above 512 KiB remains locally bounded', () => {
  const largeParagraph = 'Unchanged '.repeat(60_000);
  const doc = createRichMarkdownYDoc(`A\n\n${largeParagraph}`, 'tiptap_blocks');
  try {
    const plan = prepareAgentBlockDocumentChange(doc, json(`# A\n\n${largeParagraph}`));
    assert.ok(Buffer.byteLength(JSON.stringify(plan)) < 16 * 1024);
    const { reverse } = applyAgentBlockEdit(doc, plan, 'agent'); assert.ok(reverse);
    assert.ok(Buffer.byteLength(JSON.stringify(reverse)) < 16 * 1024);
    applyAgentBlockEdit(doc, reverse, 'revert');
    assert.equal(block(doc, largeParagraph).text, largeParagraph);
  } finally { doc.destroy(); }
});

async function adapter(doc: Y.Doc) {
  const filename = path.resolve('app/lib/collaboration/agent-file-edits.ts'); const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {}; let legacyCalls = 0;
  const state = { documentId: 'doc', workspaceId: 'workspace', path: 'doc.md', representation: 'tiptap_blocks',
    lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 1, checkpointSequence: 0, status: 'active' };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === './persistence') return { loadCollaborationState: async () => state };
    if (name === './document-access') return { readCurrentCollaborationDocument: async ({ read }: { read: (doc: Y.Doc) => unknown }) => read(doc) };
    if (name === './server-runtime') return { Y };
    if (name === './agent-operations') return {
      createRichAgentTextTargets: () => { throw new Error('Structural edit requires document adapter'); },
      createRichMarkdownReviewTarget: () => { legacyCalls++; throw new Error('Unsafe fallback'); },
    };
    return load(name);
  }, { exports }, exports);
  return { prepare: (exports as typeof FileEdits).prepareCollaborationTextEdit, legacyCalls: () => legacyCalls };
}

const workspace = { workspaceId: 'workspace' } as WorkspaceContext;
test('file preparation persists a block proposal, with no exact patch accepted a second time', async () => {
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_blocks');
  try {
    const harness = await adapter(doc); const b = block(doc, 'B');
    const prepared = await harness.prepare({ documentId: 'doc', workspace, path: 'doc.md', groupId: 'group',
      edits: [{ oldText: 'A', newText: '# A' }] });
    assert.equal(prepared.requestedMode, 'review'); assert.equal(prepared.targets.length, 1);
    assert.equal(prepared.targets[0].kind, 'block_edit'); assert.equal(prepared.targets[0].patchEdits, undefined);
    assert.equal(harness.legacyCalls(), 0);
    humanText(doc, b.id, 'Human B');
    applyAgentBlockEdit(doc, prepared.targets[0].blockEdit!, 'agent');
    assert.equal(richMarkdownFromYDoc(doc), '# A\n\nHuman B');
  } finally { doc.destroy(); }
});

test('metadata and final-line-ending changes cannot escape into legacy full-document fallback', async () => {
  for (const [source, oldText, newText] of [
    ['---\ntitle: A\n---\n\nBody', 'title: A', 'title: B'],
    ['Body\n', 'Body\n', 'Body\n\n'],
  ]) {
    const doc = createRichMarkdownYDoc(source, 'tiptap_blocks');
    try {
      const harness = await adapter(doc); const bytes = Y.encodeStateAsUpdate(doc);
      await assert.rejects(harness.prepare({ documentId: 'doc', workspace, path: 'doc.md', groupId: 'group',
        edits: [{ oldText, newText }] }), /metadata or final line endings/u);
      assert.equal(harness.legacyCalls(), 0); assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
    } finally { doc.destroy(); }
  }
});

async function legacyAdapter() {
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts'); const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8') + '\nexport { applyRichMarkdownPatchTargets, sealPayload, reviewTargetsInDocument };\n', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (['@/app/lib/audit/audit-service', '@/app/lib/db', '@/app/lib/files/collaboration-policy',
      './direct-connection', './persistence', './document-access', './agent-direct-edit-grants', './presence', './diagnostics'].includes(name)) return {};
    return load(name);
  }, { exports }, exports);
  return exports as typeof Agent & {
    sealPayload(value: unknown): string;
    reviewTargetsInDocument(row: Record<string, unknown>, doc: Y.Doc, userId: string): { proposalVersion: string | null };
    applyRichMarkdownPatchTargets(input: {
    doc: Y.Doc; targets: Agent.AgentTextTarget[];
    origin: { actorType: 'agent'; actorId: string; initiatedByUserId: string; operationId: string };
  }): { appliedTargetIds: string[]; reverseTargets: Agent.AgentTextTarget[]; conflicts: Array<{ code: string }> } };
}
const legacyOrigin = { actorType: 'agent' as const, actorId: 'agent', initiatedByUserId: 'user', operationId: 'operation' };

test('approval and target guard notice same-text formatting changes before applying', async () => {
  const agent = await legacyAdapter();
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'unit-test-format-approval-no-production-secret';
  const doc = createRichMarkdownYDoc('**Alpha**\n\nOther', 'tiptap_blocks');
  try {
    const targets = agent.createRichAgentTextTargets({ doc, search: 'Alpha', replacement: 'Revised' });
    const row = { operation_id: 'operation', document_id: 'doc', workspace_id: 'workspace', organization_id: 'organization',
      document_lifecycle_generation: 1, schema_version: 1, payload_hash: 'prepared-target', cas_version: 1, run_generation: 1,
      expires_at: Date.now() + 60_000, operation_payload: agent.sealPayload(targets), base_state_vector: Y.encodeStateVector(doc),
      result_json: JSON.stringify({ appliedTargetIds: [] }) };
    const version = agent.reviewTargetsInDocument(row, doc, 'user').proposalVersion;
    assert.ok(version);
    const text = [...blockTreeTextScopes(doc).keys()].find((entry) => entry.toDelta().map((part: { insert?: unknown }) => part.insert).join('') === 'Alpha')!;
    text.format(0, 5, { bold: null, italic: {} });
    assert.notEqual(agent.reviewTargetsInDocument(row, doc, 'user').proposalVersion, version);
    const bytes = Y.encodeStateAsUpdate(doc);
    const result = agent.applyAgentTextTargets({ doc, targets, origin: legacyOrigin });
    assert.equal(result.appliedTargetIds.length, 0); assert.equal(result.conflicts[0]?.code, 'target_changed');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
  } finally { doc.destroy(); }
});

test('unmarked replacement does not inherit newer formatting from outside its anchored range', async () => {
  const agent = await legacyAdapter();
  const doc = createRichMarkdownYDoc('Left Alpha\n\nOther', 'tiptap_blocks');
  try {
    const targets = agent.createRichAgentTextTargets({ doc, search: 'Alpha', replacement: 'Revised' });
    const text = [...blockTreeTextScopes(doc).keys()].find((entry) => entry.toDelta().map((part: { insert?: unknown }) => part.insert).join('') === 'Left Alpha')!;
    text.format(0, 5, { bold: {} });
    const expected = richMarkdownFromYDoc(doc).replace('Alpha', 'Revised');
    const result = agent.applyAgentTextTargets({ doc, targets, origin: legacyOrigin });
    assert.equal(result.appliedTargetIds.length, 1);
    assert.equal(richMarkdownFromYDoc(doc), expected);
  } finally { doc.destroy(); }
});

test('mixed original marks survive replacement and a selective inverse after binary reload', async () => {
  const agent = await legacyAdapter();
  const doc = createRichMarkdownYDoc('**Alpha***Beta*\n\nOther', 'tiptap_blocks');
  let restored: Y.Doc | undefined;
  try {
    const original = richMarkdownFromYDoc(doc); const other = block(doc, 'Other');
    const targets = agent.createRichAgentTextTargets({ doc, search: 'AlphaBeta', replacement: 'Revised' });
    const applied = agent.applyAgentTextTargets({ doc, targets, origin: legacyOrigin });
    assert.equal(applied.appliedTargetIds.length, 1);
    assert.deepEqual(applied.reverseTargets[0].replacementDelta, [
      { insert: 'Alpha', attributes: { bold: {} } }, { insert: 'Beta', attributes: { italic: {} } },
    ]);
    restored = reopen(doc); humanText(restored, other.id, 'Human other');
    const reversed = agent.applyAgentTextTargets({ doc: restored, targets: JSON.parse(JSON.stringify(applied.reverseTargets)), origin: legacyOrigin });
    assert.equal(reversed.appliedTargetIds.length, 1);
    assert.equal(richMarkdownFromYDoc(restored), original.replace('Other', 'Human other'));
  } finally { doc.destroy(); restored?.destroy(); }
});

test('legacy rich text without a format receipt cannot bypass formatting safety', async () => {
  const agent = await legacyAdapter(); const doc = createRichMarkdownYDoc('A', 'tiptap_blocks');
  try {
    const targets = agent.createRichAgentTextTargets({ doc, search: 'A', replacement: 'B' });
    delete targets[0].baseFormatHash;
    const bytes = Y.encodeStateAsUpdate(doc);
    const result = agent.applyAgentTextTargets({ doc, targets, origin: legacyOrigin });
    assert.equal(result.appliedTargetIds.length, 0); assert.equal(result.conflicts[0]?.code, 'target_changed');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
  } finally { doc.destroy(); }
});

test('format hashes deep-sort attributes and uniform formatting distinguishes different link values', async () => {
  const agent = await legacyAdapter(); const doc = new Y.Doc(); const text = doc.getText('content');
  try {
    text.insert(0, 'AB', { link: { href: 'https://example.com', title: 'A' } });
    const first = agent.createAgentTextTarget({ text, from: 0, to: 2, replacement: 'C' });
    text.format(0, 2, { link: { title: 'A', href: 'https://example.com' } });
    const same = agent.createAgentTextTarget({ text, from: 0, to: 2, replacement: 'C' });
    assert.equal(same.baseFormatHash, first.baseFormatHash);
    text.format(1, 1, { link: { href: 'https://other.example.com', title: 'A' } });
    const mixed = agent.createAgentTextTarget({ text, from: 0, to: 2, replacement: 'C' });
    assert.notEqual(mixed.baseFormatHash, first.baseFormatHash);
    assert.deepEqual(mixed.replacementAttributes, {}, 'different nested link values are not uniform marks');
  } finally { doc.destroy(); }
});

test('persisted replacement deltas validate exact content, attributes and Unicode before live mutation', async () => {
  const agent = await legacyAdapter(); const doc = new Y.Doc(); doc.getText('content').insert(0, 'A');
  try {
    const template = agent.createAgentTextTarget({ text: doc.getText('content'), from: 0, to: 1, replacement: 'B' });
    const malformed: unknown[] = [
      [{ insert: 'C', attributes: {} }], [{ insert: 'B', attributes: [] }],
      [{ insert: 'B', attributes: { bold: { invalid: undefined } } }],
      [{ insert: 'B', attributes: { bold: new Date() } }],
      [{ insert: 'B', attributes: {}, retain: 1 }], [{ insert: 'B', attributes: { padding: 'X'.repeat(512 * 1024) } }],
    ];
    for (const replacementDelta of malformed) {
      const bytes = Y.encodeStateAsUpdate(doc);
      const result = agent.applyAgentTextTargets({ doc, targets: [{ ...template, replacementDelta } as Agent.AgentTextTarget], origin: legacyOrigin });
      assert.equal(result.appliedTargetIds.length, 0); assert.equal(result.conflicts[0]?.code, 'schema_invalid');
      assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
    }
    const bytes = Y.encodeStateAsUpdate(doc);
    const splitSurrogate = agent.applyAgentTextTargets({ doc, targets: [{ ...template, replacement: '😀',
      replacementDelta: [{ insert: '\ud83d', attributes: {} }, { insert: '\ude00', attributes: {} }] }], origin: legacyOrigin });
    assert.equal(splitSurrogate.appliedTargetIds.length, 0); assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
  } finally { doc.destroy(); }
});

test('inverse size and grapheme boundaries are admitted before any live text write', async () => {
  const agent = await legacyAdapter(); const doc = new Y.Doc();
  try {
    const text = doc.getText('content'); text.insert(0, 'A'.repeat(270 * 1024));
    const targets = [agent.createAgentTextTarget({ text, from: 0, to: text.length, replacement: 'B' })];
    const bytes = Y.encodeStateAsUpdate(doc);
    const result = agent.applyAgentTextTargets({ doc, targets, origin: legacyOrigin });
    assert.equal(result.appliedTargetIds.length, 0); assert.equal(result.conflicts[0]?.code, 'limit_exceeded');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
    text.delete(0, text.length); text.insert(0, 'XA');
    const graphemeTarget = agent.createAgentTextTarget({ text, from: 1, to: 2, replacement: '\u0301' });
    const beforeGrapheme = Y.encodeStateAsUpdate(doc);
    const invalidInverse = agent.applyAgentTextTargets({ doc, targets: [graphemeTarget], origin: legacyOrigin });
    assert.equal(invalidInverse.appliedTargetIds.length, 0); assert.equal(invalidInverse.conflicts[0]?.code, 'unicode_boundary');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), beforeGrapheme);
  } finally { doc.destroy(); }
});

test('legacy XML requires original identity even when replacement nodes contain identical Markdown', async () => {
  const agent = await legacyAdapter();
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_xml');
  const replacement = createRichMarkdownYDoc('A\n\nB', 'tiptap_xml');
  try {
    const target = agent.createRichMarkdownReviewTarget({ doc, currentMarkdown: 'A\n\nB', proposedMarkdown: '# A\n\nB',
      edits: [{ oldText: 'A', newText: '# A' }] });
    assert.ok(target.baseDocumentSnapshot);
    const body = doc.getXmlFragment('body');
    doc.transact(() => {
      body.delete(0, body.length);
      body.insert(0, replacement.getXmlFragment('body').toArray().map((node) => {
        assert.ok(node instanceof Y.XmlElement || node instanceof Y.XmlText); return node.clone();
      }));
    }, 'human-replace');
    assert.equal(richMarkdownFromYDoc(doc), 'A\n\nB');
    const bytes = Y.encodeStateAsUpdate(doc);
    const result = agent.applyRichMarkdownPatchTargets({ doc, targets: [target], origin: legacyOrigin });
    assert.equal(result.appliedTargetIds.length, 0); assert.equal(result.conflicts[0]?.code, 'target_changed');
    assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes);
  } finally { doc.destroy(); replacement.destroy(); }
});

test('legacy XML reverse persists an identity proof and rejects later independent content instead of overwriting it', async () => {
  const agent = await legacyAdapter();
  const doc = createRichMarkdownYDoc('A\n\nB', 'tiptap_xml');
  let restored: Y.Doc | undefined;
  try {
    const target = agent.createRichMarkdownReviewTarget({ doc, currentMarkdown: 'A\n\nB', proposedMarkdown: '# A\n\nB',
      edits: [{ oldText: 'A', newText: '# A' }] });
    const unanchored = { ...target }; delete unanchored.baseDocumentSnapshot;
    const before = Y.encodeStateAsUpdate(doc);
    assert.equal(agent.applyRichMarkdownPatchTargets({ doc, targets: [unanchored], origin: legacyOrigin }).appliedTargetIds.length, 0);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    const result = agent.applyRichMarkdownPatchTargets({ doc, targets: [target], origin: legacyOrigin });
    assert.equal(result.appliedTargetIds.length, 1);
    assert.ok(result.reverseTargets[0].baseDocumentSnapshot);
    restored = reopen(doc);
    const reverse = JSON.parse(JSON.stringify(result.reverseTargets)) as Agent.AgentTextTarget[];
    assert.equal(agent.applyRichMarkdownPatchTargets({ doc: restored, targets: reverse, origin: legacyOrigin }).appliedTargetIds.length, 1);
    assert.equal(richMarkdownFromYDoc(restored), 'A\n\nB');
    restored.destroy(); restored = reopen(doc);
    markdown.replaceRichMarkdownInYDoc(restored, '# A\n\nHuman B', 'human');
    const changed = Y.encodeStateAsUpdate(restored);
    const reverted = agent.applyRichMarkdownPatchTargets({ doc: restored, targets: reverse, origin: legacyOrigin });
    assert.equal(reverted.appliedTargetIds.length, 0); assert.equal(reverted.conflicts[0]?.code, 'target_changed');
    assert.deepEqual(Y.encodeStateAsUpdate(restored), changed);
  } finally { doc.destroy(); restored?.destroy(); }
});
