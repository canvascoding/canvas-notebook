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
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';
import { createLocalMarkdownRichExtension, LOCAL_MARKDOWN_PROJECTION } from '../app/lib/editor/local-markdown-rich-binding';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { BLOCK_MOVE_TRANSACTION_META } from '../app/lib/editor/block-reference';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

function harness(collaborative: boolean, markdown = 'AAA\n\nBBB\n\nCCC') {
  const manager = createRichMarkdownManager();
  const local = collaborative ? null : new LocalMarkdownDocument(manager.serialize(manager.parse(markdown)));
  if (local) assert.ok(local.getSnapshot().richDocument, 'the fixture must be representable in the local rich view');
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
