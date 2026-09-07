import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import { CanvasUniqueID as UniqueID } from '../app/lib/editor/canvas-unique-id';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true },
  document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true },
  HTMLElement: { value: dom.window.HTMLElement, configurable: true },
  Element: { value: dom.window.Element, configurable: true },
  Node: { value: dom.window.Node, configurable: true },
  getComputedStyle: { value: dom.window.getComputedStyle, configurable: true },
});

const doc = createRichMarkdownYDoc('1. First item\n2. Middle item\n3. Last item');
const editor = new Editor({
  element: document.createElement('div'),
  extensions: [
    ...richMarkdownCodecExtensions().filter((extension) => extension.name !== 'uniqueID'),
    UniqueID.configure({ types: 'all', filterTransaction: (transaction) => !isChangeOrigin(transaction) }),
    Collaboration.configure({ document: doc, field: 'body' }),
  ],
});
try {
  let middle = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.textContent === 'Middle item') middle = pos + 1;
  });
  assert.ok(middle);
  editor.commands.setTextSelection({ from: middle, to: middle + 'Middle item'.length });
  editor.commands.deleteSelection();
  assert.equal(validateRichMarkdownYDoc(doc).valid, true, 'empty list item checkpoints');
  editor.commands.liftListItem('listItem');
  const validation = validateRichMarkdownYDoc(doc);
  assert.equal(validation.valid, true, `lifting the empty middle item checkpoints: ${validation.code}`);
  assert.match(richMarkdownFromYDoc(doc), /First item/u);
  assert.match(richMarkdownFromYDoc(doc), /Last item/u);
  console.log('List split maintains unique identities and a valid checkpoint.');
} finally {
  editor.destroy();
  doc.destroy();
  dom.window.close();
}
