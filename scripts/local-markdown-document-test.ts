import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JSONContent } from '@tiptap/core';

import { LocalMarkdownDocument, type LocalMarkdownView } from '../app/lib/editor/local-markdown-document';

const original = 'AAA\n\nBBB\n\nCCC\n';
const textSelection = (anchor: number, head = anchor) => ({ type: 'text', anchor, head });
const rich = (document: LocalMarkdownDocument) => {
  const value = document.getSnapshot().richDocument;
  assert(value);
  return structuredClone(value);
};
const ids = (json: JSONContent) => json.content!.map((node) => node.attrs!.id);
const edit = (document: LocalMarkdownDocument, view: LocalMarkdownView, after: JSONContent, before = 9, caret = 10, group: string | null = null) => {
  const snapshot = document.getSnapshot();
  return view.changeRich({ revision: snapshot.revision, before: snapshot.richDocument!, after,
    beforeSelection: textSelection(before), afterSelection: textSelection(caret), group });
};

test('local rich text and moves keep identities and undo across replaced views', () => {
  const document = new LocalMarkdownDocument(original);
  const initial = rich(document);
  const first = document.openView('rich', () => true);
  const changed = rich(document); changed.content![1].content![0].text = 'BBBx';
  assert(edit(document, first, changed, 9, 10, 'typing'));
  const moved = rich(document); moved.content = [moved.content![1], moved.content![0], moved.content![2]];
  assert(edit(document, first, moved, 10, 5));
  assert.equal(document.getSnapshot().markdown, 'BBBx\n\nAAA\n\nCCC\n');
  const second = document.openView('rich', () => true);
  first.release();
  assert.equal(first.history('undo'), false);
  assert(second.history('undo', false));
  assert.equal(document.getSnapshot().markdown, 'BBBx\n\nAAA\n\nCCC\n', 'availability checks do not mutate');
  assert(second.history('undo'));
  assert.equal(document.getSnapshot().markdown, 'AAA\n\nBBBx\n\nCCC\n');
  assert.deepEqual(ids(rich(document)), ids(initial));
  assert.deepEqual(document.getRichSelection(), textSelection(10));
  assert(second.history('undo'));
  assert.equal(document.getSnapshot().markdown, original);
  assert.deepEqual(document.getRichSelection(), textSelection(9));
  assert(second.history('redo'));
  assert(second.history('redo'));
  assert.deepEqual(ids(rich(document)), [ids(initial)[1], ids(initial)[0], ids(initial)[2]]);
});

test('one history spans rich edits, source changes and frontmatter without losing final line endings', () => {
  const initial = '---\ntitle: Before\n---\n\n' + original;
  const document = new LocalMarkdownDocument(initial);
  const richView = document.openView('rich', () => true);
  const changed = rich(document); changed.content![1].content![0].text = 'NEW';
  assert(edit(document, richView, changed, 6, 9));
  const beforeSource = document.getSnapshot();
  const sourceView = document.openView('source', () => true);
  const next = beforeSource.markdown.replace('Before', 'After').replace('CCC', 'ZZZ');
  assert(sourceView.changeSource({ revision: beforeSource.revision, markdown: next,
    beforeSelection: { anchor: 11, head: 17 }, afterSelection: { anchor: 16, head: 16 } }));
  const sourceIds = ids(rich(document));
  assert.deepEqual(sourceIds, ids(changed));
  assert.equal(richView.history('undo'), false, 'the old rich view is revoked');
  assert(sourceView.history('undo'));
  assert.equal(document.getSnapshot().markdown, beforeSource.markdown);
  assert.deepEqual(document.getSourceSelection(), { anchor: 11, head: 17 });
  assert(sourceView.history('undo'));
  assert.equal(document.getSnapshot().markdown, initial);
  const reopened = document.openView('rich', () => true);
  assert(reopened.history('redo'));
  assert(reopened.history('redo'));
  assert.equal(document.getSnapshot().markdown, next);
  assert.deepEqual(ids(rich(document)), sourceIds);
});

test('unrepresentable source remains verbatim and its history restores the earlier rich blocks', () => {
  const document = new LocalMarkdownDocument(original);
  const initial = rich(document);
  const view = document.openView('source', () => true);
  const opaque = '---\ninvalid: [\n---\n\n  <Custom value={1} />\n\n';
  assert(view.changeSource({ revision: 0, markdown: opaque,
    beforeSelection: { anchor: 0, head: original.length }, afterSelection: { anchor: opaque.length, head: opaque.length } }));
  assert.equal(document.getSnapshot().markdown, opaque);
  assert.equal(document.getSnapshot().richDocument, null);
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, original);
  assert.deepEqual(rich(document), initial);
  assert(view.history('redo'));
  assert.equal(document.getSnapshot().markdown, opaque);
  assert.equal(document.getSnapshot().richDocument, null);
  const corrected = original.replace('BBB', 'Edited');
  assert(view.changeSource({ revision: document.getSnapshot().revision, markdown: corrected,
    beforeSelection: { anchor: 0, head: opaque.length }, afterSelection: { anchor: corrected.length, head: corrected.length } }));
  assert.deepEqual(ids(rich(document)), ids(initial));
  assert.equal(document.getSnapshot().markdown, corrected);
});

test('source typing groups span opaque intermediate values but stop on pause, selection and mode boundaries', () => {
  const start = '---\ninvalid: [\n---\n';
  const document = new LocalMarkdownDocument(start);
  let view = document.openView('source', () => true);
  const type = (text: string, time: number) => {
    const before = document.getSnapshot(); const next = before.markdown + text;
    assert(view.changeSource({ revision: before.revision, markdown: next, group: 'typing', time,
      beforeSelection: { anchor: before.markdown.length, head: before.markdown.length },
      afterSelection: { anchor: next.length, head: next.length } }));
  };
  type('A', 1000); type('B', 1100);
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, start);
  assert(view.history('redo'));
  type('C', 1700); type('D', 2300);
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, start + 'ABC');
  view.setSourceSelection({ anchor: 0, head: 0 });
  type('E', 2400);
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, start + 'ABC');
  view.release(); view = document.openView('source', () => true);
  type('F', 2450);
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, start + 'ABC');
});

test('stale revisions, read-only transitions and external replacements cannot replay an obsolete local edit', () => {
  const document = new LocalMarkdownDocument(original);
  let writable = true;
  const view = document.openView('source', () => writable);
  const stale = { revision: 0, markdown: original + 'x', beforeSelection: { anchor: original.length, head: original.length },
    afterSelection: { anchor: original.length + 1, head: original.length + 1 } };
  assert(view.changeSource(stale));
  const changed = document.getSnapshot();
  writable = false;
  assert.equal(view.history('undo'), false);
  assert.equal(view.changeSource({ ...stale, revision: changed.revision }), false);
  writable = true;
  assert.equal(view.changeSource(stale), false);
  const idsBefore = ids(rich(document));
  document.replaceExternal(document.getSnapshot().markdown);
  assert.equal(document.getSnapshot(), changed, 'parent acknowledgements keep the current history');
  document.replaceExternal(original.replace('CCC', 'External'));
  assert.equal(document.getSnapshot().canUndo, false);
  assert.equal(document.getSourceSelection(), null, 'external replacement drops offsets from the previous source');
  assert.deepEqual(ids(rich(document)).slice(0, 2), idsBefore.slice(0, 2));
  assert.equal(view.changeSource({ ...stale, revision: changed.revision }), false);
  view.release();
  assert.equal(view.history('undo'), false);
});

test('metadata drafts preserve the current body and undo with the same document history', () => {
  const initial = '---\ntitle: Before\n---\n\n' + original;
  const document = new LocalMarkdownDocument(initial);
  const view = document.openView('rich', () => true);
  const changed = rich(document); changed.content![1].content![0].text = 'Current';
  assert(edit(document, view, changed, 6, 13));
  const beforeMetadata = document.getSnapshot().markdown;
  assert(view.changeMetadata({ revision: document.getSnapshot().revision,
    markdown: initial.replace('Before', 'After') }));
  assert.equal(document.getSnapshot().markdown, beforeMetadata.replace('Before', 'After'));
  assert.deepEqual(ids(rich(document)), ids(changed));
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, beforeMetadata);
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, initial);
});
