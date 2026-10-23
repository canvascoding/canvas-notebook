import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { nativeRichDocumentFixture } from './helpers/rich-markdown-projection-fixtures';

const p = (content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const neighbor = p([{ type: 'text', text: 'Unchanged neighbor' }]);
const wrappers: { name: string; wrap: (content: JSONContent[]) => JSONContent }[] = [
  { name: 'paragraph', wrap: p },
  { name: 'heading', wrap: (content) => ({ type: 'heading', attrs: { level: 2 }, content }) },
  { name: 'bullet list', wrap: (content) => ({ type: 'bulletList', content: [{ type: 'listItem', content: [p(content), neighbor] }] }) },
  { name: 'ordered list', wrap: (content) => ({ type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(content), neighbor] }] }) },
  { name: 'task list', wrap: (content) => ({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p(content), neighbor] }] }) },
  { name: 'blockquote', wrap: (content) => ({ type: 'blockquote', content: [p(content), neighbor] }) },
  { name: 'callout title', wrap: (content) => ({ type: 'canvasCallout', attrs: { calloutType: 'note', fold: null },
    content: [{ type: 'canvasCalloutTitle', content }, neighbor] }) },
  { name: 'callout body', wrap: (content) => ({ type: 'canvasCallout', attrs: { calloutType: 'note', fold: null },
    content: [{ type: 'canvasCalloutTitle', content: [{ type: 'text', text: 'Title' }] }, p(content), neighbor] }) },
  { name: 'details summary', wrap: (content) => ({ type: 'canvasDetails', attrs: { open: false },
    content: [{ type: 'canvasDetailsSummary', content }, { type: 'canvasDetailsContent', content: [neighbor] }] }) },
  { name: 'details body', wrap: (content) => ({ type: 'canvasDetails', attrs: { open: false },
    content: [{ type: 'canvasDetailsSummary', content: [{ type: 'text', text: 'Summary' }] },
      { type: 'canvasDetailsContent', content: [p(content), neighbor] }] }) },
  { name: 'table', wrap: (content) => ({ type: 'table', content: [true, false].map((header) => ({ type: 'tableRow', content: [
    { type: header ? 'tableHeader' : 'tableCell', content: [p(content)] },
    { type: header ? 'tableHeader' : 'tableCell', content: [neighbor] },
  ] })) }) },
];
const link = { type: 'link', attrs: { href: 'target.md#section' } };
const marks: NonNullable<JSONContent['marks']>[] = [
  [], [{ type: 'bold' }], [{ type: 'italic' }], [{ type: 'strike' }], [{ type: 'underline' }],
  [{ type: 'canvasHighlight' }], [link], [{ type: 'bold' }, { type: 'italic' }],
  [{ type: 'bold' }, { type: 'italic' }, link], [{ type: 'code' }],
];
const texts = ['Alpha Beta', 'A\nB', 'A\tB', 'A\t\nB', 'A\rB', 'A\r\nB', 'A\tB \r\nC 😀 é'];

for (const format of ['tiptap_xml', 'tiptap_blocks'] as const) {
  for (const wrapper of wrappers) test(`${format}: ${wrapper.name} preserves controls, marks, structure, and source evidence`, () => {
    for (const activeMarks of marks) for (const text of texts) {
      const content: JSONContent[] = [
        { type: 'text', text: 'Before ' },
        { type: 'text', text, marks: activeMarks },
        { type: 'text', text: ' after' },
      ];
      const doc = nativeRichDocumentFixture({ type: 'doc', content: [wrapper.wrap(content)] }, format);
      let reparsed: Y.Doc | null = null;
      try {
        // Leading table whitespace in frontmatter documents has a separate
        // pre-existing Markdown fixed-point failure, covered explicitly below.
        if (wrapper.name !== 'table') doc.getText('frontmatter').insert(0, '---\ntitle: Synthetic fixture\n---\n');
        doc.getText('bodyFinalLineEnding').insert(0, '\r\n');
        const before = readRichDocumentJson(doc);
        const binary = Y.encodeStateAsUpdate(doc);
        const vector = Y.encodeStateVector(doc);
        const label = `${wrapper.name}/${activeMarks.map((mark) => mark.type).join(',')}/${JSON.stringify(text)}`;
        assert.equal(validateRichMarkdownYDoc(doc).valid, true, label);
        const markdown = richMarkdownFromYDoc(doc);
        reparsed = createRichMarkdownYDoc(markdown);
        assert(equivalentRichDocument(before, readRichDocumentJson(reparsed)), label);
        assert.equal(richMarkdownFromYDoc(reparsed), markdown, `${label}: Markdown fixed point`);
        assert.equal(reparsed.getText('frontmatter').toString(), doc.getText('frontmatter').toString());
        assert.equal(reparsed.getText('bodyFinalLineEnding').toString(), '\r\n');
        assert.deepEqual(readRichDocumentJson(doc), before, `${label}: source IDs/attributes unchanged`);
        assert.deepEqual(Y.encodeStateAsUpdate(doc), binary, `${label}: original binary unchanged`);
        assert.deepEqual(Y.encodeStateVector(doc), vector, `${label}: original vector unchanged`);
      } finally { reparsed?.destroy(); doc.destroy(); }
    }
  });
}

for (const format of ['tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${format}: table with frontmatter retains its named Markdown fixed-point limitation`, () => {
    const table = wrappers.find((wrapper) => wrapper.name === 'table')!.wrap([{ type: 'text', text: 'Plain text' }]);
    const doc = nativeRichDocumentFixture({ type: 'doc', content: [table] }, format);
    let reparsed: Y.Doc | null = null;
    try {
      doc.getText('frontmatter').insert(0, '---\ntitle: Synthetic fixture\n---\n');
      const binary = Y.encodeStateAsUpdate(doc);
      const markdown = richMarkdownFromYDoc(doc);
      assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
      reparsed = createRichMarkdownYDoc(markdown);
      assert(equivalentRichDocument(readRichDocumentJson(doc), readRichDocumentJson(reparsed)));
      assert.notEqual(richMarkdownFromYDoc(reparsed), markdown, 'the leading table newline moves into the metadata prefix');
      assert.deepEqual(Y.encodeStateAsUpdate(doc), binary);
    } finally { reparsed?.destroy(); doc.destroy(); }
  });
  test(`${format}: fenced-code CR retains its named literal line-ending limitation`, () => {
    for (const text of ['A\rB', 'A\r\nB']) {
      const doc = nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'text' },
        content: [{ type: 'text', text }] }] }, format);
      try {
        const binary = Y.encodeStateAsUpdate(doc);
        assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable', 'fenced literal text is outside the inline escape fix');
        assert.deepEqual(Y.encodeStateAsUpdate(doc), binary);
      } finally { doc.destroy(); }
    }
  });
}
