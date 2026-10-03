import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JSONContent } from '@tiptap/core';

import { LocalMarkdownDocument, type LocalMarkdownView } from '../app/lib/editor/local-markdown-document';
import { LocalMarkdownOwner } from '../app/lib/editor/local-markdown-owner';
import { LocalMarkdownOwnerCore } from '../app/lib/editor/local-markdown-owner-core';
import type { LocalMarkdownOwnerBackendChange, LocalMarkdownOwnerBackendFactory } from '../app/lib/editor/local-markdown-owner-contract';

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

for (const frontmatter of ['metadata', 'content'] as const) {
  test(`empty ${frontmatter} documents have an editable paragraph without changing their source`, () => {
    const document = new LocalMarkdownDocument('', frontmatter);
    const snapshot = document.getSnapshot();
    assert.equal(snapshot.markdown, '');
    assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.canUndo, false);
    assert.equal(snapshot.canRedo, false);
    const empty = rich(document);
    assert.equal(empty.content!.length, 1);
    assert.equal(empty.content![0].type, 'paragraph');
    assert.equal(empty.content![0].content, undefined);
    assert.match(empty.content![0].attrs!.id, /^[a-z0-9-]+$/i);

    const sourceOnly = new LocalMarkdownDocument(' ', frontmatter).getSnapshot();
    assert.equal(sourceOnly.markdown, ' ');
    assert.equal(sourceOnly.richDocument, null, 'source-only whitespace stays verbatim');
  });

  test(`deleting all ${frontmatter} source preserves bytes and identities through undo and redo`, () => {
    const initial = frontmatter === 'metadata' ? '---\r\ntitle: Before\r\n---\r\n\r\nExisting prompt\r\n' : 'Existing prompt\r\n';
    const document = new LocalMarkdownDocument(initial, frontmatter);
    const initialRich = rich(document);
    const view = document.openView('source', () => true);
    assert(view.changeSource({ revision: 0, markdown: '',
      beforeSelection: { anchor: 0, head: initial.length }, afterSelection: { anchor: 0, head: 0 } }));
    assert.equal(document.getSnapshot().markdown, '');
    const clearedRich = rich(document);
    assert.equal(clearedRich.content!.length, 1);
    assert.equal(clearedRich.content![0].type, 'paragraph');
    assert.equal(clearedRich.content![0].content, undefined, 'the fresh paragraph cannot retain deleted content');
    assert.ok(clearedRich.content![0].attrs!.id);
    assert(view.history('undo'));
    assert.equal(document.getSnapshot().markdown, initial, 'undo restores the exact original source bytes');
    assert.deepEqual(rich(document), initialRich);
    assert.deepEqual(document.getSourceSelection(), { anchor: 0, head: initial.length });
    assert(view.history('redo'));
    assert.equal(document.getSnapshot().markdown, '');
    assert.deepEqual(rich(document), clearedRich, 'redo retains the empty paragraph identity');
    assert.deepEqual(document.getSourceSelection(), { anchor: 0, head: 0 });
  });
}

test('metadata-only source remains exact while its empty body has a writable rich projection', () => {
  const initial = '---\r\ntitle: Empty body\r\n---\r\n\r\n';
  const document = new LocalMarkdownDocument(initial);
  assert.equal(document.getSnapshot().markdown, initial);
  assert.equal(document.getSnapshot().canUndo, false);
  const empty = rich(document);
  assert.equal(empty.content!.length, 1);
  assert.equal(empty.content![0].type, 'paragraph');
  assert.equal(empty.content![0].content, undefined);
  assert.ok(empty.content![0].attrs!.id);
});

test('external empty replacements remove prior content and reset local history', () => {
  const document = new LocalMarkdownDocument('Existing prompt', 'content');
  const view = document.openView('source', () => true);
  assert(document.changeSourceFromOwner('Existing prompt edited'));
  assert.equal(document.getSnapshot().canUndo, true);
  document.replaceExternal('');
  assert.equal(document.getSnapshot().markdown, '');
  assert.equal(document.getSnapshot().canUndo, false);
  assert.equal(document.getSnapshot().canRedo, false);
  assert.equal(document.getSourceSelection(), null);
  const empty = rich(document);
  assert.equal(empty.content!.length, 1);
  assert.equal(empty.content![0].type, 'paragraph');
  assert.equal(empty.content![0].content, undefined);
  assert.ok(empty.content![0].attrs!.id);
  assert.equal(view.history('undo'), false, 'an external clear cannot resurrect the prior prompt');
  const cleared = document.getSnapshot();
  document.replaceExternal('');
  assert.equal(document.getSnapshot(), cleared, 'an empty parent echo preserves the current identity');
});

test('typing into a new empty rich document and undo keep its paragraph identity', () => {
  const document = new LocalMarkdownDocument('', 'content');
  const initialRich = rich(document);
  const view = document.openView('rich', () => true);
  const typed = rich(document);
  typed.content![0].content = [{ type: 'text', text: 'Hello' }];
  assert(edit(document, view, typed, 1, 6, 'typing'));
  assert.equal(document.getSnapshot().markdown, 'Hello');
  assert.deepEqual(ids(rich(document)), ids(initialRich));
  assert(view.history('undo'));
  assert.equal(document.getSnapshot().markdown, '');
  assert.deepEqual(rich(document), initialRich);
  assert.deepEqual(document.getRichSelection(), textSelection(1));
  assert(view.history('redo'));
  assert.equal(document.getSnapshot().markdown, 'Hello');
  assert.deepEqual(rich(document), typed);
  assert.deepEqual(document.getRichSelection(), textSelection(6));
});

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

// This raw-only backend is the boundary under test: it has no schema, parser or
// copied owner/history policy. All controlled-value decisions use the real core.
function createRawOwnerBackend({ markdown, isWritable }: Parameters<LocalMarkdownOwnerBackendFactory<{
  getSnapshot: () => { markdown: string };
  subscribe: (listener: (change: LocalMarkdownOwnerBackendChange) => void) => () => void;
  replaceExternal: (markdown: string) => void;
}>>[0]) {
  let snapshot = Object.freeze({ markdown });
  const listeners = new Set<(change: LocalMarkdownOwnerBackendChange) => void>();
  const replacements: string[] = [];
  const publish = (next: string, origin: LocalMarkdownOwnerBackendChange['origin']) => {
    snapshot = Object.freeze({ markdown: next });
    for (const listener of listeners) listener({ origin, snapshot });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: (change: LocalMarkdownOwnerBackendChange) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    replaceExternal: (next: string) => { replacements.push(next); publish(next, 'external'); },
    edit: (next: string, origin: 'source' | 'rich' | 'history' = 'source') => {
      if (!isWritable()) return false;
      publish(next, origin);
      return true;
    },
    project: () => publish(snapshot.markdown, 'projection'),
    replacements,
    isWritable,
    listenerCount: () => listeners.size,
  };
}

test('portable owner constructs only enabled backends and gates writes by committed lifetime and rights', () => {
  const disabled = new LocalMarkdownOwnerCore('disabled', '', false, 'content', false, () => {
    assert.fail('disabled owners must not construct a local backend');
  });
  assert.equal(disabled.document, null);
  disabled.update('', false, 'always');
  const disconnectDisabled = disabled.connect();
  disconnectDisabled();

  let inputScope = '';
  let inputFrontmatter = '';
  const owner = new LocalMarkdownOwnerCore('prompt-scope', '', true, 'content', false, (input) => {
    inputScope = input.scope;
    inputFrontmatter = input.frontmatter;
    return createRawOwnerBackend(input);
  });
  const document = owner.document!;
  assert.equal(inputScope, 'prompt-scope');
  assert.equal(inputFrontmatter, 'content');
  assert.equal(document.edit('before commit'), false);
  const values: string[] = [];
  const onChange = (value: string) => { values.push(value); };
  owner.update('', false, 'always', onChange);
  const disconnect = owner.connect();
  assert(document.edit('accepted'));
  owner.update('accepted', true, 'always', onChange);
  assert.equal(document.edit('forbidden'), false);
  owner.update('accepted', false, 'always', onChange);
  assert(document.edit('after grant'));
  disconnect();
  assert.equal(document.isWritable(), false);
  assert.equal(document.listenerCount(), 0);
  assert.equal(document.edit('after unmount'), false);
  assert.deepEqual(values, ['accepted', 'after grant']);
});

test('portable owner retains exact opaque source through old parent echoes and deferred empty replacement', () => {
  const initial = '\uFEFF---\r\ninvalid: [\r\n---\r\n\r\n😀 opaque <Custom />\r\n';
  const owner = new LocalMarkdownOwnerCore('opaque', initial, true, 'metadata', false, createRawOwnerBackend);
  const document = owner.document!;
  const values: string[] = [];
  const onChange = (value: string) => { values.push(value); };
  owner.update(initial, false, 'when-blurred', onChange);
  const disconnect = owner.connect();
  owner.setFocused(true);
  const first = initial + 'first\r\n';
  const second = initial + 'second\r\n';
  assert(document.edit(first));
  assert(document.edit(second, 'rich'));
  owner.update(second, false, 'when-blurred', onChange);
  owner.update(first, false, 'when-blurred', onChange);
  assert.equal(document.getSnapshot().markdown, second, 'an older local acknowledgement is not an external replacement');
  assert.deepEqual(document.replacements, []);
  assert(document.edit(second + 'dirty\r\n'));
  owner.update('', false, 'when-blurred', onChange);
  assert.equal(document.getSnapshot().markdown, second + 'dirty\r\n');
  owner.setFocused(false);
  assert.equal(document.getSnapshot().markdown, '', 'empty is an authoritative replacement, not the pending sentinel');
  assert.deepEqual(document.replacements, ['']);
  assert.deepEqual(values, [first, second, second + 'dirty\r\n'], 'external replacement is never echoed back as a content edit');
  disconnect();
});

test('derived projection publishes to backend subscribers without parent changes or losing the current edit', () => {
  const owner = new LocalMarkdownOwnerCore('cache', 'before', true, 'content', false, createRawOwnerBackend);
  const document = owner.document!;
  const values: string[] = [];
  let projections = 0;
  const onChange = (value: string) => { values.push(value); };
  owner.update('before', false, 'always', onChange);
  const disconnect = owner.connect();
  const unsubscribe = document.subscribe(({ origin }) => { if (origin === 'projection') projections++; });
  assert(document.edit('after'));
  const beforeProjection = values.length;
  document.project();
  assert.equal(projections, 1);
  assert.equal(values.length, beforeProjection, 'installing a rich cache cannot masquerade as a user edit');
  owner.update('after', false, 'always', onChange);
  assert.equal(document.getSnapshot().markdown, 'after');
  assert.deepEqual(document.replacements, []);
  unsubscribe();
  disconnect();
});

test('permission revocation flushes deferred external source and reconnect does not duplicate callbacks', () => {
  const owner = new LocalMarkdownOwnerCore('lifetime', 'before', true, 'content', false, createRawOwnerBackend);
  const document = owner.document!;
  const firstValues: string[] = [];
  const firstChange = (value: string) => { firstValues.push(value); };
  owner.update('before', false, 'when-blurred', firstChange);
  const disconnect = owner.connect();
  owner.setFocused(true);
  assert(document.edit('dirty'));
  owner.update('external', false, 'when-blurred', firstChange);
  assert.equal(document.getSnapshot().markdown, 'dirty');
  owner.update('external', true, 'when-blurred', firstChange);
  assert.equal(document.getSnapshot().markdown, 'external', 'a revoked writer cannot retain a dirty editable value over authority');
  assert.equal(document.edit('forbidden'), false);
  disconnect();
  const secondValues: string[] = [];
  const secondChange = (value: string) => { secondValues.push(value); };
  const disconnectAgain = owner.connect();
  owner.update('external', false, 'always', secondChange);
  assert.equal(document.listenerCount(), 1);
  assert(document.edit('reconnected', 'history'));
  assert.deepEqual(firstValues, ['dirty']);
  assert.deepEqual(secondValues, ['reconnected']);
  disconnectAgain();
});

test('five-argument Web owner keeps actual rich/source history and identities after delayed acknowledgements', () => {
  const owner = new LocalMarkdownOwner('web-history', original, true, 'content', false);
  const document = owner.document!;
  const values: string[] = [];
  const onChange = (value: string) => { values.push(value); };
  owner.update(original, false, 'always', onChange);
  const disconnect = owner.connect();
  const initialRich = rich(document);
  let sourceView = document.openView('source', () => true);
  const sourceRaw = 'Source ' + original;
  assert(sourceView.changeSource({ revision: 0, markdown: sourceRaw,
    beforeSelection: { anchor: 0, head: 0 }, afterSelection: { anchor: 7, head: 7 } }));
  const richView = document.openView('rich', () => true);
  const changed = rich(document);
  changed.content![1].content![0].text = 'Rich BBB';
  assert(edit(document, richView, changed, 15, 18));
  const richRaw = document.getSnapshot().markdown;
  sourceView = document.openView('source', () => true);
  const finalRaw = richRaw + 'Last source\n';
  assert(sourceView.changeSource({ revision: document.getSnapshot().revision, markdown: finalRaw,
    beforeSelection: { anchor: richRaw.length, head: richRaw.length },
    afterSelection: { anchor: finalRaw.length, head: finalRaw.length } }));
  owner.update(finalRaw, false, 'always', onChange);
  owner.update(sourceRaw, false, 'always', onChange);
  owner.update(richRaw, false, 'always', onChange);
  assert.equal(document.getSnapshot().markdown, finalRaw);
  assert(sourceView.history('undo'));
  assert.equal(document.getSnapshot().markdown, richRaw);
  assert(sourceView.history('undo'));
  assert.equal(document.getSnapshot().markdown, sourceRaw);
  assert(sourceView.history('undo'));
  assert.equal(document.getSnapshot().markdown, original);
  assert.deepEqual(rich(document), initialRich, 'the Web wrapper still uses the real PM history and IDs');
  assert(sourceView.history('redo'));
  assert(sourceView.history('redo'));
  assert(sourceView.history('redo'));
  assert.equal(document.getSnapshot().markdown, finalRaw);
  owner.update(finalRaw, true, 'always', onChange);
  assert.equal(sourceView.history('undo'), false);
  owner.update('Authoritative replacement\n', false, 'always', onChange);
  assert.equal(document.getSnapshot().markdown, 'Authoritative replacement\n');
  assert.equal(document.getSnapshot().canUndo, false);
  assert.equal(sourceView.history('undo'), false);
  disconnect();
});
