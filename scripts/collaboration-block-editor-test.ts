import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
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

function createEditor(doc: Y.Doc, errors: Error[], awareness?: Awareness) {
  return new Editor({
    extensions: [
      ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
        : extension.name === 'uniqueID' ? extension.configure({ filterTransaction: (transaction: import('@tiptap/pm/state').Transaction) => !isRemoteRichEditorTransaction(transaction) }) : extension),
      ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: awareness ?? null,
        user: { name: 'Peer', color: '#123456' }, onError: (error) => errors.push(error) }),
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

test('remote carets follow a moved block and disappear when its target is deleted', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const awarenessA = new Awareness(left);
  const awarenessB = new Awareness(right);
  const errors: Error[] = [];
  const a = createEditor(left, errors, awarenessA);
  const b = createEditor(right, errors, awarenessB);
  document.body.append(a.view.dom, b.view.dom);
  try {
    await Promise.resolve();
    a.view.focus();
    a.commands.setTextSelection(position(a, 'BBB') + 1);
    await Promise.resolve();
    applyAwarenessUpdate(awarenessB, encodeAwarenessUpdate(awarenessA, [awarenessA.clientID]), {});
    assert.equal(b.view.dom.querySelectorAll('[data-collaboration-user="Peer"]').length, 1);
    const id = a.state.doc.child(1).attrs.id;
    new CollaborationBlockTree(right, schema).move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, {});
    const caret = b.view.dom.querySelector('[data-collaboration-user="Peer"]')!;
    assert.equal(caret.closest('p')?.textContent, 'BPeerBB');
    assert.equal(caret.closest('p'), b.view.dom.lastElementChild);
    new CollaborationBlockTree(right, schema).delete(id, 'delete', {});
    assert.equal(b.view.dom.querySelectorAll('[data-collaboration-user="Peer"]').length, 0);
    assert.deepEqual(errors, []);
  } finally {
    a.destroy(); b.destroy(); awarenessA.destroy(); awarenessB.destroy(); left.destroy(); right.destroy();
  }
});

test('closing an older view cannot clear a cursor published by the current view', async () => {
  const doc = createDocument();
  const awareness = new Awareness(doc);
  const errors: Error[] = [];
  const a = createEditor(doc, errors, awareness);
  const b = createEditor(doc, errors, awareness);
  document.body.append(a.view.dom, b.view.dom);
  try {
    await Promise.resolve();
    a.view.focus();
    a.commands.setTextSelection(position(a, 'AAA') + 1);
    await Promise.resolve();
    const oldOwner = awareness.getLocalState()?.canvasBlockSelection?.owner;
    assert.ok(oldOwner);
    b.view.focus();
    b.commands.setTextSelection(position(b, 'CCC') + 1);
    await Promise.resolve();
    const active = awareness.getLocalState()?.canvasBlockSelection;
    assert.ok(active?.owner && active.owner !== oldOwner);
    a.destroy();
    assert.deepEqual(awareness.getLocalState()?.canvasBlockSelection, active);
    b.destroy();
    assert.equal(awareness.getLocalState()?.canvasBlockSelection, null);
    assert.deepEqual(errors, []);
  } finally {
    if (!a.isDestroyed) a.destroy();
    if (!b.isDestroyed) b.destroy();
    awareness.destroy(); doc.destroy();
  }
});

test('an active composition keeps its DOM text through a remote block move', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const editor = createEditor(left, errors);
  document.body.append(editor.view.dom);
  try {
    await Promise.resolve();
    editor.view.focus();
    editor.commands.setTextSelection(position(editor, 'BBB') + 1);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.equal(editor.view.composing, true);
    const composingText = editor.view.dom.querySelectorAll('p')[1].firstChild!;
    const id = editor.state.doc.child(1).attrs.id;
    new CollaborationBlockTree(right, schema).move({ blockId: id, parentId: null, beforeId: null, operationId: 'remote-move' }, {});
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    assert.equal(composingText.isConnected, true, 'the browser composition node must not be replaced');
    assert.equal(editor.view.composing, true);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); left.destroy(); right.destroy(); }
});

test('composition edits sync immediately and merge with remote text and placement as one undo action', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const editor = createEditor(left, errors);
  document.body.append(editor.view.dom);
  try {
    await Promise.resolve();
    editor.view.focus();
    editor.commands.setTextSelection(position(editor, 'BBB') + 1);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    const from = position(editor, 'BBB');
    const source = getReorderableBlockRangeAt(editor, from)!;
    assert.equal(moveReorderableBlock(editor, source, 0), false, 'local drag does not interrupt composition');
    editor.view.dispatch(editor.state.tr.insertText('中', from + 1));
    assert.equal(new CollaborationBlockTree(left, schema).read().child(1).textContent, 'B中BB', 'the composing draft is already in the durable document');
    const remote = new CollaborationBlockTree(right, schema);
    const id = remote.read().child(1).attrs.id;
    (remote.content(id).get(0) as Y.XmlText).insert(0, 'R');
    remote.move({ blockId: id, parentId: null, beforeId: null, operationId: 'remote' }, {});
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    assert.deepEqual(texts(editor), ['AAA', 'B中BB', 'CCC'], 'remote rendering waits for compositionend');
    editor.view.dispatch(editor.state.tr.insertText('文', from + 2));
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'RB中文BB']);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'RBBB'], 'undo retains remote text and move');
    assert.equal(editor.commands.redo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'RB中文BB']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); left.destroy(); right.destroy(); }
});

test('repeated composition reuses its actor and unmount retains the latest synchronized input', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const countListeners = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  const baseline = countListeners();
  const editor = createEditor(doc, errors);
  document.body.append(editor.view.dom);
  try {
    await Promise.resolve();
    editor.view.focus();
    editor.commands.setTextSelection(position(editor, 'AAA') + 1);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText('中'));
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    const actors = Y.decodeStateVector(Y.encodeStateVector(doc)).size;
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText('文'));
    assert.equal(Y.decodeStateVector(Y.encodeStateVector(doc)).size, actors);
    editor.destroy();
    await Promise.resolve();
    assert.equal(new CollaborationBlockTree(doc, schema).read().firstChild!.textContent, 'A中文AA');
    assert.equal(countListeners(), baseline);
    assert.deepEqual(errors, []);
  } finally { if (!editor.isDestroyed) editor.destroy(); doc.destroy(); }
});
