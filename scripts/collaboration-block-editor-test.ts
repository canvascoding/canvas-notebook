import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Editor, getSchema } from '@tiptap/core';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import { CellSelection } from '@tiptap/pm/tables';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';

import { createRichMarkdownYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { BlockTreePlacementNotice } from '../app/lib/collaboration/block-tree-editor';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { createEditorNodeTarget, createEditorRangeTarget, createEditorSelectionTarget, invalidateEditorTarget, resolveEditorNodeTarget, resolveEditorRangeTarget, resolveEditorSelectionTarget } from '../app/lib/editor/interaction-target';
import { moveMarkdownTablePart } from '../app/lib/markdown/core/table-commands';
import { insertMathAtRange, insertRichFootnoteAtRange, replaceRichBlockTitle, richBlockContentMarkdown, updateFootnoteDefinition } from '../app/lib/editor/rich-block-commands';
import tableEdits from '../app/lib/markdown/core/table-command-fixtures.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}

const schema = getSchema(richMarkdownCodecExtensions());

test('toolbar targets retain backward text, node and exact table cell selections through moves', async () => {
  const doc = createDocument('AAA\n\nBBB\n\n| A | B |\n| --- | --- |\n| one | two |');
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const tree = new CollaborationBlockTree(doc, schema);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 9, 6)));
    const text = createEditorSelectionTarget(editor);
    tree.move({ blockId: editor.state.doc.child(1).attrs.id, parentId: null, beforeId: editor.state.doc.child(0).attrs.id, operationId: 'backward-move' }, 'peer');
    const backward = resolveEditorSelectionTarget(editor, text)!;
    assert.equal(backward.anchor, 4);
    assert.equal(backward.head, 1);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    const node = createEditorSelectionTarget(editor);
    tree.move({ blockId: editor.state.doc.child(0).attrs.id, parentId: null, beforeId: null, operationId: 'node-move' }, 'peer');
    const nodeSelection = resolveEditorSelectionTarget(editor, node);
    assert.ok(nodeSelection instanceof NodeSelection);
    assert.equal(nodeSelection.node.textContent, 'BBB');
    assert.equal(nodeSelection.from, editor.state.doc.content.size - 5);
    const positions: number[] = [];
    editor.state.doc.descendants((child, from) => { if (child.type.spec.tableRole === 'cell') positions.push(from); });
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, positions[0], positions[1])));
    const cells = createEditorSelectionTarget(editor);
    const originalIds: string[] = [];
    (editor.state.selection as CellSelection).forEachCell((cell) => originalIds.push(cell.attrs.id));
    tree.move({ blockId: editor.state.doc.child(1).attrs.id, parentId: null, beforeId: null, operationId: 'table-move-again' }, 'peer');
    const restored = resolveEditorSelectionTarget(editor, cells);
    assert.ok(restored instanceof CellSelection);
    const restoredIds: string[] = [];
    restored.forEachCell((cell) => restoredIds.push(cell.attrs.id));
    assert.deepEqual(restoredIds, originalIds);
    editor.view.dispatch(editor.state.tr.setSelection(restored));
    editor.commands.addColumnAfter();
    // The range remains the same exact cells if a column is added outside it.
    assert.ok(resolveEditorSelectionTarget(editor, cells) instanceof CellSelection);
    editor.commands.setTextSelection(position(editor, 'one'));
    editor.view.dispatch(editor.state.tr.insertText('changed'));
    assert.equal(resolveEditorSelectionTarget(editor, cells), null);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('prepared image and emoji replacements follow a moved block and preserve neighbouring content', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const target = createEditorRangeTarget(editor, { from: 6, to: 9 });
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: editor.state.doc.child(1).attrs.id, parentId: null, beforeId: null, operationId: 'image-target-move' }, 'peer');
    const range = resolveEditorRangeTarget(editor, target)!;
    assert.ok(range);
    assert.equal(editor.chain().insertContentAt(range, [{ type: 'image', attrs: { src: 'attachments/example.png', alt: 'Example' } }]).run(), true);
    const images: string[] = [];
    editor.state.doc.descendants((node) => { if (node.type.name === 'image') images.push(node.attrs.src); });
    assert.deepEqual(images, ['attachments/example.png']);
    assert.equal(editor.state.doc.textContent, 'AAACCC');
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    editor.commands.undo();
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    const emoji = createEditorRangeTarget(editor, { from: 11, to: 14 });
    tree.move({ blockId: editor.state.doc.child(2).attrs.id, parentId: null, beforeId: editor.state.doc.child(0).attrs.id, operationId: 'emoji-target-move' }, 'peer');
    assert.equal(editor.chain().insertContentAt(resolveEditorRangeTarget(editor, emoji)!, '👩🏽‍💻').run(), true);
    assert.deepEqual(texts(editor), ['👩🏽‍💻', 'AAA', 'CCC']);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

for (const fixture of [
  { markdown: '> [!note] Title\n> Body', type: 'canvasCallout', title: 'canvasCalloutTitle', attrs: { calloutType: 'warning' } },
  { markdown: '<details>\n<summary>Title</summary>\n\nBody\n\n</details>', type: 'canvasDetails', title: 'canvasDetailsSummary', attrs: { open: true } },
]) test(`a ${fixture.type} dialog follows its moved node and rejects a concurrently changed draft`, async () => {
  const doc = createDocument(`AAA\n\n${fixture.markdown}\n\nCCC`);
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    assert.equal(editor.state.doc.child(1).type.name, fixture.type);
    const original = editor.state.doc.child(1);
    const target = createEditorNodeTarget(editor, 5);
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: original.attrs.id, parentId: null, beforeId: null, operationId: 'dialog-container-move' }, 'peer');
    const position = resolveEditorNodeTarget(editor, target)!;
    assert.equal(replaceRichBlockTitle(editor, position, fixture.type, fixture.title, 'Edited', fixture.attrs), true);
    const edited = editor.state.doc.nodeAt(position)!;
    assert.equal(edited.attrs.id, original.attrs.id);
    assert.equal(edited.firstChild!.attrs.id, original.firstChild!.attrs.id);
    assert.ok(edited.child(1).eq(original.child(1)));
    editor.commands.undo();
    assert.ok(editor.state.doc.nodeAt(position)!.eq(original));
    const another = createEditorNodeTarget(editor, position);
    let bodyId: string | undefined;
    original.descendants((node) => { if (node.inlineContent && node.textContent === 'Body') bodyId = node.attrs.id; });
    assert.ok(bodyId);
    (tree.content(bodyId).get(0) as Y.XmlText).insert(0, 'Remote ');
    assert.equal(resolveEditorNodeTarget(editor, another), null);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

for (const kind of ['inlineMath', 'blockMath'] as const) test(`${kind} replacement is a single undo action at a moved dialog target`, async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const target = createEditorRangeTarget(editor, { from: 6, to: 9 });
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: editor.state.doc.child(1).attrs.id, parentId: null, beforeId: null, operationId: 'math-target-move' }, 'peer');
    (tree.content(editor.state.doc.child(0).attrs.id).get(0) as Y.XmlText).insert(0, 'Remote ');
    const range = resolveEditorRangeTarget(editor, target)!;
    assert.equal(insertMathAtRange(editor, kind, 'x^2', range), true);
    let formulas = 0;
    editor.state.doc.descendants((node) => { if (node.type.name === kind) { formulas++; assert.equal(node.attrs.latex, 'x^2'); } });
    assert.equal(formulas, 1);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(texts(editor), ['Remote AAA', 'CCC', 'BBB']);
    editor.setEditable(false);
    assert.equal(insertMathAtRange(editor, kind, 'forbidden', { from: 1, to: 2 }), false);
    assert.deepEqual(texts(editor), ['Remote AAA', 'CCC', 'BBB']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('footnote editing uses the resolved definition position after a move', async () => {
  const doc = createDocument('AAA[^1]\n\nCCC\n\n[^1]: Original note');
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    let position = -1;
    editor.state.doc.descendants((node, from) => { if (node.type.name === 'markdownFootnoteDefinition') position = from; });
    const target = createEditorNodeTarget(editor, position);
    const original = editor.state.doc.nodeAt(position)!;
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: original.attrs.id, parentId: null, beforeId: editor.state.doc.child(0).attrs.id, operationId: 'definition-move' }, 'peer');
    const current = resolveEditorNodeTarget(editor, target)!;
    assert.equal(updateFootnoteDefinition(editor, current, 'Edited note'), true);
    assert.equal(editor.state.doc.nodeAt(current)!.firstChild!.attrs.id, original.firstChild!.attrs.id);
    assert.equal(editor.state.doc.nodeAt(current)!.textContent, 'Edited note');
    editor.commands.undo();
    assert.ok(editor.state.doc.nodeAt(current)!.eq(original));
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('table insertion resolves its prepared range after movement and is independently undoable', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const target = createEditorRangeTarget(editor, { from: 6, to: 9 });
    const tree = new CollaborationBlockTree(doc, schema);
    tree.move({ blockId: editor.state.doc.child(1).attrs.id, parentId: null, beforeId: null, operationId: 'table-dialog-move' }, 'peer');
    const range = resolveEditorRangeTarget(editor, target)!;
    assert.equal(editor.chain().setTextSelection(range).insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(), true);
    assert.equal(editor.state.doc.child(0).textContent, 'AAA');
    assert.equal(editor.state.doc.child(1).textContent, 'CCC');
    assert.equal(editor.state.doc.child(2).type.name, 'table');
    assert.equal(editor.state.doc.textContent, 'AAACCC');
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    editor.commands.undo();
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('changing callout attributes preserves an unchanged formatted title', async () => {
  const doc = createDocument('> [!note] **Title**\n> Body');
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const original = editor.state.doc.firstChild!;
    assert.equal(original.firstChild!.firstChild!.marks[0].type.name, 'bold');
    assert.equal(replaceRichBlockTitle(editor, 0, 'canvasCallout', 'canvasCalloutTitle', 'Title', { calloutType: 'warning' }), true);
    assert.ok(editor.state.doc.firstChild!.firstChild!.eq(original.firstChild!));
    assert.ok(editor.state.doc.firstChild!.child(1).eq(original.child(1)));
    assert.equal(editor.state.doc.firstChild!.attrs.calloutType, 'warning');
    editor.commands.undo();
    assert.ok(editor.state.doc.firstChild!.eq(original));
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('footnote drafts preserve multiple paragraphs, lists, marks and unchanged child identities', async () => {
  const doc = createDocument('AAA[^1]\n\n[^1]: **First** note.\n    \n    Second *paragraph*.\n    \n    - item\n    - another');
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const original = editor.state.doc.lastChild!;
    assert.equal(original.type.name, 'markdownFootnoteDefinition');
    assert.equal(original.childCount, 3);
    const position = editor.state.doc.content.size - original.nodeSize;
    const draft = richBlockContentMarkdown(editor, original)!;
    assert.match(draft, /\*\*First\*\*/);
    assert.match(draft, /Second \*paragraph\*/);
    assert.equal(updateFootnoteDefinition(editor, position, draft.replace('Second', 'Revised')), true);
    const edited = editor.state.doc.nodeAt(position)!;
    assert.equal(edited.childCount, 3, 'later paragraphs are not duplicated into the first one');
    assert.ok(edited.child(0).eq(original.child(0)));
    assert.equal(edited.child(1).attrs.id, original.child(1).attrs.id);
    assert.equal(edited.child(1).textContent, 'Revised paragraph.');
    assert.equal(edited.child(1).child(1).marks[0].type.name, 'italic');
    assert.ok(edited.child(2).eq(original.child(2)));
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    editor.commands.undo();
    assert.ok(editor.state.doc.nodeAt(position)!.eq(original));
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('a new Markdown footnote is inserted with its formatted body in one undo transaction', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    assert.equal(insertRichFootnoteAtRange(editor, '**First**\n\nSecond *paragraph*', { from: 6, to: 9 }), true);
    assert.deepEqual(errors, []);
    const definitions: import('@tiptap/pm/model').Node[] = [];
    editor.state.doc.descendants((node) => { if (node.type.name === 'markdownFootnoteDefinition') definitions.push(node); });
    assert.equal(definitions.length, 1);
    const definition = definitions[0];
    assert.equal(definition.childCount, 2);
    assert.equal(definition.child(0).firstChild!.marks[0].type.name, 'bold');
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    editor.commands.undo();
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

function createDocument(markdown = 'AAA\n\nBBB\n\nCCC') {
  const source = createRichMarkdownYDoc(markdown);
  const initial = initProseMirrorDoc(source.getXmlFragment('body'), schema).doc;
  source.destroy();
  const doc = new Y.Doc();
  CollaborationBlockTree.create(doc, initial);
  return doc;
}

function createEditor(doc: Y.Doc, errors: Error[], awareness?: Awareness) {
  return new Editor({
    extensions: [
      ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
        : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction: import('@tiptap/pm/state').Transaction) => !isRemoteRichEditorTransaction(transaction) }) : extension),
      ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: awareness ?? null,
        user: { name: 'Peer', color: '#123456' }, onError: (error) => errors.push(error) }),
    ],
  });
}

function position(editor: Editor, text: string): number {
  let result = -1;
  editor.state.doc.descendants((node, from) => { if (node.isText && node.text === text) result = from; });
  assert.ok(result >= 0, `missing ${text}`);
  return result;
}

function texts(editor: Editor): string[] {
  const result: string[] = [];
  editor.state.doc.forEach((node) => result.push(node.textContent));
  return result;
}

test('two real editors preserve concurrent edits, the move intention and selective undo', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const a = createEditor(left, errors);
  const b = createEditor(right, errors);
  try {
    await Promise.resolve();
    assert.deepEqual(texts(a), ['AAA', 'BBB', 'CCC']);
    const from = position(a, 'BBB');
    a.commands.setTextSelection(from + 1);
    const source = getReorderableBlockRangeAt(a, from)!;
    assert.equal(moveReorderableBlock(a, source, 0), true);
    const otherFrom = position(b, 'BBB');
    b.view.dispatch(b.state.tr.insertText('NEW', otherFrom, otherFrom + 3));
    const aUpdate = Y.encodeStateAsUpdate(left);
    const bUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, bUpdate);
    Y.applyUpdate(right, aUpdate);
    assert.deepEqual(texts(a), ['NEW', 'AAA', 'CCC']);
    assert.deepEqual(a.getJSON(), b.getJSON());
    assert.equal(a.commands.undo(), true);
    assert.deepEqual(texts(a), ['AAA', 'NEW', 'CCC']);
    assert.equal(a.commands.redo(), true);
    assert.deepEqual(texts(a), ['NEW', 'AAA', 'CCC']);
    assert.deepEqual(errors, []);
  } finally { a.destroy(); b.destroy(); left.destroy(); right.destroy(); }
});

for (const fixture of tableEdits) test(`table command through the block binding: ${fixture.name}`, async () => {
  const doc = createDocument('| A | B |\n| --- | --- |\n| one | two |\n| three | four |');
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  const reopened = new Y.Doc();
  try {
    await Promise.resolve();
    editor.commands.setTextSelection(position(editor, fixture.cell));
    if (fixture.initialAlign) editor.commands.setCellAttribute('align', fixture.initialAlign);
    const before = editor.getJSON();
    let changed: boolean;
    if (fixture.axis) changed = editor.commands.command((props) => moveMarkdownTablePart(props, fixture.axis as 'row' | 'column', fixture.direction as -1 | 1));
    else if (fixture.align) changed = editor.commands.setCellAttribute('align', fixture.align);
    else changed = editor.commands[fixture.command as 'addRowBefore' | 'addRowAfter' | 'deleteRow']();
    assert.equal(changed, true);
    const rows: string[][] = [];
    editor.state.doc.firstChild!.forEach((row, _offset, index) => {
      const cells: string[] = [];
      row.forEach((cell) => {
        assert.equal(cell.type.name, index === 0 ? 'tableHeader' : 'tableCell');
        cells.push(cell.textContent);
      });
      rows.push(cells);
    });
    assert.deepEqual(rows, fixture.rows);
    const after = editor.getJSON();
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
    assert.deepEqual(new CollaborationBlockTree(reopened, schema).read().toJSON(), after);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(errors, [], 'undo projects without an error');
    assert.deepEqual(new CollaborationBlockTree(doc, schema).read().toJSON(), editor.getJSON(), 'undo view matches storage');
    assert.deepEqual(editor.getJSON(), before, 'undo keeps the original identities');
    assert.equal(editor.commands.redo(), true);
    assert.deepEqual(editor.getJSON(), after, 'redo restores the same identities');
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); reopened.destroy(); }
});

test('lifting a middle list item and joining it back retains unaffected blocks and remote text', async () => {
  const left = createDocument('1. First item\n2. Middle item\n3. Last item');
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const a = createEditor(left, errors);
  const b = createEditor(right, errors);
  try {
    await Promise.resolve();
    const initial = a.getJSON();
    a.commands.setTextSelection(position(a, 'Middle item'));
    assert.equal(a.commands.liftListItem('listItem'), true);
    assert.deepEqual(errors, [], 'lifting is accepted by the structural adapter');
    assert.deepEqual(texts(a).filter(Boolean), ['First item', 'Middle item', 'Last item']);
    const last = position(b, 'Last item');
    b.view.dispatch(b.state.tr.insertText('updated Last item', last, last + 'Last item'.length));
    const aUpdate = Y.encodeStateAsUpdate(left);
    const bUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, bUpdate);
    Y.applyUpdate(right, aUpdate);
    assert.deepEqual(texts(a).filter(Boolean), ['First item', 'Middle item', 'updated Last item']);
    assert.deepEqual(a.getJSON(), b.getJSON());
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
    assert.equal(a.commands.undo(), true);
    assert.equal(a.state.doc.firstChild!.childCount, 3);
    assert.equal(a.state.doc.firstChild!.child(2).textContent, 'updated Last item');
    assert.equal(a.state.doc.firstChild!.attrs.id, initial.content![0].attrs!.id);
    assert.equal(a.commands.redo(), true);
    assert.deepEqual(texts(a).filter(Boolean), ['First item', 'Middle item', 'updated Last item']);
    assert.deepEqual(errors, []);
  } finally { a.destroy(); b.destroy(); left.destroy(); right.destroy(); }
});

test('splitting and joining text creates only the required identities through the live binding', async () => {
  const doc = createDocument('AlphaBeta\n\nNeighbor');
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const before = editor.getJSON();
    editor.commands.setTextSelection(position(editor, 'AlphaBeta') + 5);
    assert.equal(editor.commands.splitBlock(), true);
    const split = editor.getJSON();
    assert.deepEqual(texts(editor), ['Alpha', 'Beta', 'Neighbor']);
    assert.equal(split.content![0].attrs!.id, before.content![0].attrs!.id);
    assert.notEqual(split.content![1].attrs!.id, before.content![0].attrs!.id);
    assert.equal(split.content![2].attrs!.id, before.content![1].attrs!.id);
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    assert.equal(editor.commands.joinBackward(), true);
    assert.deepEqual(editor.getJSON(), before);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(editor.getJSON(), split);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(editor.getJSON(), before);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('loading and selecting a table never generates a local paragraph from deferred creation callbacks', async () => {
  const doc = createDocument('| A | B |\n| --- | --- |\n| one | two |');
  const before = Y.encodeStateAsUpdate(doc);
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(editor.state.doc.childCount, 1);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    editor.commands.setTextSelection(position(editor, 'one'));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before, 'selection is not a content edit');
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('local and remote cell highlights follow a moved column through the live binding', async () => {
  const left = createDocument('| A | B |\n| --- | --- |\n| one | two |');
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const aPresence = new Awareness(left);
  const bPresence = new Awareness(right);
  const errors: Error[] = [];
  const a = createEditor(left, errors, aPresence);
  const b = createEditor(right, errors, bPresence);
  document.body.append(a.view.dom, b.view.dom);
  try {
    await Promise.resolve();
    const aCell = a.state.doc.resolve(position(a, 'A')).before(3);
    const oneCell = a.state.doc.resolve(position(a, 'one')).before(3);
    a.view.focus();
    a.view.dispatch(a.state.tr.setSelection(CellSelection.create(a.state.doc, aCell, oneCell)));
    await Promise.resolve();
    applyAwarenessUpdate(bPresence, encodeAwarenessUpdate(aPresence, [left.clientID]), 'peer');
    const highlighted = () => [...b.view.dom.querySelectorAll('td.collaboration-carets__selection, th.collaboration-carets__selection')]
      .map((cell) => cell.querySelector('p')?.textContent);
    assert.deepEqual(highlighted(), ['A', 'one']);
    b.commands.setTextSelection(position(b, 'one'));
    assert.equal(b.commands.command((props) => moveMarkdownTablePart(props, 'column', 1)), true);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    assert.ok(a.state.selection instanceof CellSelection);
    const selected: string[] = [];
    a.state.selection.forEachCell((cell) => selected.push(cell.textContent));
    assert.deepEqual(selected, ['A', 'one']);
    assert.deepEqual(highlighted(), ['A', 'one']);
    assert.deepEqual(errors, []);
  } finally { a.destroy(); b.destroy(); aPresence.destroy(); bPresence.destroy(); left.destroy(); right.destroy(); }
});

test('a rejected concurrent placement is reported once while the valid document remains editable', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  left.clientID = 20;
  right.clientID = 10;
  const errors: Error[] = [];
  const editor = createEditor(left, errors);
  try {
    await Promise.resolve();
    const tree = new CollaborationBlockTree(left, schema);
    const initial = tree.read();
    tree.move({ blockId: initial.child(1).attrs.id, parentId: null, beforeId: initial.child(0).attrs.id, operationId: 'move-to-deleted-target' }, {});
    new CollaborationBlockTree(right, schema).delete(initial.child(0).attrs.id, 'delete-target', {});
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    assert.deepEqual(texts(editor), ['BBB', 'CCC']);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof BlockTreePlacementNotice);
    assert.equal(errors[0].count, 1);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    editor.view.dispatch(editor.state.tr.insertText('updated ', position(editor, 'BBB')));
    assert.deepEqual(texts(editor), ['updated BBB', 'CCC']);
    assert.equal(errors.length, 1, 'duplicate updates and subsequent typing do not repeat a notice');
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
  } finally { editor.destroy(); left.destroy(); right.destroy(); }
});

test('undo can resolve an incompatible row-column merge while preserving the peer column', async () => {
  const left = createDocument('| A | B |\n| --- | --- |\n| one | two |');
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const aErrors: Error[] = [];
  const bErrors: Error[] = [];
  const a = createEditor(left, aErrors);
  const b = createEditor(right, bErrors);
  try {
    await Promise.resolve();
    a.commands.setTextSelection(position(a, 'one'));
    assert.equal(a.commands.addRowAfter(), true);
    b.commands.setTextSelection(position(b, 'one'));
    assert.equal(b.commands.addColumnAfter(), true);
    const beforeMerge = a.getJSON();
    const aUpdate = Y.encodeStateAsUpdate(left);
    const bUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, bUpdate);
    Y.applyUpdate(right, aUpdate);
    assert.deepEqual(a.getJSON(), beforeMerge, 'the view keeps its last valid projection');
    assert.equal(validateRichMarkdownYDoc(left).valid, false);
    assert.equal(aErrors.length, 1);
    const blockedState = Y.encodeStateAsUpdate(left);
    a.commands.insertContent('must not write into an invalid projection');
    assert.deepEqual(Y.encodeStateAsUpdate(left), blockedState);
    assert.equal(a.commands.undo(), true, 'the user can undo their own incompatible row action');
    assert.equal(a.state.doc.firstChild!.childCount, 2);
    assert.equal(a.state.doc.firstChild!.firstChild!.childCount, 3, 'the peer column survives recovery');
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    assert.deepEqual(a.getJSON(), b.getJSON());
    const changed = position(a, 'one');
    a.view.dispatch(a.state.tr.insertText('updated ', changed));
    assert.match(a.state.doc.textContent, /updated one/);
  } finally { a.destroy(); b.destroy(); left.destroy(); right.destroy(); }
});

test('dialog targets follow block identity and relative text while rejecting changed node drafts', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const from = position(editor, 'BBB');
    const range = createEditorRangeTarget(editor, { from: from + 1, to: from + 2 })!;
    const node = createEditorNodeTarget(editor, from - 1)!;
    const tree = new CollaborationBlockTree(doc, schema);
    const id = tree.read().child(1).attrs.id;
    tree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'move-dialog-target' }, {});
    assert.equal(resolveEditorNodeTarget(editor, node), position(editor, 'BBB') - 1);
    (tree.content(id).get(0) as Y.XmlText).insert(0, 'prefix ');
    const current = resolveEditorRangeTarget(editor, range)!;
    assert.ok(current);
    assert.equal(editor.state.doc.textBetween(current.from, current.to), 'B');
    assert.equal(current.from, position(editor, 'prefix BBB') + 8);
    assert.equal(resolveEditorNodeTarget(editor, node), null, 'a stale full-node dialog cannot overwrite the remote edit');
    editor.view.dispatch(editor.state.tr.insertText('X', current.from, current.to));
    assert.equal(resolveEditorRangeTarget(editor, range), null, 'a changed target selection requires review');
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); doc.destroy(); }
});

test('dialog targets cannot outlive cancellation, permission loss, deletion, or their editor instance', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const a = createEditor(doc, errors);
  const b = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const from = position(a, 'BBB');
    const target = createEditorRangeTarget(a, { from, to: from })!;
    assert.equal(resolveEditorRangeTarget(b, target), null);
    a.setEditable(false);
    assert.equal(resolveEditorRangeTarget(a, target), null);
    a.setEditable(true);
    invalidateEditorTarget(target);
    assert.equal(resolveEditorRangeTarget(a, target), null);
    const deleted = createEditorRangeTarget(a, { from, to: from })!;
    new CollaborationBlockTree(doc, schema).delete(a.state.doc.child(1).attrs.id, 'delete-dialog', {});
    assert.equal(resolveEditorRangeTarget(a, deleted), null);
    const pending = createEditorRangeTarget(a)!;
    a.destroy();
    assert.equal(resolveEditorRangeTarget(a, pending), null);
  } finally { if (!a.isDestroyed) a.destroy(); b.destroy(); doc.destroy(); }
});

test('local editor dialog targets use block identities instead of stale positions', async () => {
  const editor = new Editor({ extensions: richMarkdownCodecExtensions(), content: 'AAA\n\nBBB\n\nCCC', contentType: 'markdown' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const from = position(editor, 'BBB');
    const target = createEditorRangeTarget(editor, { from, to: from + 3 })!;
    const source = getReorderableBlockRangeAt(editor, from)!;
    assert.equal(moveReorderableBlock(editor, source, 0), true);
    assert.deepEqual(resolveEditorRangeTarget(editor, target), { from: 1, to: 4 });
    editor.view.dispatch(editor.state.tr.insertText('changed', 1, 4));
    assert.equal(resolveEditorRangeTarget(editor, target), null);
  } finally { editor.destroy(); }
});

test('hydration never replaces server data with an empty editor and permission gates every mutation', async () => {
  const server = createDocument();
  const client = new Y.Doc();
  const errors: Error[] = [];
  const editor = createEditor(client, errors);
  try {
    editor.commands.insertContent('too early');
    await Promise.resolve();
    assert.equal(client.share.size, 0);
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    editor.setEditable(false);
    const before = Y.encodeStateAsUpdate(client);
    editor.commands.insertContent('forbidden');
    assert.deepEqual(Y.encodeStateAsUpdate(client), before);
    assert.deepEqual(texts(editor), ['AAA', 'BBB', 'CCC']);
    const serverTree = new CollaborationBlockTree(server, schema);
    const id = serverTree.read().child(1).attrs.id;
    serverTree.move({ blockId: id, parentId: null, beforeId: null, operationId: 'remote' }, {});
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB'], 'read-only views still receive remote changes');
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); client.destroy(); server.destroy(); }
});

test('unmount releases observers and pending callbacks cannot write after editor destruction', async () => {
  const doc = createDocument();
  const count = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  const baseline = count();
  const before = Y.encodeStateAsUpdate(doc);
  for (let run = 0; run < 4; run += 1) {
    const errors: Error[] = [];
    const editor = createEditor(doc, errors);
    if (run % 2 === 0) await Promise.resolve();
    editor.destroy();
    await Promise.resolve();
    assert.equal(count(), baseline, 'view and UndoManager listeners are fully released');
    assert.deepEqual(errors, []);
  }
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  doc.destroy();
});

test('invalid editor changes are rejected without changing the visible or durable state', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const editor = createEditor(doc, errors);
  try {
    await Promise.resolve();
    const before = Y.encodeStateAsUpdate(doc);
    const original = editor.getJSON();
    // An existing hidden identity may not be resurrected by a stale command.
    const tree = new CollaborationBlockTree(doc, schema);
    const id = tree.read().child(1).attrs.id;
    tree.delete(id, 'delete', {});
    const deleted = Y.encodeStateAsUpdate(doc);
    const visible = editor.getJSON();
    editor.commands.setContent(original);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), deleted);
    assert.deepEqual(editor.getJSON(), visible);
    assert.notDeepEqual(deleted, before);
    assert.equal(errors.length, 1);
  } finally { editor.destroy(); doc.destroy(); }
});

test('remote carets follow a moved block and disappear when its target is deleted', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const awarenessA = new Awareness(left);
  const awarenessB = new Awareness(right);
  const errors: Error[] = [];
  const a = createEditor(left, errors, awarenessA);
  const b = createEditor(right, errors, awarenessB);
  document.body.append(a.view.dom, b.view.dom);
  try {
    await Promise.resolve();
    a.view.focus();
    a.commands.setTextSelection(position(a, 'BBB') + 1);
    await Promise.resolve();
    applyAwarenessUpdate(awarenessB, encodeAwarenessUpdate(awarenessA, [awarenessA.clientID]), {});
    assert.equal(b.view.dom.querySelectorAll('[data-collaboration-user="Peer"]').length, 1);
    const id = a.state.doc.child(1).attrs.id;
    new CollaborationBlockTree(right, schema).move({ blockId: id, parentId: null, beforeId: null, operationId: 'move' }, {});
    const caret = b.view.dom.querySelector('[data-collaboration-user="Peer"]')!;
    assert.equal(caret.closest('p')?.textContent, 'BPeerBB');
    assert.equal(caret.closest('p'), b.view.dom.lastElementChild);
    new CollaborationBlockTree(right, schema).delete(id, 'delete', {});
    assert.equal(b.view.dom.querySelectorAll('[data-collaboration-user="Peer"]').length, 0);
    assert.deepEqual(errors, []);
  } finally {
    a.destroy(); b.destroy(); awarenessA.destroy(); awarenessB.destroy(); left.destroy(); right.destroy();
  }
});

test('closing an older view cannot clear a cursor published by the current view', async () => {
  const doc = createDocument();
  const awareness = new Awareness(doc);
  const errors: Error[] = [];
  const a = createEditor(doc, errors, awareness);
  const b = createEditor(doc, errors, awareness);
  document.body.append(a.view.dom, b.view.dom);
  try {
    await Promise.resolve();
    a.view.focus();
    a.commands.setTextSelection(position(a, 'AAA') + 1);
    await Promise.resolve();
    const oldOwner = awareness.getLocalState()?.canvasBlockSelection?.owner;
    assert.ok(oldOwner);
    b.view.focus();
    b.commands.setTextSelection(position(b, 'CCC') + 1);
    await Promise.resolve();
    const active = awareness.getLocalState()?.canvasBlockSelection;
    assert.ok(active?.owner && active.owner !== oldOwner);
    a.destroy();
    assert.deepEqual(awareness.getLocalState()?.canvasBlockSelection, active);
    b.destroy();
    assert.equal(awareness.getLocalState()?.canvasBlockSelection, null);
    assert.deepEqual(errors, []);
  } finally {
    if (!a.isDestroyed) a.destroy();
    if (!b.isDestroyed) b.destroy();
    awareness.destroy(); doc.destroy();
  }
});

test('an active composition keeps its DOM text through a remote block move', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const editor = createEditor(left, errors);
  document.body.append(editor.view.dom);
  try {
    await Promise.resolve();
    editor.view.focus();
    editor.commands.setTextSelection(position(editor, 'BBB') + 1);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.equal(editor.view.composing, true);
    const composingText = editor.view.dom.querySelectorAll('p')[1].firstChild!;
    const id = editor.state.doc.child(1).attrs.id;
    new CollaborationBlockTree(right, schema).move({ blockId: id, parentId: null, beforeId: null, operationId: 'remote-move' }, {});
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    assert.equal(composingText.isConnected, true, 'the browser composition node must not be replaced');
    assert.equal(editor.view.composing, true);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'BBB']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); left.destroy(); right.destroy(); }
});

test('composition edits sync immediately and merge with remote text and placement as one undo action', async () => {
  const left = createDocument();
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  const errors: Error[] = [];
  const editor = createEditor(left, errors);
  document.body.append(editor.view.dom);
  try {
    await Promise.resolve();
    editor.view.focus();
    editor.commands.setTextSelection(position(editor, 'BBB') + 1);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    const from = position(editor, 'BBB');
    const source = getReorderableBlockRangeAt(editor, from)!;
    assert.equal(moveReorderableBlock(editor, source, 0), false, 'local drag does not interrupt composition');
    editor.view.dispatch(editor.state.tr.insertText('中', from + 1));
    assert.equal(new CollaborationBlockTree(left, schema).read().child(1).textContent, 'B中BB', 'the composing draft is already in the durable document');
    const remote = new CollaborationBlockTree(right, schema);
    const id = remote.read().child(1).attrs.id;
    (remote.content(id).get(0) as Y.XmlText).insert(0, 'R');
    remote.move({ blockId: id, parentId: null, beforeId: null, operationId: 'remote' }, {});
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    assert.deepEqual(texts(editor), ['AAA', 'B中BB', 'CCC'], 'remote rendering waits for compositionend');
    editor.view.dispatch(editor.state.tr.insertText('文', from + 2));
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'RB中文BB']);
    assert.equal(editor.commands.undo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'RBBB'], 'undo retains remote text and move');
    assert.equal(editor.commands.redo(), true);
    assert.deepEqual(texts(editor), ['AAA', 'CCC', 'RB中文BB']);
    assert.deepEqual(errors, []);
  } finally { editor.destroy(); left.destroy(); right.destroy(); }
});

test('repeated composition reuses its actor and unmount retains the latest synchronized input', async () => {
  const doc = createDocument();
  const errors: Error[] = [];
  const countListeners = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  const baseline = countListeners();
  const editor = createEditor(doc, errors);
  document.body.append(editor.view.dom);
  try {
    await Promise.resolve();
    editor.view.focus();
    editor.commands.setTextSelection(position(editor, 'AAA') + 1);
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText('中'));
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    await Promise.resolve();
    const actors = Y.decodeStateVector(Y.encodeStateVector(doc)).size;
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText('文'));
    assert.equal(Y.decodeStateVector(Y.encodeStateVector(doc)).size, actors);
    editor.destroy();
    await Promise.resolve();
    assert.equal(new CollaborationBlockTree(doc, schema).read().firstChild!.textContent, 'A中文AA');
    assert.equal(countListeners(), baseline);
    assert.deepEqual(errors, []);
  } finally { if (!editor.isDestroyed) editor.destroy(); doc.destroy(); }
});
