import assert from 'node:assert/strict';
import { getSchema, type JSONContent } from '@tiptap/core';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { TiptapTransformer } from '../app/lib/collaboration/server-runtime';
import { convertRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { Marked } from 'canvas-markdown-parser';
import { JSDOM } from 'jsdom';

const extensions = richMarkdownCodecExtensions();
const schema = getSchema(extensions);
const cases: { name: string; content: JSONContent[] }[] = [];
for (const mark of [
  { type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'underline' }, { type: 'canvasHighlight' },
  { type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow', class: null } },
]) {
  for (const text of [' space ', '   ', '\tlabel\t', '\u00a0label\u00a0']) cases.push({
    name: `${mark.type}:${JSON.stringify(text)}`, content: [{ type: 'text', text, marks: [mark] }],
  });
}
cases.push({ name: 'overlapping marks and ordinary adjacent whitespace', content: [
  { type: 'text', text: 'before ' },
  { type: 'text', text: ' bold ', marks: [{ type: 'bold' }] },
  { type: 'text', text: ' both ', marks: [{ type: 'bold' }, { type: 'italic' }] },
  { type: 'text', text: ' italic ', marks: [{ type: 'italic' }] },
  { type: 'text', text: ' after' },
] });
cases.push({ name: 'literal entities, markdown syntax and private-use text', content: [
  { type: 'text', text: '\uE000CanvasSpace0\uE001 ' },
  { type: 'text', text: ' &#32; *literal* & <tag> ', marks: [{ type: 'bold' }] },
] });
cases.push({ name: 'marked whitespace next to unmarked letters', content: [
  { type: 'text', text: 'before' },
  { type: 'text', text: ' bold ', marks: [{ type: 'bold' }] },
  { type: 'text', text: 'after' },
] });
cases.push({ name: 'linked formatted whitespace', content: [{ type: 'text', text: ' linked ', marks: [
  { type: 'bold' }, { type: 'italic' },
  { type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer nofollow', class: null } },
] }] });

function verifyStandardRendering(markdown: string, content: JSONContent[], name: string) {
  // No Canvas tokenizers or Tiptap parser: standard GFM output must retain the
  // same characters and mark coverage, including spaces at mark boundaries.
  const html = new Marked({ gfm: true }).parse(markdown, { async: false });
  const dom = new JSDOM(html);
  try {
    const paragraph = dom.window.document.querySelector('p'); assert(paragraph, name);
    const tagMarks: Record<string, string> = { STRONG: 'bold', EM: 'italic', DEL: 'strike', S: 'strike',
      U: 'underline', MARK: 'canvasHighlight', A: 'link' };
    const actual: { character: string; marks: string[] }[] = [];
    const walker = dom.window.document.createTreeWalker(paragraph, dom.window.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const marks: string[] = [];
      for (let parent = node.parentElement; parent && parent !== paragraph; parent = parent.parentElement) {
        if (tagMarks[parent.tagName]) marks.push(tagMarks[parent.tagName]);
      }
      actual.push(...Array.from(node.textContent ?? '', (character) => ({ character, marks: marks.sort() })));
    }
    const expected = content.flatMap((node) => Array.from(node.text ?? '', (character) => ({ character,
      marks: (node.marks ?? []).map((mark) => mark.type).sort() })));
    assert.deepEqual(actual, expected, `${name}: standard GFM mark coverage`);
  } finally { dom.window.close(); }
}

const wrappers: { name: string; wrap: (content: JSONContent[]) => JSONContent }[] = [
  { name: 'paragraph', wrap: (content) => ({ type: 'paragraph', content }) },
  { name: 'heading', wrap: (content) => ({ type: 'heading', attrs: { level: 2 }, content }) },
  { name: 'callout title', wrap: (content) => ({ type: 'canvasCallout', attrs: { calloutType: 'note', fold: null },
    content: [{ type: 'canvasCalloutTitle', content }, { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] }) },
  { name: 'details summary', wrap: (content) => ({ type: 'canvasDetails', attrs: { open: false },
    content: [{ type: 'canvasDetailsSummary', content }, { type: 'canvasDetailsContent',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] }] }) },
];
let verified = 0;
for (const wrapper of wrappers) for (const fixture of cases) {
  const node = schema.nodeFromJSON({ type: 'doc', content: [wrapper.wrap(fixture.content)] }); node.check();
  const xml = TiptapTransformer.toYdoc(generateUniqueIds(node.toJSON(), extensions), 'body', extensions);
  const blocks = convertRichMarkdownYDoc(xml, 'tiptap_blocks');
  try {
    for (const doc of [xml, blocks]) {
      const before = readRichDocumentJson(doc);
      const result = validateRichMarkdownYDoc(doc);
      assert.equal(result.valid, true, `${wrapper.name}/${fixture.name}: ${JSON.stringify(result)}; ${richMarkdownFromYDoc(doc)}`);
      assert.deepEqual(readRichDocumentJson(doc), before, 'checkpoint validation never rewrites marked spaces');
      if (wrapper.name === 'paragraph') verifyStandardRendering(richMarkdownFromYDoc(doc), fixture.content, fixture.name);
      verified++;
    }
  } finally { xml.destroy(); blocks.destroy(); }
}
console.log(`${verified} marked-whitespace roundtrips preserve text, marks and identities in XML and block documents.`);
