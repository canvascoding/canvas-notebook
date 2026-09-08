import assert from 'node:assert/strict';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { Marked } from 'canvas-markdown-parser';
import { JSDOM } from 'jsdom';
import { createRichMarkdownManager, richMarkdownCodecExtensions, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';
import { TiptapTransformer } from '../app/lib/collaboration/server-runtime';
import { convertRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';

const text = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const br = (marks?: JSONContent['marks']): JSONContent => ({ type: 'hardBreak', ...(marks ? { marks } : {}) });
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const fixtures = [
  { name: 'single break', blocks: [p(text('A'), br(), text('B'))] },
  { name: 'two breaks', blocks: [p(text('A'), br(), br(), text('B'))] },
  { name: 'three breaks', blocks: [p(text('A'), br(), br(), br(), text('B'))] },
  { name: 'leading breaks', blocks: [p(br(), br(), text('B'))] },
  { name: 'trailing breaks', blocks: [p(text('A'), br(), br())] },
  { name: 'only breaks', blocks: [p(br(), br())] },
  { name: 'paragraphs', blocks: [p(text('A')), p(text('B'))] },
  { name: 'trailing break then paragraph', blocks: [p(text('A'), br()), p(text('B'))] },
  { name: 'paragraph then leading break', blocks: [p(text('A')), p(br(), text('B'))] },
  { name: 'both paragraph edges', blocks: [p(text('A'), br()), p(br(), text('B'))] },
  { name: 'empty middle paragraph', blocks: [p(text('A'), br()), p(), p(br(), text('B'))] },
  { name: 'empty outer paragraphs', blocks: [p(), p(br(), br()), p()] },
  { name: 'formatted text around breaks', blocks: [p(text(' A ', [{ type: 'bold' }]), br(), br(), text(' B ', [{ type: 'italic' }]))] },
  { name: 'formatted breaks', blocks: [p(text('A'), br([{ type: 'bold' }]), br([{ type: 'italic' }, { type: 'underline' }]), text('B'))] },
  { name: 'code marked break', blocks: [p(text('A'), br([{ type: 'code' }]), br(), text('B'))] },
  { name: 'linked break', blocks: [p(text('A'), br([{ type: 'link', attrs: { href: 'https://example.com',
    target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }]), br(), text('B'))] },
];
const extensions = richMarkdownCodecExtensions();
const schema = getSchema(extensions);
let verified = 0;
for (const fixture of fixtures) {
  const json: JSONContent = { type: 'doc', content: [{ type: 'table', content: [true, false].map((header) => ({
    type: 'tableRow', content: [
      { type: header ? 'tableHeader' : 'tableCell', content: fixture.blocks },
      { type: header ? 'tableHeader' : 'tableCell', content: [p(text('<br><br> <br data-canvas-hard-break> | neighbor', [{ type: 'code' }]))] },
    ],
  })) }] };
  const node = schema.nodeFromJSON(json); node.check();
  const xml = TiptapTransformer.toYdoc(generateUniqueIds(node.toJSON(), extensions), 'body', extensions);
  const blocks = convertRichMarkdownYDoc(xml, 'tiptap_blocks');
  try {
    for (const doc of [xml, blocks]) {
      const before = readRichDocumentJson(doc);
      const result = validateRichMarkdownYDoc(doc);
      assert.equal(result.valid, true, `${fixture.name}: ${JSON.stringify(result)}`);
      assert.deepEqual(readRichDocumentJson(doc), before, `${fixture.name}: no validation side effects`);
      const markdown = richMarkdownFromYDoc(doc);
      const dom = new JSDOM(new Marked({ gfm: true }).parse(markdown, { async: false }));
      try {
        const rows = Array.from(dom.window.document.querySelectorAll('tr')); assert.equal(rows.length, 2);
        for (const row of rows) {
          assert.equal(row.children.length, 2);
          assert.equal(row.children[1].querySelectorAll('br').length, 0, 'code-like break markers stay literal');
          assert.equal(row.children[1].textContent, '<br><br> <br data-canvas-hard-break> | neighbor', 'literal code and neighboring cells are unchanged');
          const actual: string[] = [];
          const collect = (node: globalThis.Node) => {
            if (node.nodeType === dom.window.Node.TEXT_NODE) actual.push(node.textContent ?? '');
            else if ((node as Element).tagName === 'BR') actual.push('\n');
            else for (const child of Array.from(node.childNodes)) collect(child);
          };
          collect(row.children[0]);
          const expected = fixture.blocks.map((block) => (block.content ?? [])
            .map((inline) => inline.type === 'hardBreak' ? '\n' : inline.text ?? '').join('')).join('\n\n');
          assert.equal(actual.join(''), expected, `${fixture.name}: standard GFM break placement`);
        }
      } finally { dom.window.close(); }
      verified++;
    }
  } finally { xml.destroy(); blocks.destroy(); }
}

const legacy = '| A | B |\n|---|---|\n| One<br>Two<br><br>Three | four |\n';
const normalized = '\n| A                       | B    |\n| ----------------------- | ---- |\n| One<br>Two<br><br>Three | four |\n';
assert.equal(serializeRichMarkdownBody(legacy), normalized);
const manager = createRichMarkdownManager();
const table = manager.parse(legacy).content?.find((node) => node.type === 'table');
const cell = table?.content?.[1].content?.[0];
assert.equal(cell?.content?.length, 2, 'legacy two-BR paragraph meaning is retained');
assert.equal(cell?.content?.[0].content?.[1].type, 'hardBreak');
console.log(`${verified} table break/paragraph roundtrips preserve structure, mark coverage, neighboring cells and standard GFM rendering.`);

const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const editor = new Editor({ extensions: richMarkdownCodecExtensions(), content: '| Head | Other |\n|---|---|\n| A B | Neighbor |', contentType: 'markdown' });
try {
  let position: number | null = null;
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'A B') position = pos + 1; });
  assert.notEqual(position, null);
  editor.commands.setTextSelection(position!);
  editor.view.dispatch(closeHistory(editor.state.tr));
  const before = editor.getJSON();
  assert.equal(editor.chain().setHardBreak().setHardBreak().splitBlock().run(), true);
  const changed = editor.getJSON() as JSONContent;
  const cell = changed.content?.[0].content?.[1].content?.[0];
  assert.equal(cell?.content?.length, 2);
  assert.equal(cell?.content?.[0].content?.filter((node) => node.type === 'hardBreak').length, 2);
  const reloaded = new Editor({ extensions: richMarkdownCodecExtensions(), content: editor.getMarkdown(), contentType: 'markdown' });
  try { assert.equal(equivalentRichDocument(changed, reloaded.getJSON()), true, 'actual editor commands survive serialization and reload'); }
  finally { reloaded.destroy(); }
  assert.equal(editor.commands.undo(), true);
  assert.equal(equivalentRichDocument(before, editor.getJSON()), true, 'the command group has one undo unit');
  assert.equal(editor.commands.redo(), true);
  assert.equal(equivalentRichDocument(changed, editor.getJSON()), true);
  console.log('Actual table hard-break/split commands preserve paragraphs and breaks across reload and undo/redo in JSDOM.');
} finally { editor.destroy(); dom.window.close(); }
