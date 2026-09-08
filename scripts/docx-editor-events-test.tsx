import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act, createRef } from 'react';
import { JSDOM } from 'jsdom';
import type { Document as OfficeDocument } from '@eigenpal/docx-js-editor/core';
import type { DocxEditorRef } from '@eigenpal/docx-js-editor/react';
import type { EditorView } from 'prosemirror-view';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'DOMParser', 'XMLSerializer', 'MutationObserver', 'DOMRect', 'Range', 'getComputedStyle', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key) });
}
for (const key of Object.getOwnPropertyNames(win).filter((name) => /^[A-Z]/.test(name))) {
  if (!(key in globalThis)) Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key) });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
Object.defineProperty(win, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
const frame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
Object.assign(globalThis, { requestAnimationFrame: frame, cancelAnimationFrame: clearTimeout });
Object.assign(win, { requestAnimationFrame: frame, cancelAnimationFrame: clearTimeout });
class ResizeObserverStub { observe() {} disconnect() {} unobserve() {} }
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
Object.assign(win, { ResizeObserver: ResizeObserverStub });
Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', { value: () => new Proxy({
  measureText(text: string) { return { width: text.length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }; },
}, { get(target, name) { return Reflect.get(target, name) ?? (() => undefined); }, set() { return true; } }) });
Object.defineProperty(win.HTMLElement.prototype, 'scrollIntoView', { value() {} });
Object.defineProperty(win.Range.prototype, 'getClientRects', { value: () => [] });
Object.defineProperty(win.Range.prototype, 'getBoundingClientRect', { value: () => new win.DOMRect(0, 0, 5, 15) });
Object.defineProperty(win.document, 'fonts', { value: { ready: Promise.resolve(), check: () => true, load: async () => [], addEventListener() {}, removeEventListener() {} } });
const require = createRequire(path.join(process.cwd(), 'package.json'));
require.extensions['.css'] = () => undefined;
const prosemirror = require('prosemirror-view') as typeof import('prosemirror-view');
const NativeEditorView = prosemirror.EditorView;
const views: EditorView[] = [];
prosemirror.EditorView = class extends NativeEditorView {
  constructor(...args: ConstructorParameters<typeof NativeEditorView>) { super(...args); views.push(this); }
};
const { render, fireEvent } = require('@testing-library/react') as typeof import('@testing-library/react');
const { DocxEditor } = require('@eigenpal/docx-js-editor/react') as typeof import('@eigenpal/docx-js-editor/react');
const { createEmptyDocument } = require('@eigenpal/docx-js-editor/core') as typeof import('@eigenpal/docx-js-editor/core');

async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }

async function main() {
  const initial = createEmptyDocument();
  initial.package.document.content = [{ type: 'paragraph', paraId: 'PARA0001', content: [{ type: 'commentRangeStart', id: 1 }, { type: 'run', content: [{ type: 'text', text: 'Original text' }] }, { type: 'commentRangeEnd', id: 1 }] }];
  initial.package.document.comments = [{ id: 1, author: 'Alice', content: [{ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text: 'Original comment' }] }] }], date: new Date().toISOString() }];
  initial.package.headers = new Map([['rIdHeader1', { type: 'header', hdrFtrType: 'default', content: [{ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text: 'Header original' }] }] }] }]]);
  initial.package.document.finalSectionProperties!.headerReferences = [{ type: 'default', rId: 'rIdHeader1' }];
  const snapshots: OfficeDocument[] = [];
  const editor = createRef<DocxEditorRef>();
  let saves = 0;
  const onChange = (value: OfficeDocument) => snapshots.push(structuredClone(value));
  const renderEditor = (readOnly: boolean) => <DocxEditor ref={editor} document={initial} canvasWorkspaceBound onSaveRequest={() => { saves++; }} onChange={onChange} readOnly={readOnly} mode={readOnly ? 'viewing' : 'editing'} />;
  const mounted = render(renderEditor(false));
  await settle();
  assert.equal(snapshots.length, 0, 'initial document and comment hydration are not edits');
  assert.ok(editor.current);
  const view = editor.current.getEditorRef()?.getView();
  assert.ok(view, 'actual ProseMirror view mounted');
  await act(async () => {
    view.dispatch(view.state.tr.insertText(' edited', 1));
    assert.equal(snapshots.length, 1, 'body mutation emits before React render and layout');
    assert.ok(JSON.stringify(snapshots[0].package.document.content).includes('edited'));
  });
  const beforeUndo = snapshots.length;
  fireEvent.keyDown(view.dom, { key: 'z', ctrlKey: true });
  assert.equal(snapshots.length, beforeUndo + 1, 'native editor undo shortcut emits one complete change');
  assert.equal(view.state.doc.textContent, 'Original text');
  fireEvent.keyDown(view.dom, { key: 'z', ctrlKey: true, shiftKey: true });
  assert.ok(view.state.doc.textContent.includes('edited'), 'native redo still works without global history handler');
  await act(async () => {
    const reply = editor.current!.replyToComment(1, 'Reply retained', 'Bob');
    assert.ok(reply !== null);
    assert.ok(JSON.stringify(snapshots.at(-1)!.package.document.comments).includes('Reply retained'), 'reply reaches full document immediately');
    editor.current!.resolveComment(1);
    assert.equal(snapshots.at(-1)!.package.document.comments?.find((comment) => comment.id === 1)?.done, true, 'resolve is persisted without body edits');
  });
  const header = mounted.container.querySelector('.layout-page-header');
  assert.ok(header, 'the actual header is rendered');
  fireEvent.click(header, { detail: 2 });
  await settle();
  const headerView = views.find((candidate) => candidate.dom.closest('.hf-editor-pm'));
  assert.ok(headerView, 'actual header ProseMirror editor mounted');
  await act(async () => {
    const before = snapshots.length;
    headerView.dispatch(headerView.state.tr.insertText('Header changed ', 1));
    assert.equal(snapshots.length, before + 1, 'header transaction immediately emits without blur/render');
    assert.ok(JSON.stringify(snapshots.at(-1)!.package.headers?.get('rIdHeader1')).includes('Header changed'));
    view.dispatch(view.state.tr.insertText('body before render ', 1));
    assert.ok(JSON.stringify(snapshots.at(-1)!.package.headers?.get('rIdHeader1')).includes('Header changed'), 'body event before React render keeps the newest header');
  });
  fireEvent.keyDown(document, { key: 'Escape' });
  await settle();
  const footer = mounted.container.querySelector('.layout-page-footer');
  assert.ok(footer);
  const beforeFooter = snapshots.length;
  fireEvent.click(footer, { detail: 2 });
  await settle();
  assert.ok(snapshots.length > beforeFooter, 'creating a footer is an immediate document mutation');
  const footerView = views.find((candidate) => !candidate.isDestroyed && candidate.dom.closest('.hf-editor-pm'));
  assert.ok(footerView);
  await act(async () => {
    const before = snapshots.length;
    footerView.dispatch(footerView.state.tr.insertText('Footer retained', 1));
    assert.equal(snapshots.length, before + 1, 'footer typing emits before any blur or layout');
    assert.ok(JSON.stringify([...snapshots.at(-1)!.package.footers!.values()]).includes('Footer retained'));
  });
  fireEvent.click(mounted.getByRole('button', { name: /Options/ }));
  const beforeRemoval = snapshots.length;
  fireEvent.click(mounted.getByRole('button', { name: /Remove footer/i }));
  assert.equal(snapshots.length, beforeRemoval + 1, 'footer removal immediately emits');
  assert.equal(snapshots.at(-1)!.package.footers?.size, 0);
  assert.equal(snapshots.at(-1)!.package.document.finalSectionProperties?.footerReferences?.length, 0);
  const hiddenOpen = mounted.container.querySelector('input[type="file"][accept^=".docx"]');
  assert.ok(hiddenOpen);
  let localFileRead = false;
  const beforeOpen = snapshots.length;
  fireEvent.change(hiddenOpen, { target: { files: [{ arrayBuffer() { localFileRead = true; return Promise.resolve(new ArrayBuffer(0)); } }] } });
  await settle();
  assert.equal(localFileRead, false, 'bound editor rejects even a direct hidden-input open event');
  assert.equal(snapshots.length, beforeOpen);
  const fileMenu = mounted.getByRole('button', { name: /^File$/i });
  fireEvent.click(fileMenu);
  assert.equal(mounted.queryByText(/^Open(?:\.\.\.)?$/i), null, 'bound editor cannot open another local document');
  fireEvent.click(mounted.getByText(/^Save(?:\.\.\.)?$/i));
  await settle();
  assert.equal(saves, 1, 'File Save routes to common flush request without exporting itself');
  await act(async () => { mounted.rerender(renderEditor(true)); });
  const beforeReadonly = snapshots.length;
  const textBeforeReadonly = view.state.doc.textContent;
  assert.equal(view.editable, false, 'live readonly changes update the existing ProseMirror view');
  await act(async () => { view.dispatch(view.state.tr.insertText(' forbidden', 1)); });
  assert.equal(snapshots.length, beforeReadonly);
  assert.equal(view.state.doc.textContent, textBeforeReadonly, 'readonly rejects document-changing transactions');
  await act(async () => { editor.current!.resolveComment(1); });
  assert.equal(snapshots.length, beforeReadonly, 'readonly suppresses comment mutation paths too');
  assert.equal(mounted.queryByRole('button', { name: /^File$/i }), null);
  await act(async () => { mounted.unmount(); });
  win.close();
  console.log('DOCX editor real React/ProseMirror events, comments, workspace menu and live readonly passed.');
}
void main().catch((error) => { console.error(error); win.close(); process.exitCode = 1; });
