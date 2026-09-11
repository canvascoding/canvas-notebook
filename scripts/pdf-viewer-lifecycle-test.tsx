import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import messages from '../messages/en.json';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function main() {
  const dom = new JSDOM('<div id="root"></div><p id="markdown">A selection in the Markdown editor</p>',
    { url: 'https://canvas.test', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLCanvasElement', 'Element', 'Node',
    'Range', 'AbortController', 'AbortSignal', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
  }
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} disconnect() {} }, configurable: true });
  Object.defineProperty(globalThis, 'IntersectionObserver', { value: class { observe() {} disconnect() {} }, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 800, configurable: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const textTasks: ControlledTextLayer[] = [];
  class ControlledTextLayer {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    gate = deferred<void>();
    cancelled = 0;
    constructor(readonly options: { container: HTMLDivElement }) {
      options.container.dataset.renderId = String(textTasks.length);
      textTasks.push(this);
    }
    render() {
      // Model completion already queued when cancel runs. The installed
      // TextLayerBuilder continuation must still execute, not a rewritten copy.
      return this.gate.promise.then(() => { this.options.container.append(document.createTextNode('PDF selectable text')); });
    }
    cancel() { this.cancelled++; }
  }
  Object.assign(globalThis, { pdfjsLib: { ...pdfjs, TextLayer: ControlledTextLayer } });
  const viewer = await import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
  const selectionListeners = new Set<EventListener>();
  const capturedListeners: EventListener[] = [];
  const originalAdd = document.addEventListener.bind(document);
  document.addEventListener = ((name: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => {
    if (name === 'selectionchange' && options && typeof options === 'object' && options.signal && !options.signal.aborted) {
      capturedListeners.push(listener); selectionListeners.add(listener);
      options.signal.addEventListener('abort', () => selectionListeners.delete(listener), { once: true });
    }
    originalAdd(name, listener, options);
  }) as typeof document.addEventListener;
  const select = (element: Node) => {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange(); range.selectNodeContents(element); selection.addRange(range);
  };
  const event = () => new dom.window.Event('selectionchange');
  const warnings: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => { warnings.push(args); };
  const root = createRoot(document.getElementById('root')!);
  const flush = async () => act(async () => { await Promise.resolve(); });
  const until = async (condition: () => boolean) => {
    for (let attempt = 0; !condition() && attempt < 30; attempt++) await flush();
    assert(condition(), 'controlled PDF boundary was reached');
  };
  const viewPort = (scale = 1) => ({ width: 600 * scale, height: 800 * scale, scale, rotation: 0,
    clone() { return this; } });
  const annotationTasks: ControlledAnnotationLayer[] = [];
  class ControlledAnnotationLayer {
    gate = deferred<void>();
    div: HTMLDivElement | null = null;
    cancelled = 0;
    constructor(readonly options: { onAppend: (element: HTMLDivElement) => void }) { annotationTasks.push(this); }
    async render() {
      await this.gate.promise;
      this.div = document.createElement('div'); this.div.className = 'annotationLayer';
      this.options.onAppend(this.div);
    }
    cancel() { this.cancelled++; }
  }
  const canvasTasks: { gate: ReturnType<typeof deferred<void>>; cancelled: number }[] = [];
  const page = {
    getViewport: ({ scale }: { scale: number }) => viewPort(scale),
    streamTextContent: () => ({}),
    render: () => {
      const task = { gate: deferred<void>(), cancelled: 0 }; canvasTasks.push(task);
      return { promise: task.gate.promise, cancel: () => { task.cancelled++; } };
    },
  };
  const documentTasks: { url: string; gate: ReturnType<typeof deferred<unknown>>; destroyed: number; failDestroy: boolean }[] = [];
  const runtime = { viewer: { ...viewer, AnnotationLayerBuilder: ControlledAnnotationLayer,
    PDFLinkService: class { setDocument() {} setViewer() {} } },
    pdfjs: { getDocument: ({ url }: { url: string }) => {
      const task = { url, gate: deferred<unknown>(), destroyed: 0, failDestroy: false }; documentTasks.push(task);
      return { promise: task.gate.promise, destroy: async () => {
        task.destroyed++; if (task.failDestroy) throw new Error('EXPECTED_DESTROY_FAILURE');
      } };
    } } };
  // Load production React components with only PDF transport/raster completion
  // controlled. PDF.js TextLayerBuilder and its global selection handler are real.
  const filename = path.resolve('app/components/editor/PdfViewer.tsx');
  const source = (await fs.readFile(filename, 'utf8')).replace('import.meta.url', JSON.stringify(pathToFileURL(filename).href))
    + '\nexport { PdfPageCanvas };';
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } });
  const load = createRequire(filename);
  const exports: { PdfViewer?: React.ComponentType<{ path: string; sourceUrl: string }>;
    PdfPageCanvas?: React.ComponentType<Record<string, unknown>> } = {};
  const requireMock = (name: string) => {
    if (name === './PdfViewer.module.css') return { page: 'pdf-page', canvas: 'pdf-canvas', layers: 'pdf-layers' };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: (selector: (state: { activeWorkspaceId: null }) => unknown) => selector({ activeWorkspaceId: null }) };
    return load(name);
  };
  new Function('require', 'module', 'exports', 'runtime', compiled.outputText + '\nloadPdfJs = () => Promise.resolve(runtime);')(
    requireMock, { exports }, exports, runtime);
  const PdfPageCanvas = exports.PdfPageCanvas!; const PdfViewer = exports.PdfViewer!;
  const wrap = (child: React.ReactNode) => <StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>{child}</NextIntlClientProvider></StrictMode>;
  const renderPage = async (zoom: number, pdf = { getPage: async () => page }) => act(async () => root.render(wrap(
    <PdfPageCanvas pdf={pdf} pageNumber={1} containerWidth={800} zoom={zoom} rotation={0} linkService={{}} scrollRoot={null} setPageRef={() => {}} />)));
  const clear = async () => act(async () => root.render(null));
  try {
    const direct = new viewer.TextLayerBuilder({ pdfPage: page as never });
    document.body.append(direct.div);
    const rendering = direct.render({ viewport: viewPort() as never, images: null as never });
    textTasks.at(-1)!.gate.resolve(); await rendering;
    assert.equal(selectionListeners.size, 1);
    const queued = capturedListeners.at(-1)!;
    select(direct.div); queued(event()); assert(direct.div.classList.contains('selecting'), 'normal PDF selection still works');
    direct.cancel(); direct.div.remove(); assert.equal(selectionListeners.size, 0);
    select(document.getElementById('markdown')!);
    assert.doesNotThrow(() => queued(event()), 'last-layer callback no longer passes undefined to getComputedStyle');

    const firstCount = textTasks.length;
    await renderPage(1); await until(() => textTasks.length > firstCount);
    const staleText = textTasks.at(-1)!; const staleAnnotation = annotationTasks.at(-1)!; const staleCanvas = canvasTasks.at(-1)!;
    await clear(); assert(staleText.cancelled); assert(staleAnnotation.cancelled); assert(staleCanvas.cancelled);
    await act(async () => { staleText.gate.resolve(); staleAnnotation.gate.resolve(); staleCanvas.gate.resolve(); });
    assert.equal(selectionListeners.size, 0, 'late text render cannot leak a new selection listener after unmount');
    assert.equal(document.querySelector('.textLayer,.annotationLayer'), null);
    assert(staleAnnotation.div && !staleAnnotation.div.isConnected, 'late annotation completion never appends to the closed page');
    for (const listener of capturedListeners) assert.doesNotThrow(() => listener(event()));

    const nextCount = textTasks.length;
    const sharedPdf = { getPage: async () => page };
    await renderPage(1, sharedPdf); await until(() => textTasks.length > nextCount);
    const old = { text: textTasks.at(-1)!, annotation: annotationTasks.at(-1)!, canvas: canvasTasks.at(-1)! };
    await renderPage(2, sharedPdf); await until(() => textTasks.at(-1) !== old.text);
    const current = { text: textTasks.at(-1)!, annotation: annotationTasks.at(-1)!, canvas: canvasTasks.at(-1)! };
    await act(async () => { current.text.gate.resolve(); current.annotation.gate.resolve(); current.canvas.gate.resolve(); });
    const currentElement = current.text.options.container;
    assert(currentElement.isConnected); assert.equal(selectionListeners.size, 1);
    await act(async () => { old.text.gate.resolve(); old.annotation.gate.resolve(); old.canvas.gate.resolve(); });
    assert(currentElement.isConnected, 'stale completion cannot remove the replacement render');
    assert.equal(document.querySelectorAll('.textLayer').length, 1);
    assert.equal(document.querySelectorAll('.annotationLayer').length, 1);
    assert.equal(selectionListeners.size, 1, 'cancelling one page does not abort a still-visible layer');
    select(currentElement); const liveListener = [...selectionListeners][0];
    const savedStyle = globalThis.getComputedStyle;
    Object.defineProperty(globalThis, 'getComputedStyle', { value: () => { throw new Error('EXPECTED_STYLE_FAILURE'); }, configurable: true });
    assert.throws(() => liveListener(event()), /EXPECTED_STYLE_FAILURE/u, 'unrelated style errors are not swallowed');
    Object.defineProperty(globalThis, 'getComputedStyle', { value: savedStyle, configurable: true });
    await clear(); assert.equal(selectionListeners.size, 0);

    const duoStart = textTasks.length;
    const duoLinks = {};
    const setPageRef = () => {};
    const renderTwoPages = async (includeFirst: boolean) => act(async () => root.render(wrap(<>
      {includeFirst && <PdfPageCanvas key="first" pdf={sharedPdf} pageNumber={1} containerWidth={800} zoom={1}
        rotation={0} linkService={duoLinks} scrollRoot={null} setPageRef={setPageRef} />}
      <PdfPageCanvas key="second" pdf={sharedPdf} pageNumber={2} containerWidth={800} zoom={1}
        rotation={0} linkService={duoLinks} scrollRoot={null} setPageRef={setPageRef} />
    </>)));
    const duoAnnotationStart = annotationTasks.length;
    const duoCanvasStart = canvasTasks.length;
    await renderTwoPages(true); await until(() => textTasks.length === duoStart + 2);
    await act(async () => {
      for (const task of textTasks.slice(duoStart)) task.gate.resolve();
      for (const task of annotationTasks.slice(duoAnnotationStart)) task.gate.resolve();
      for (const task of canvasTasks.slice(duoCanvasStart)) task.gate.resolve();
    });
    assert.equal(selectionListeners.size, 1);
    const survivingLayer = textTasks.at(-1)!.options.container;
    await renderTwoPages(false);
    assert(survivingLayer.isConnected);
    assert.equal(selectionListeners.size, 1, 'closing the first visible page cannot abort shared selection for the second page');
    select(survivingLayer); [...selectionListeners][0](event()); assert(survivingLayer.classList.contains('selecting'));
    await clear(); assert.equal(selectionListeners.size, 0);

    const loadingPdf = { numPages: 1, getOptionalContentConfig: async () => ({}), getPage: () => deferred<unknown>().promise,
      cleanup: () => { throw new Error('Document cleanup must not race active page rendering.'); } };
    const open = async (url: string) => act(async () => root.render(wrap(<PdfViewer path="same.pdf" sourceUrl={url} />)));
    await open('/first.pdf'); await until(() => documentTasks.length === 1);
    const first = documentTasks[0]; first.failDestroy = true;
    await open('/second.pdf'); await until(() => documentTasks.length === 2);
    assert.equal(first.destroyed, 1);
    await act(async () => first.gate.resolve({ ...loadingPdf, numPages: 99 }));
    assert(!document.body.textContent!.includes('99'), 'late document load cannot publish into another source');
    await act(async () => documentTasks[1].gate.resolve(loadingPdf));
    await clear(); assert.equal(documentTasks[1].destroyed, 1);
    assert(warnings.some((entry) => entry.some((value) => value instanceof Error && value.message === 'EXPECTED_DESTROY_FAILURE')),
      'failed teardown remains diagnostic, but is handled rather than becoming an unhandled promise rejection');
    assert.equal(selectionListeners.size, 0);
    select(document.getElementById('markdown')!); document.dispatchEvent(event());
    console.log('Installed PDF.js selection guard and actual PdfViewer async close/replace/cancel ownership passed; unrelated errors remain visible.');
  } finally {
    await act(async () => root.unmount());
    console.error = originalError;
    await new Promise((resolve) => setTimeout(resolve, 25));
    dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
