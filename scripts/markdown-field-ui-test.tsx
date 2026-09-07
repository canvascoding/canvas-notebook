import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { MarkdownEditorProps } from '../app/components/editor/MarkdownEditor';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event',
  'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});

async function main() {
  const { MarkdownModeBar } = await import('../app/components/editor/MarkdownDocumentModes');
  const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const seen: MarkdownEditorProps[] = [];
  internals._load = (request, parent, isMain) => {
    if (request === '@/app/components/editor/MarkdownEditorClient') return {
      // Test the form/dialog contract separately from the codec regression suite.
      MarkdownEditor: (props: MarkdownEditorProps) => {
        seen.push(props);
        return <div data-testid="field-editor">
          <MarkdownModeBar mode={props.mode!} onChange={props.onModeChange!} readOnly={props.readOnly!}
            wide documentControls={false} onWideChange={() => {}} actions={props.modeBarActions} />
          {props.mode === 'read' ? <p>{props.value}</p> :
            <textarea aria-label="Prompt content" value={props.value} readOnly={props.readOnly}
              onChange={(event) => props.onChange?.(event.target.value)} />}
        </div>;
      },
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { MarkdownField } = await import('../app/components/editor/MarkdownField');
    function Form({ initialValue = 'Original prompt' }: { initialValue?: string }) {
      const [value, setValue] = useState(initialValue);
      return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <MarkdownField label="Task" value={value} onChange={setValue} />
        <output data-testid="saved-value">{value}</output>
      </NextIntlClientProvider>;
    }
    render(<Form />);
    assert.equal(seen.at(-1)?.frontmatter, 'content');
    assert.equal(seen.at(-1)?.layout, 'field');
    assert.equal(seen.at(-1)?.mode, 'read');
    assert.equal(screen.queryByRole('button', { name: messages.notebook.editorModes.wide }), null);
    fireEvent.click(screen.getByRole('button', { name: messages.notebook.editorModes.rich }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed before expanding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand editor' }));
    assert.ok(screen.getByRole('dialog', { name: 'Task' }));
    assert.equal(screen.getAllByTestId('field-editor').length, 1, 'only one editor may own the draft');
    assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'Changed before expanding');
    assert.equal(seen.at(-1)?.expanded, true);
    fireEvent.click(screen.getByRole('button', { name: messages.notebook.editorModes.source }));
    const yaml = '---\ntitle: Keep this YAML\n---\n\nChanged in dialog';
    fireEvent.change(screen.getByRole('textbox'), { target: { value: yaml } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    assert.equal(screen.queryByRole('dialog'), null);
    assert.equal(seen.at(-1)?.expanded, false);
    assert.equal(seen.at(-1)?.mode, 'source');
    assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, yaml);
    assert.equal(screen.getByTestId('saved-value').textContent, yaml);
    await waitFor(() => assert.equal(document.activeElement?.getAttribute('role'), 'group', 'closing restores focus to the form field'));
    fireEvent.click(screen.getByRole('button', { name: messages.notebook.editorModes.read }));
    assert.equal(screen.getByTestId('saved-value').textContent, yaml, 'mode changes do not write or normalize the prompt');
    cleanup();
    render(<Form initialValue="" />);
    assert.equal(seen.at(-1)?.mode, 'rich', 'a new empty prompt starts ready to type');
    assert.ok(screen.getByRole('textbox'));
    cleanup();
    console.log('Markdown field mode, dialog and draft persistence tests passed.');
  } finally {
    internals._load = originalLoad;
    cleanup();
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
