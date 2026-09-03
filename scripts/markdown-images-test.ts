import assert from 'node:assert/strict';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { CANVAS_MARKDOWN_REMARK_PLUGINS } from '../app/lib/markdown/canvas-markdown';
import { parsePortableImage, serializePortableImage } from '../app/lib/markdown/core/portable-image';
import { renderMarkdownForPdf } from '../app/lib/pdf/markdown-renderer';
import { Editor } from '@tiptap/core';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';

async function main() {
  const image = { src: 'assets/diagram.png', alt: 'A & B', title: 'A "title"', width: 240, height: null, align: 'center' as const };
  const markdown = serializePortableImage(image);
  assert.deepEqual(parsePortableImage(markdown), image);
  for (const invalid of [markdown.replace('width="240"', 'width="0"'), markdown.replace('<img ', '<img onerror="alert(1)" '), markdown.replace('height:auto;', 'position:fixed;'), markdown.replace('width="240"', 'width="240" width="160"')]) {
    assert.equal(parsePortableImage(invalid), null);
  }
  for (const html of [renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: CANVAS_MARKDOWN_REMARK_PLUGINS }, markdown)), await renderMarkdownForPdf(markdown)]) {
    const node = new JSDOM(html).window.document.querySelector('img')!;
    assert.equal(node.getAttribute('src'), image.src);
    assert.equal(node.getAttribute('width'), '240');
    assert.equal(node.getAttribute('alt'), image.alt);
    assert.equal(node.style.marginLeft, 'auto');
    assert.equal(node.style.marginRight, 'auto');
  }
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window','document','DOMParser','navigator','Node','HTMLElement','MutationObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const editor = new Editor({ extensions: richMarkdownCodecExtensions(), content: '![Diagram](assets/diagram.png)', contentType: 'markdown' });
  editor.commands.setNodeSelection(0);
  assert.equal(editor.commands.updateAttributes('image', { width: 240, align: 'right' }), true);
  const changed = editor.getJSON();
  const reloaded = new Editor({ extensions: richMarkdownCodecExtensions(), content: editor.getMarkdown(), contentType: 'markdown' });
  assert.equal(equivalentRichDocument(changed, reloaded.getJSON()), true);
  assert.equal(editor.commands.undo(), true);
  assert.equal(editor.getMarkdown().trimEnd(), '![Diagram](assets/diagram.png)');
  assert.equal(editor.commands.redo(), true);
  assert.equal(equivalentRichDocument(changed, editor.getJSON()), true);
  editor.destroy(); reloaded.destroy(); dom.window.close();
  console.log('Portable images: strict parsing, web/PDF rendering, edit/undo/redo/reload passed.');
}
void main();
