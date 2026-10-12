import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { Editor } from '@tiptap/core';
import type { EditorRangeTarget } from '../app/lib/editor/interaction-target';
import type { MarkdownFrontmatterMode } from '../app/lib/markdown/editor-document';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
Object.defineProperty(dom.window, 'ResizeObserver', { value: globalThis.ResizeObserver, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

async function main() {
  const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
  const { richMarkdownCodecExtensions } = await import('../app/lib/markdown/rich-markdown-codec');
  const { createEditorRangeTarget, invalidateEditorTarget } = await import('../app/lib/editor/interaction-target');
  const { MarkdownInsertDialog } = await import('../app/components/editor/MarkdownInsertDialog');
  const createEditor = () => new Editor({
    extensions: richMarkdownCodecExtensions(), content: 'Before\n\nAfter', contentType: 'markdown',
  });
  const wrap = (props: React.ComponentProps<typeof MarkdownInsertDialog>) => <StrictMode>
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><MarkdownInsertDialog {...props} /></NextIntlClientProvider>
  </StrictMode>;
  const input = () => screen.getByRole('textbox', { name: 'Markdown' }) as HTMLTextAreaElement;
  const insert = () => fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  const type = (value: string) => fireEvent.change(input(), { target: { value } });

  type Fixture = {
    editor: Editor; target: EditorRangeTarget;
    closeCount: () => number;
    rerender: (props: Partial<React.ComponentProps<typeof MarkdownInsertDialog>>) => void;
  };
  async function scenario(frontmatter: MarkdownFrontmatterMode, run: (fixture: Fixture) => Promise<void> | void) {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 7 });
    const target = createEditorRangeTarget(editor);
    assert(target);
    let closed = 0;
    let props: React.ComponentProps<typeof MarkdownInsertDialog> = {
      editor, target, frontmatter, readOnly: false, onClose: () => { closed++; },
    };
    const view = render(wrap(props));
    try {
      await run({ editor, target, closeCount: () => closed, rerender: next => {
        props = { ...props, ...next }; view.rerender(wrap(props));
      } });
    } finally {
      cleanup(); editor.destroy();
    }
  }

  try {
    await scenario('metadata', ({ editor, closeCount }) => {
      const before = editor.getJSON();
      assert.equal((screen.getByRole('button', { name: 'Insert' }) as HTMLButtonElement).disabled, true,
        'empty Markdown cannot submit');
      const draft = '<div>Preserve this unsupported markup</div>';
      type(draft); insert();
      assert.equal(input().value, draft, 'rejected input stays available to edit or copy');
      assert(screen.getByRole('alert').textContent?.trim(), 'validation failure gives an actionable message');
      assert.deepEqual(editor.getJSON(), before, 'rejected Markdown never changes the live document');
      assert.equal(closeCount(), 0);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      assert.equal(closeCount(), 1, 'explicit Cancel closes even a rejected draft');
      assert.deepEqual(editor.getJSON(), before);
    });

    for (const draft of ['---\ntitle: Keep this metadata\n---\n\n# Imported', '---\ntitle: [invalid\n---\n\n# Imported']) {
      await scenario('metadata', ({ editor, closeCount }) => {
        const before = editor.getJSON();
        type(draft); insert();
        assert.equal(input().value, draft, 'frontmatter is not silently discarded');
        assert(screen.getByRole('alert').textContent?.trim());
        assert.deepEqual(editor.getJSON(), before);
        assert.equal(closeCount(), 0);
      });
    }

    await scenario('content', ({ editor, rerender }) => {
      const draft = '---\ntitle: Keep this YAML\n---\n\nBody';
      const before = editor.getJSON();
      type(draft); insert();
      assert.equal(input().value, draft, 'field content is never silently treated as removable document metadata');
      assert.equal(screen.getByRole('alert').textContent, messages.notebook.markdownInsert.errors.roundtrip_changed);
      assert.deepEqual(editor.getJSON(), before);
      let contentAtClose = '';
      rerender({ onClose: () => { contentAtClose = editor.state.doc.textContent; } });
      type('title: Keep this YAML\n\nBody'); insert();
      assert(contentAtClose.includes('title: Keep this YAML') && contentAtClose.includes('Body'),
        'corrected field content inserts successfully');
      assert(contentAtClose.includes('After'), 'inserting field content retains surrounding text');
    });

    await scenario('metadata', ({ editor, rerender, closeCount }) => {
      const before = editor.getJSON();
      const draft = '# Retained after permission change';
      type(draft);
      rerender({ readOnly: true }); insert();
      assert.equal(input().value, draft, 'a read-only prop transition keeps the draft mounted');
      assert.deepEqual(editor.getJSON(), before, 'the permission prop wins even while Tiptap remains editable');
      assert.equal(closeCount(), 0);
      rerender({ readOnly: false });
      editor.setEditable(false); insert();
      assert.equal(input().value, draft, 'native permission revocation also preserves the draft');
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(closeCount(), 0);
    });

    await scenario('metadata', ({ editor, rerender, closeCount }) => {
      const before = editor.getJSON();
      const replacement = createEditor();
      const replacementBefore = replacement.getJSON();
      const draft = '# Kept across editor replacement';
      try {
        type(draft); rerender({ editor: null }); insert();
        assert.equal(input().value, draft, 'temporary missing editor does not erase input');
        rerender({ editor: replacement }); insert();
        assert.equal(input().value, draft, 'a replacement editor cannot acquire the old target');
        assert(screen.getByRole('alert').textContent?.trim());
        assert.deepEqual(editor.getJSON(), before, 'the old editor receives no late insert');
        assert.deepEqual(replacement.getJSON(), replacementBefore, 'the new editor receives no unrelated insert');
        assert.equal(closeCount(), 0);
      } finally { replacement.destroy(); }
    });

    await scenario('metadata', async ({ editor, closeCount }) => {
      const draft = '# Kept after editor destruction';
      type(draft);
      await act(async () => editor.destroy());
      insert();
      assert.equal(input().value, draft);
      assert(screen.getByRole('alert').textContent?.trim());
      assert.equal(closeCount(), 0, 'destroying the editor neither writes nor reports success');
    });

    await scenario('metadata', ({ editor, target, closeCount }) => {
      const before = editor.getJSON();
      const draft = '# Kept after selection loss';
      type(draft); invalidateEditorTarget(target); insert();
      assert.equal(input().value, draft);
      assert(screen.getByRole('alert').textContent?.trim());
      assert.deepEqual(editor.getJSON(), before);
      assert.equal(closeCount(), 0);
    });

    await scenario('metadata', ({ editor, rerender }) => {
      let changedTransactions = 0;
      let successfulClose = 0;
      editor.on('transaction', ({ transaction }) => { if (transaction.docChanged) changedTransactions++; });
      rerender({ onClose: () => {
        successfulClose++;
        assert(changedTransactions > 0, 'success closes only after a document transaction');
        assert(editor.state.doc.textContent.includes('Inserted heading'));
      } });
      type('# Inserted heading\n\n**Bold text**'); insert();
      assert.equal(successfulClose, 1);
      assert(editor.getHTML().includes('<h1'), 'Markdown heading is inserted as a native heading');
      assert(editor.getHTML().includes('<strong>Bold text</strong>'), 'Markdown bold is inserted as a native mark');
      assert(editor.state.doc.textContent.includes('After'), 'existing surrounding content survives');
      assert(!editor.state.doc.textContent.includes('Before'), 'the originally selected text is replaced');
    });
    console.log('Markdown insertion dialog: validation/frontmatter, draft retention, permissions, target lifetime and native completion passed.');
  } finally { cleanup(); dom.window.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
