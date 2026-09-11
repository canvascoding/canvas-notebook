import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { createRichMarkdownYDoc, richMarkdownFromYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import type { RichTextCollaborationRepresentation } from '../app/lib/collaboration/types';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'HTMLDetailsElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function createEditor(doc: Y.Doc, representation: RichTextCollaborationRepresentation, errors: Error[]): Editor {
  return new Editor({
    extensions: [
      ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit'
        ? extension.configure({ undoRedo: false })
        : extension.name === 'uniqueID'
          ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction: Transaction) => !isRemoteRichEditorTransaction(transaction) })
          : extension),
      ...createRichEditorCollaborationExtensions({ document: doc, representation, awareness: null,
        user: { name: 'Deletion test', color: '#123456' }, onError: (error) => errors.push(error) }),
    ],
  });
}

function textblockPosition(editor: Editor, text: string): number {
  const positions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.isTextblock && node.textContent === text) positions.push(position);
  });
  assert.equal(positions.length, 1, `expected exactly one textblock containing ${JSON.stringify(text)}`);
  return positions[0];
}

/** Binary persistence and live replication must preserve IDs, marks and exact whitespace. */
function assertPreservedAndProjectable(doc: Y.Doc, peer: Y.Doc, editor: Editor, other: Editor): void {
  const expected = readRichDocumentJson(doc);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(peer)), 'remote');
  assert.deepEqual(readRichDocumentJson(peer), expected, 'the peer receives exact document content and identities');
  assert.deepEqual(other.getJSON(), editor.getJSON(), 'both mounted editors agree');
  const restored = new Y.Doc();
  try {
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    assert.deepEqual(readRichDocumentJson(restored), expected, 'binary reload retains exact content and identities');
    for (const [label, current] of [['local', doc], ['peer', peer], ['reloaded', restored]] as const) {
      const result = validateRichMarkdownYDoc(current);
      assert.equal(result.valid, true, `${label} must remain projectable after deletion: ${JSON.stringify(result)}`);
    }
    const markdown = richMarkdownFromYDoc(doc);
    const roundtrip = createRichMarkdownYDoc(markdown);
    try {
      assert.equal(equivalentRichDocument(expected, readRichDocumentJson(roundtrip)), true,
        'Markdown reparsing preserves the authored structure, marks and whitespace, not merely its serialized string');
      assert.equal(richMarkdownFromYDoc(roundtrip), markdown, 'a second Markdown projection is stable');
    } finally { roundtrip.destroy(); }
  } finally { restored.destroy(); }
}

type DeletionCase = {
  name: string;
  markdown: string;
  text: string;
  from: number;
  to: number;
  expectedText: string;
  expectedInline?: string[];
  expectedMarks?: string[][];
  insertBreaks?: { offset: number; count: number };
  deleteAgain?: { from: number; to: number };
};

const cases: DeletionCase[] = [
  { name: 'deleting bold list prefix retains the unmarked leading space', markdown: '- **One** two\n- Three', text: 'One two', from: 0, to: 3, expectedText: ' two' },
  { name: 'deleting bold list suffix retains the unmarked trailing space', markdown: '- One **two**\n- Three', text: 'One two', from: 4, to: 7, expectedText: 'One ' },
  { name: 'deleting heading prefix retains the leading space', markdown: '# One two', text: 'One two', from: 0, to: 3, expectedText: ' two' },
  { name: 'deleting heading suffix retains the trailing space', markdown: '# One two', text: 'One two', from: 4, to: 7, expectedText: 'One ' },
  { name: 'deleting table-cell prefix retains the leading space', markdown: '| Heading | Other |\n| --- | --- |\n| One two | Unchanged |', text: 'One two', from: 0, to: 3, expectedText: ' two' },
  { name: 'deleting table-cell suffix retains the trailing space', markdown: '| Heading | Other |\n| --- | --- |\n| One two | Unchanged |', text: 'One two', from: 4, to: 7, expectedText: 'One ' },
  { name: 'deleting text before a hard break retains the leading break', markdown: 'A\\\nB', text: 'AB', from: 0, to: 1, expectedText: 'B', expectedInline: ['hardBreak', 'text'] },
  { name: 'deleting text after a hard break retains the trailing break', markdown: 'A\\\nB', text: 'AB', from: 2, to: 3, expectedText: 'A', expectedInline: ['text', 'hardBreak'] },
  { name: 'deleting first line content retains the leading soft newline', markdown: 'A\nB\nC', text: 'A\nB\nC', from: 0, to: 1, expectedText: '\nB\nC' },
  { name: 'deleting last line content retains the trailing soft newline', markdown: 'A\nB\nC', text: 'A\nB\nC', from: 4, to: 5, expectedText: 'A\nB\n' },
  { name: 'emptying a heading retains the heading block', markdown: '# Heading', text: 'Heading', from: 0, to: 7, expectedText: '', expectedInline: [] },
  { name: 'emptying a table cell retains the table structure', markdown: '| Heading | Other |\n| --- | --- |\n| One two | Unchanged |', text: 'One two', from: 0, to: 7, expectedText: '', expectedInline: [] },
  { name: 'deleting text before consecutive hard breaks retains both breaks', markdown: 'AB', text: 'AB', insertBreaks: { offset: 1, count: 2 }, from: 0, to: 1, expectedText: 'B', expectedInline: ['hardBreak', 'hardBreak', 'text'] },
  { name: 'deleting text after consecutive hard breaks retains both breaks', markdown: 'AB', text: 'AB', insertBreaks: { offset: 1, count: 2 }, from: 3, to: 4, expectedText: 'A', expectedInline: ['text', 'hardBreak', 'hardBreak'] },
  { name: 'deleting heading text after a hard break retains the heading and break', markdown: '# AB', text: 'AB', insertBreaks: { offset: 1, count: 1 }, from: 2, to: 3, expectedText: 'A', expectedInline: ['text', 'hardBreak'] },
  { name: 'deleting heading text before a hard break retains the break and following text', markdown: '# AB', text: 'AB', insertBreaks: { offset: 1, count: 1 }, from: 0, to: 1, expectedText: 'B', expectedInline: ['hardBreak', 'text'] },
  { name: 'deleting inline-code prefix retains the code-marked leading space', markdown: '`A B`', text: 'A B', from: 0, to: 1, expectedText: ' B', expectedInline: ['text'], expectedMarks: [['code']] },
  { name: 'deleting inline-code suffix retains the code-marked trailing space', markdown: '`A B`', text: 'A B', from: 2, to: 3, expectedText: 'A ', expectedInline: ['text'], expectedMarks: [['code']] },
  { name: 'deleting inline-code words retains the code-marked space between them', markdown: '`A B`', text: 'A B', from: 2, to: 3, deleteAgain: { from: 0, to: 1 }, expectedText: ' ', expectedInline: ['text'], expectedMarks: [['code']] },
];

for (const representation of ['tiptap_blocks', 'tiptap_xml'] as const) {
  for (const scenario of cases) {
    test(`${representation}: ${scenario.name}`, async () => {
      const doc = createRichMarkdownYDoc(scenario.markdown, representation);
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const errors: Error[] = [];
      const editor = createEditor(doc, representation, errors);
      const other = createEditor(peer, representation, errors);
      try {
        await Promise.resolve();
        assert.equal(validateRichMarkdownYDoc(doc).valid, true, 'the initial supported Markdown must be valid');
        const position = textblockPosition(editor, scenario.text);
        const original = editor.state.doc.nodeAt(position)!;
        const blockId = original.attrs.id;
        assert.ok(blockId, 'the edited textblock has an identity before deletion');
        if (scenario.insertBreaks) {
          assert.equal(editor.commands.insertContentAt(position + 1 + scenario.insertBreaks.offset,
            Array.from({ length: scenario.insertBreaks.count }, () => ({ type: 'hardBreak' }))), true);
        }
        assert.equal(editor.commands.deleteRange({ from: position + 1 + scenario.from, to: position + 1 + scenario.to }), true);
        if (scenario.deleteAgain) {
          assert.equal(editor.commands.deleteRange({ from: position + 1 + scenario.deleteAgain.from,
            to: position + 1 + scenario.deleteAgain.to }), true);
        }
        await Promise.resolve();
        const edited = editor.state.doc.nodeAt(position)!;
        assert.equal(edited.attrs.id, blockId, 'text deletion must not replace the containing block');
        assert.equal(edited.type.name, original.type.name);
        assert.equal(edited.textContent, scenario.expectedText, 'the editor retains exactly the undeleted text');
        if (scenario.expectedInline) {
          assert.deepEqual(Array.from({ length: edited.childCount }, (_, index) => edited.child(index).type.name), scenario.expectedInline);
        }
        if (scenario.expectedMarks) {
          assert.deepEqual(Array.from({ length: edited.childCount }, (_, index) => edited.child(index).marks.map((mark) => mark.type.name)), scenario.expectedMarks);
        }
        assertPreservedAndProjectable(doc, peer, editor, other);
        assert.deepEqual(errors, []);
      } finally { editor.destroy(); other.destroy(); doc.destroy(); peer.destroy(); }
    });
  }

  test(`${representation}: deleting a table-cell prefix preserves a literal newline as soft text`, async () => {
    const doc = createRichMarkdownYDoc('| Heading | Other |\n| --- | --- |\n| Seed | Unchanged |', representation);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const errors: Error[] = [];
    const editor = createEditor(doc, representation, errors);
    const other = createEditor(peer, representation, errors);
    try {
      await Promise.resolve();
      assert.equal(validateRichMarkdownYDoc(doc).valid, true, 'the initial table is supported before the text edit');
      const position = textblockPosition(editor, 'Seed');
      const id = editor.state.doc.nodeAt(position)!.attrs.id;
      editor.view.dispatch(editor.state.tr.insertText('Prefix A\nB', position + 1, position + 5));
      assert.equal(editor.commands.deleteRange({ from: position + 1, to: position + 8 }), true);
      await Promise.resolve();
      const cell = editor.state.doc.firstChild!.child(1).child(0);
      assert.equal(cell.type.name, 'tableCell');
      assert.equal(cell.childCount, 1, 'a soft newline does not create another cell paragraph');
      const paragraph = cell.firstChild!;
      assert.equal(paragraph.attrs.id, id);
      assert.equal(paragraph.childCount, 1, 'a soft newline must not become a hardBreak node');
      assert.equal(paragraph.firstChild!.isText, true);
      assert.equal(paragraph.firstChild!.text, 'A\nB');
      assert.deepEqual(paragraph.firstChild!.marks, []);
      assert.equal(editor.state.doc.firstChild!.child(1).child(1).textContent, 'Unchanged');
      assertPreservedAndProjectable(doc, peer, editor, other);
      assert.deepEqual(errors, []);
    } finally { editor.destroy(); other.destroy(); doc.destroy(); peer.destroy(); }
  });

  for (const literalText of ['A  \nB', 'A\n\nB']) {
    test(`${representation}: deleting a prefix preserves literal ${JSON.stringify(literalText)} as one paragraph of text`, async () => {
      const doc = createRichMarkdownYDoc('Seed', representation);
      const peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const errors: Error[] = [];
      const editor = createEditor(doc, representation, errors);
      const other = createEditor(peer, representation, errors);
      try {
        await Promise.resolve();
        const id = editor.state.doc.firstChild!.attrs.id;
        editor.view.dispatch(editor.state.tr.insertText(`Prefix ${literalText}`, 1, 5));
        assert.equal(editor.commands.deleteRange({ from: 1, to: 8 }), true);
        await Promise.resolve();
        assert.equal(editor.state.doc.childCount, 1, 'literal blank lines must not split the paragraph');
        const paragraph = editor.state.doc.firstChild!;
        assert.equal(paragraph.type.name, 'paragraph');
        assert.equal(paragraph.attrs.id, id);
        assert.equal(paragraph.childCount, 1, 'literal line endings must not become hardBreak nodes');
        assert.equal(paragraph.firstChild!.isText, true);
        assert.equal(paragraph.firstChild!.text, literalText);
        assertPreservedAndProjectable(doc, peer, editor, other);
        assert.deepEqual(errors, []);
      } finally { editor.destroy(); other.destroy(); doc.destroy(); peer.destroy(); }
    });
  }

  test(`${representation}: deletion distinguishes an authored NBSP-only paragraph from an empty paragraph`, async () => {
    const doc = createRichMarkdownYDoc('A\u00a0B', representation);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const errors: Error[] = [];
    const editor = createEditor(doc, representation, errors);
    const other = createEditor(peer, representation, errors);
    try {
      await Promise.resolve();
      const id = editor.state.doc.firstChild!.attrs.id;
      assert.equal(editor.commands.deleteRange({ from: 3, to: 4 }), true);
      assert.equal(editor.commands.deleteRange({ from: 1, to: 2 }), true);
      assert.equal(editor.state.doc.firstChild!.textContent, '\u00a0');
      assert.equal(editor.state.doc.firstChild!.childCount, 1, 'the authored nonbreaking space remains a text node');
      assert.equal(editor.state.doc.firstChild!.attrs.id, id);
      assertPreservedAndProjectable(doc, peer, editor, other);
      const withAuthoredSpace = richMarkdownFromYDoc(doc);
      assert.equal(editor.commands.deleteRange({ from: 1, to: 2 }), true);
      assert.equal(editor.state.doc.firstChild!.childCount, 0, 'removing the last character leaves a genuinely empty paragraph');
      assert.equal(editor.state.doc.firstChild!.attrs.id, id);
      assertPreservedAndProjectable(doc, peer, editor, other);
      assert.notEqual(richMarkdownFromYDoc(doc), withAuthoredSpace, 'empty-block encoding must not consume authored whitespace');
      assert.deepEqual(errors, []);
    } finally { editor.destroy(); other.destroy(); doc.destroy(); peer.destroy(); }
  });

  test(`${representation}: deleting a whole block retains a concurrent edit and surviving block identities`, async () => {
    const doc = createRichMarkdownYDoc('AAA\n\nBBB\n\nCCC', representation);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const errors: Error[] = [];
    const editor = createEditor(doc, representation, errors);
    const other = createEditor(peer, representation, errors);
    try {
      await Promise.resolve();
      const firstId = editor.state.doc.child(0).attrs.id;
      const deletedId = editor.state.doc.child(1).attrs.id;
      const lastId = editor.state.doc.child(2).attrs.id;
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, textblockPosition(editor, 'BBB'))));
      assert.equal(editor.commands.deleteSelection(), true);
      const peerPosition = textblockPosition(other, 'CCC');
      other.view.dispatch(other.state.tr.insertText(' shared', peerPosition + 4));
      const localUpdate = Y.encodeStateAsUpdate(doc);
      const remoteUpdate = Y.encodeStateAsUpdate(peer);
      Y.applyUpdate(doc, remoteUpdate, 'remote');
      Y.applyUpdate(peer, localUpdate, 'remote');
      await Promise.resolve();
      assert.equal(editor.state.doc.childCount, 2);
      assert.deepEqual([editor.state.doc.child(0).textContent, editor.state.doc.child(1).textContent], ['AAA', 'CCC shared']);
      assert.deepEqual([editor.state.doc.child(0).attrs.id, editor.state.doc.child(1).attrs.id], [firstId, lastId]);
      assert.ok(!JSON.stringify(editor.getJSON()).includes(deletedId), 'the deleted block is not resurrected by the peer update');
      assertPreservedAndProjectable(doc, peer, editor, other);
      assert.deepEqual(errors, []);
    } finally { editor.destroy(); other.destroy(); doc.destroy(); peer.destroy(); }
  });
}
