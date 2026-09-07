import assert from 'node:assert/strict';
import { getSchema, type JSONContent } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { TiptapTransformer, Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { analyzeMarkdownRichMode, createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { LIST_BOUNDARY_MARKDOWN } from '../app/lib/markdown/core/list-boundary';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';

const extensions = richMarkdownCodecExtensions();
const manager = createRichMarkdownManager();
const schema = getSchema(extensions);
const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const list = (type: string, index: number): JSONContent => ({ type,
  ...(type === 'orderedList' ? { attrs: { start: index === 1 ? 7 : 1 } } : {}),
  content: [{ type: type === 'taskList' ? 'taskItem' : 'listItem',
    ...(type === 'taskList' ? { attrs: { checked: index === 1 } } : {}),
    content: [paragraph(`Item ${index + 1}`)],
  }],
});

const containers: Array<[string, (children: JSONContent[]) => JSONContent[]]> = [
  ['document', (children) => children],
  ['blockquote', (children) => [{ type: 'blockquote', content: children }]],
  ['nested unordered item', (children) => [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Parent'), ...children] }] }]],
  ['nested ordered item', (children) => [{ type: 'orderedList', content: [{ type: 'listItem', content: [paragraph('Parent'), ...children] }] }]],
  ['nested task item', (children) => [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph('Parent'), ...children] }] }]],
];
let checks = 0;
for (const first of ['orderedList', 'bulletList', 'taskList']) {
  for (const second of ['orderedList', 'bulletList', 'taskList']) {
    for (const [name, wrap] of containers) {
      const json = schema.nodeFromJSON({ type: 'doc', content: wrap([list(first, 0), list(second, 1), list(second, 2)]) }).toJSON();
      const doc = TiptapTransformer.toYdoc(generateUniqueIds(json, extensions), 'body', extensions);
      const before = Y.encodeStateAsUpdate(doc);
      try {
        const validation = validateRichMarkdownYDoc(doc);
        assert.equal(validation.valid, true, `${name}: ${first}/${second}: ${validation.code}\n${validation.markdown}`);
        const reloaded = createRichMarkdownYDoc(validation.markdown!);
        try {
          assert.equal(equivalentRichDocument(TiptapTransformer.fromYdoc(doc, 'body'), TiptapTransformer.fromYdoc(reloaded, 'body')), true);
          assert.equal(richMarkdownFromYDoc(reloaded), validation.markdown);
          assert.equal(analyzeMarkdownRichMode(validation.markdown!).mode, 'rich');
          assert.deepEqual(Y.encodeStateAsUpdate(doc), before, 'checkpoint validation must not rewrite the CRDT or its identities');
        } finally { reloaded.destroy(); }
        checks += 1;
      } finally { doc.destroy(); }
    }
  }
}

for (const source of [
  '1. First\n\n2. Last',
  '> 1. First\n> 2. Last',
  '- [ ] First\n- [x] Last',
]) {
  assert.ok(!manager.serialize(manager.parse(source)).includes(LIST_BOUNDARY_MARKDOWN), 'ordinary lists need no structural marker');
}
const code = '```html\n' + LIST_BOUNDARY_MARKDOWN + '\n```';
assert.equal(manager.serialize(manager.parse(code)), code, 'a boundary written inside code remains literal');
const inlineBoundary = `Literal ${LIST_BOUNDARY_MARKDOWN} text`;
assert.equal(schema.nodeFromJSON(manager.parse(inlineBoundary)).textContent, inlineBoundary, 'the marker is only recognized on its own block line');
assert.equal(analyzeMarkdownRichMode('<!-- keep this comment -->\n\nText').mode, 'source', 'ordinary comments retain source protection');
assert.equal(analyzeMarkdownRichMode('<div>Keep exactly</div>').mode, 'source', 'raw HTML retains source protection');
console.log(`${checks} adjacent list/container combinations preserve structure, numbering, checks and identities.`);
