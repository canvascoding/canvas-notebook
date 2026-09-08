import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { BLOCK_TREE_KEY, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readRichDocumentJson, richDocumentFormat } from '../app/lib/collaboration/rich-document';
import { convertRichMarkdownYDoc, createRichMarkdownYDoc, replaceRichMarkdownInYDoc, richMarkdownFromYDoc,
  richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';

const schema = getSchema(richMarkdownSchemaExtensions());
const fixtures = [
  '---\ntitle: Shared\n---\n\n# Heading\n\nOne **bold** and *italic* paragraph.\n\n',
  '- [ ] First\n- [x] Second\n\n1. Ordered\n2. Items',
  '| Name | Cost |\n| --- | --- |\n| Heating | **71,69 €** |',
  '> [!warning]+ Review together\n> Keep this callout.\n\n<details>\n<summary>Context</summary>\n\nNested content.\n\n</details>',
  'Highlight ==text==, @{Ada|user-ada}, [[notes/shared.md|Shared]] and $x^2$.\n\nReference.[^1]\n\n[^1]: Footnote.',
  '```typescript\nconst n = 1;\n```\n\n---\n\n![Caption](image.png)',
  '',
  '\n\n',
];

for (const [index, markdown] of fixtures.entries()) {
  test(`both rich formats export and restore the same document (${index})`, () => {
    const legacy = createRichMarkdownYDoc(markdown);
    const blocks = createRichMarkdownYDoc(markdown, 'tiptap_blocks');
    const restored = new Y.Doc();
    try {
      assert.equal(richDocumentFormat(legacy), 'tiptap_xml');
      assert.equal(richDocumentFormat(blocks), 'tiptap_blocks');
      assert.equal(blocks.share.has('body'), false);
      assert.ok(equivalentRichDocument(readRichDocumentJson(legacy), readRichDocumentJson(blocks)));
      assert.equal(richMarkdownFromYDoc(blocks), richMarkdownFromYDoc(legacy));
      const bytes = Y.encodeStateAsUpdate(blocks);
      assert.deepEqual(validateRichMarkdownYDoc(blocks), validateRichMarkdownYDoc(legacy));
      assert.equal(validateRichMarkdownYDoc(blocks).valid, true);
      assert.deepEqual(Y.encodeStateAsUpdate(blocks), bytes, 'validation must not change durable content');
      Y.applyUpdate(restored, bytes);
      assert.deepEqual(readRichDocumentJson(restored), readRichDocumentJson(blocks));
      assert.equal(richMarkdownFromYDoc(restored), richMarkdownFromYDoc(blocks));
    } finally { legacy.destroy(); blocks.destroy(); restored.destroy(); }
  });
}

test('a source move preserves shared text and merges concurrent content into the moved identity', () => {
  const left = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', 'tiptap_blocks');
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  try {
    const tree = new CollaborationBlockTree(left, schema);
    const remote = new CollaborationBlockTree(right, schema);
    const id = tree.read().child(1).attrs.id as string;
    const text = tree.content(id).get(0) as Y.XmlText;
    const anchor = Y.createRelativePositionFromTypeIndex(text, 1);
    replaceRichMarkdownInYDoc(left, 'AAA\n\nCCC\n\nBBB', 'source-edit');
    assert.equal(tree.content(id).get(0), text);
    const remoteText = remote.content(id).get(0) as Y.XmlText;
    remoteText.insert(3, '!');
    const a = Y.encodeStateAsUpdate(left);
    const b = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, b); Y.applyUpdate(right, a);
    assert.equal(richMarkdownFromYDoc(left), 'AAA\n\nCCC\n\nBBB!');
    assert.deepEqual(readRichDocumentJson(left), readRichDocumentJson(right));
    assert.equal(Y.createAbsolutePositionFromRelativePosition(anchor, left)?.type, text);
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
  } finally { left.destroy(); right.destroy(); }
});

test('source replacement changes text, structure and metadata without changing an untouched block identity', () => {
  const doc = createRichMarkdownYDoc('---\ntitle: Old\n---\n\nKeep\n\nChange', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, schema);
    const first = tree.read().firstChild!;
    const text = tree.content(first.attrs.id).get(0);
    replaceRichMarkdownInYDoc(doc, '---\ntitle: New\n---\n\nKeep\n\nChanged\n\n- A\n- B\n', 'source-edit');
    assert.equal(tree.read().firstChild!.attrs.id, first.attrs.id);
    assert.equal(tree.content(first.attrs.id).get(0), text);
    assert.equal(doc.getText('frontmatter').toString(), '---\ntitle: New\n---\n\n');
    assert.match(richMarkdownFromYDoc(doc), /Keep\n\nChanged\n\n- A\n- B\n$/u);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
  } finally { doc.destroy(); }
});

test('mixed roots and unknown block format versions fail validation without exporting partial content', () => {
  for (const corrupt of [
    (doc: Y.Doc) => doc.getXmlFragment('body'),
    (doc: Y.Doc) => doc.getMap(BLOCK_TREE_KEY).set('version', 99),
  ]) {
    const doc = createRichMarkdownYDoc('Preserve me', 'tiptap_blocks');
    try {
      corrupt(doc);
      assert.throws(() => readRichDocumentJson(doc));
      assert.deepEqual(validateRichMarkdownYDoc(doc), { valid: false, code: 'schema_invalid' });
    } finally { doc.destroy(); }
  }
});

test('format conversion retains every stable identity and metadata while leaving the source unchanged', () => {
  const source = createRichMarkdownYDoc(fixtures[0] + '\n\n' + fixtures[2]);
  const original = Y.encodeStateAsUpdate(source);
  const converted = convertRichMarkdownYDoc(source, 'tiptap_blocks');
  const rollback = convertRichMarkdownYDoc(converted, 'tiptap_xml');
  try {
    assert.deepEqual(readRichDocumentJson(converted), readRichDocumentJson(source));
    assert.deepEqual(readRichDocumentJson(rollback), readRichDocumentJson(source));
    assert.equal(richMarkdownFromYDoc(converted), richMarkdownFromYDoc(source));
    assert.deepEqual(Y.encodeStateAsUpdate(source), original);
    assert.equal(converted.share.has('body'), false);
    assert.equal(rollback.share.has(BLOCK_TREE_KEY), false);
  } finally { source.destroy(); converted.destroy(); rollback.destroy(); }
});
