import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  analyzeMarkdownRichMode,
  serializeRichMarkdownBody,
} from '../app/lib/markdown/rich-markdown-codec';
import {
  composeCanvasMarkdownDocument,
  splitCanvasMarkdownForRichEditor,
} from '../app/lib/markdown/obsidian-metadata';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'markdown-roundtrip');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8');
}

const safeFixture = readFixture('marp-frontmatter-safe.md');
const safeParts = splitCanvasMarkdownForRichEditor(safeFixture);
assert.equal(composeCanvasMarkdownDocument(safeParts.prefix, safeParts.body), safeFixture);
assert.deepEqual(analyzeMarkdownRichMode(safeFixture), {
  mode: 'rich',
  prefix: safeParts.prefix,
  body: safeParts.body,
});

assert.equal(serializeRichMarkdownBody(safeParts.body), safeParts.body);

const directiveFixture = readFixture('marp-directive-source-only.md');
assert.deepEqual(analyzeMarkdownRichMode(directiveFixture), {
  mode: 'source',
  reason: 'unsupported_marp_directive',
});

const invalidFrontmatter = '---\n: invalid: yaml\n---\n# Body\n';
assert.deepEqual(analyzeMarkdownRichMode(invalidFrontmatter), {
  mode: 'source',
  reason: 'invalid_frontmatter',
});

const crlfBody = '---\r\nmarp: true\r\n---\r\n\r\n# Slide\r\n';
assert.equal(analyzeMarkdownRichMode(crlfBody).mode, 'rich');

console.log('markdown-roundtrip-preservation-test: ok');
