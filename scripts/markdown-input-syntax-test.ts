import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import type { RichTextCollaborationRepresentation } from '../app/lib/collaboration/types';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'HTMLDetailsElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function fixture(markdown: string, representation: RichTextCollaborationRepresentation) {
  const doc = createRichMarkdownYDoc(markdown, representation);
  const errors: Error[] = [];
  const editor = new Editor({ extensions: [
    ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit'
      ? extension.configure({ undoRedo: false }) : extension.name === 'uniqueID'
        ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction: Transaction) => !isRemoteRichEditorTransaction(transaction) })
        : extension),
    ...createRichEditorCollaborationExtensions({ document: doc, representation, awareness: null,
      user: { name: 'Syntax fixture', color: '#123456' }, onError: (error) => errors.push(error) }),
  ] });
  return { doc, editor, errors, close: () => { editor.destroy(); doc.destroy(); } };
}

/** Invoke the actual installed InputRules plugin, then the normal text insertion fallback. */
function typeText(editor: Editor, value: string) {
  for (const character of value) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    const handled = editor.view.someProp('handleTextInput', (handler) => handler(editor.view, from, to, character, insert));
    if (!handled) editor.view.dispatch(insert());
  }
}

function preserved(doc: Y.Doc, projectable = true) {
  const expected = readRichDocumentJson(doc);
  const reload = new Y.Doc();
  try {
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    assert.deepEqual(readRichDocumentJson(reload), expected, 'binary reload preserves identities, marks and characters');
    const validation = validateRichMarkdownYDoc(reload);
    assert.equal(validation.valid, projectable, JSON.stringify(validation));
    if (!projectable) { assert.equal(validation.code, 'roundtrip_unstable'); return; }
    const markdown = richMarkdownFromYDoc(reload);
    const parsed = createRichMarkdownYDoc(markdown);
    try {
      assert.equal(equivalentRichDocument(expected, readRichDocumentJson(parsed)), true, 'projected syntax retains the authored meaning');
      assert.equal(richMarkdownFromYDoc(parsed), markdown, 'second projection is stable');
    } finally { parsed.destroy(); }
  } finally { reload.destroy(); }
}

const rules = [
  { prefix: '## ', type: 'heading', attrs: { level: 2 }, text: 'Heading # literal' },
  { prefix: '- ', type: 'bulletList', text: 'List item' },
  { prefix: '1. ', type: 'orderedList', attrs: { start: 1 }, text: 'Numbered item' },
  { prefix: '> ', type: 'blockquote', text: 'Quoted text' },
  { prefix: '```ts ', type: 'codeBlock', attrs: { language: 'ts' }, text: 'const fence = "```"; // \\ | * _' },
  { prefix: '[ ] ', type: 'taskList', text: 'Unchecked task' },
];

for (const representation of ['tiptap_blocks', 'tiptap_xml'] as const) {
  for (const rule of rules) test(`${representation}: actual ${rule.type} input rule keeps valid Markdown syntax`, async () => {
    const current = fixture('', representation);
    try {
      await Promise.resolve();
      typeText(current.editor, rule.prefix);
      assert.equal(current.editor.state.doc.firstChild?.type.name, rule.type);
      for (const [key, value] of Object.entries(rule.attrs ?? {})) assert.equal(current.editor.state.doc.firstChild?.attrs[key], value);
      typeText(current.editor, rule.text);
      assert.equal(current.editor.state.doc.firstChild?.textContent, rule.text);
      preserved(current.doc);
      assert.deepEqual(current.errors, []);
    } finally { current.close(); }
  });

  test(`${representation}: literal delimiters, soft newlines and authored hard breaks remain distinct`, async () => {
    const current = fixture('Soft\nline\n\nLiteral: ', representation);
    try {
      await Promise.resolve();
      const last = current.editor.state.doc.lastChild!;
      current.editor.commands.setTextSelection(current.editor.state.doc.content.size - 1);
      typeText(current.editor, '* _ # > ` \\ |');
      assert.equal(current.editor.commands.setHardBreak(), true);
      typeText(current.editor, 'After  two spaces');
      assert.equal(current.editor.state.doc.firstChild?.textContent, 'Soft\nline');
      assert.equal(current.editor.state.doc.lastChild?.attrs.id, last.attrs.id);
      assert.equal(current.editor.state.doc.lastChild?.child(1).type.name, 'hardBreak');
      preserved(current.doc);
    } finally { current.close(); }
  });

  test(`${representation}: unrepresentable table code remains editable and binary durable, then recovers after removing its mark`, async () => {
    const current = fixture('| First | Second |\n| --- | --- |\n| Seed | Neighbor |', representation);
    const peer = new Y.Doc();
    try {
      await Promise.resolve();
      let start = -1;
      current.editor.state.doc.descendants((node, position) => { if (node.isText && node.text === 'Seed') start = position; });
      assert(start > 0);
      current.editor.commands.setTextSelection({ from: start, to: start + 4 });
      typeText(current.editor, 'odd\\|pipe');
      preserved(current.doc);
      current.editor.commands.setTextSelection({ from: start, to: start + 9 });
      assert.equal(current.editor.commands.toggleCode(), true);
      preserved(current.doc, false);
      assert.equal(current.editor.isEditable, true);
      current.editor.commands.setTextSelection(start + 9);
      typeText(current.editor, ' remains editable');
      preserved(current.doc, false);
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(current.doc));
      assert.deepEqual(readRichDocumentJson(peer), readRichDocumentJson(current.doc), 'a peer receives exact unprojectable content');
      current.editor.commands.setTextSelection({ from: start, to: start + 'odd\\|pipe remains editable'.length });
      assert.equal(current.editor.commands.unsetCode(), true);
      preserved(current.doc);
      assert.deepEqual(current.errors, [], 'projection validation must not break the live editor');
    } finally { peer.destroy(); current.close(); }
  });
}
