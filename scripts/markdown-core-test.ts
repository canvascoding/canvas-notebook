import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import contract from '../app/lib/markdown/core/contract.json';
import corpus from '../app/lib/markdown/core/fixtures.json';
import { equivalentMarkdownNormalization } from '../app/lib/markdown/core/equivalence';
import { analyzeMarkdownRichMode, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import tableEscapes from '../app/lib/markdown/core/table-escape-fixtures.json';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { XmlElement } from 'yjs';
import { getSchema } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { TiptapTransformer } from '../app/lib/collaboration/server-runtime';

const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.equal(lockfile.packages['node_modules/@tiptap/core'].version, contract.tiptap);
assert.equal(lockfile.packages['node_modules/canvas-markdown-parser'].version, contract.marked);

for (const fixture of corpus.fixtures) {
  assert.notEqual(analyzeMarkdownRichMode(fixture.source).mode, 'source', fixture.name);
  assert.equal(serializeRichMarkdownBody(fixture.source), fixture.normalized, fixture.name);
  assert.equal(serializeRichMarkdownBody(fixture.normalized), fixture.normalized, `${fixture.name}: second serialization`);
  const doc = createRichMarkdownYDoc(fixture.normalized);
  try {
    assert.equal(richMarkdownFromYDoc(doc), fixture.normalized, fixture.name);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true, `${fixture.name}: structure and identities`);
  } finally { doc.destroy(); }
}
for (const [before, after] of corpus.negativePairs) {
  assert.equal(equivalentMarkdownNormalization(before, after), null, 'semantic changes must never normalize');
}

const image = createRichMarkdownYDoc('![Diagram](diagram.png)');
try {
  const node = image.getXmlFragment('body').get(0) as XmlElement;
  node.setAttribute('width', '480');
  assert.equal(validateRichMarkdownYDoc(image).valid, false, 'a stable string must not hide a lost image attribute');
} finally { image.destroy(); }
console.log(`Markdown core: ${corpus.fixtures.length} shared fixtures, ${corpus.negativePairs.length} rejected semantic changes, and attribute-loss validation passed.`);

const extensions = richMarkdownCodecExtensions();
for (const node of corpus.emptyNodes) {
  const schemaDoc = getSchema(extensions).nodeFromJSON({ type: 'doc', content: [node] });
  schemaDoc.check();
  const doc = TiptapTransformer.toYdoc(generateUniqueIds(schemaDoc.toJSON(), extensions), 'body', extensions);
  try {
    assert.equal(validateRichMarkdownYDoc(doc).valid, true, `${node.type}: an empty inserted block must checkpoint: ${richMarkdownFromYDoc(doc)}`);
  } finally { doc.destroy(); }
}
console.log(`${corpus.emptyNodes.length} empty block states checkpoint without inserted placeholder text.`);

// Exercise rich edits, not just already-valid source, against an independent GFM reader.
for (const fixture of tableEscapes) {
  const cell = (text: string, header: boolean, code = false) => ({
    type: header ? 'tableHeader' : 'tableCell',
    content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(code ? { marks: [{ type: 'code' }] } : {}) }] }],
  });
  // Both the header and body must keep the following cell, even for rejected edits.
  const json = { type: 'doc', content: [{ type: 'table', content: [true, false].map((header) => ({
    type: 'tableRow', content: [cell(fixture.text, header, fixture.code), cell('neighbor', header)],
  })) }] };
  const schemaDoc = getSchema(extensions).nodeFromJSON(json);
  schemaDoc.check();
  const doc = TiptapTransformer.toYdoc(generateUniqueIds(schemaDoc.toJSON(), extensions), 'body', extensions);
  try {
    const before = TiptapTransformer.fromYdoc(doc, 'body');
    const markdown = richMarkdownFromYDoc(doc);
    const table = unified().use(remarkParse).use(remarkGfm).parse(markdown).children[0];
    assert.equal(table.type, 'table', fixture.name);
    if (table.type !== 'table') throw new Error(fixture.name);
    for (const row of table.children) {
      assert.equal(row.children.length, 2, `${fixture.name}: no injected columns`);
      assert.deepEqual(row.children[1].children.map((node) => 'value' in node ? node.value : ''), ['neighbor']);
      if (fixture.valid) {
        assert.equal(row.children[0].children.map((node) => 'value' in node ? node.value : '').join(''), fixture.text);
        if (fixture.code) assert.equal(row.children[0].children[0].type, 'inlineCode');
      }
    }
    const result = validateRichMarkdownYDoc(doc);
    assert.equal(result.valid, fixture.valid, `${fixture.name}: checkpoint preserves content and marks`);
    if (!result.valid) assert.equal(result.code, 'roundtrip_unstable');
    assert.deepEqual(TiptapTransformer.fromYdoc(doc, 'body'), before, `${fixture.name}: validation never rewrites the edit`);
  } finally { doc.destroy(); }
}
console.log(`${tableEscapes.length} table escaping cases preserve cell boundaries and checkpoint guards.`);
