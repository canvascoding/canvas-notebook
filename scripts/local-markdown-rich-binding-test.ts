import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, Extension } from '@tiptap/core';
import { Plugin, type Transaction } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';
import { createLocalMarkdownRichExtension, LOCAL_MARKDOWN_PROJECTION, updateLocalMarkdownMetadata } from '../app/lib/editor/local-markdown-rich-binding';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';
import { moveMarkdownTablePart } from '../app/lib/markdown/core/table-commands';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
function mount(document: LocalMarkdownDocument, errors: Error[], extras: Extension[] = []) {
  return new Editor({ extensions: [
    ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction: Transaction) => !transaction.getMeta(LOCAL_MARKDOWN_PROJECTION) }) : extension),
    createLocalMarkdownRichExtension({ document, onError: (error) => errors.push(error) }), ...extras,
  ] });
}
const original = 'AAA\n\nBBB\n\nCCC\n';
const texts = (editor: Editor) => editor.state.doc.content.content.map((node) => node.textContent);

test('real Tiptap typing, block movement and exact selection survive a destroyed view', async () => {
  const document = new LocalMarkdownDocument(original);
  const errors: Error[] = [];
  let editor = mount(document, errors);
  try {
    await Promise.resolve();
    const initial = editor.getJSON();
    editor.commands.setTextSelection(9);
    editor.view.dispatch(editor.state.tr.insertText('x'));
    await Promise.resolve();
    editor.view.dispatch(editor.state.tr.insertText('y'));
    assert.equal(document.getSnapshot().markdown, 'AAA\n\nBBBxy\n\nCCC\n');
    const block = getReorderableBlockRangeAt(editor, 6)!;
    assert(moveReorderableBlock(editor, block, 0));
    assert.deepEqual(texts(editor), ['BBBxy', 'AAA', 'CCC']);
    const moved = editor.getJSON();
    editor.destroy(); editor = mount(document, errors);
    await Promise.resolve();
    assert.deepEqual(editor.getJSON(), moved);
    assert(editor.can().undo());
    assert.deepEqual(editor.getJSON(), moved, 'dry-run command must not change content');
    assert(editor.commands.undo());
    assert.deepEqual(texts(editor), ['AAA', 'BBBxy', 'CCC']);
    assert(editor.commands.undo());
    assert.deepEqual(editor.getJSON(), initial);
    assert.equal(editor.state.selection.from, 9);
    assert.equal(editor.can().undo(), false);
    assert(editor.commands.redo()); assert(editor.commands.redo());
    assert.deepEqual(editor.getJSON(), moved);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); }
});

test('source edits and metadata use the same real editor history without stale body replacement', async () => {
  const document = new LocalMarkdownDocument('---\ntitle: First\n---\n\n' + original);
  const errors: Error[] = [];
  let editor = mount(document, errors);
  try {
    await Promise.resolve();
    const oldDraft = document.getSnapshot().markdown;
    editor.commands.setTextSelection(9); editor.view.dispatch(editor.state.tr.insertText('x'));
    assert(updateLocalMarkdownMetadata(editor, oldDraft.replace('First', 'Second')));
    assert.equal(document.getSnapshot().markdown, oldDraft.replace('First', 'Second').replace('BBB', 'BBBx'));
    editor.destroy();
    const source = document.openView('source', () => true);
    const before = document.getSnapshot();
    assert(source.changeSource({ revision: before.revision, markdown: before.markdown.replace('CCC', 'Last'),
      beforeSelection: { anchor: 0, head: 0 }, afterSelection: { anchor: 0, head: 0 } }));
    source.release(); editor = mount(document, errors);
    await Promise.resolve();
    assert.deepEqual(texts(editor), ['AAA', 'BBBx', 'Last']);
    assert(editor.commands.undo()); assert(editor.commands.undo()); assert(editor.commands.undo());
    assert.equal(document.getSnapshot().markdown, oldDraft);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); }
});

test('table geometry, cell selections and undo stay exact across projection and remount', async () => {
  const manager = createRichMarkdownManager();
  const initial = manager.serialize(manager.parse('| A | B |\n| --- | --- |\n| one | two |\n')) + '\n';
  const document = new LocalMarkdownDocument(initial);
  const errors: Error[] = [];
  let editor = mount(document, errors);
  try {
    await Promise.resolve();
    const cells: number[] = [];
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'tableCell') cells.push(pos); });
    assert.equal(cells.length, 2);
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[1])));
    const selected = editor.state.selection.toJSON();
    assert(editor.commands.command((props) => moveMarkdownTablePart(props, 'column', -1)));
    const moved = editor.getJSON();
    editor.destroy(); editor = mount(document, errors);
    await Promise.resolve();
    assert.deepEqual(editor.getJSON(), moved);
    assert(editor.commands.undo());
    assert.deepEqual(editor.state.selection.toJSON(), selected);
    assert.equal(document.getSnapshot().markdown, initial);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); }
});

test('old views and readonly transitions cannot edit or consume history', async () => {
  const document = new LocalMarkdownDocument(original);
  const errors: Error[] = [];
  const old = mount(document, errors);
  await Promise.resolve();
  const editor = mount(document, errors);
  try {
    await Promise.resolve();
    old.commands.insertContent('STALE');
    assert.equal(document.getSnapshot().markdown, original);
    assert.deepEqual(texts(old), ['AAA', 'BBB', 'CCC']);
    old.destroy();
    editor.commands.setTextSelection(4); editor.view.dispatch(editor.state.tr.insertText('x'));
    const changed = document.getSnapshot();
    editor.setEditable(false);
    assert.equal(editor.commands.undo(), false);
    editor.commands.insertContent('FORBIDDEN');
    assert.equal(document.getSnapshot(), changed);
    editor.setEditable(true); assert(editor.commands.undo());
    assert.equal(document.getSnapshot().markdown, original);
    assert.deepEqual(errors, []);
  } finally { old.destroy(); editor.destroy(); }
});

test('focus and authoritative projections never acquire view-only appended content', async () => {
  const appender = Extension.create({ name: 'maliciousAppender', addProseMirrorPlugins: () => [new Plugin({
    appendTransaction(transactions, _before, after) {
      if (transactions.some((transaction) => transaction.getMeta('probe') || transaction.getMeta(LOCAL_MARKDOWN_PROJECTION))) {
        return after.tr.insertText('WRONG', 1);
      }
    },
  })] });
  const document = new LocalMarkdownDocument(original);
  const errors: Error[] = [];
  const editor = mount(document, errors, [appender]);
  try {
    await Promise.resolve();
    editor.view.dispatch(editor.state.tr.setMeta('probe', true));
    assert.equal(document.getSnapshot().markdown, original);
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    document.replaceExternal('External\n');
    assert.deepEqual(texts(editor), ['External']);
    assert.equal(editor.can().undo(), false);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); }
});

test('composition stays one history item across long input intervals and forbids moves until completion', async () => {
  const document = new LocalMarkdownDocument(original);
  const errors: Error[] = [];
  const editor = mount(document, errors);
  try {
    await Promise.resolve();
    editor.commands.setTextSelection(9);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText('x').setTime(1000));
    editor.view.dispatch(editor.state.tr.insertText('y').setTime(9000));
    assert.equal(editor.commands.undo(), false);
    const block = getReorderableBlockRangeAt(editor, 6)!;
    moveReorderableBlock(editor, block, 0);
    assert.deepEqual(texts(editor), ['AAA', 'BBBxy', 'CCC']);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    assert(editor.commands.undo());
    assert.equal(document.getSnapshot().markdown, original);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); }
});
