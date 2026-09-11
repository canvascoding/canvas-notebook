import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { TiptapTransformer, Y } from '../app/lib/collaboration/server-runtime';
import { convertRichMarkdownYDoc, createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { escapeParagraphBlockSyntax } from '../app/lib/markdown/core/paragraph-syntax';
import { analyzeMarkdownRichMode, createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const extensions = richMarkdownCodecExtensions();
const schema = getSchema(extensions);
const manager = createRichMarkdownManager();
const paragraphTexts = ['-', '+', '#', '1.', '1)', '# Heading', '- Item', '+ Item', '1. Item', '> quote',
  'A\n---', 'A\n===', 'A\n# Heading', 'A\n- Item', 'A\n> quote', '- - -',
  'A\n|---|', 'A | B\n--- | ---', 'A\n:---:', 'A | B\n| :--- | ---: |'];

test('paragraph punctuation is escaped at physical line starts without changing inline markup', () => {
  const examples: Array<[string, string]> = [
    ['-', '\\-'], ['+', '\\+'], ['#', '\\#'], ['1.', '1\\.'], ['1)', '1\\)'],
    ['# Heading', '\\# Heading'], ['- **Item**', '\\- **Item**'], ['1. *Item*', '1\\. *Item*'],
    ['> quote', '\\> quote'], ['A\n---', 'A\n\\---'], ['A\r\n===', 'A\r\n\\==='],
    ['  - Item', '  \\- Item'], ['- - -', '\\- - -'],
    ['A\n|---|', 'A\n\\|---|'], ['A | B\n--- | ---', 'A | B\n\\--- | ---'],
    ['A\n:---:', 'A\n\\:---:'], ['A | B\n| :--- | ---: |', 'A | B\n\\| :--- | ---: |'],
  ];
  for (const [source, expected] of examples) {
    assert.equal(escapeParagraphBlockSyntax(source), expected, source);
    assert.equal(escapeParagraphBlockSyntax(expected), expected, 'escaping is idempotent');
  }
  for (const unchanged of ['A **bold** B', '[link](https://example.com/#heading)', '\\- literal',
    '&#32;- text', 'A&#10;---', '<br data-canvas-hard-break>', '<strong>text</strong>',
    '`A\n---`', '`A\n|---|`', '``A\n# heading\n`literal` ``', '1234567890. text', '####### text',
    '| ordinary pipe', 'A | B', '--', '===', '|---|', ':---:']) {
    assert.equal(escapeParagraphBlockSyntax(unchanged), unchanged);
  }
});

test('standalone delimiter-like prose keeps its existing rich source mode', () => {
  for (const markdown of ['--', '===', '|---|', ':---:', 'A | B', '| ordinary pipe']) {
    assert.equal(manager.serialize(manager.parse(markdown)), markdown);
    assert.equal(analyzeMarkdownRichMode(markdown).mode, 'rich');
  }
});

for (const text of paragraphTexts) {
  test(`punctuation remaining after deletion stays a paragraph: ${JSON.stringify(text)}`, () => {
    const node = schema.nodeFromJSON(generateRichNodeIds({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
    ] }, extensions));
    node.check();
    const xml = TiptapTransformer.toYdoc(node.toJSON(), 'body', extensions);
    const blocks = convertRichMarkdownYDoc(xml, 'tiptap_blocks');
    try {
      for (const doc of [xml, blocks]) {
        const before = readRichDocumentJson(doc);
        const result = validateRichMarkdownYDoc(doc);
        assert.equal(result.valid, true, JSON.stringify(result));
        assert.deepEqual(readRichDocumentJson(doc), before, 'validation does not rewrite authored text');
        const restored = new Y.Doc();
        const reparsed = createRichMarkdownYDoc(richMarkdownFromYDoc(doc));
        try {
          Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
          assert.deepEqual(readRichDocumentJson(restored), before, 'binary persistence preserves exact content and identities');
          assert.equal(validateRichMarkdownYDoc(restored).valid, true);
          assert.equal(equivalentRichDocument(before, readRichDocumentJson(reparsed)), true,
            'Markdown projection preserves the paragraph and exact text');
          assert.equal(readRichDocumentJson(reparsed).content?.[0].type, 'paragraph');
        } finally { restored.destroy(); reparsed.destroy(); }
      }
    } finally { xml.destroy(); blocks.destroy(); }
  });
}

for (const text of ['#', '###', 'A #', 'A ###', 'C#', 'A \\#']) {
  test(`hashes remaining after deletion stay heading content: ${JSON.stringify(text)}`, () => {
    const json = generateRichNodeIds(schema.nodeFromJSON({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] },
    ] }).toJSON(), extensions);
    const xml = TiptapTransformer.toYdoc(json, 'body', extensions);
    const blocks = convertRichMarkdownYDoc(xml, 'tiptap_blocks');
    try {
      for (const doc of [xml, blocks]) {
        const before = readRichDocumentJson(doc);
        assert.equal(validateRichMarkdownYDoc(doc).valid, true);
        const markdown = richMarkdownFromYDoc(doc);
        assert.ok(markdown.startsWith('## '), 'the actual heading marker is preserved');
        const roundtrip = createRichMarkdownYDoc(markdown);
        const restored = new Y.Doc();
        try {
          assert.equal(equivalentRichDocument(before, readRichDocumentJson(roundtrip)), true,
            'literal closing hashes are not removed');
          assert.equal(readRichDocumentJson(roundtrip).content?.[0].type, 'heading');
          Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
          assert.deepEqual(readRichDocumentJson(restored), before);
          assert.equal(validateRichMarkdownYDoc(restored).valid, true);
        } finally { roundtrip.destroy(); restored.destroy(); }
        assert.deepEqual(readRichDocumentJson(doc), before, 'projection does not mutate the live heading');
      }
    } finally { xml.destroy(); blocks.destroy(); }
  });
}

test('actual structural blocks and ordinary inline formatting retain their renderer', () => {
  for (const markdown of ['# Heading', '- Item', '+ Item', '1. Item', '> quote', 'A **bold** B',
    '[link](https://example.com)', '`# literal`']) {
    const before = manager.parse(markdown);
    const projected = manager.serialize(before);
    assert.equal(equivalentRichDocument(before, manager.parse(projected)), true, markdown);
    if (markdown === '# Heading' || markdown === '- Item' || markdown === '1. Item') {
      assert.equal(projected, markdown, 'structural markers are not escaped');
    }
  }
  const marked: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: '- ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
  ] }] };
  const normalized = schema.nodeFromJSON(marked).toJSON();
  assert.equal(equivalentRichDocument(normalized, schema.nodeFromJSON(manager.parse(manager.serialize(normalized))).toJSON()), true);
});
