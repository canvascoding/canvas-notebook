import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, getSchema, type Range } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import * as Y from 'yjs';

import { useEditorRangeTarget } from '../app/hooks/use-editor-range-target';
import { useEditorToolbarTarget } from '../app/hooks/use-editor-toolbar-target';
import { useEditorAsyncAction } from '../app/hooks/use-editor-async-action';
import { MarkdownUrlPaste, type PastedMarkdownLink } from '../app/components/editor/MarkdownUrlPaste';
import { resolveEditorRangeTarget } from '../app/lib/editor/interaction-target';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const extensions = richMarkdownCodecExtensions();
  const doc = new Y.Doc();
  CollaborationBlockTree.create(doc, getSchema(extensions).nodeFromJSON(generateUniqueIds(
    createRichMarkdownManager().parse('AAA\n\nBBB\n\nCCC'), extensions,
  )));
  const errors: Error[] = [];
  const createEditor = () => new Editor({ extensions: [
    ...extensions.map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (tr) => !isRemoteRichEditorTransaction(tr) }) : extension),
    ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: null,
      user: { name: 'Test', color: '#123456' }, onError: (error) => errors.push(error) }),
  ] });
  const a = createEditor();
  const b = createEditor();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let resolve: () => Range | null = () => null;
  function Probe({ editor, open }: { editor: Editor; open: boolean }) {
    const target = useEditorRangeTarget(editor, open);
    const status = useEditorState({ editor, selector: ({ editor: current }) => `${current.can().undo()}:${current.can().redo()}` });
    useEffect(() => { resolve = target; }, [target]);
    return <output>{status}</output>;
  }
  const render = (editor: Editor, open: boolean) => root.render(<StrictMode><Probe editor={editor} open={open} /></StrictMode>);
  let unmounted = false;
  try {
    await Promise.resolve();
    a.commands.setTextSelection(6);
    await act(async () => { render(a, true); });
    assert.equal(container.textContent, 'false:false');
    await act(async () => { b.view.dispatch(b.state.tr.insertText('X', 1)); });
    assert.equal(container.textContent, 'true:false', 'another mounted view refreshes its undo toolbar after the shared capture');
    await act(async () => { a.commands.undo(); });
    assert.equal(container.textContent, 'false:true');
    a.commands.setTextSelection(6);
    const retained = resolve;
    assert.ok(retained(), 'StrictMode cleanup does not invalidate the live dialog');
    await act(async () => { render(a, false); });
    assert.equal(retained(), null);
    await act(async () => { render(a, true); });
    assert.ok(retained());
    await act(async () => { render(b, true); });
    assert.equal(retained(), null, 'an old callback cannot act through a still-live old editor');
    assert.equal(resolve(), null, 'the old draft never acquires the new editor target');
    await act(async () => { root.unmount(); });
    unmounted = true;
    assert.equal(resolve(), null);
    const pasteRoot = createRoot(container);
    let captured: PastedMarkdownLink | undefined;
    document.body.append(a.view.dom);
    try {
      await act(async () => pasteRoot.render(<MarkdownUrlPaste editor={a} renderDialog={(link) => {
        captured = link;
        return <output>{link.href}</output>;
      }} />));
      a.view.focus();
      a.commands.setTextSelection({ from: 6, to: 9 });
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => 'https://example.com' } });
      await act(async () => { a.view.dom.dispatchEvent(event); });
      const link = captured as PastedMarkdownLink | undefined;
      assert.ok(link);
      assert.equal(event.defaultPrevented, true);
      assert.equal(link.text, 'BBB');
      const tree = new CollaborationBlockTree(doc, a.schema);
      tree.move({ blockId: tree.read().child(1).attrs.id, parentId: null, beforeId: null, operationId: 'move-pasted-link' }, 'peer');
      assert.deepEqual(resolveEditorRangeTarget(a, link.target), { from: 11, to: 14 });
    } finally { await act(async () => pasteRoot.unmount()); }
    await toolbarLifecycle(a, b, doc, container);
    await asyncActionLifecycle(a, b, container);
    assert.deepEqual(errors, []);
    console.log('Dialog lifecycle: StrictMode, close, editor replacement, retained callbacks and URL-paste target capture passed.');
  } finally {
    if (!unmounted) await act(async () => { root.unmount(); });
    a.destroy(); b.destroy(); doc.destroy(); container.remove(); dom.window.close();
  }
}

async function toolbarLifecycle(a: Editor, b: Editor, doc: Y.Doc, container: HTMLElement) {
  const root = createRoot(container);
  let controls: ReturnType<typeof useEditorToolbarTarget> | undefined;
  function Toolbar({ editor }: { editor: Editor }) {
    const target = useEditorToolbarTarget(editor);
    useEffect(() => { controls = target; }, [target]);
    return null;
  }
  let unmounted = false;
  try {
    a.commands.setTextSelection({ from: 11, to: 14 });
    await act(async () => root.render(<StrictMode><Toolbar editor={a} /></StrictMode>));
    const retained = controls!;
    retained.hold();
    const tree = new CollaborationBlockTree(doc, a.schema);
    const id = tree.read().child(2).attrs.id;
    tree.move({ blockId: id, parentId: null, beforeId: tree.read().child(0).attrs.id, operationId: 'toolbar-move' }, 'peer');
    retained.hold(); // A sheet tile's second press must not recapture a mapped selection.
    assert.deepEqual(retained.restore(), { from: 1, to: 4 });
    assert.equal(a.state.doc.textBetween(a.state.selection.from, a.state.selection.to), 'BBB');
    (tree.content(id).get(0) as Y.XmlText).insert(1, 'NEW');
    assert.equal(retained.restore(), null, 'a transaction does not replace the held target with changed text');
    retained.release();
    a.commands.setTextSelection(2);
    retained.hold();
    a.setEditable(false);
    assert.equal(retained.restore(), null);
    a.setEditable(true);
    assert.deepEqual(retained.restore(), { from: 2, to: 2 });
    a.commands.deleteRange({ from: 0, to: a.state.doc.child(0).nodeSize });
    assert.equal(retained.restore(), null, 'deleting the held block never falls back to its neighbour');
    await act(async () => root.render(<StrictMode><Toolbar editor={b} /></StrictMode>));
    assert.equal(retained.restore(), null, 'the previous view cannot dispatch through its retained toolbar callback');
    const latest = controls!;
    await act(async () => root.unmount());
    unmounted = true;
    assert.equal(latest.restore(), null);
    console.log('Toolbar target: move, second press, changed text, read-only, deletion and retained view callbacks passed.');
  } finally { if (!unmounted) await act(async () => root.unmount()); }
}

async function asyncActionLifecycle(a: Editor, b: Editor, container: HTMLElement) {
  const root = createRoot(container);
  let controls: ReturnType<typeof useEditorAsyncAction> | undefined;
  function Import({ editor, open }: { editor: Editor; open: boolean }) {
    const action = useEditorAsyncAction(editor, open);
    useEffect(() => { controls = action; }, [action]);
    return null;
  }
  const render = (editor: Editor, open: boolean) => act(async () => root.render(<StrictMode><Import editor={editor} open={open} /></StrictMode>));
  let unmounted = false;
  try {
    await render(a, true);
    const original = controls!;
    const first = original.begin()!;
    assert.ok(first);
    assert.equal(original.begin(), null, 'double submit has exactly one request');
    original.finish(first);
    const second = original.begin()!;
    assert.equal(original.isCurrent(first), false, 'a completed response cannot settle its successor');
    original.finish(first);
    assert.equal(original.isCurrent(second), true);
    original.cancel();
    assert.equal(second.signal.aborted, true);
    assert.equal(original.isCurrent(second), false);
    await render(a, false);
    await render(a, true);
    assert.equal(original.begin(), null, 'an old dialog callback cannot start work in a reopened dialog');
    const reopened = controls!;
    const pending = reopened.begin()!;
    let respond!: () => void;
    const response = new Promise<void>((resolve) => { respond = resolve; });
    let inserted = false;
    const late = response.then(() => { if (reopened.isCurrent(pending)) inserted = true; });
    await render(b, true);
    assert.equal(pending.signal.aborted, true);
    respond(); await late;
    assert.equal(inserted, false, 'a transport ignoring abort cannot complete through an old editor');
    const latest = controls!;
    const unmounting = latest.begin()!;
    await act(async () => root.unmount()); unmounted = true;
    assert.equal(unmounting.signal.aborted, true);
    assert.equal(latest.isCurrent(unmounting), false);
    assert.equal(latest.begin(), null);
    console.log('Async editor action: duplicate submit, retry, cancellation, reopen, late response and unmount passed.');
  } finally { if (!unmounted) await act(async () => root.unmount()); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
