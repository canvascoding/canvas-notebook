import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';
import { moveMarkdownTablePart } from '../app/lib/markdown/core/table-commands';
import tableEdits from '../app/lib/markdown/core/table-command-fixtures.json';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'MutationObserver'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
const extensions = richMarkdownCodecExtensions();
const tableSource = '| A | B |\n| --- | --- |\n| one | two |\n| three | four |';
for (const fixture of tableEdits) {
  const editor = new Editor({ extensions, content: tableSource, contentType: 'markdown' });
  let position = 0;
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === fixture.cell) position = pos; });
  editor.commands.setTextSelection(position);
  if (fixture.initialAlign) editor.commands.setCellAttribute('align', fixture.initialAlign);
  editor.view.dispatch(closeHistory(editor.state.tr));
  const before = editor.getJSON();
  let changed: boolean;
  if (fixture.axis) changed = editor.commands.command((props) => moveMarkdownTablePart(props, fixture.axis as 'row' | 'column', fixture.direction as -1 | 1));
  else if (fixture.align) changed = editor.commands.setCellAttribute('align', fixture.align);
  else changed = editor.commands[fixture.command as 'addRowBefore' | 'addRowAfter' | 'deleteRow']();
  assert.equal(changed, true, fixture.name);
  editor.state.doc.check();
  const table = editor.state.doc.firstChild!;
  assert.deepEqual(Array.from({ length: table.childCount }, (_, row) => {
    const entry = table.child(row);
    return Array.from({ length: entry.childCount }, (_, col) => {
      assert.equal(entry.child(col).type.name, row === 0 ? 'tableHeader' : 'tableCell', fixture.name);
      if (fixture.align || fixture.initialAlign) assert.equal(entry.child(col).attrs.align, col === 0 ? fixture.align || fixture.initialAlign : null);
      return entry.child(col).textContent;
    });
  }), fixture.rows, fixture.name);
  const changedJson = editor.getJSON();
  const reloaded = new Editor({ extensions, content: editor.getMarkdown(), contentType: 'markdown' });
  assert.equal(equivalentRichDocument(changedJson, reloaded.getJSON()), true, `${fixture.name}: reload`);
  reloaded.destroy();
  assert.equal(editor.commands.undo(), true, `${fixture.name}: undo`);
  assert.equal(equivalentRichDocument(before, editor.getJSON()), true, `${fixture.name}: undo retains original`);
  assert.equal(editor.commands.redo(), true);
  assert.equal(equivalentRichDocument(changedJson, editor.getJSON()), true);
  editor.destroy();
}
console.log(`Portable table commands: ${tableEdits.length} edit/undo/redo/reload cases passed.`);

dom.window.close();
