import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { CanvasCodeBlock } from '../app/lib/markdown/core/base-blocks';
import { withStableNodeViewMount } from '../app/lib/editor/stable-node-view';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

async function main() {
  const { MermaidCodeBlockNodeView } = await import('../app/components/editor/MermaidCodeBlockNodeView');
  const chart = 'xychart-beta\n x-axis [Desktop, Mobile]\n bar [44, 99]';
  const extension = CanvasCodeBlock.extend({
    addNodeView() { return withStableNodeViewMount(ReactNodeViewRenderer(MermaidCodeBlockNodeView)); },
  });
  let editor: Editor | null = null;
  function Harness() {
    editor = useEditor({
      extensions: [StarterKit.configure({ codeBlock: false }), extension],
      content: { type: 'doc', content: [
        { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: chart }] },
        { type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: 'const value = 1;' }] },
      ] },
      immediatelyRender: false,
    });
    return <EditorContent editor={editor} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><Harness /></NextIntlClientProvider>,
    ));
    assert.ok(editor);
    const activeEditor = editor as Editor;
    const block = host.querySelector('[data-mermaid-mode]')!;
    const contentDom = block.querySelector('[data-node-view-content]');
    assert.ok(contentDom);
    const before = activeEditor.getJSON();
    assert.equal(block.getAttribute('data-mermaid-mode'), 'preview');
    assert.equal((block.querySelector('pre') as HTMLElement).style.display, 'none');

    for (let index = 0; index < 3; index++) {
      await act(async () => { (block.querySelector('[data-testid="markdown-editor-mermaid-toggle"]') as HTMLButtonElement).click(); });
      assert.equal(block.getAttribute('data-mermaid-mode'), 'code');
      assert.equal(block.querySelector('[data-node-view-content]'), contentDom, 'the editable DOM must survive mode switches');
      assert.equal((block.querySelector('pre') as HTMLElement).style.display, '');
      assert.equal(block.querySelector('button[aria-label="Show Mermaid diagram"]')?.tagName, 'BUTTON');
      await act(async () => { (block.querySelector('[data-testid="markdown-editor-mermaid-toggle"]') as HTMLButtonElement).click(); });
      assert.equal(block.getAttribute('data-mermaid-mode'), 'preview');
      assert.deepEqual(activeEditor.getJSON(), before, 'changing the view must not change document content');
    }

    await act(async () => {
      block.querySelector('[role="button"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(block.getAttribute('data-mermaid-mode'), 'code', 'the preview must remain keyboard accessible');
    const edited = chart.replace('[44, 99]', '[45, 100]');
    await act(async () => { activeEditor.commands.insertContentAt({ from: 1, to: 1 + chart.length }, { type: 'text', text: edited }); });
    assert.equal(contentDom.textContent, edited);
    await act(async () => { (block.querySelector('[data-testid="markdown-editor-mermaid-toggle"]') as HTMLButtonElement).click(); });
    assert.equal(block.getAttribute('data-mermaid-mode'), 'preview');
    assert.equal(activeEditor.state.doc.firstChild?.textContent, edited, 'the preview must use the latest edited source');
    assert.equal(block.querySelector('[data-node-view-content]'), contentDom);
    assert.equal(activeEditor.state.doc.child(1).textContent, 'const value = 1;');
    assert.equal(host.querySelectorAll('[data-testid="markdown-editor-mermaid-toggle"]').length, 1,
      'ordinary code blocks must not acquire a Mermaid toggle');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
  console.log('mermaid-editor-toggle-test: ok');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
