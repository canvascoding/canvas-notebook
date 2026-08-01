import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import {
  getMarkdownDocumentStats,
  markdownTextForStats,
} from '../app/lib/editor/markdown-document-stats';

const statsMarkdown = `---
title: Hidden Metadata
---

# Hello **world**

A [linked label](https://example.com).

> [!note] Notice
> More text.

[^1]: Footnote body.`;
const expectedStatsText = `Hello world

A linked label.

Notice
More text.

Footnote body.`;

assert.equal(markdownTextForStats(statsMarkdown), expectedStatsText);
assert.deepEqual(getMarkdownDocumentStats(statsMarkdown), {
  characters: Array.from(expectedStatsText).length,
  words: 10,
});

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}

async function main() {
  const { Editor } = await import('@tiptap/core');
  const { StarterKit } = await import('@tiptap/starter-kit');
  const {
    clearMarkdownSearch,
    findMarkdownDocumentMatches,
    getMarkdownSearchState,
    MarkdownSearchExtension,
    moveMarkdownSearchSelection,
    setMarkdownSearchQuery,
  } = await import('../app/lib/editor/markdown-search');

  const editor = new Editor({
    content: '<p>Alpha <strong>beta</strong> alpha.</p><p>Alpha beta.</p>',
    extensions: [StarterKit, MarkdownSearchExtension],
  });

  assert.equal(
    findMarkdownDocumentMatches(editor.state.doc, 'alpha beta').length,
    2,
    'search terms must match across adjacent inline marks without crossing block boundaries',
  );
  assert.equal(setMarkdownSearchQuery(editor, 'alpha').matches.length, 3);
  assert.equal(
    editor.view.dom.querySelectorAll('.markdown-search-match').length,
    3,
    'every match must be visible as a ProseMirror decoration',
  );
  assert.equal(moveMarkdownSearchSelection(editor, 1).currentIndex, 1);
  assert.equal(editor.state.doc.textBetween(
    editor.state.selection.from,
    editor.state.selection.to,
  ), 'alpha');
  assert.equal(moveMarkdownSearchSelection(editor, 2).currentIndex, 0, 'navigation must wrap');
  clearMarkdownSearch(editor);
  assert.deepEqual(getMarkdownSearchState(editor).matches, []);

  editor.destroy();
  console.log('markdown-search-stats-test: ok');
}

void main();
