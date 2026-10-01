import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import { parseCanvasMarkdownDocument } from '../app/lib/markdown/obsidian-metadata';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { MarkdownPropertiesPanel } = await import('../app/components/editor/MarkdownPropertiesPanel');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useWorkspaceStore.setState({ activeWorkspaceId: null });
  const wrap = (children: React.ReactNode) => (
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
  const markdownWithTitle = (title: string) => `---\ntitle: ${JSON.stringify(title)}\n---\n\n# Body\n`;

  try {
    for (const [storedTitle, displayedTitle] of [
      ['Reel 001 - Unboxing &amp; Produktionsprozess Teaser', 'Reel 001 - Unboxing & Produktionsprozess Teaser'],
      ['Unboxing & Produktionsprozess', 'Unboxing & Produktionsprozess'],
      ['Fish &#38; Chips &#x1F3AC;', 'Fish & Chips 🎬'],
      ['&quot;Title&quot; &apos;note&apos; &nbsp;', '"Title" \'note\' \u00a0'],
      ['&amp;lt;example&amp;gt;', '&lt;example&gt;'],
      ['&lt;img src=x onerror=alert(1)&gt;', '<img src=x onerror=alert(1)>'],
    ]) {
      const view = render(wrap(<MarkdownPropertiesPanel readOnly value={markdownWithTitle(storedTitle)} />));
      const header = view.getByRole('button', { expanded: false });
      assert.ok(header.textContent?.includes(displayedTitle), 'the collapsed title must decode entities once');
      fireEvent.click(header);
      assert.equal(view.getByText(displayedTitle, { selector: 'p', exact: true, normalizer: (text) => text }).textContent,
        displayedTitle, 'the expanded read-only title must match the header');
      assert.equal(view.container.querySelector('img, script'), null, 'decoded titles must remain plain text');
      cleanup();
    }

    const storedTitle = 'Reel 001 - Unboxing &amp; Produktionsprozess Teaser';
    const changes: string[] = [];
    const value = `---\ntitle: ${storedTitle}\ntags:\n  - type/document\n---\n\n# Body\n`;
    const view = render(wrap(<MarkdownPropertiesPanel value={value} onChange={(markdown) => changes.push(markdown)} />));
    const header = view.getByRole('button', { expanded: false });
    assert.ok(header.textContent?.includes('Unboxing & Produktionsprozess'));
    fireEvent.click(header);
    const titleInput = view.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    assert.equal(titleInput.value, storedTitle, 'editing must retain the original YAML title');
    fireEvent.blur(titleInput);
    assert.deepEqual(changes, [], 'displaying or leaving an unchanged title must not rewrite the document');
    fireEvent.click(view.getByRole('button', { name: 'Remove tag #type/document' }));
    assert.equal(parseCanvasMarkdownDocument(changes[0]).frontmatter?.title, storedTitle,
      'editing another property must not decode the stored title');
    assert.equal(parseCanvasMarkdownDocument(changes[0]).body, '\n# Body\n');
    fireEvent.change(titleInput, { target: { value: 'Updated & title' } });
    fireEvent.blur(titleInput);
    assert.equal(parseCanvasMarkdownDocument(changes.at(-1)!).frontmatter?.title, 'Updated & title',
      'explicit title edits must still be saved');
    console.log('Markdown properties title display, safe text and source preservation tests passed.');
  } finally {
    cleanup();
    dom.window.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
