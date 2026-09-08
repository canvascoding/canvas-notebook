import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Editor } from '@tiptap/core';
import messages from '../messages/en.json';
import type { MarkdownEditorProps } from '../app/components/editor/MarkdownEditor';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';

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

async function main() {
  const { EditorView } = await import('@codemirror/view');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
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
    console.log('Real MarkdownEditor lifecycle: StrictMode, block moves, Rich/Read/Source, shared undo, delayed acknowledgements, blur, normalization, permissions and file replacement passed.');
  } finally {
    await act(async () => root.unmount());
    internals._load = originalLoad;
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
