import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { generateUniqueIds, UniqueID, type UniqueIDGenerationContext } from '@tiptap/extension-unique-id';
import { generateRichNodeIds } from '../app/lib/editor/generate-rich-node-ids';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const fixtures = [
  '',
  '# Title\n\nParagraph with **bold**, *italic*, `code`, Unicode ä 😀 and a\\\nhard break.',
  '> Quote\n>\n> - Nested item\n>   - Inner item\n\n1. One\n2. Two\n\n- [ ] Task\n- [x] Done',
  '| Header | Second |\n| :--- | ---: |\n| Cell | **Value** |',
  '> [!note]+ Title\n> Callout\n\n<details>\n<summary>More</summary>\n\nBody\n\n</details>',
  'Text[^a] with $x$.\n\n![alt](https://example.test/image.png)\n\n[^a]: Definition\n\n$$\nx+y\n$$',
];

function compare(input: JSONContent, attributeName = 'id', types: 'all' | string[] = 'all') {
  const before = structuredClone(input);
  const make = () => {
    const calls: unknown[] = [];
    const extensions = richMarkdownCodecExtensions().map(extension => extension.name === 'uniqueID'
      ? UniqueID.configure({ attributeName, types, generateID: ({ node, pos }: UniqueIDGenerationContext) => {
        calls.push({ node: node.toJSON(), pos });
        return `generated-${calls.length}-${pos}`;
      } }) : extension);
    return { calls, extensions };
  };
  const original = make();
  const optimized = make();
  const originalStart = performance.now();
  const expected = generateUniqueIds(input, original.extensions);
  const originalMs = performance.now() - originalStart;
  const optimizedStart = performance.now();
  const actual = generateRichNodeIds(input, optimized.extensions);
  const optimizedMs = performance.now() - optimizedStart;
  assert.deepEqual({ ...actual, content: undefined }, { ...expected, content: undefined });
  assert.equal(actual.content?.length, expected.content?.length);
  for (let i = 0; i < (actual.content?.length ?? 0); i++) {
    assert.deepEqual(actual.content![i], expected.content![i], `child ${i}: JSON, defaults, IDs, marks and ordering match`);
  }
  assert.equal(optimized.calls.length, original.calls.length);
  for (let i = 0; i < optimized.calls.length; i++) {
    assert.deepEqual(optimized.calls[i], original.calls[i], `generator call ${i}: same original node and position`);
  }
  assert.deepEqual(input, before, 'ID generation never mutates the input document');
  if (actual.content?.length) getSchema(optimized.extensions).nodeFromJSON(actual).check();
  return { actual, calls: optimized.calls, originalMs, optimizedMs };
}

for (const [index, markdown] of fixtures.entries()) {
  test(`ID generation matches UniqueID across the rich schema (${index})`, () => {
    const parsed = createRichMarkdownManager().parse(markdown);
    compare(parsed);
    compare(parsed, 'uid', ['paragraph', 'heading', 'tableCell']);
  });
}

test('existing IDs and duplicates are preserved while missing/falsy IDs are generated', () => {
  const paragraph = (id: unknown): JSONContent => ({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: 'same' }] });
  const input: JSONContent = { type: 'doc', content: [paragraph('keep'), paragraph('keep'), paragraph(''), paragraph(null), paragraph(0)] };
  const { actual, calls } = compare(input);
  assert.equal(calls.length, 3);
  assert.deepEqual(actual.content?.slice(0, 2).map(node => node.attrs?.id), ['keep', 'keep']);
});

test('large flat input has the same normalized output and generator context', context => {
  const input: JSONContent = { type: 'doc', content: Array.from({ length: 5000 }, (_, index) => ({
    type: 'paragraph', ...(index % 3 === 0 ? { attrs: { id: `authored-${index}` } } : {}),
    content: [{ type: 'text', text: 'Alpha ' }, { type: 'text', text: 'Beta' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
  })) };
  const result = compare(input);
  assert.equal(result.calls.length, 3333);
  context.diagnostic(`ID generation for 5,000 paragraphs: original ${result.originalMs.toFixed(1)} ms; current ${result.optimizedMs.toFixed(1)} ms (informational, no time threshold).`);
});

test('custom generator values pass through the same schema defaults', () => {
  for (const value of [undefined, null, '', 0, false, 'custom-id']) {
    const extensions = richMarkdownCodecExtensions().map(extension => extension.name === 'uniqueID'
      ? UniqueID.configure({ types: 'all', generateID: () => value }) : extension);
    const input = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] };
    assert.deepEqual(generateRichNodeIds(input, extensions), generateUniqueIds(input, extensions));
  }
});

test('missing extension and invalid node types are rejected without mutating input', () => {
  assert.throws(() => generateRichNodeIds({ type: 'doc' }, []), /UniqueID extension not found/);
  const invalid = { type: 'doc', content: [{ type: 'unknown-node' }] };
  const before = structuredClone(invalid);
  assert.throws(() => generateRichNodeIds(invalid, richMarkdownCodecExtensions()), /Unknown node type/);
  assert.deepEqual(invalid, before);
  const invalidParagraph = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'image.png' } }] }] };
  assert.throws(() => generateUniqueIds(invalidParagraph, richMarkdownCodecExtensions()), /Invalid content/);
  assert.throws(() => generateRichNodeIds(invalidParagraph, richMarkdownCodecExtensions()), /Invalid content/);
});
