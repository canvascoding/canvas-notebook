import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { prosemirrorToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';
import { createLocalMarkdownRichExtension, LOCAL_MARKDOWN_PROJECTION } from '../app/lib/editor/local-markdown-rich-binding';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { createEditorRangeTarget, invalidateEditorTarget } from '../app/lib/editor/interaction-target';
import { insertPreparedMarkdown, prepareMarkdownInsertion } from '../app/lib/editor/markdown-insertion';
import { MARKDOWN_RICH_TEXT_CHARACTER_LIMIT, TEXT_EDITOR_LONG_LINE_LIMIT, RUNAWAY_SLASH_SEQUENCE_LIMIT } from '../app/lib/editor/text-editor-guards';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

type Mode = 'local' | 'blocks' | 'xml' | 'standalone';
async function harness(mode: Mode, initial = '') {
  const manager = createRichMarkdownManager();
  const local = mode === 'local' ? new LocalMarkdownDocument(manager.serialize(manager.parse(initial))) : null;
  let document: Y.Doc | null = null;
  if (mode === 'blocks' || mode === 'xml') {
    const extensions = richMarkdownCodecExtensions();
    const parsed = manager.parse(initial);
    const json = parsed.content?.length ? parsed : { type: 'doc', content: [{ type: 'paragraph' }] };
    const node = getSchema(extensions).nodeFromJSON(generateRichNodeIds(json, extensions));
    if (mode === 'xml') document = prosemirrorToYDoc(node, 'body');
    else { document = new Y.Doc(); CollaborationBlockTree.create(document, node); }
  }
  const errors: Error[] = [];
  const element = dom.window.document.createElement('div');
  dom.window.document.body.append(element);
  const editor = new Editor({ element, content: mode === 'standalone' ? initial : undefined, contentType: 'markdown', extensions: [
    ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit' && mode !== 'standalone'
      ? extension.configure({ undoRedo: false }) : extension.name === 'uniqueID'
        ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (tr: Transaction) =>
          !isRemoteRichEditorTransaction(tr) && !tr.getMeta(LOCAL_MARKDOWN_PROJECTION) }) : extension),
    ...(document ? createRichEditorCollaborationExtensions({ document, representation: mode === 'xml' ? 'tiptap_xml' : 'tiptap_blocks', awareness: null,
      user: { name: 'Test', color: '#123456' }, onError: error => errors.push(error) })
      : local ? [createLocalMarkdownRichExtension({ document: local, onError: error => errors.push(error) })] : []),
  ] });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { editor, document, local, errors, mode, destroy() { editor.destroy(); document?.destroy(); element.remove(); } };
}

function prepared(markdown: string) {
  const result = prepareMarkdownInsertion(markdown);
  assert(result.ok, JSON.stringify(result));
  return result;
}

function ids(doc: ProseMirrorNode): string[] {
  const result: string[] = [];
  doc.descendants(node => { if (!node.isText) result.push(node.attrs.id); });
  assert(result.every(id => typeof id === 'string' && id));
  assert.equal(new Set(result).size, result.length);
  return result;
}

function verify(h: Awaited<ReturnType<typeof harness>>) {
  h.editor.state.doc.check(); ids(h.editor.state.doc); assert.deepEqual(h.errors, []);
  if (h.local) assert(h.editor.schema.nodeFromJSON(h.local.getSnapshot().richDocument!).eq(h.editor.state.doc));
  if (h.document) {
    const reopened = new Y.Doc();
    try {
      Y.applyUpdate(reopened, Y.encodeStateAsUpdate(h.document));
      const json = h.mode === 'xml' ? yDocToProsemirrorJSON(reopened, 'body')
        : new CollaborationBlockTree(reopened, h.editor.schema).read().toJSON();
      assert(h.editor.schema.nodeFromJSON(json).eq(h.editor.state.doc));
    } finally { reopened.destroy(); }
  }
}

test('preparation admits exact Markdown, exposes safe normalization, and rejects content loss or metadata changes', () => {
  assert.deepEqual(prepareMarkdownInsertion(' \n\t'), { ok: false, reason: 'empty' });
  assert.deepEqual(prepared('# Title\n\n**Bold** text').normalizations, []);
  assert.deepEqual(prepared('1. First\n\n2. Second\n').normalizations, ['ordered_list_spacing']);
  const metadata = '---\ntitle: Keep\n---\n\nText';
  assert.deepEqual(prepareMarkdownInsertion(metadata), { ok: false, reason: 'frontmatter' });
  assert.deepEqual(prepareMarkdownInsertion('---\ntitle: [\n---\n\nText'), { ok: false, reason: 'invalid_frontmatter' });
  assert.notEqual(prepareMarkdownInsertion(metadata, 'content').ok, true, 'content mode retains the existing codec roundtrip guard');
  assert.equal(prepareMarkdownInsertion('title: Keep', 'content').ok, true);
  for (const raw of ['<div>keep exactly</div>', '# Heading\n\n\n\nExtra', '<!-- _class: title -->\n\n# Slide']) {
    assert.equal(prepareMarkdownInsertion(raw).ok, false, raw);
  }
  assert.deepEqual(prepareMarkdownInsertion('x\n'.repeat(MARKDOWN_RICH_TEXT_CHARACTER_LIMIT)), { ok: false, reason: 'document_too_large' });
  assert.deepEqual(prepareMarkdownInsertion('x'.repeat(TEXT_EDITOR_LONG_LINE_LIMIT + 1)), { ok: false, reason: 'long_line' });
  assert.deepEqual(prepareMarkdownInsertion('/'.repeat(RUNAWAY_SLASH_SEQUENCE_LIMIT)), { ok: false, reason: 'unsafe_slash_run' });
});

for (const mode of ['local', 'blocks', 'standalone'] as const) {
  test(`${mode}: full Markdown inserts native blocks into an empty document with one content transaction and undo`, async () => {
    const h = await harness(mode);
    try {
      const before = h.editor.getJSON();
      const changes: Transaction[] = [];
      h.editor.on('transaction', ({ transaction }) => { if (transaction.docChanged) changes.push(transaction); });
      const markdown = '# Imported\n\nA **bold** paragraph.\n\n- First\n- Second\n\n| A | B |\n| --- | --- |\n| C | D |\n\n```ts\nconst x = 1;\n```';
      assert.deepEqual(insertPreparedMarkdown(h.editor, createEditorRangeTarget(h.editor), prepared(markdown)), { ok: true });
      assert.equal(changes.length, 1);
      assert.equal(changes[0].getMeta('uiEvent'), 'paste');
      assert.deepEqual(h.editor.state.doc.content.content.map(node => node.type.name), ['heading', 'paragraph', 'bulletList', 'table', 'codeBlock', 'paragraph']);
      assert.equal(h.editor.state.doc.lastChild!.textContent, '', 'native editing retains its structural trailing paragraph');
      verify(h);
      const after = h.editor.getJSON();
      assert(h.editor.commands.undo()); assert.deepEqual(h.editor.getJSON(), before);
      assert.equal(h.editor.can().undo(), false);
      assert(h.editor.commands.redo()); assert.deepEqual(h.editor.getJSON(), after);
      verify(h);
    } finally { h.destroy(); }
  });

  test(`${mode}: selected text and middle/end block insertion preserve untouched IDs and isolate adjacent typing`, async () => {
    const h = await harness(mode, 'Start TARGET end\n\nKeep');
    try {
      const editor = h.editor;
      const originalIds = ids(editor.state.doc);
      editor.commands.setTextSelection({ from: 7, to: 13 });
      assert.deepEqual(insertPreparedMarkdown(editor, createEditorRangeTarget(editor), prepared('**New**')), { ok: true });
      assert.equal(editor.state.doc.firstChild!.textContent, 'Start New end');
      assert.equal(editor.state.doc.firstChild!.content.child(1).marks[0].type.name, 'bold');
      assert.deepEqual(ids(editor.state.doc), originalIds);
      editor.commands.setTextSelection(6);
      editor.view.dispatch(editor.state.tr.insertText('x'));
      const typedBefore = editor.getJSON();
      assert.deepEqual(insertPreparedMarkdown(editor, createEditorRangeTarget(editor), prepared('## Inserted\n\nNew paragraph')), { ok: true });
      const inserted = editor.getJSON();
      assert(editor.state.doc.content.content.some(node => node.type.name === 'heading' && node.textContent === 'Inserted'));
      assert.equal(editor.state.doc.lastChild!.attrs.id, originalIds.at(-1));
      assert.equal(editor.state.doc.textContent, 'StartxInsertedNew paragraph New endKeep');
      editor.view.dispatch(editor.state.tr.insertText('y'));
      assert(editor.commands.undo()); assert.deepEqual(editor.getJSON(), inserted, 'first undo removes later typing only');
      assert(editor.commands.undo()); assert.deepEqual(editor.getJSON(), typedBefore, 'one undo removes the whole Markdown insertion');
      assert(editor.commands.undo()); assert.equal(editor.state.doc.firstChild!.textContent, 'Start New end', 'earlier typing remains a distinct action');
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      assert.deepEqual(insertPreparedMarkdown(editor, createEditorRangeTarget(editor), prepared('First appended\n\nSecond appended')), { ok: true });
      assert(editor.state.doc.textContent.endsWith('KeepFirst appendedSecond appended'));
      verify(h);
    } finally { h.destroy(); }
  });
}

test('legacy XML rejects Markdown insertion without changing its content or undo history', async () => {
  const h = await harness('xml', 'Keep');
  try {
    const before = h.editor.getJSON();
    assert.deepEqual(insertPreparedMarkdown(h.editor, createEditorRangeTarget(h.editor), prepared('# Imported\n\nBody')),
      { ok: false, reason: 'invalid_content' });
    assert.deepEqual(h.editor.getJSON(), before);
    assert.equal(h.editor.can().undo(), false);
    verify(h);
  } finally { h.destroy(); }
});

test('Yjs target follows unrelated peer changes but rejects edits to the captured selection', async () => {
  const h = await harness('blocks', 'Alpha\n\nTARGET\n\nOmega');
  try {
    const editor = h.editor;
    const tree = new CollaborationBlockTree(h.document!, editor.schema);
    const first = editor.state.doc.firstChild!;
    editor.commands.setTextSelection({ from: first.nodeSize + 1, to: first.nodeSize + 7 });
    const target = createEditorRangeTarget(editor);
    tree.updateInlineContent(first.attrs.id, first.type.create(first.attrs, editor.schema.text('Peer Alpha')), 'peer');
    assert.deepEqual(insertPreparedMarkdown(editor, target, prepared('**Inserted**')), { ok: true });
    assert.equal(editor.state.doc.firstChild!.textContent, 'Peer Alpha');
    assert(editor.commands.undo());
    assert.equal(editor.state.doc.textContent, 'Peer AlphaTARGETOmega');
    const middle = editor.state.doc.child(1);
    const position = editor.state.doc.firstChild!.nodeSize + 1;
    editor.commands.setTextSelection({ from: position, to: position + 6 });
    const stale = createEditorRangeTarget(editor);
    tree.updateInlineContent(middle.attrs.id, middle.type.create(middle.attrs, editor.schema.text('Peer changed target')), 'peer');
    const before = editor.getJSON();
    assert.deepEqual(insertPreparedMarkdown(editor, stale, prepared('Overwrite')), { ok: false, reason: 'target_changed' });
    assert.deepEqual(editor.getJSON(), before); verify(h);
  } finally { h.destroy(); }
});

test('invalid fitting and expired editor capabilities leave both document and history unchanged', async () => {
  const h = await harness('blocks', '```\ncode\n```\n\nKeep');
  const other = await harness('blocks', 'Other');
  try {
    h.editor.commands.setTextSelection(2);
    const target = createEditorRangeTarget(h.editor);
    const before = h.editor.getJSON();
    assert.deepEqual(insertPreparedMarkdown(h.editor, target, prepared('**bold**')), { ok: false, reason: 'invalid_content' });
    assert.deepEqual(h.editor.getJSON(), before);
    assert.equal(h.editor.can().undo(), false);
    assert.deepEqual(insertPreparedMarkdown(other.editor, target, prepared('Text')), { ok: false, reason: 'target_changed' });
    h.editor.setEditable(false);
    assert.deepEqual(insertPreparedMarkdown(h.editor, target, prepared('Text')), { ok: false, reason: 'target_changed' });
    h.editor.setEditable(true);
    invalidateEditorTarget(target);
    assert.deepEqual(insertPreparedMarkdown(h.editor, target, prepared('Text')), { ok: false, reason: 'target_changed' });
    const live = createEditorRangeTarget(h.editor);
    h.editor.destroy();
    assert.deepEqual(insertPreparedMarkdown(h.editor, live, prepared('Text')), { ok: false, reason: 'target_changed' });
    assert.equal(other.editor.state.doc.textContent, 'Other');
  } finally { h.destroy(); other.destroy(); }
});
