import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createBlockTreeCollaborationExtension } from '../app/lib/collaboration/block-tree-editor';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}

const schema = getSchema(richMarkdownCodecExtensions());

function createDocument() {
  const source = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC');
  const initial = initProseMirrorDoc(source.getXmlFragment('body'), schema).doc;
  source.destroy();
  const doc = new Y.Doc();
  CollaborationBlockTree.create(doc, initial);
  return doc;
}

function createEditor(doc: Y.Doc, errors: Error[]) {
  return new Editor({
    extensions: [
      ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false }) : extension),
      createBlockTreeCollaborationExtension({ document: doc, onError: (error) => errors.push(error) }),
    ],
  });
}

function position(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, from) => { if (node.isText && node.text === text) result = from; });
  assert.ok(result >= 0, `missing ${text}`);
  return result;
}

function texts(editor: Editor): string[] {
  const result: string[] = [];
  editor.state.doc.forEach((node) => result.push(node.textContent));
  return result;
}

test('two real editors preserve concurrent edits, the move intention and selective undo', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const a = createEditor(left, errors);
  const b = createEditor(right, errors);
  try {
    await Promise.resolve();
    assert.deepEqual(texts(a), ['AAA', 'BBB', 'CCC']);
    const from = position(a, 'BBB');
    a.commands.setTextSelection(from + 1);
    const source = getReorderableBlockRangeAt(a, from)!;
    assert.equal(moveReorderableBlock(a, source, 0), true);
    const otherFrom = position(b, 'BBB');
    b.view.dispatch(b.state.tr.insertText('NEW', otherFrom, otherFrom + 3));
    const aUpdate = Y.encodeStateAsUpdate(left);
    const bUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, bUpdate);
    Y.applyUpdate(right, aUpdate);
    assert.deepEqual(texts(a), ['NEW', 'AAA', 'CCC']);
    assert.deepEqual(a.getJSON(), b.getJSON());
    assert.equal(a.commands.undo(), true);
    assert.deepEqual(texts(a), ['AAA', 'NEW', 'CCC']);
    assert.equal(a.commands.redo(), true);
    assert.deepEqual(texts(a), ['NEW', 'AAA', 'CCC']);
    assert.deepEqual(errors, []);
  } finally { a.destroy(); b.destroy(); left.destroy(); right.destroy(); }
});

test('hydration never replaces server data with an empty editor and permission gates every mutation', async () => {
  const server = createDocument();
  const client = new Y.Doc();
  const errors: Error[] = [];
  const editor = createEditor(client, errors);
  try {
    editor.commands.insertContent('too early');
    await Promise.resolve();
    assert.equal(client.share.size, 0);
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    editor.setEditable(false);
    const before = Y.encodeStateAsUpdate(client);
    editor.commands.insertContent('forbidden');
    assert.deepEqual(Y.encodeStateAsUpdate(client), before);
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    const serverTree = new CollaborationBlockTree(server, schema);
    const id = serverTree.read().child(1).attrs.id;
    serverTree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'remote' }, {});
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB'], 'read-only views still receive remote changes');
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); client.destroy(); server.destroy(); }
});

test('unmount releases observers and pending callbacks cannot write after editor destruction', async () => {
  const doc = createDocument();
  const count = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  const baseline = count();
  const before = Y.encodeStateAsUpdate(doc);
  for (let run = 0; run < 4; run += 1) {
    const errors: Error[] = [];
    const editor = createEditor(doc, errors);
    if (run % 2 === 0) await Promise.resolve();
    editor.destroy();
    await Promise.resolve();
    assert.equal(count(), baseline, 'view and UndoManager listeners are fully released');
    assert.deepEqual(errors, []);
  }
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  doc.destroy();
});

test('invalid editor changes are rejected without changing the visible or durable state', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const before = Y.encodeStateAsUpdate(doc);
    const original = editor.getJSON();
    // An existing hidden identity may not be resurrected by a stale command.
    const tree = new CollaborationBlockTree(doc, schema);
    const id = tree.read().child(1).attrs.id;
    tree.delete(id, 'delete', {});
    const deleted = Y.encodeStateAsUpdate(doc);
    const visible = editor.getJSON();
    editor.commands.setContent(original);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), deleted);
    assert.deepEqual(editor.getJSON(), visible);
    assert.notDeepEqual(deleted, before);
    assert.equal(errors.length, 1);
  } finally { editor.destroy(); doc.destroy(); }
});
