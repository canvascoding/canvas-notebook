import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection } from '@tiptap/pm/state';
import messages from '../messages/en.json';
import type { MarkdownEditorProps } from '../app/components/editor/MarkdownEditor';
import { CANVAS_BLOCK_DRAG_DATA_TYPE, getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event',
  'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
// JSDOM has no layout. These tests inspect document state and lifecycle, not geometry.
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };

async function main() {
  const { EditorView } = await import('@codemirror/view');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const originalResizeObserver = globalThis.ResizeObserver;
  const workspace = { activeWorkspaceId: null };
  const files = { currentFile: null };
  internals._load = (request, parent, isMain) => {
    if (request === './CodeEditorClient') return originalLoad('./CodeEditor', parent, isMain);
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: ({ content }: { content: string }) => <pre data-reader>{content}</pre> };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign((selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign((selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    return originalLoad(request, parent, isMain);
  };
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  try {
    const { MarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
    const values: string[] = [];
    let props: MarkdownEditorProps = { value: 'AAA\n\nBBB\n\nCCC\n', filePath: 'test.md', layout: 'field',
      mode: 'rich', onChange: (value) => values.push(value) };
    const render = async (next: Partial<MarkdownEditorProps> = {}) => {
      props = { ...props, ...next };
      await act(async () => { root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <MarkdownEditor {...props} />
      </NextIntlClientProvider></StrictMode>); });
    };
    const rich = () => {
      const element = container.querySelector('.tiptap') as HTMLElement & { editor?: Editor };
      assert(element?.editor, 'rich editor is mounted');
      return element.editor;
    };
    await render();
    const first = rich();
    assert.equal(values.length, 0, 'opening does not emit a document replacement');
    assert.equal(first.can().undo(), false, 'deferred initialization does not create history');
    const staleTransaction = first.state.tr.insertText('LATE', 1);
    const staleDispatch = first.view.dispatch;
    await act(async () => { first.commands.setTextSelection(9); first.view.dispatch(first.state.tr.insertText('x')); });
    assert.equal(values.at(-1), props.value.replace('BBB', 'BBBx'));
    await act(async () => { assert(moveReorderableBlock(first, getReorderableBlockRangeAt(first, 6)!, 0)); });
    assert.equal(values.at(-1), 'BBBx\n\nAAA\n\nCCC\n');
    await render({ value: values.at(-1) });
    await render({ mode: 'read' });
    assert.equal(container.querySelector('[data-reader]')?.textContent, values.at(-1));
    await render({ mode: 'rich' });
    assert.notEqual(rich(), first);
    await act(async () => { assert(rich().commands.undo()); });
    assert.equal(values.at(-1), 'AAA\n\nBBBx\n\nCCC\n');
    await act(async () => { assert(rich().commands.undo()); });
    assert.equal(values.at(-1), 'AAA\n\nBBB\n\nCCC\n');
    await render({ value: values.at(-1), mode: 'source' });
    const sourceElement = container.querySelector<HTMLElement>('.cm-editor');
    assert(sourceElement);
    const source = EditorView.findFromDOM(sourceElement)!;
    assert(source, 'source uses a real CodeMirror view');
    await act(async () => { source.dispatch({ changes: { from: 0, insert: 'Source ' } }); });
    assert.equal(values.at(-1), 'Source AAA\n\nBBB\n\nCCC\n');
    await render({ value: values.at(-1), mode: 'rich' });
    assert.equal(rich().state.doc.firstChild?.textContent, 'Source AAA');
    await act(async () => { assert(rich().commands.undo()); });
    assert.equal(values.at(-1), 'AAA\n\nBBB\n\nCCC\n');
    await render({ value: values.at(-1), readOnly: true });
    const count = values.length;
    await act(async () => { rich().commands.insertContent('FORBIDDEN'); });
    assert.equal(values.length, count);
    await render({ readOnly: false, externalValueSync: 'when-blurred' });
    await act(async () => {
      rich().view.focus();
      rich().view.dispatch(rich().state.tr.insertText('First ', 1));
    });
    const firstValue = values.at(-1)!;
    await act(async () => { rich().view.dispatch(rich().state.tr.insertText('Second ', 1)); });
    const secondValue = values.at(-1)!;
    await render({ value: secondValue });
    await render({ value: firstValue });
    assert.equal(rich().state.doc.firstChild?.textContent, 'Second First AAA', 'a delayed older acknowledgement does not replace current text');
    await act(async () => { rich().view.dispatch(rich().state.tr.insertText('Dirty ', 1)); });
    await render({ value: 'External replacement\n' });
    assert.equal(rich().state.doc.firstChild?.textContent, 'Dirty Second First AAA', 'focused dirty text defers external replacement');
    const outside = dom.window.document.createElement('button');
    dom.window.document.body.append(outside);
    await act(async () => { outside.focus(); });
    assert.equal(rich().state.doc.textContent, 'External replacement', 'blur flushes the pending authoritative value');
    outside.remove();
    await render({ value: 'Other file\n', filePath: 'other.md', readOnly: false });
    assert.equal(rich().state.doc.textContent, 'Other file');
    assert.equal(rich().can().undo(), false);
    const finalCount = values.length;
    await act(async () => { staleDispatch(staleTransaction); });
    assert.equal(values.length, finalCount);
    const unnormalized = '| A | B |\n| --- | --- |\n| one | two |\n';
    await render({ value: unnormalized, filePath: 'table.md', mode: 'rich' });
    const normalize = container.querySelector('[data-testid="markdown-normalize-rich-text"]') as HTMLButtonElement;
    assert(normalize);
    await act(async () => { normalize.click(); });
    assert.equal(rich().state.doc.firstChild?.type.name, 'table');
    await render({ value: values.at(-1) });
    await act(async () => { assert(rich().commands.undo()); });
    const reverted = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    assert.equal(reverted.state.doc.toString(), unnormalized, 'normalization undo returns the original source and view');
    const lateSource = reverted.state.update({ changes: { from: 0, insert: 'LATE SOURCE ' } });
    const opaque = '---\ninvalid: [\n---\n\nOpaque\n';
    await render({ value: opaque, filePath: 'source.md', mode: 'source' });
    const currentSource = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    assert.notEqual(currentSource, reverted);
    await act(async () => { reverted.dispatch(lateSource); });
    assert.equal(currentSource.state.doc.toString(), opaque);
    await act(async () => { currentSource.dispatch({ changes: { from: opaque.length, insert: 'Change' } }); });
    await render({ value: values.at(-1), readOnly: true });
    assert.equal(EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!), currentSource, 'permission changes do not replace the source view');
    await act(async () => { currentSource.dispatch({ changes: { from: 0, insert: 'FORBIDDEN ' } }); });
    assert.equal(currentSource.state.doc.toString(), opaque + 'Change');
    await render({ readOnly: false });
    await act(async () => {
      currentSource.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(currentSource.state.doc.toString(), opaque, 'source keyboard undo uses the shared history after permission changes');
    await render({ documentKey: 'rename-lifetime', filePath: 'folder/before.md', value: 'AAA\n\nBBB\n', mode: 'rich' });
    const beforeRename = rich();
    await act(async () => { assert(moveReorderableBlock(beforeRename, getReorderableBlockRangeAt(beforeRename, 6)!, 0)); });
    const lateRename = beforeRename.state.tr.insertText('STALE RICH ', 1);
    const dispatchBeforeRename = beforeRename.view.dispatch;
    await render({ filePath: 'renamed/after.md', value: values.at(-1) });
    assert.notEqual(rich(), beforeRename, 'rename replaces the interaction view');
    assert.equal(rich().state.doc.firstChild?.textContent, 'BBB');
    const beforeLate = values.length;
    await act(async () => { dispatchBeforeRename(lateRename); });
    assert.equal(values.length, beforeLate, 'rename revokes callbacks of the old rich view');
    await act(async () => { assert(rich().commands.undo()); });
    assert.equal(values.at(-1), 'AAA\n\nBBB\n', 'rename retains the document and block move history');
    await render({ mode: 'source', value: values.at(-1) });
    const beforeSourceRename = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    await act(async () => { beforeSourceRename.dispatch({ changes: { from: 0, insert: 'Renamed ' } }); });
    const lateRenameSource = beforeSourceRename.state.update({ changes: { from: 0, insert: 'STALE SOURCE ' } });
    await render({ filePath: 'renamed/again.md', value: values.at(-1) });
    const afterSourceRename = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    assert.notEqual(afterSourceRename, beforeSourceRename);
    await act(async () => { beforeSourceRename.dispatch(lateRenameSource); });
    assert.equal(afterSourceRename.state.doc.toString(), 'Renamed AAA\n\nBBB\n');
    await render({ mode: 'rich' });
    await act(async () => { assert(rich().commands.undo()); });
    assert.equal(values.at(-1), 'AAA\n\nBBB\n', 'source edit remains undoable after a second rename');
    await render({ documentKey: 'new-open-lifetime', value: values.at(-1) });
    assert.equal(rich().can().undo(), false, 'a new open lifetime resets history even at the same path');

    const findPosition = (editor: Editor, type: string, text?: string) => {
      let found = -1;
      editor.state.doc.descendants((node, from) => {
        if (node.type.name === type && (text === undefined || node.textContent === text)) found = from;
      });
      assert(found >= 0, `missing ${type}/${text}`);
      return found;
    };
    const createTransfer = () => {
      const data = new Map<string, string>();
      return { get types() { return [...data.keys()]; }, setData: (key: string, value: string) => data.set(key, value),
        getData: (key: string) => data.get(key) ?? '', clearData: () => data.clear(), files: [], effectAllowed: 'none', dropEffect: 'none' };
    };
    const drag = (target: EventTarget, type: string, transfer: ReturnType<typeof createTransfer>, point: MouseEventInit = {}) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 100, ...point });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event);
      return event;
    };
    for (const fixture of [
      { type: 'codeBlock', markdown: 'AAA\n\n```ts\nconst x = 1;\n```\n\nCCC\n' },
      { type: 'image', markdown: 'AAA\n\n![Alt](image.png)\n\nCCC\n' },
      { type: 'horizontalRule', markdown: 'AAA\n\n---\n\nCCC\n' },
    ]) {
      await render({ value: fixture.markdown, documentKey: `grip-${fixture.type}`, filePath: 'grips.md', layout: 'document',
        showNotebookMetadata: false, externalValueSync: 'always', mode: 'rich' });
      const editor = rich();
      const selectSource = async () => act(async () => {
        const from = findPosition(editor, fixture.type);
        if (fixture.type === 'codeBlock') editor.commands.setTextSelection(from + 3);
        else editor.commands.setNodeSelection(from);
      });
      await selectSource();
      const sourceId = editor.state.doc.nodeAt(findPosition(editor, fixture.type))!.attrs.id;
      const before = editor.getJSON();
      const beforeSelection = editor.state.selection.toJSON();
      editor.view.posAtCoords = () => ({ pos: findPosition(editor, 'paragraph', 'CCC') + 1, inside: -1 });
      const handle = () => {
        const element = container.querySelector<HTMLButtonElement>('.tiptap-block-drag-handle');
        assert(element, `${fixture.type} has a real mounted drag handle`);
        return element;
      };
      await act(async () => handle().click());
      assert.equal(container.querySelector('.tiptap-slash-menu'), null, 'an atom/code grip does not invent a text-format target');
      assert.deepEqual(editor.state.selection.toJSON(), beforeSelection);
      const transfer = createTransfer();
      await act(async () => { assert.equal(drag(handle(), 'dragstart', transfer).defaultPrevented, false); });
      assert(transfer.types.includes(CANVAS_BLOCK_DRAG_DATA_TYPE));
      assert(container.querySelector('.tiptap-block-drag-overlay-source'));
      const protectedTransfer = { ...transfer, getData: () => '' };
      await act(async () => { assert.equal(drag(editor.view.dom, 'dragover', protectedTransfer).defaultPrevented, true); });
      assert.equal(protectedTransfer.dropEffect, 'move', 'preview works while dragover exposes only MIME types');
      assert(container.querySelector('.tiptap-block-drop-indicator'));
      await act(async () => { assert.equal(drag(editor.view.dom, 'drop', transfer).defaultPrevented, true); });
      assert.deepEqual(editor.getJSON(), { ...before, content: [before.content![0], before.content![2], before.content![1]] });
      if (fixture.type === 'codeBlock') assert.equal(editor.state.selection.$from.parent.attrs.id, sourceId);
      else {
        assert(editor.state.selection instanceof NodeSelection);
        assert.equal(editor.state.selection.node.attrs.id, sourceId);
      }
      assert.equal(container.querySelector('.tiptap-block-drag-overlay-source'), null);
      const moved = editor.getJSON();
      const movedSelection = editor.state.selection.toJSON();
      await act(async () => { assert(editor.commands.undo()); });
      assert.deepEqual(editor.getJSON(), before);
      assert.deepEqual(editor.state.selection.toJSON(), beforeSelection);
      await act(async () => { assert(editor.commands.redo()); });
      assert.deepEqual(editor.getJSON(), moved);
      assert.deepEqual(editor.state.selection.toJSON(), movedSelection);
      await act(async () => { assert(editor.commands.undo()); });
      await selectSource();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.tiptap-block-controls button')!.click();
        await new Promise(resolve => setTimeout(resolve, 25));
      });
      assert.equal(editor.state.doc.childCount, before.content!.length + 1, 'plus inserts beside the atom/code block');
      assert.equal(editor.state.doc.child(1).attrs.id, sourceId);
      assert.equal(editor.state.doc.child(2).type.name, 'paragraph');
      assert.equal(editor.state.doc.child(2).textContent, '');
      assert.equal(editor.state.selection.$from.parent.attrs.id, editor.state.doc.child(2).attrs.id);
      assert(container.querySelector('.tiptap-slash-menu'), 'the insertion menu targets the new paragraph');
      await act(async () => {
        window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert(editor.commands.undo());
      });
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(editor.can().undo(), false);
      for (const cancel of ['permission', 'composition', 'escape', 'blur', 'dragend']) {
        await selectSource();
        const lateTransfer = createTransfer();
        await act(async () => { drag(handle(), 'dragstart', lateTransfer); });
        assert(container.querySelector('.tiptap-block-drag-overlay-source'));
        await act(async () => {
          if (cancel === 'permission') { editor.setEditable(false); editor.setEditable(true); }
          else if (cancel === 'composition') {
            editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
            editor.view.dom.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 30));
          } else if (cancel === 'escape') window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
          else window.dispatchEvent(new dom.window.Event(cancel));
        });
        assert.equal(container.querySelector('.tiptap-block-drag-overlay-source'), null, `${cancel} clears the drag`);
        await act(async () => { drag(editor.view.dom, 'drop', lateTransfer); });
        assert.deepEqual(editor.getJSON(), before, `${cancel} prevents a late drop even after editability is restored`);
      }
      await selectSource();
      const obsoleteTransfer = createTransfer();
      await act(async () => {
        drag(handle(), 'dragstart', obsoleteTransfer);
        window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      });
      const freshTransfer = createTransfer();
      await act(async () => { drag(handle(), 'dragstart', freshTransfer); });
      assert.notEqual(freshTransfer.getData(CANVAS_BLOCK_DRAG_DATA_TYPE), obsoleteTransfer.getData(CANVAS_BLOCK_DRAG_DATA_TYPE));
      await act(async () => { drag(editor.view.dom, 'drop', obsoleteTransfer); });
      assert.deepEqual(editor.getJSON(), before, 'a late old transfer cannot execute the new gesture');
      await act(async () => { drag(editor.view.dom, 'drop', freshTransfer); });
      assert.deepEqual(editor.getJSON(), before, 'a mismatched drop cancels the current gesture');
      await act(async () => { editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc))); });
      assert.equal(container.querySelector('.tiptap-block-drag-handle'), null, 'a multiple-block selection has no guessed grip');
      await selectSource();
      const lateTransfer = createTransfer();
      const oldDom = editor.view.dom;
      await act(async () => { drag(handle(), 'dragstart', lateTransfer); });
      await render({ mode: 'read', value: fixture.markdown });
      await render({ mode: 'rich' });
      const newBefore = rich().getJSON();
      await act(async () => { drag(oldDom, 'drop', lateTransfer); drag(rich().view.dom, 'drop', lateTransfer); });
      assert.deepEqual(rich().getJSON(), newBefore, 'old drag callbacks do not cross a view replacement');
    }
    for (const fixture of [
      { type: 'paragraph', markdown: 'AAA\n\nBBB\n\nCCC' },
      { type: 'image', markdown: 'AAA\n\n![Alt](image.png)\n\nCCC' },
      { type: 'codeBlock', markdown: 'AAA\n\n```ts\nconst x = 1;\n```\n\nCCC' },
      { type: 'horizontalRule', markdown: 'AAA\n\n---\n\nCCC' },
      { type: 'blockquote', markdown: 'AAA\n\n> Quote\n>\n> - Nested\n\nCCC' },
      { type: 'nestedTaskBody', markdown: 'AAA\n\n- Outer\n  - [x] Task\n  \n    Tail\n\nCCC' },
      { type: 'paragraphAfterTask', markdown: 'AAA\n\n- Outer\n  - [x] Task\n\n  After\n\nCCC' },
    ]) {
      await render({ mode: 'rich', value: fixture.markdown, documentKey: `native-${fixture.type}`, readOnly: false });
      const editor = rich();
      const before = editor.getJSON();
      const source = editor.state.doc.child(1);
      const data = createTransfer();
      await act(async () => {
        editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
        drag(editor.view.dom, 'dragstart', data);
        editor.view.posAtCoords = () => ({ pos: 0, inside: -1 });
        drag(editor.view.dom, 'drop', data);
      });
      assert(!editor.isDestroyed, `${fixture.type}: moving a block must keep the rich view mounted`);
      assert(editor.state.doc.firstChild!.eq(source), `${fixture.type}: the actual editor preserves native-drag identity`);
      assert(editor.state.selection instanceof NodeSelection);
      assert.equal(editor.state.selection.from, 0);
      await act(async () => { assert(editor.commands.undo()); });
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(editor.can().undo(), false);
      await act(async () => { assert(editor.commands.redo()); });
      assert(editor.state.doc.firstChild!.eq(source));
    }
    for (const targetType of ['paragraph', 'blockquote']) {
      await render({ value: `AAA\n\nBBB\n\n${targetType === 'blockquote' ? '> ' : ''}CCC\n\nDDD\n`,
        documentKey: `deleted-drag-target-${targetType}`, layout: 'document', mode: 'rich' });
      const editor = rich();
      await act(async () => { editor.commands.setTextSelection(findPosition(editor, 'paragraph', 'BBB') + 1); });
      const handle = () => container.querySelector<HTMLButtonElement>('.tiptap-block-drag-handle')!;
      const transfer = createTransfer();
      let targetText = 'CCC';
      editor.view.posAtCoords = () => ({ pos: findPosition(editor, 'paragraph', targetText) + 1, inside: -1 });
      await act(async () => {
        drag(handle(), 'dragstart', transfer);
        drag(editor.view.dom, 'dragover', transfer);
      });
      assert(container.querySelector('.tiptap-block-drop-indicator'));
      await act(async () => {
        const from = findPosition(editor, targetType, 'CCC');
        targetText = 'DDD'; // The same pointer now hits the following block.
        editor.view.dispatch(editor.state.tr.delete(from, from + editor.state.doc.nodeAt(from)!.nodeSize));
      });
      const deleted = editor.getJSON();
      assert.equal(Boolean(container.querySelector('.tiptap-block-drag-overlay-source')), false,
        `${targetType}: deleting the previewed target cancels the gesture instead of picking a replacement`);
      await act(async () => { drag(editor.view.dom, 'drop', transfer); });
      assert.deepEqual(editor.getJSON(), deleted, 'a late drop cannot execute the revoked intent');
      const freshTransfer = createTransfer();
      await act(async () => {
        drag(handle(), 'dragstart', freshTransfer);
        drag(editor.view.dom, 'dragover', freshTransfer);
        drag(editor.view.dom, 'drop', freshTransfer);
      });
      assert.deepEqual(editor.getJSON(), { ...deleted, content: [deleted.content![0], deleted.content![2], deleted.content![1]] },
        'an explicit new gesture can use the remaining target');
    }
    const layoutObservers: Array<{ elements: Set<Element>; disconnected: boolean }> = [];
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
      record = { elements: new Set<Element>(), disconnected: false };
      constructor() { layoutObservers.push(this.record); }
      observe(element: Element) { this.record.elements.add(element); }
      unobserve(element: Element) { this.record.elements.delete(element); }
      disconnect() { this.record.disconnected = true; }
    } });
    await render({ value: '> AAA\n>\n> BBB\n>\n> CCC\n', documentKey: 'layout-and-scroll', layout: 'document', mode: 'rich' });
    const layoutEditor = rich();
    const viewport = container.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"]')!;
    viewport.getBoundingClientRect = () => new dom.window.DOMRect(20, 40, 504, 304);
    for (const [key, value] of Object.entries({ clientTop: 2, clientLeft: 2, clientWidth: 500, clientHeight: 300, scrollHeight: 1000 })) {
      Object.defineProperty(viewport, key, { value, configurable: true });
    }
    viewport.scrollTop = 50; viewport.scrollLeft = 10;
    const sourceFrom = findPosition(layoutEditor, 'paragraph', 'BBB');
    const targetFrom = findPosition(layoutEditor, 'paragraph', 'AAA');
    const sourceDom = layoutEditor.view.nodeDOM(sourceFrom) as HTMLElement;
    const targetDom = layoutEditor.view.nodeDOM(targetFrom) as HTMLElement;
    let sourceRect = new dom.window.DOMRect(140, 200, 260, 80);
    let targetRect = new dom.window.DOMRect(140, 120, 300, 30);
    const scrolledRect = (rect: DOMRect) => new dom.window.DOMRect(rect.x - viewport.scrollLeft + 10,
      rect.y - viewport.scrollTop + 50, rect.width, rect.height);
    sourceDom.getBoundingClientRect = () => scrolledRect(sourceRect);
    targetDom.getBoundingClientRect = () => scrolledRect(targetRect);
    layoutEditor.view.posAtCoords = () => ({ pos: targetFrom + 1, inside: -1 });
    await act(async () => { layoutEditor.commands.setTextSelection(sourceFrom + 1); });
    const layoutBefore = layoutEditor.getJSON();
    const control = () => container.querySelector<HTMLElement>('.tiptap-block-controls')!;
    const grip = () => container.querySelector<HTMLButtonElement>('.tiptap-block-drag-handle')!;
    assert.equal(control().style.left, '64px');
    assert.equal(control().style.top, '220px', 'a tall block grip stays near its first line');
    const layoutTransfer = createTransfer();
    await act(async () => {
      drag(grip(), 'dragstart', layoutTransfer);
      drag(layoutEditor.view.dom, 'dragover', layoutTransfer, { clientX: 200, clientY: 100 });
    });
    const overlay = () => container.querySelector<HTMLElement>('.tiptap-block-drag-overlay-source')!;
    const indicator = () => container.querySelector<HTMLElement>('.tiptap-block-drop-indicator')!;
    assert.equal(overlay().style.left, '128px'); assert.equal(overlay().style.width, '260px');
    assert.equal(indicator().style.top, '128px'); assert.equal(indicator().style.width, '300px');
    await act(async () => {
      sourceRect = new dom.window.DOMRect(160, 230, 310, 160);
      targetRect = new dom.window.DOMRect(150, 130, 340, 36);
      sourceDom.dispatchEvent(new dom.window.Event('load'));
      layoutEditor.view.dom.parentElement!.classList.add('layout-probe');
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(control().style.left, '84px'); assert.equal(control().style.top, '250px');
    assert.equal(overlay().style.width, '310px'); assert.equal(overlay().style.height, '160px');
    assert.equal(indicator().style.left, '138px'); assert.equal(indicator().style.top, '138px');
    assert.equal(indicator().style.width, '340px');
    assert.deepEqual(layoutEditor.getJSON(), layoutBefore, 'layout updates never edit the document');
    const wrapper = layoutEditor.view.dom.parentElement!;
    await act(async () => { wrapper.hidden = true; await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(overlay(), null, 'a hidden source ends its gesture');
    assert.equal(control(), null);
    await act(async () => {
      wrapper.hidden = false;
      await new Promise(resolve => setTimeout(resolve, 30));
      drag(layoutEditor.view.dom, 'drop', layoutTransfer, { clientX: 200, clientY: 100 });
    });
    assert.deepEqual(layoutEditor.getJSON(), layoutBefore);
    for (const cancel of ['escape', 'leave', 'permission', 'visibility']) {
      const transfer = createTransfer();
      const beforeScroll = viewport.scrollTop;
      await act(async () => {
        drag(grip(), 'dragstart', transfer);
        drag(layoutEditor.view.dom, 'dragover', transfer, { clientX: 200, clientY: 340 });
        await new Promise(resolve => setTimeout(resolve, 40));
      });
      assert(viewport.scrollTop > beforeScroll, `${cancel}: the mounted editor scrolls at its visible bottom edge`);
      assert.equal(overlay().style.top, '238px', 'the overlay retains content coordinates while the viewport scrolls');
      await act(async () => {
        if (cancel === 'escape') window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        else if (cancel === 'leave') drag(layoutEditor.view.dom, 'dragleave', transfer);
        else if (cancel === 'permission') { layoutEditor.setEditable(false); layoutEditor.setEditable(true); }
        else {
          Object.defineProperty(document, 'hidden', { value: true, configurable: true });
          document.dispatchEvent(new dom.window.Event('visibilitychange'));
          Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        }
      });
      const stopped = viewport.scrollTop;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
      assert.equal(viewport.scrollTop, stopped, `${cancel}: scrolling stops immediately`);
      assert.deepEqual(layoutEditor.getJSON(), layoutBefore);
    }
    const transfer = createTransfer();
    await act(async () => {
      drag(grip(), 'dragstart', transfer);
      drag(layoutEditor.view.dom, 'dragover', transfer, { clientX: 200, clientY: 340 });
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const activeObservers = layoutObservers.filter(record => !record.disconnected
      && record.elements.has(viewport) && record.elements.has(layoutEditor.view.dom));
    assert.equal(activeObservers.length, 1, 'StrictMode retains only the current block layout observer');
    await act(async () => { layoutEditor.destroy(); });
    assert(activeObservers[0].disconnected, 'editor destruction releases layout observers before React unmount');
    const stoppedOnDestroy = viewport.scrollTop;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    assert.equal(viewport.scrollTop, stoppedOnDestroy);
    await render({ mode: 'read', value: props.value });
    const stoppedOnUnmount = viewport.scrollTop;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    assert.equal(viewport.scrollTop, stoppedOnUnmount, 'unmount stops the old viewport and its callbacks');
    console.log('Real MarkdownEditor lifecycle: StrictMode, code/image/rule grips, layout updates, bounded autoscroll, native block identity, drag selection/history, revoked gestures, Rich/Read/Source, delayed acknowledgements, normalization, permissions and file replacement passed.');
  } finally {
    await act(async () => root.unmount());
    internals._load = originalLoad;
    Object.defineProperty(globalThis, 'ResizeObserver', { value: originalResizeObserver, configurable: true });
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
