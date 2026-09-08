import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import type { EditorView as View } from '@codemirror/view';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
// Load all runtime modules through the same loader, after the DOM globals exist.
// Mixing native dynamic imports with tsx's CJS imports duplicates CM/Yjs classes.
const loadRuntime = createRequire(__filename);
const runtime = Promise.resolve([
  loadRuntime('@codemirror/state') as typeof import('@codemirror/state'),
  loadRuntime('@codemirror/view') as typeof import('@codemirror/view'),
  loadRuntime('../app/lib/collaboration/text-editor-history') as typeof import('../app/lib/collaboration/text-editor-history'),
] as const);

async function mount(text: Y.Text) {
  const [{ EditorState }, { EditorView }, { createTextEditorCollaboration }] = await runtime;
  return new EditorView({ parent: dom.window.document.body, state: EditorState.create({ doc: text.toString(),
    extensions: [EditorState.allowMultipleSelections.of(true), createTextEditorCollaboration(text, null)] }) });
}
function undo(view: View, redo = false) {
  const event = new dom.window.KeyboardEvent('keydown', { key: redo ? 'Z' : 'z', code: 'KeyZ', keyCode: 90,
    ctrlKey: true, shiftKey: redo, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  assert(event.defaultPrevented);
}

test('text history groups typing across remote input, separates deletion and excludes non-history writes', async () => {
  const [{ Transaction }] = await runtime;
  const doc = new Y.Doc(); const text = doc.getText('content'); text.insert(0, 'AAA');
  const view = await mount(text);
  const type = (value: string) => view.dispatch({ ...view.state.replaceSelection(value), annotations: Transaction.userEvent.of('input.type') });
  try {
    view.dispatch({ selection: { anchor: 3 } }); type('x'); type('y');
    doc.transact(() => text.insert(0, 'Peer '), 'peer');
    type('z');
    assert.equal(text.toString(), 'Peer AAAxyz');
    undo(view); assert.equal(text.toString(), 'Peer AAA');
    undo(view, true);
    for (let count = 0; count < 2; count++) {
      const end = view.state.selection.main.head;
      view.dispatch({ changes: { from: end - 1, to: end }, selection: { anchor: end - 1 }, annotations: Transaction.userEvent.of('delete.backward') });
    }
    assert.equal(text.toString(), 'Peer AAAx');
    undo(view); assert.equal(text.toString(), 'Peer AAAxyz');
    view.dispatch({ changes: { from: 0, insert: 'Kept ' }, annotations: Transaction.addToHistory.of(false) });
    undo(view); assert.equal(text.toString(), 'Kept Peer AAA');
    undo(view, true); assert.equal(text.toString(), 'Kept Peer AAAxyz');
  } finally { view.destroy(); doc.destroy(); }
});

test('relative multi-selection history survives CRLF, Unicode, a remote insertion and a new view', async () => {
  const [{ EditorSelection }] = await runtime;
  const initial = 'abc def\r\nsecond\n';
  const doc = new Y.Doc(); const text = doc.getText('content'); text.insert(0, initial);
  let view = await mount(text);
  try {
    assert.equal(view.state.doc.toString(), initial);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.range(7, 4)], 1) });
    view.dispatch(view.state.replaceSelection('😀'));
    const after = text.toString();
    doc.transact(() => text.insert(0, 'Peer '), 'peer');
    view.destroy(); view = await mount(text);
    undo(view);
    assert.equal(text.toString(), 'Peer ' + initial);
    assert.deepEqual(view.state.selection.toJSON(), { ranges: [{ anchor: 8, head: 8 }, { anchor: 12, head: 9 }], main: 1 });
    undo(view, true); assert.equal(text.toString(), 'Peer ' + after);
  } finally { view.destroy(); doc.destroy(); }
});

test('composition is a single selective item across long pauses and native beforeinput uses the same history', async () => {
  const [{ Transaction }] = await runtime;
  const doc = new Y.Doc(); const text = doc.getText('content'); text.insert(0, 'AAA');
  const view = await mount(text);
  try {
    view.dispatch({ selection: { anchor: 3 } });
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch({ ...view.state.replaceSelection('x'), annotations: Transaction.userEvent.of('input.type.compose') });
    await new Promise((resolve) => setTimeout(resolve, 550));
    doc.transact(() => text.insert(0, 'Peer '), 'peer');
    view.dispatch({ ...view.state.replaceSelection('y'), annotations: Transaction.userEvent.of('input.type.compose') });
    undo(view); assert.equal(text.toString(), 'Peer AAAxy', 'undo waits for composition completion');
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    const input = new dom.window.InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(input);
    assert(input.defaultPrevented);
    assert.equal(text.toString(), 'Peer AAA');
    // CodeMirror suppresses a Safari keydown immediately after compositionend.
    await new Promise((resolve) => setTimeout(resolve, 110));
    undo(view, true); assert.equal(text.toString(), 'Peer AAAxy');
  } finally { view.destroy(); doc.destroy(); }
});

test('view replacement keeps document observers bounded and document destruction revokes history and writes', async () => {
  const doc = new Y.Doc(); const text = doc.getText('content'); text.insert(0, 'AAA');
  let view = await mount(text);
  const count = () => (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get('afterTransaction')?.size;
  const expected = count();
  try {
    for (let index = 0; index < 8; index++) {
      view.destroy(); view = await mount(text);
      assert.equal(count(), expected);
    }
    view.dispatch({ changes: { from: 3, insert: 'x' } });
    doc.destroy();
    undo(view); assert.equal(text.toString(), 'AAAx');
    view.dispatch({ changes: { from: 0, insert: 'STALE ' } });
    assert.equal(text.toString(), 'AAAx');
  } finally { view.destroy(); doc.destroy(); }
});
