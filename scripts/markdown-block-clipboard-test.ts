import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import { NodeSelection, Plugin, type Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';
import { createLocalMarkdownRichExtension, LOCAL_MARKDOWN_PROJECTION } from '../app/lib/editor/local-markdown-rich-binding';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { analyzeMarkdownRichMode, createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { MarkdownBlockMovement } from '../app/lib/editor/block-move-command';
import { NATIVE_BLOCK_DRAG_TYPE } from '../app/lib/editor/native-block-drag';
import { BLOCK_MOVE_TRANSACTION_META } from '../app/lib/editor/block-reference';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

async function harness(collaborative: boolean, body: string) {
  const manager = createRichMarkdownManager();
  const local = collaborative ? null : new LocalMarkdownDocument(manager.serialize(manager.parse(body)));
  if (local) assert.ok(local.getSnapshot().richDocument);
  const document = collaborative ? new Y.Doc() : null;
  if (document) {
    const extensions = richMarkdownCodecExtensions();
    CollaborationBlockTree.create(document, getSchema(extensions).nodeFromJSON(generateRichNodeIds(manager.parse(body), extensions)));
  }
  const errors: Error[] = [];
  const element = dom.window.document.createElement('div');
  dom.window.document.body.append(element);
  const editor = new Editor({ element, extensions: [
    MarkdownBlockMovement,
    ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (tr: Transaction) =>
        !isRemoteRichEditorTransaction(tr) && !tr.getMeta(LOCAL_MARKDOWN_PROJECTION) }) : extension),
    ...(document ? createRichEditorCollaborationExtensions({ document, representation: 'tiptap_blocks', awareness: null,
      user: { name: 'Test', color: '#123456' }, onError: error => errors.push(error) })
      : [createLocalMarkdownRichExtension({ document: local!, onError: error => errors.push(error) })]),
  ] });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { editor, document, local, errors, destroy() { editor.destroy(); document?.destroy(); element.remove(); } };
}

class Transfer {
  values = new Map<string, string>();
  effectAllowed = 'uninitialized';
  files: File[] = [];
  get types() { return [...this.values.keys()]; }
  clearData() { this.values.clear(); }
  setData(type: string, value: string) { this.values.set(type, value); }
  getData(type: string) { return this.values.get(type) ?? ''; }
}

function transferEvent(editor: Editor, type: string, data = new Transfer(), extra = {}) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: data, dataTransfer: data, clientX: 0, clientY: 0, ...extra });
  editor.view.dom.dispatchEvent(event);
  return data;
}
function ids(node: ProseMirrorNode) {
  const result: string[] = [];
  if (node.type.name !== 'doc') result.push(node.attrs.id);
  node.descendants(child => { if (!child.isText) result.push(child.attrs.id); });
  assert.ok(result.every(id => typeof id === 'string' && id));
  assert.equal(new Set(result).size, result.length, 'every node has a unique ID');
  return result;
}
function verify(editor: Editor) {
  editor.state.doc.check(); ids(editor.state.doc);
  const manager = createRichMarkdownManager();
  const markdown = manager.serialize(editor.getJSON());
  assert(equivalentRichDocument(editor.getJSON(), editor.schema.nodeFromJSON(manager.parse(markdown)).toJSON()), markdown);
}

const blocks = [
  '**Paragraph** with `code`', '> Quote\n>\n> - Nested', '- [x] Task\n  - Nested',
  '| A | B |\n| --- | --- |\n| C | D |', '![Alt](image.png)', '```ts\nconst x = 1;\n```',
  ...['left', 'center', 'right'].map(align => '<img src="image.png" alt="Aligned" width="240" style="display:block;max-width:100%;height:auto;margin-left:'
    + (align === 'left' ? '0' : 'auto') + ';margin-right:' + (align === 'right' ? '0' : 'auto') + '">'),
  '> [!note] **Title**\n> Body', '<details open>\n<summary>Summary</summary>\n\nBody\n\n</details>',
];
for (const collaborative of [false, true]) test(`DOM clipboard copies, repeated paste and direct duplication retain source identities (${collaborative})`, async () => {
  for (const block of blocks) {
    const h = await harness(collaborative, `INTRO\n\n${block}\n\nTAIL`);
    const { editor } = h;
    try {
      const from = editor.state.doc.firstChild!.nodeSize;
      const original = editor.state.doc.child(1);
      const originalIds = ids(original);
      editor.commands.setNodeSelection(from);
      const before = editor.getJSON();
      const data = transferEvent(editor, 'copy');
      assert.deepEqual(editor.getJSON(), before);
      assert.ok(data.getData('text/html').includes('data-id='));
      for (let index = 0; index < 2; index++) {
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
        transferEvent(editor, 'paste', data);
        assert.ok(editor.state.doc.child(1).eq(original), 'copy cannot reassign the original or nested identities');
        assert.equal(editor.state.doc.content.content.filter(node => node.type === original.type && node.textContent === original.textContent).length, index + 2);
        for (const copied of editor.state.doc.content.content.filter(node => node.type === original.type
          && node.textContent === original.textContent && node.attrs.id !== original.attrs.id)) {
          assert(equivalentRichDocument(copied.toJSON(), original.toJSON()), 'clipboard preserves block attributes and nested content');
        }
        ids(editor.state.doc);
      }
      assert.equal(editor.commands.undo(), true);
      assert.equal(editor.commands.undo(), true);
      assert.deepEqual(editor.getJSON(), before);
      // Commands that insert a node directly do not run DOM paste handlers.
      editor.view.dispatch(editor.state.tr.insert(0, original));
      assert.ok(editor.state.doc.child(2).eq(original));
      assert(ids(editor.state.doc.firstChild!).every(id => !originalIds.includes(id)));
      verify(editor); assert.deepEqual(h.errors, []);
    } finally { h.destroy(); }
  }
});

for (const collaborative of [false, true]) test(`cut/paste history and cross-document copies do not share IDs (${collaborative})`, async () => {
  const source = await harness(collaborative, 'AAA\n\n> Quote\n>\n> - Nested\n\nTAIL');
  const target = await harness(collaborative, 'TARGET');
  try {
    const { editor } = source;
    const before = editor.getJSON();
    const original = editor.state.doc.child(1);
    editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
    const data = transferEvent(editor, 'cut');
    assert.equal(editor.state.doc.childCount, 2);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    transferEvent(editor, 'paste', data);
    const pasted = editor.state.doc.content.content.find(node => node.type === original.type)!;
    assert(pasted && equivalentRichDocument(pasted.toJSON(), original.toJSON()));
    assert(ids(pasted).every(id => !ids(original).includes(id)), 'paste is a new identity, including after cut');
    assert(editor.commands.undo()); assert.equal(editor.state.doc.childCount, 2);
    assert(editor.commands.undo()); assert.deepEqual(editor.getJSON(), before);
    target.editor.commands.setTextSelection(target.editor.state.doc.content.size - 1);
    transferEvent(target.editor, 'paste', data);
    assert.deepEqual(editor.getJSON(), before);
    assert(ids(target.editor.state.doc).every(id => !ids(editor.state.doc).includes(id)));
    verify(editor); verify(target.editor);
    assert.deepEqual([...source.errors, ...target.errors], []);
  } finally { source.destroy(); target.destroy(); }
});

for (const collaborative of [false, true]) test(`native whole-block move keeps the current block identity (${collaborative})`, async () => {
  const h = await harness(collaborative, 'AAA\n\nBBB\n\nCCC');
  const { editor } = h;
  try {
    const original = editor.state.doc.child(1);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, editor.state.doc.firstChild!.nodeSize)));
    editor.view.posAtCoords = () => ({ pos: editor.state.selection.from + 1, inside: editor.state.selection.from });
    const data = transferEvent(editor, 'dragstart');
    assert.ok(data.types.includes(NATIVE_BLOCK_DRAG_TYPE));
    editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
    transferEvent(editor, 'drop', data);
    assert.ok(editor.state.doc.firstChild!.eq(original), 'a move retains its ID, unlike a clipboard copy');
    verify(editor); assert.deepEqual(h.errors, []);
  } finally { h.destroy(); }
});

test('native block move resolves concurrent content and Undo retains peer edits through binary reopen', async () => {
  const h = await harness(true, 'AAA\n\nBBB\n\nCCC');
  const { editor } = h;
  try {
    const original = editor.state.doc.child(1);
    editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
    const data = transferEvent(editor, 'dragstart');
    const tree = new CollaborationBlockTree(h.document!, editor.schema);
    tree.updateInlineContent(original.attrs.id, original.type.create(original.attrs, editor.schema.text('Peer BBB')), 'peer');
    const beforeMove = editor.getJSON();
    editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
    transferEvent(editor, 'drop', data);
    assert.equal(editor.state.doc.firstChild!.attrs.id, original.attrs.id);
    assert.equal(editor.state.doc.firstChild!.textContent, 'Peer BBB');
    assert(editor.commands.undo()); assert.deepEqual(editor.getJSON(), beforeMove);
    assert(editor.commands.redo()); assert.equal(editor.state.doc.firstChild!.textContent, 'Peer BBB');
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(h.document!));
      assert.deepEqual(new CollaborationBlockTree(restored, editor.schema).read().toJSON(), editor.getJSON());
    } finally { restored.destroy(); }
    verify(editor); assert.deepEqual(h.errors, []);
  } finally { h.destroy(); }
});

for (const collaborative of [false, true]) test(`native gestures revoke old scope, permissions, composition and tokens (${collaborative})`, async () => {
  const h = await harness(collaborative, 'AAA\n\nBBB\n\nCCC');
  const other = await harness(collaborative, 'OTHER');
  const { editor } = h;
  try {
    editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
    other.editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
    for (const cancel of ['permission', 'composition', 'escape', 'visibility', 'outside-drag', 'foreign-view', 'old-token']) {
      editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
      const data = transferEvent(editor, 'dragstart');
      const before = editor.getJSON(); const foreignBefore = other.editor.getJSON();
      if (cancel === 'permission') { editor.setEditable(false, false); editor.setEditable(true, false); }
      if (cancel === 'composition') {
        editor.commands.setTextSelection(editor.state.selection.from + 1);
        editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
        editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
        await Promise.resolve();
      }
      if (cancel === 'escape') window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
      if (cancel === 'visibility') {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new dom.window.Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      }
      if (cancel === 'outside-drag') dom.window.document.body.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
      if (cancel === 'old-token') transferEvent(editor, 'dragstart');
      transferEvent(cancel === 'foreign-view' ? other.editor : editor, 'drop', data);
      assert.deepEqual(editor.getJSON(), before, cancel);
      assert.deepEqual(other.editor.getJSON(), foreignBefore, cancel);
      assert.equal(editor.can().undo(), false, 'a revoked drop cannot write history');
    }
    assert.deepEqual([...h.errors, ...other.errors], []);
  } finally { h.destroy(); other.destroy(); }
});

for (const collaborative of [false, true]) test(`native copy modifiers and unselected image drags preserve source semantics (${collaborative})`, async () => {
  for (const copyAtStart of [false, true]) {
    const h = await harness(collaborative, 'AAA\n\nBBB\n\nCCC');
    const { editor } = h;
    try {
      const original = editor.state.doc.child(1);
      editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
      editor.view.posAtCoords = () => ({ pos: editor.state.selection.from + 1, inside: editor.state.selection.from });
      const data = transferEvent(editor, 'dragstart', new Transfer(), { ctrlKey: copyAtStart, altKey: copyAtStart });
      editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
      transferEvent(editor, 'drop', data, { ctrlKey: true, altKey: true });
      assert.ok(editor.state.doc.child(2).eq(original));
      assert.equal(editor.state.doc.firstChild!.textContent, original.textContent);
      assert.notEqual(editor.state.doc.firstChild!.attrs.id, original.attrs.id);
      verify(editor); assert.deepEqual(h.errors, []);
    } finally { h.destroy(); }
  }
  const h = await harness(collaborative, 'AAA\n\n![Alt](image.png)\n\nCCC');
  try {
    const { editor } = h;
    const image = editor.state.doc.child(1);
    editor.commands.setTextSelection(1);
    const data = new Transfer();
    const start = new dom.window.Event('dragstart', { bubbles: true, cancelable: true });
    Object.assign(start, { dataTransfer: data });
    editor.view.dom.querySelector('img')!.dispatchEvent(start);
    assert.ok(data.types.includes(NATIVE_BLOCK_DRAG_TYPE));
    editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
    transferEvent(editor, 'drop', data);
    assert.ok(editor.state.doc.firstChild!.eq(image));
    assert(editor.state.selection instanceof NodeSelection);
    assert.equal(editor.state.selection.from, 0);
    verify(editor); assert.deepEqual(h.errors, []);
  } finally { h.destroy(); }
});

for (const collaborative of [false, true]) test(`released copy modifier moves by identity; rejected or deleted sources cannot fall through to HTML paste (${collaborative})`, async () => {
  for (const action of ['release-copy', 'reject-transaction', 'delete-source', 'replace-view']) {
    const h = await harness(collaborative, 'AAA\n\nBBB\n\nCCC');
    const { editor } = h;
    try {
      const original = editor.state.doc.child(1);
      editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
      const data = transferEvent(editor, 'dragstart', new Transfer(), { ctrlKey: true, altKey: true });
      editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
      if (action === 'reject-transaction') editor.registerPlugin(new Plugin({ filterTransaction: tr => !tr.getMeta(BLOCK_MOVE_TRANSACTION_META) }));
      if (action === 'delete-source') editor.commands.deleteSelection();
      const before = editor.getJSON();
      const bytes = h.document && Y.encodeStateAsUpdate(h.document);
      if (action === 'replace-view') {
        editor.destroy();
        const next = await harness(collaborative, 'NEW VIEW');
        try {
          const nextBefore = next.editor.getJSON();
          next.editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
          transferEvent(next.editor, 'drop', data);
          assert.deepEqual(next.editor.getJSON(), nextBefore);
          assert.equal(next.editor.can().undo(), false);
        } finally { next.destroy(); }
      } else {
        transferEvent(editor, 'drop', data);
        if (action === 'release-copy') {
          assert(editor.state.doc.firstChild!.eq(original));
          assert(editor.commands.undo()); assert.deepEqual(editor.getJSON(), before);
        } else {
          assert.deepEqual(editor.getJSON(), before);
          if (bytes) assert.deepEqual(Y.encodeStateAsUpdate(h.document!), bytes);
        }
      }
      assert.deepEqual(h.errors, []);
    } finally { h.destroy(); }
  }
});

test('clipboard snapshots receive new IDs while peer changes remain attached to their original block', async () => {
  const h = await harness(true, 'AAA\n\nBBB\n\nCCC');
  const { editor } = h;
  try {
    const original = editor.state.doc.child(1);
    editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
    const data = transferEvent(editor, 'copy');
    const tree = new CollaborationBlockTree(h.document!, editor.schema);
    tree.updateInlineContent(original.attrs.id, original.type.create(original.attrs, editor.schema.text('Agent BBB')), 'peer');
    const before = editor.getJSON();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    transferEvent(editor, 'paste', data);
    const copied = editor.state.doc.content.content.find(node => node.textContent === 'BBB')!;
    assert(copied && copied.attrs.id !== original.attrs.id);
    assert.equal(editor.state.doc.child(1).attrs.id, original.attrs.id);
    assert.equal(editor.state.doc.child(1).textContent, 'Agent BBB');
    assert(editor.commands.undo()); assert.deepEqual(editor.getJSON(), before);
    assert(editor.commands.redo()); assert.equal(editor.state.doc.child(1).textContent, 'Agent BBB');
    verify(editor); assert.deepEqual(h.errors, []);
  } finally { h.destroy(); }
});

test('a thematic break at the beginning stays rich and cannot consume document metadata', async () => {
  for (const collaborative of [false, true]) {
    const h = await harness(collaborative, 'AAA\n\n---\n\nCCC');
    try {
      const { editor } = h;
      editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
      const data = transferEvent(editor, 'dragstart');
      editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
      transferEvent(editor, 'drop', data);
      const markdown = createRichMarkdownManager().serialize(editor.getJSON());
      assert.ok(markdown.startsWith('***\n'));
      for (const prefix of ['', '---\ntitle: Metadata\n---\n\n']) {
        const source = prefix + markdown;
        assert.equal(analyzeMarkdownRichMode(source).mode, 'rich');
        const reopened = new LocalMarkdownDocument(source).getSnapshot();
        assert.ok(reopened.richDocument);
        assert.equal(reopened.markdown, source);
        assert(equivalentRichDocument(reopened.richDocument, editor.getJSON()));
      }
      verify(editor); assert.deepEqual(h.errors, []);
    } finally { h.destroy(); }
  }
});

for (const collaborative of [false, true]) test(`a native block drag cannot start without write permission and become writable later (${collaborative})`, async () => {
  const h = await harness(collaborative, 'AAA\n\nBBB\n\nCCC');
  const { editor } = h;
  try {
    editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
    editor.view.posAtCoords = () => ({ pos: editor.state.selection.from + 1, inside: editor.state.selection.from });
    editor.setEditable(false);
    const before = editor.getJSON();
    const data = transferEvent(editor, 'dragstart');
    assert.equal(Boolean(editor.view.dragging), false, 'a disallowed block gesture must not create a fallback ProseMirror move');
    editor.setEditable(true);
    editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
    transferEvent(editor, 'drop', data);
    assert.deepEqual(editor.getJSON(), before);
    assert.equal(editor.can().undo(), false);
  } finally { h.destroy(); }
});
