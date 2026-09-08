import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';
import { createLocalMarkdownSourceBinding } from '../app/lib/editor/local-markdown-source-binding';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}

function mount(document: LocalMarkdownDocument, extras: Extension[] = []) {
  const binding = createLocalMarkdownSourceBinding(document);
  const editor = new EditorView({ parent: dom.window.document.body,
    state: EditorState.create({ doc: document.getSnapshot().markdown,
      extensions: [EditorState.allowMultipleSelections.of(true), ...binding.extensions, ...extras] }),
    dispatchTransactions: binding.dispatchTransactions,
  });
  return { editor, ...binding };
}
const original = 'AAA\n\nBBB\n\nCCC\n';

test('CodeMirror typing and selection boundaries share history across view replacements', async () => {
  const document = new LocalMarkdownDocument(original);
  let source = mount(document);
  try {
    await Promise.resolve();
    source.editor.dispatch({ selection: { anchor: 8 } });
    source.editor.dispatch({ ...source.editor.state.replaceSelection('x'), annotations: Transaction.userEvent.of('input.type') });
    source.editor.dispatch({ ...source.editor.state.replaceSelection('y'), annotations: Transaction.userEvent.of('input.type') });
    assert.equal(document.getSnapshot().markdown, original.replace('BBB', 'BBBxy'));
    source.editor.dispatch({ selection: { anchor: 0 } });
    source.editor.dispatch({ ...source.editor.state.replaceSelection('Start '), annotations: Transaction.userEvent.of('input.type') });
    const cursor = source.editor.state.selection.toJSON();
    source.editor.destroy(); source = mount(document);
    await Promise.resolve();
    assert.deepEqual(source.editor.state.selection.toJSON(), cursor);
    assert(source.undo(source.editor));
    assert.equal(source.editor.state.doc.toString(), original.replace('BBB', 'BBBxy'));
    assert.equal(source.editor.state.selection.main.anchor, 0);
    assert(source.undo(source.editor));
    assert.equal(source.editor.state.doc.toString(), original);
    assert.equal(source.editor.state.selection.main.anchor, 8);
    assert(source.redo(source.editor)); assert(source.redo(source.editor));
    assert.equal(source.editor.state.doc.toString(), 'Start ' + original.replace('BBB', 'BBBxy'));
  } finally { source.editor.destroy(); }
});

test('raw source retains mixed line endings, opaque syntax, and multiple cursors through undo', async () => {
  const original = '---\r\ninvalid: [\n---\r\n\r\n<Custom />\n';
  const document = new LocalMarkdownDocument(original);
  const source = mount(document);
  try {
    await Promise.resolve();
    assert.equal(source.editor.state.doc.toString(), original);
    source.editor.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.range(10, 8)], 1) });
    const selection = source.editor.state.selection.toJSON();
    source.editor.dispatch(source.editor.state.replaceSelection('😀'));
    const edited = source.editor.state.doc.toString();
    assert.equal(document.getSnapshot().markdown, edited);
    assert.equal(document.getSnapshot().richDocument, null);
    assert(source.undo(source.editor));
    assert.equal(source.editor.state.doc.toString(), original);
    assert.deepEqual(source.editor.state.selection.toJSON(), selection);
    assert(source.redo(source.editor));
    assert.equal(source.editor.state.doc.toString(), edited);
    const escaped = document.getSourceSelection()!;
    escaped.ranges![0].anchor = 999;
    assert.notEqual(document.getSourceSelection()!.ranges![0].anchor, 999);
  } finally { source.editor.destroy(); }
});

test('revoked and stale prebuilt transactions never reach the view or its update callbacks', async () => {
  const document = new LocalMarkdownDocument(original);
  const updates: string[] = [];
  const source = mount(document, [EditorView.updateListener.of((update) => {
    if (update.docChanged) updates.push(update.state.doc.toString());
  })]);
  await Promise.resolve();
  const stale = source.editor.state.update({ changes: { from: 0, insert: 'STALE ' } });
  const next = mount(document);
  try {
    await Promise.resolve();
    source.editor.dispatch(stale);
    assert.equal(source.editor.state.doc.toString(), original);
    assert.equal(document.getSnapshot().markdown, original);
    assert.deepEqual(updates, []);
    source.editor.destroy();
    next.editor.dispatch({ changes: { from: 0, insert: 'Current ' } });
    const externalStale = next.editor.state.update({ changes: { from: 0, insert: 'LATE ' } });
    document.replaceExternal('Replacement\n');
    next.editor.dispatch(externalStale);
    assert.equal(next.editor.state.doc.toString(), 'Replacement\n');
    assert.equal(next.undo(next.editor), false);
  } finally { source.editor.destroy(); next.editor.destroy(); }
});

test('readonly reconfiguration keeps history and denies even prebuilt content transactions', async () => {
  const document = new LocalMarkdownDocument(original);
  const permission = new Compartment();
  const source = mount(document, [permission.of(EditorState.readOnly.of(false))]);
  try {
    await Promise.resolve();
    source.editor.dispatch({ changes: { from: 0, insert: 'Before ' } });
    const changed = source.editor.state.doc.toString();
    source.editor.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(true)) });
    source.editor.dispatch({ changes: { from: 0, insert: 'FORBIDDEN ' } });
    assert.equal(source.editor.state.doc.toString(), changed);
    assert.equal(source.undo(source.editor), false);
    source.editor.dispatch({ effects: permission.reconfigure(EditorState.readOnly.of(false)) });
    assert(source.undo(source.editor));
    assert.equal(source.editor.state.doc.toString(), original);
  } finally { source.editor.destroy(); }
});

test('source undo and redo traverse earlier rich changes and return their original raw source', async () => {
  const document = new LocalMarkdownDocument(original);
  const rich = document.openView('rich', () => true);
  const before = document.getSnapshot().richDocument!;
  const after = structuredClone(before); after.content![1].content![0].text = 'Rich change';
  assert(rich.changeRich({ revision: 0, before, after, beforeSelection: { type: 'text', anchor: 6, head: 9 }, afterSelection: { type: 'text', anchor: 17, head: 17 } }));
  rich.release();
  const source = mount(document);
  try {
    await Promise.resolve();
    source.editor.dispatch({ changes: { from: 0, insert: 'Source ' } });
    assert(source.undo(source.editor)); assert(source.undo(source.editor));
    assert.equal(source.editor.state.doc.toString(), original);
    assert(source.redo(source.editor)); assert(source.redo(source.editor));
    assert.equal(source.editor.state.doc.toString(), 'Source ' + original.replace('BBB', 'Rich change'));
  } finally { source.editor.destroy(); }
});
