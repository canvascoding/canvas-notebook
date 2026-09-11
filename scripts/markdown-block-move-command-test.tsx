import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { Editor, getSchema } from '@tiptap/core';
import { AllSelection, NodeSelection, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import * as Y from 'yjs';
import messages from '../messages/en.json';
import { MarkdownBlockMovement, captureBlockMoveSource, moveBlockInDirection } from '../app/lib/editor/block-move-command';
import { MarkdownDomSelection } from '../app/components/editor/MarkdownDomSelection';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';
import { createLocalMarkdownRichExtension, LOCAL_MARKDOWN_PROJECTION } from '../app/lib/editor/local-markdown-rich-binding';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { BLOCK_MOVE_TRANSACTION_META } from '../app/lib/editor/block-reference';
import { createBlockReference, resolveBlockReference } from '../app/lib/editor/block-reference';
import { getBlockContainerOptions, type BlockContainerTarget } from '../app/lib/editor/block-container-target';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { parseDetailsBlock } from '../app/lib/markdown/core/details-block';
import { applyReorderableBlockMove, createInsertedBlockCommandTarget, getBlockDropTarget, getBlockInsertButtonPosition,
  getReorderableBlockRangeAt, resolveReorderableBlockRange } from '../app/lib/editor/reorderable-blocks';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

function harness(collaborative: boolean, markdown = 'AAA\n\nBBB\n\nCCC') {
  const manager = createRichMarkdownManager();
  const local = collaborative ? null : new LocalMarkdownDocument(manager.serialize(manager.parse(markdown)));
  if (local) assert.ok(local.getSnapshot().richDocument, `the fixture must be representable in the local rich view: ${markdown}`);
  const doc = collaborative ? new Y.Doc() : null;
  if (doc) {
    const extensions = richMarkdownCodecExtensions();
    CollaborationBlockTree.create(doc, getSchema(extensions).nodeFromJSON(generateRichNodeIds(createRichMarkdownManager().parse(markdown), extensions)));
  }
  const errors: Error[] = [];
  const mount = (onRejected?: () => void) => {
    const editor = new Editor({ extensions: [
      ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
        : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (tr: Transaction) =>
          !isRemoteRichEditorTransaction(tr) && !tr.getMeta(LOCAL_MARKDOWN_PROJECTION) }) : extension),
      MarkdownBlockMovement.configure({ onRejected }),
      MarkdownDomSelection,
      ...(doc ? createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: null,
        user: { name: 'Test', color: '#123456' }, onError: error => errors.push(error) })
        : [createLocalMarkdownRichExtension({ document: local!, onError: error => errors.push(error) })]),
    ] });
    document.body.append(editor.view.dom);
    return editor;
  };
  return { doc, local, errors, mount, destroy: () => doc?.destroy() };
}

const texts = (editor: Editor) => editor.state.doc.content.content.map(node => node.textContent);
function position(editor: Editor, type: string, text?: string) {
  let found = -1;
  editor.state.doc.descendants((node, from) => { if (node.type.name === type && (text === undefined || node.textContent === text)) found = from; });
  assert.ok(found >= 0, `${type}/${text} must exist`);
  return found;
}
function key(editor: Editor, key: string, extra: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

for (const collaborative of [false, true]) test(`keyboard move follows the visible caret before selectionchange arrives (collaborative=${collaborative})`, async () => {
  const h = harness(collaborative);
  const editor = h.mount();
  try {
    await Promise.resolve();
    editor.view.focus();
    const id = editor.state.doc.child(2).attrs.id;
    const targetText = editor.view.dom.querySelectorAll('p')[2].firstChild!;
    dom.window.getSelection()!.collapse(targetText, 1);
    assert.equal(editor.state.selection.from, 1, 'the observer has not yet received the visible caret move');
    assert.equal(key(editor, 'ArrowUp'), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    assert.equal(editor.state.selection.$head.parent.attrs.id, id);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    assert.equal(editor.can().undo(), false, 'reconciling the caret does not add a content history entry');
    assert.deepEqual(h.errors, []);
  } finally { editor.destroy(); h.destroy(); }
});

for (const collaborative of [false, true]) test(`caret reconciliation preserves structured selection and composition guards (collaborative=${collaborative})`, async () => {
  for (const mode of ['node', 'cells', 'all', 'composing', 'readOnly'] as const) {
    const h = harness(collaborative, 'AAA\n\n![Block](image.png)\n\n| H |\n| --- |\n| Cell |\n\nCCC');
    const editor = h.mount();
    try {
      await Promise.resolve(); editor.view.focus();
      const original = editor.getJSON();
      if (mode === 'node' || mode === 'cells') {
        const from = position(editor, mode === 'node' ? 'image' : 'tableCell');
        const selection = mode === 'node' ? NodeSelection.create(editor.state.doc, from) : CellSelection.create(editor.state.doc, from);
        const selectedId = editor.state.doc.nodeAt(from)!.attrs.id;
        editor.view.dispatch(editor.state.tr.setSelection(selection));
        assert.equal(key(editor, 'ArrowUp'), true);
        if (mode === 'node') {
          assert(editor.state.selection instanceof NodeSelection);
          assert.equal(editor.state.selection.node.attrs.id, selectedId);
        } else {
          assert(editor.state.selection instanceof CellSelection);
          assert.equal(editor.state.selection.$anchorCell.nodeAfter!.attrs.id, selectedId);
        }
        assert.equal(editor.state.doc.child(mode === 'node' ? 0 : 1).type.name, mode === 'node' ? 'image' : 'table');
        assert.equal(editor.commands.undo(), true);
      } else if (mode === 'all') {
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
        key(editor, 'ArrowUp');
        assert(editor.state.selection instanceof AllSelection);
      } else {
        const targetText = editor.view.dom.querySelector(':scope > p:last-child')!.firstChild!;
        dom.window.getSelection()!.collapse(targetText, 1);
        if (mode === 'readOnly') editor.setEditable(false);
        key(editor, 'ArrowUp', { isComposing: mode === 'composing' });
        assert.equal(editor.state.selection.from, 1, `${mode} must not reconcile an ineligible input`);
      }
      assert.deepEqual(editor.getJSON(), original);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

for (const collaborative of [false, true]) test(`keyboard move preserves backward selection and document history (collaborative=${collaborative})`, async () => {
  const h = harness(collaborative);
  let editor = h.mount();
  try {
    await Promise.resolve();
    const id = editor.state.doc.child(1).attrs.id;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 8, 6)));
    assert.equal(key(editor, 'ArrowDown'), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    assert.equal(editor.state.selection.$head.parent.attrs.id, id);
    assert.equal(editor.state.selection.anchor > editor.state.selection.head, true);
    assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), 'BB');
    const movedSelection = editor.state.selection.toJSON();
    assert.equal(key(editor, 'ArrowDown'), true, 'boundary consumes the shortcut without moving text selection');
    assert.deepEqual(editor.state.selection.toJSON(), movedSelection);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    assert.equal(editor.can().undo(), false, 'selection restoration is not another history action');
    assert.equal(editor.commands.redo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    assert.deepEqual(editor.state.selection.toJSON(), movedSelection, 'redo restores the moved selection, not the block start');
    const captured = captureBlockMoveSource(editor)!;
    editor.destroy();
    editor = h.mount();
    await Promise.resolve();
    assert.deepEqual(moveBlockInDirection(editor, 'up', captured), { ok: false, reason: 'source_changed' });
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    editor.commands.setTextSelection(6);
    const before = editor.getJSON();
    assert.equal(key(editor, 'ArrowDown', { isComposing: true }), false);
    editor.setEditable(false);
    assert.equal(key(editor, 'ArrowDown'), false);
    assert.deepEqual(editor.getJSON(), before);
    assert.deepEqual(h.errors, []);
  } finally { editor.destroy(); h.destroy(); }
});

for (const collaborative of [false, true]) test(`list, code, image and cell selections use the same move (collaborative=${collaborative})`, async () => {
  for (const item of [
    { markdown: 'AAA\n\n```ts\nconst x = 1;\n```\n\nCCC', type: 'codeBlock' },
    { markdown: 'AAA\n\n![Alt](image.png)\n\nCCC', type: 'image' },
    { markdown: 'AAA\n\n| A | B |\n| --- | --- |\n| X | Y |\n\nCCC', type: 'tableCell' },
    { markdown: '- [ ] One\n- [x] Two\n- [ ] Three', type: 'taskItem' },
  ]) {
    const h = harness(collaborative, item.markdown);
    const editor = h.mount();
    try {
      await Promise.resolve();
      const from = position(editor, item.type, item.type === 'taskItem' ? 'Two' : undefined);
      const node = editor.state.doc.nodeAt(from)!;
      const selection = item.type === 'tableCell' ? CellSelection.create(editor.state.doc, from)
        : item.type === 'codeBlock' ? TextSelection.create(editor.state.doc, from + 3)
          : NodeSelection.create(editor.state.doc, from);
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      const before = editor.getJSON();
      const selectedId = node.attrs.id;
      assert.equal(moveBlockInDirection(editor, 'up').ok, true, item.type);
      if (item.type === 'tableCell') {
        assert(editor.state.selection instanceof CellSelection);
        assert.equal(editor.state.selection.$anchorCell.nodeAfter!.attrs.id, selectedId);
      } else if (item.type === 'codeBlock') assert.equal(editor.state.selection.$head.parent.attrs.id, selectedId);
      else {
        assert(editor.state.selection instanceof NodeSelection);
        assert.equal(editor.state.selection.node.attrs.id, selectedId);
      }
      if (item.type === 'taskItem') {
        assert.equal(editor.state.doc.firstChild!.firstChild!.attrs.checked, true);
        assert.equal(moveBlockInDirection(editor, 'up').ok, false, 'first item never escapes its list');
      }
      assert.equal(editor.commands.undo(), true);
      assert.deepEqual(editor.getJSON(), before);
      assert.deepEqual(editor.state.selection.toJSON(), selection.toJSON(), `${item.type} undo restores the original selection kind and range`);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

test('a multi-block selection never guesses which block to move', async () => {
  const h = harness(false);
  const editor = h.mount();
  try {
    await Promise.resolve();
    const before = editor.getJSON();
    for (const selection of [new AllSelection(editor.state.doc), TextSelection.create(editor.state.doc, 2, 8)]) {
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      assert.equal(captureBlockMoveSource(editor), null);
      assert.equal(moveBlockInDirection(editor, 'down').ok, false);
      assert.deepEqual(editor.getJSON(), before);
    }
  } finally { editor.destroy(); h.destroy(); }
});

for (const collaborative of [false, true]) test(`nested blocks move within their live container and preserve history (collaborative=${collaborative})`, async () => {
  for (const fixture of [
    { markdown: '> AAA\n>\n> BBB\n>\n> CCC', type: 'paragraph', text: 'BBB', parent: 'blockquote' },
    { markdown: '> > AAA\n> >\n> > BBB\n> >\n> > CCC', type: 'paragraph', text: 'BBB', parent: 'blockquote' },
    { markdown: '> [!note] Title\n> AAA\n>\n> BBB\n>\n> CCC', type: 'paragraph', text: 'BBB', parent: 'canvasCallout' },
    { markdown: '<details open>\n<summary>Title</summary>\n\nAAA\n\nBBB\n\nCCC\n\n</details>', type: 'paragraph', text: 'BBB', parent: 'canvasDetailsContent' },
    { markdown: '> AAA\n>\n> ```ts\n> BBB\n> ```\n>\n> CCC', type: 'codeBlock', text: 'BBB', parent: 'blockquote' },
    { markdown: '> AAA\n>\n> ![Image](image.png)\n>\n> CCC', type: 'image', text: '', parent: 'blockquote' },
    { markdown: '> AAA\n>\n> > BBB\n>\n> CCC', type: 'blockquote', text: 'BBB', parent: 'blockquote' },
    { markdown: '> AAA\n>\n> - BBB\n>\n> CCC', type: 'bulletList', text: 'BBB', parent: 'blockquote' },
  ]) {
    const h = harness(collaborative, fixture.markdown);
    const editor = h.mount();
    try {
      await Promise.resolve();
      const from = position(editor, fixture.type, fixture.text);
      const node = editor.state.doc.nodeAt(from)!;
      const selection = node.isTextblock ? TextSelection.create(editor.state.doc, from + 3, from + 1)
        : NodeSelection.create(editor.state.doc, from);
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      const source = captureBlockMoveSource(editor)!;
      assert(source, JSON.stringify(fixture));
      assert.equal(source.node.attrs.id, node.attrs.id);
      assert.equal(source.kind, 'nested');
      assert.equal(editor.state.doc.resolve(source.from).parent.type.name, fixture.parent);
      const before = editor.getJSON();
      assert.equal(key(editor, 'ArrowDown'), true);
      const current = resolveReorderableBlockRange(editor, source)!;
      const parent = editor.state.doc.resolve(current.from).parent;
      assert.equal(parent.lastChild!.attrs.id, node.attrs.id);
      assert.equal(current.node.eq(node), true, 'the exact block, attributes and descendants remain');
      const moved = editor.getJSON();
      const movedSelection = editor.state.selection.toJSON();
      assert.equal(moveBlockInDirection(editor, 'down').ok, false, 'last child does not escape its container');
      assert.deepEqual(editor.getJSON(), moved);
      assert.deepEqual(applyReorderableBlockMove(editor, source, editor.state.doc.content.size), { ok: false, reason: 'invalid_destination' });
      assert.equal(editor.commands.undo(), true);
      assert.deepEqual(editor.getJSON(), before);
      assert.deepEqual(editor.state.selection.toJSON(), selection.toJSON());
      assert.equal(editor.can().undo(), false);
      assert.equal(editor.commands.redo(), true);
      assert.deepEqual(editor.getJSON(), moved);
      assert.deepEqual(editor.state.selection.toJSON(), movedSelection);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

test('fixed container slots remain intact while ordinary nested siblings are addressable', async () => {
  for (const fixture of [
    { markdown: '> [!note] Title\n> AAA\n>\n> BBB', text: 'Title', type: 'canvasCalloutTitle', source: 'canvasCallout' },
    { markdown: '<details open>\n<summary>Title</summary>\n\nAAA\n\nBBB\n\n</details>', text: 'Title', type: 'canvasDetailsSummary', source: 'canvasDetails' },
    { markdown: '> - AAA\n> - BBB', text: 'AAA', type: 'paragraph', source: 'listItem' },
    { markdown: '> - [ ] AAA\n> - [x] BBB', text: 'AAA', type: 'paragraph', source: 'taskItem' },
    { markdown: '> | AAA | BBB |\n> | --- | --- |\n> | CCC | DDD |', text: 'AAA', type: 'paragraph', source: 'table' },
  ]) {
    const h = harness(false, fixture.markdown);
    const editor = h.mount();
    try {
      await Promise.resolve();
      editor.commands.setTextSelection(position(editor, fixture.type, fixture.text) + 1);
      assert.equal(captureBlockMoveSource(editor)!.node.type.name, fixture.source);
      const before = editor.getJSON();
      assert.equal(moveBlockInDirection(editor, 'up').ok, false, 'the structural first slot is not reordered');
      assert.deepEqual(editor.getJSON(), before);
    } finally { editor.destroy(); h.destroy(); }
  }
  const h = harness(false, '> [!note] Title\n> AAA\n>\n> BBB');
  const editor = h.mount();
  try {
    await Promise.resolve();
    editor.commands.setTextSelection(position(editor, 'paragraph', 'AAA') + 1);
    const before = editor.getJSON();
    assert.equal(moveBlockInDirection(editor, 'up').ok, false, 'the first body block cannot displace the callout title');
    assert.deepEqual(editor.getJSON(), before);
  } finally { editor.destroy(); h.destroy(); }
});

test('nested drag targets resolve in the source parent after peer edits and container moves', async () => {
  const h = harness(true, 'Before\n\n> AAA\n>\n> BBB\n>\n> CCC\n\nAfter');
  const editor = h.mount();
  try {
    await Promise.resolve();
    editor.commands.setTextSelection(position(editor, 'paragraph', 'BBB') + 1);
    const source = captureBlockMoveSource(editor)!;
    const target = getReorderableBlockRangeAt(editor, position(editor, 'paragraph', 'CCC') + 1, source)!;
    const tree = new CollaborationBlockTree(h.doc!, editor.schema);
    const parent = editor.state.doc.resolve(source.from).parent;
    tree.move({ blockId: parent.attrs.id, parentId: null, beforeId: null, operationId: 'peer-parent-move' }, 'peer');
    tree.updateInlineContent(source.node.attrs.id, source.node.type.create(source.node.attrs, editor.schema.text('Peer BBB')), 'peer');
    const peerDocument = editor.getJSON();
    // Supply geometry only. Target lookup, source refresh and the transaction
    // are the actual production drag path; this does not assert browser layout.
    editor.view.posAtCoords = () => ({ pos: position(editor, 'paragraph', 'CCC') + 1, inside: -1 });
    const destination = getBlockDropTarget(editor, { clientX: 20, clientY: 100 }, source)!;
    assert.equal(destination.target.reference.id, target.reference.id);
    assert.equal(destination.placement, 'after');
    assert.equal(applyReorderableBlockMove(editor, source, destination, { preserveSelection: true }).ok, true);
    const movedParent = editor.state.doc.resolve(resolveReorderableBlockRange(editor, source)!.from).parent;
    assert.equal(movedParent.attrs.id, parent.attrs.id);
    assert.deepEqual(movedParent.content.content.map(node => node.textContent), ['AAA', 'CCC', 'Peer BBB']);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(editor.getJSON(), peerDocument, 'undo retains the peer text and parent move');
    tree.delete(target.node.attrs.id, 'peer-delete-target', 'peer');
    const afterDelete = Y.encodeStateAsUpdate(h.doc!);
    assert.deepEqual(applyReorderableBlockMove(editor, source, destination), { ok: false, reason: 'target_changed' });
    assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), afterDelete);
    assert.deepEqual(h.errors, []);
  } finally { editor.destroy(); h.destroy(); }
});

test('nested moves retain simultaneous peer text through selective undo, redo and binary reopen', async () => {
  const h = harness(true, '> AAA\n>\n> BBB\n>\n> CCC');
  const editor = h.mount();
  const peer = new Y.Doc();
  try {
    await Promise.resolve();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc!));
    const tree = new CollaborationBlockTree(peer, editor.schema);
    editor.commands.setTextSelection(position(editor, 'paragraph', 'BBB') + 1);
    const source = captureBlockMoveSource(editor)!;
    assert.equal(moveBlockInDirection(editor, 'down').ok, true);
    tree.updateInlineContent(source.node.attrs.id, source.node.type.create(source.node.attrs, editor.schema.text('Peer BBB')), 'peer');
    Y.applyUpdate(h.doc!, Y.encodeStateAsUpdate(peer), 'peer');
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc!), 'peer');
    assert.deepEqual(editor.state.doc.firstChild!.content.content.map(node => node.textContent), ['AAA', 'CCC', 'Peer BBB']);
    assert.deepEqual(tree.read().toJSON(), editor.getJSON());
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(editor.state.doc.firstChild!.content.content.map(node => node.textContent), ['AAA', 'Peer BBB', 'CCC']);
    assert.equal(editor.commands.redo(), true);
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(h.doc!));
      assert.deepEqual(new CollaborationBlockTree(restored, editor.schema).read().toJSON(), editor.getJSON());
    } finally { restored.destroy(); }
    assert.deepEqual(h.errors, []);
  } finally { editor.destroy(); peer.destroy(); h.destroy(); }
});

for (const collaborative of [false, true]) test(`code and atom controls have independent insert targets and reject unavailable writes (collaborative=${collaborative})`, async () => {
  for (const fixture of [
    { markdown: 'AAA\n\n```ts\nconst x = 1;\n```\n\nCCC', type: 'codeBlock' },
    { markdown: 'AAA\n\n![Alt](image.png)\n\nCCC', type: 'image' },
    { markdown: 'AAA\n\n---\n\nCCC', type: 'horizontalRule' },
  ]) {
    const h = harness(collaborative, fixture.markdown);
    const editor = h.mount();
    const container = document.createElement('div');
    try {
      await Promise.resolve();
      const from = position(editor, fixture.type);
      if (fixture.type === 'codeBlock') editor.commands.setTextSelection(from + 2);
      else editor.commands.setNodeSelection(from);
      const source = captureBlockMoveSource(editor)!;
      const controls = getBlockInsertButtonPosition(editor, container)!;
      assert.equal(controls.blockRange.reference.id, source.reference.id);
      assert.equal(controls.menuRange, null);
      const before = editor.getJSON();
      for (const placement of ['above', 'below'] as const) {
        const target = createInsertedBlockCommandTarget(editor, placement, source)!;
        assert(target, `${fixture.type}/${placement}`);
        assert.equal(editor.state.doc.resolve(target.from).parent.type.name, 'paragraph');
        assert.equal(editor.state.doc.resolve(target.from).parent.textContent, '');
        assert.equal(resolveReorderableBlockRange(editor, source)!.node.eq(source.node), true);
        assert(editor.commands.undo());
        assert.deepEqual(editor.getJSON(), before);
      }
      editor.setEditable(false);
      assert.equal(getBlockInsertButtonPosition(editor, container), null);
      assert.equal(createInsertedBlockCommandTarget(editor, 'below', source), null);
      editor.setEditable(true);
      // A pending atom/code target may coexist with IME input at a text caret.
      editor.commands.setTextSelection(2);
      editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
      assert.equal(getBlockInsertButtonPosition(editor, container), null);
      assert.equal(createInsertedBlockCommandTarget(editor, 'below', source), null);
      assert.deepEqual(applyReorderableBlockMove(editor, source, editor.state.doc.content.size), { ok: false, reason: 'read_only' });
      editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
      await Promise.resolve();
      editor.registerPlugin(new Plugin({ filterTransaction: transaction => !transaction.docChanged }));
      await Promise.resolve();
      assert.equal(createInsertedBlockCommandTarget(editor, 'below', source), null, 'a rejected insertion cannot open a menu at old content');
      assert.deepEqual(editor.getJSON(), before);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

for (const collaborative of [false, true]) test(`a rejected keyboard move reports failure without changing content or selection (collaborative=${collaborative})`, async () => {
  const h = harness(collaborative);
  let rejected = 0;
  const editor = h.mount(() => { rejected++; });
  try {
    await Promise.resolve();
    editor.commands.setTextSelection(7);
    const before = editor.getJSON();
    const selection = editor.state.selection.toJSON();
    const saved = h.doc ? Y.encodeStateAsUpdate(h.doc) : h.local!.getSnapshot();
    editor.registerPlugin(new Plugin({ filterTransaction: transaction => !transaction.getMeta(BLOCK_MOVE_TRANSACTION_META) }));
    await Promise.resolve(); // Reconfiguring plugins remounts the collaboration binding.
    assert.equal(key(editor, 'ArrowDown'), true);
    assert.equal(rejected, 1);
    assert.deepEqual(editor.getJSON(), before);
    assert.deepEqual(editor.state.selection.toJSON(), selection);
    assert.deepEqual(h.doc ? Y.encodeStateAsUpdate(h.doc) : h.local!.getSnapshot(), saved);
    assert.equal(editor.can().undo(), false);
  } finally { editor.destroy(); h.destroy(); }
});

test('desktop and touch menus preserve their moved target and revoke old view/permission lifetimes', async () => {
  const { MarkdownBlockMoveMenu } = await import('../app/components/editor/MarkdownBlockMoveMenu');
  const h = harness(true);
  const a = h.mount();
  const b = h.mount();
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const render = async (editor: Editor, mobile = false) => act(async () => root.render(
    <StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MarkdownBlockMoveMenu editor={editor} mobile={mobile} />
    </NextIntlClientProvider></StrictMode>,
  ));
  const open = async (mobile = false) => {
    const button = container.querySelector('button')!;
    await act(async () => {
      const event = mobile ? new dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })
        : new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      if (mobile) Object.defineProperty(event, 'pointerType', { value: 'touch' });
      button.dispatchEvent(event);
    });
    assert(document.querySelector('[role="menu"]'), 'the actual Radix menu opened');
  };
  try {
    await Promise.resolve();
    a.commands.setTextSelection(7);
    await render(a);
    await open();
    const tree = new CollaborationBlockTree(h.doc!, a.schema);
    const id = a.state.doc.child(1).attrs.id;
    await act(async () => {
      tree.move({ blockId: id, parentId: null, beforeId: a.state.doc.firstChild!.attrs.id, operationId: 'peer-move' }, 'peer');
      const node = a.state.doc.firstChild!;
      tree.updateInlineContent(id, node.type.create(node.attrs, a.schema.text('Peer BBB')), 'peer');
    });
    const down = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Move block down'))!;
    await act(async () => down.click());
    assert.deepEqual(texts(a), ['AAA', 'Peer BBB', 'CCC']);
    await act(async () => { assert(a.commands.undo()); });
    assert.deepEqual(texts(a), ['Peer BBB', 'AAA', 'CCC']);
    await open();
    await render(b);
    await render(a);
    assert.equal(document.querySelector('[role="menu"]'), null, 'A→B→A cannot reopen an old intent');
    await act(async () => a.setEditable(false));
    assert.equal(container.querySelector('button')!.disabled, true, 'a closed menu reflects revoked write access');
    await act(async () => a.setEditable(true));
    assert.equal(container.querySelector('button')!.disabled, false, 'restored access enables a fresh action');
    await open();
    await act(async () => { a.setEditable(false); a.setEditable(true); });
    assert.equal(document.querySelector('[role="menu"]'), null, 'permission restoration cannot reopen a revoked intent');
    await open();
    await act(async () => {
      document.querySelector('[role="menu"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, container.querySelector('button'), 'Escape restores focus to the menu trigger');
    await render(a, true);
    await open(true);
    const mobileDown = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Move block down'))!;
    await act(async () => mobileDown.click());
    assert.deepEqual(texts(a), ['AAA', 'Peer BBB', 'CCC'], 'the touch menu invokes the same live block command');
    await open(true);
    const before = Y.encodeStateAsUpdate(h.doc!);
    await act(async () => root.unmount());
    unmounted = true;
    down.click();
    assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), before);
    assert.deepEqual(h.errors, []);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    a.destroy(); b.destroy(); h.destroy(); container.remove();
  }
});

for (const collaborative of [false, true]) test(`explicit container moves preserve identities, required slots and one selection/history action (collaborative=${collaborative})`, async () => {
  const cases = [
    { markdown: '> AAA\n\nBBB\n\nCCC', source: 'paragraph', text: 'BBB', target: 'blockquote' },
    { markdown: '> BBB\n\n> [!note] Title\n> AAA\n\nCCC', source: 'paragraph', text: 'BBB', target: 'canvasCallout', pruned: 'blockquote' },
    { markdown: '> > BBB\n\nCCC', source: 'paragraph', text: 'BBB', target: 'blockquote', ancestor: true },
    { markdown: '> [!note] Title\n> BBB\n\nCCC', source: 'paragraph', text: 'BBB', target: 'doc' },
    { markdown: '<details>\n<summary>Title</summary>\n\nBBB\n\n</details>\n\n> AAA\n\nCCC', source: 'paragraph', text: 'BBB', target: 'blockquote' },
    { markdown: '> AAA\n\n<details>\n<summary>Title</summary>\n\nBBB\n\n</details>\n\nCCC', source: 'paragraph', text: 'AAA', target: 'canvasDetailsContent', pruned: 'blockquote' },
    { markdown: '- BBB\n\nCCC\n\n7. AAA', source: 'listItem', text: 'BBB', target: 'orderedList', pruned: 'bulletList' },
    { markdown: '- [x] BBB\n\nCCC\n\n- [ ] AAA', source: 'taskItem', text: 'BBB', target: 'taskList', pruned: 'taskList' },
    { markdown: '> AAA\n\n| H |\n| --- |\n| BBB |\n\nCCC', source: 'tableCell', text: 'BBB', target: 'blockquote', cell: true },
    { markdown: '- AAA\n\n![Alt](image.png)\n\nCCC', source: 'image', target: 'listItem' },
    { markdown: 'BBB\n\nReference[^n]\n\n[^n]: AAA', source: 'paragraph', text: 'BBB', target: 'markdownFootnoteDefinition' },
  ];
  for (const item of cases) {
    const h = harness(collaborative, item.markdown);
    const editor = h.mount();
    try {
      await Promise.resolve();
      const from = position(editor, item.source, item.text);
      const node = editor.state.doc.nodeAt(from)!;
      editor.view.dispatch(editor.state.tr.setSelection(item.cell ? CellSelection.create(editor.state.doc, from)
        : node.isTextblock ? TextSelection.create(editor.state.doc, from + 3, from + 1) : NodeSelection.create(editor.state.doc, from)));
      const source = captureBlockMoveSource(editor)!;
      const before = editor.getJSON();
      const sourceId = source.node.attrs.id;
      const oldParentId = editor.state.doc.resolve(source.from).parent.attrs.id;
      const options = getBlockContainerOptions(editor, source);
      const destination = options.find(option => option.type === item.target
        && option.target.parent?.id !== oldParentId);
      assert(destination, `a destination exists for ${item.source} → ${item.target}`);
      const targetId = destination.target.parent?.id ?? null;
      assert.equal(applyReorderableBlockMove(editor, source, destination.target, { preserveSelection: true }).ok, true, JSON.stringify(item));
      editor.state.doc.check();
      const ids = new Set<string>();
      editor.state.doc.descendants(node => {
        if (node.isText) return;
        assert.equal(typeof node.attrs.id, 'string');
        assert(node.attrs.id && !ids.has(node.attrs.id), 'moved blocks and new empty-body paragraphs have unique IDs');
        ids.add(node.attrs.id);
      });
      const current = resolveBlockReference(editor.state.doc, editor, source.reference)!;
      assert(current, 'the original block identity remains addressable after changing its container');
      assert(editor.state.selection.from >= current.from && editor.state.selection.to <= current.to, 'selection remains inside the moved block');
      assert.equal(current.node.attrs.id, sourceId);
      assert.deepEqual(current.node.toJSON(), source.node.toJSON(), 'all moved descendants retain their IDs, attributes and text');
      const actualParent = editor.state.doc.resolve(current.from).parent;
      assert.equal(actualParent === editor.state.doc ? null : actualParent.attrs.id, targetId);
      assert.equal(actualParent.lastChild!.attrs.id, sourceId, 'the explicit action appends to the chosen current container');
      if (item.pruned) {
        let oldParentRemains = false;
        editor.state.doc.descendants(node => { if (node.attrs.id === oldParentId) oldParentRemains = true; });
        assert.equal(oldParentRemains, false, 'an emptied required wrapper is removed without a phantom replacement item');
      }
      if (item.ancestor) assert.equal(editor.state.doc.firstChild!.firstChild!.type.name, 'paragraph', 'the empty inner quote is pruned, but its destination ancestor survives');
      if (item.target === 'canvasDetailsContent') assert.equal(editor.state.doc.firstChild!.attrs.open, true, 'the destination opens in the same undoable move so its new content is visible');
      if (item.cell) assert(editor.state.selection instanceof CellSelection);
      const moved = editor.getJSON();
      const selection = editor.state.selection.toJSON();
      const manager = createRichMarkdownManager();
      assert(equivalentRichDocument(moved, editor.schema.nodeFromJSON(manager.parse(manager.serialize(moved))).toJSON()),
        `${JSON.stringify(item)}: an offered move remains representable through the strict Markdown roundtrip`);
      assert.equal(editor.commands.undo(), true);
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(editor.can().undo(), false);
      assert.equal(editor.commands.redo(), true);
      assert.deepEqual(editor.getJSON(), moved);
      assert.deepEqual(editor.state.selection.toJSON(), selection);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

test('container choices follow current target identities and reject deleted, foreign, cyclic or revoked destinations', async () => {
  const h = harness(true, '> AAA\n\nBBB\n\nCCC');
  const editor = h.mount();
  try {
    await Promise.resolve();
    editor.commands.setTextSelection(position(editor, 'paragraph', 'BBB') + 1);
    const source = captureBlockMoveSource(editor)!;
    const destination = getBlockContainerOptions(editor, source).find(option => option.type === 'blockquote')!.target;
    const tree = new CollaborationBlockTree(h.doc!, editor.schema);
    const quote = editor.state.doc.firstChild!;
    tree.move({ blockId: quote.attrs.id, parentId: null, beforeId: null, operationId: 'destination-moved' }, 'peer');
    tree.updateInlineContent(source.node.attrs.id, source.node.type.create(source.node.attrs, editor.schema.text('Peer BBB')), 'peer');
    assert.equal(applyReorderableBlockMove(editor, source, destination, { preserveSelection: true }).ok, true);
    assert.equal(editor.state.doc.lastChild!.lastChild!.textContent, 'Peer BBB');
    assert.equal(editor.commands.undo(), true);
    assert.equal(editor.state.doc.firstChild!.textContent, 'Peer BBB');
    assert.equal(editor.state.doc.lastChild!.attrs.id, quote.attrs.id, 'own undo retains the peer container move');
    const before = Y.encodeStateAsUpdate(h.doc!);
    const self: BlockContainerTarget = { kind: 'container', scope: editor, parent: createBlockReference(editor, editor.state.doc.lastChild!) };
    const quoteRange = getReorderableBlockRangeAt(editor, editor.state.doc.content.size - quote.nodeSize)!;
    assert.equal(applyReorderableBlockMove(editor, quoteRange, self).ok, false);
    assert.equal(applyReorderableBlockMove(editor, source, { ...destination, scope: {} as Editor }).ok, false);
    editor.setEditable(false);
    assert.equal(applyReorderableBlockMove(editor, source, destination).ok, false);
    editor.setEditable(true);
    assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), before);
    tree.delete(quote.attrs.id, 'delete-destination', 'peer');
    const deleted = Y.encodeStateAsUpdate(h.doc!);
    assert.equal(applyReorderableBlockMove(editor, source, destination).ok, false);
    assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), deleted);
    assert.deepEqual(h.errors, []);
  } finally { editor.destroy(); h.destroy(); }
});

test('container reparenting retains concurrent peer text, selective history and binary restart', async () => {
  for (const markdown of ['> AAA\n\nBBB\n\nCCC', '> [!note] Title\n> BBB\n\n> AAA\n\nCCC', '- BBB\n\nCCC\n\n7. AAA']) {
    const h = harness(true, markdown);
    const editor = h.mount();
    const peer = new Y.Doc();
    try {
      await Promise.resolve();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc!));
      editor.commands.setTextSelection(position(editor, 'paragraph', 'BBB') + 2);
      const source = captureBlockMoveSource(editor)!;
      const options = getBlockContainerOptions(editor, source);
      const destination = options.find(option => ['blockquote', 'orderedList'].includes(option.type))!;
      const peerTree = new CollaborationBlockTree(peer, editor.schema);
      const paragraph = editor.state.doc.nodeAt(position(editor, 'paragraph', 'BBB'))!;
      const originalParentId = editor.state.doc.resolve(source.from).parent.attrs.id;
      assert.equal(applyReorderableBlockMove(editor, source, destination.target, { preserveSelection: true }).ok, true);
      peerTree.updateInlineContent(paragraph.attrs.id, paragraph.type.create(paragraph.attrs, editor.schema.text('BBB 👩🏽‍💻 Peer')), 'peer');
      Y.applyUpdate(h.doc!, Y.encodeStateAsUpdate(peer), 'peer');
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.doc!), 'peer');
      assert.deepEqual(peerTree.read().toJSON(), editor.getJSON());
      const moved = resolveBlockReference(editor.state.doc, editor, source.reference)!;
      assert.equal(moved.node.textContent, 'BBB 👩🏽‍💻 Peer');
      assert.equal(moved.parent.attrs.id, destination.target.parent!.id);
      assert.equal(editor.commands.undo(), true);
      const undone = resolveBlockReference(editor.state.doc, editor, source.reference)!;
      assert.equal(undone.node.textContent, 'BBB 👩🏽‍💻 Peer');
      assert.equal(undone.parent.attrs.id, originalParentId, 'undo restores the original container, including a pruned list wrapper');
      assert.equal(editor.commands.redo(), true);
      assert.equal(resolveBlockReference(editor.state.doc, editor, source.reference)!.parent.attrs.id, destination.target.parent!.id);
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(restored, Y.encodeStateAsUpdate(h.doc!));
        assert.deepEqual(new CollaborationBlockTree(restored, editor.schema).read().toJSON(), editor.getJSON());
      } finally { restored.destroy(); }
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); peer.destroy(); h.destroy(); }
  }
});

test('the actual desktop and touch container menu follows peer edits and revokes old intents', async () => {
  const { MarkdownBlockMoveMenu } = await import('../app/components/editor/MarkdownBlockMoveMenu');
  for (const mobile of [false, true]) {
    const h = harness(true, '> AAA\n\nBBB\n\nCCC');
    const editor = h.mount();
    const replacement = h.mount();
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const render = async (current: Editor) => act(async () => root.render(
      <StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <MarkdownBlockMoveMenu editor={current} mobile={mobile} />
      </NextIntlClientProvider></StrictMode>));
    const open = async () => act(async () => {
      const button = container.querySelector('button')!;
      const event = mobile ? new dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })
        : new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      if (mobile) Object.defineProperty(event, 'pointerType', { value: 'touch' });
      button.dispatchEvent(event);
    });
    try {
      await Promise.resolve();
      editor.commands.setTextSelection(position(editor, 'paragraph', 'BBB') + 1);
      const source = captureBlockMoveSource(editor)!;
      const tree = new CollaborationBlockTree(h.doc!, editor.schema);
      const quoteId = editor.state.doc.firstChild!.attrs.id;
      await render(editor); await open();
      const option = () => document.querySelector<HTMLElement>(`[data-container-id="${quoteId}"]`)!;
      assert(option(), 'the real menu exposes compatible container destinations');
      await act(async () => {
        tree.move({ blockId: quoteId, parentId: null, beforeId: null, operationId: 'menu-peer-container' }, 'peer');
        tree.updateInlineContent(source.node.attrs.id, source.node.type.create(source.node.attrs, editor.schema.text('Peer BBB')), 'peer');
      });
      assert(option().textContent!.includes('3 · Quote'), 'destination path follows its current position');
      await act(async () => option().click());
      assert.equal(editor.state.doc.lastChild!.lastChild!.textContent, 'Peer BBB');
      await act(async () => { assert(editor.commands.undo()); });
      assert.equal(editor.state.doc.firstChild!.textContent, 'Peer BBB');
      await open();
      const old = option();
      await act(async () => { editor.setEditable(false); editor.setEditable(true); });
      assert.equal(document.querySelector('[role="menu"]'), null);
      const before = Y.encodeStateAsUpdate(h.doc!);
      await act(async () => old.click());
      assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), before);
      await open();
      await render(replacement); await render(editor);
      assert.equal(document.querySelector('[role="menu"]'), null);
      await act(async () => old.click());
      assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), before);
      await open();
      await act(async () => {
        editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
        editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
        await Promise.resolve();
      });
      assert.equal(document.querySelector('[role="menu"]'), null);
      await act(async () => old.click());
      assert.deepEqual(Y.encodeStateAsUpdate(h.doc!), before);
      assert.deepEqual(h.errors, []);
    } finally {
      await act(async () => root.unmount());
      editor.destroy(); replacement.destroy(); h.destroy(); container.remove();
    }
  }
});

for (const collaborative of [false, true]) test(`list body blocks can move into and back out of items while their first paragraph stays protected (collaborative=${collaborative})`, async () => {
  for (const fixture of [
    { markdown: '- AAA\n\n![Alt](image.png)\n\nCCC', type: 'image' },
    { markdown: '- AAA\n\n```ts\nBBB\n```\n\nCCC', type: 'codeBlock' },
    { markdown: '- AAA\n\nBBB\n\nCCC', type: 'paragraph', text: 'BBB' },
    { markdown: '- AAA\n\n> BBB\n\nCCC', type: 'blockquote' },
  ]) {
    const h = harness(collaborative, fixture.markdown);
    const editor = h.mount();
    try {
      await Promise.resolve();
      const from = position(editor, fixture.type, fixture.text);
      editor.commands.setNodeSelection(from);
      const captured = captureBlockMoveSource(editor)!;
      const destination = getBlockContainerOptions(editor, captured).find(option => option.type === 'listItem')!;
      const before = editor.getJSON();
      assert.equal(applyReorderableBlockMove(editor, captured, destination.target, { preserveSelection: true }).ok, true);
      const nested = captureBlockMoveSource(editor)!;
      assert.equal(nested.reference.id, captured.reference.id, 'the inserted block remains individually selectable');
      assert.equal(nested.kind, 'nested');
      assert.equal(moveBlockInDirection(editor, 'up', nested).ok, false, 'a move cannot precede the required first paragraph');
      const root = getBlockContainerOptions(editor, nested).find(option => option.type === 'doc')!;
      assert.equal(applyReorderableBlockMove(editor, nested, root.target, { preserveSelection: true }).ok, true);
      assert.deepEqual(editor.state.doc.lastChild!.toJSON(), captured.node.toJSON());
      assert.equal(editor.state.doc.firstChild!.firstChild!.childCount, 1);
      assert.equal(editor.state.doc.firstChild!.textContent, 'AAA');
      assert.equal(editor.commands.undo(), true);
      assert.equal(captureBlockMoveSource(editor)!.reference.id, captured.reference.id);
      assert.equal(editor.commands.undo(), true);
      assert.deepEqual(editor.getJSON(), before);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

test('offered container pairs retain the strict Markdown structure contract', async () => {
  const sources = ['BBB', '```ts\nBBB\n```', '![Alt](image.png)', '---', '| H |\n| --- |\n| BBB |',
    '> [!note] **Source**\n> **BBB** and `code` 👩🏽‍💻\n>\n> Second', '<details>\n<summary>Source</summary>\n\nBBB\n\n</details>', '- BBB', '[^source]: BBB', '$$\nx^2\n$$',
    '<img src="image.png" alt="Alt" width="120" height="90" style="display:block;max-width:100%;height:auto;margin-left:auto;margin-right:auto">'];
  const targets = [
    { markdown: '> AAA', type: 'blockquote' },
    { markdown: '> [!note] Target\n> AAA', type: 'canvasCallout' },
    { markdown: '<details>\n<summary>Target</summary>\n\nAAA\n\n</details>', type: 'canvasDetailsContent' },
    { markdown: '- AAA', type: 'listItem' },
    { markdown: '- [x] AAA', type: 'taskItem' },
    { markdown: '[^target]: AAA', type: 'markdownFootnoteDefinition' },
  ];
  const manager = createRichMarkdownManager();
  for (const sourceMarkdown of sources) for (const target of targets) {
    // A leading thematic break is ambiguous with YAML frontmatter; keep this
    // matrix about moving blocks inside an already editable Markdown body.
    const h = harness(false, `INTRO\n\n${sourceMarkdown}\n\nSEPARATOR\n\n${target.markdown}\n\nTAIL`);
    const editor = h.mount();
    try {
      await Promise.resolve();
      editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
      const source = captureBlockMoveSource(editor)!;
      const destination = getBlockContainerOptions(editor, source).find(option => option.type === target.type);
      assert(destination, `${source.node.type.name} → ${target.type} is an expected supported pair`);
      const before = editor.getJSON();
      const result = applyReorderableBlockMove(editor, source, destination.target, { preserveSelection: true });
      assert.equal(result.ok, true, `${source.node.type.name} → ${target.type} must not offer an invalid write`);
      const next = editor.getJSON();
      const markdown = manager.serialize(next);
      const reloaded = editor.schema.nodeFromJSON(manager.parse(markdown)).toJSON();
      assert(equivalentRichDocument(next, reloaded), `${source.node.type.name} → ${target.type} must retain its Markdown structure`);
      assert.equal(manager.serialize(reloaded), markdown, 'the serialized checkpoint is also a textual fixed point');
      assert.equal(editor.commands.undo(), true);
      assert.deepEqual(editor.getJSON(), before);
      assert.deepEqual(h.errors, []);
    } finally { editor.destroy(); h.destroy(); }
  }
});

for (const collaborative of [false, true]) test(`rejected container transactions cannot open Details, prune a wrapper or add history (collaborative=${collaborative})`, async () => {
  const h = harness(collaborative, '> BBB\n\n<details>\n<summary>Target</summary>\n\nAAA\n\n</details>');
  const editor = h.mount();
  try {
    await Promise.resolve();
    editor.registerPlugin(new Plugin({ filterTransaction: transaction => !transaction.getMeta(BLOCK_MOVE_TRANSACTION_META) }));
    await Promise.resolve();
    editor.commands.setTextSelection(position(editor, 'paragraph', 'BBB') + 1);
    const source = captureBlockMoveSource(editor)!;
    const destination = getBlockContainerOptions(editor, source).find(option => option.type === 'canvasDetailsContent')!;
    const before = editor.getJSON();
    const selection = editor.state.selection.toJSON();
    const durable = h.doc ? Y.encodeStateAsUpdate(h.doc) : h.local!.getSnapshot();
    assert.equal(applyReorderableBlockMove(editor, source, destination.target, { preserveSelection: true }).ok, false);
    assert.deepEqual(editor.getJSON(), before);
    assert.deepEqual(editor.state.selection.toJSON(), selection);
    assert.deepEqual(h.doc ? Y.encodeStateAsUpdate(h.doc) : h.local!.getSnapshot(), durable);
    assert.equal(editor.can().undo(), false);
    assert.deepEqual(h.errors, []);
  } finally { editor.destroy(); h.destroy(); }
});

test('nested Details balance real containers while preserving tag-looking code and following blocks', () => {
  const manager = createRichMarkdownManager();
  const schema = getSchema(richMarkdownCodecExtensions());
  for (const ending of ['\n', '\r\n']) for (const fence of ['```', '````', '~~~~']) {
    const literal = '</details>\n<details>\n' + (fence === '````' ? '```\n</details>\n' : '') + 'literal';
    const inner = `<details open>\n<summary>Inner</summary>\n\n${fence}txt\n${literal}\n${fence}\n\n</details>`;
    const outer = `<details>\n<summary>Outer</summary>\n\nBefore\n\n${inner}\n\nAfter\n\n</details>`.replaceAll('\n', ending);
    const token = parseDetailsBlock(outer + ending + ending + 'TAIL')!;
    assert(token);
    assert.equal(token.raw, outer + ending);
    assert.equal(token.open, false);
    assert.equal(token.summary, 'Outer');
    const json = schema.nodeFromJSON(manager.parse(outer + ending + ending + 'TAIL'));
    assert.equal(json.childCount, 2);
    assert.equal(json.lastChild!.textContent, 'TAIL');
    const body = json.firstChild!.child(1);
    assert.equal(body.childCount, 3);
    assert.equal(body.child(1).type.name, 'canvasDetails');
    assert.equal(body.child(1).child(1).firstChild!.textContent, literal);
    assert(equivalentRichDocument(json.toJSON(), schema.nodeFromJSON(manager.parse(manager.serialize(json.toJSON()))).toJSON()));
    assert.equal(parseDetailsBlock(outer.slice(0, outer.lastIndexOf('</details>'))), null, 'an inner closing tag cannot close an unfinished outer block');
  }
});
