import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import contract from '../app/lib/markdown/core/contract.json';
import corpus from '../app/lib/markdown/core/fixtures.json';
import { equivalentMarkdownNormalization } from '../app/lib/markdown/core/equivalence';
import { analyzeMarkdownRichMode, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
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
