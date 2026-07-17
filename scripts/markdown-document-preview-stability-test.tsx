import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'Event', { value: dom.window.Event, configurable: true });
Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true });
Object.defineProperty(globalThis, 'EventTarget', { value: dom.window.EventTarget, configurable: true });
Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true });
Object.defineProperty(globalThis, 'NodeFilter', { value: dom.window.NodeFilter, configurable: true });
Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true });
Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
Object.defineProperty(globalThis, 'HTMLInputElement', { value: dom.window.HTMLInputElement, configurable: true });
Object.defineProperty(globalThis, 'MutationObserver', { value: dom.window.MutationObserver, configurable: true });
Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const documentPath = '03_releases/v2026.7.17.7/social-posts.md';
const documentTitle = 'Canvas Notebook Release Social Posts — v2026.7.17.7';
const messages = {
  notebook: {
    markdownDocumentLinkAmbiguous: 'Ambiguous: {candidates}',
    markdownDocumentLinkMissing: 'Missing: {target}',
    markdownDocumentLinkPreview: 'Preview {title}',
    markdownDocumentLinkResolving: 'Resolving',
    markdownDocumentLinkUnavailable: 'Unavailable: {error}',
    markdownDocumentPreviewEmpty: 'Empty preview',
    markdownDocumentPreviewLoadError: 'Preview failed',
    markdownDocumentPreviewLoading: 'Loading preview',
    markdownDocumentPreviewOpen: 'Open in editor',
    markdownDocumentPreviewTitle: 'Document preview',
    markdownDocumentPreviewTruncated: 'Truncated preview',
    markdownDocumentPreviewUnavailable: 'Preview unavailable',
    markdownEditorLinkOpenError: 'Open failed',
  },
};

const linkIndex = {
  backlinks: {},
  brokenLinks: [],
  documents: [{
    aliases: [],
    blockIds: [],
    headings: [],
    path: documentPath,
    tags: [],
    title: documentTitle,
  }],
  edges: [],
  generatedAt: new Date(0).toISOString(),
  omittedDocuments: [],
};

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/markdown/link-index')) {
      return Response.json({ success: true, index: linkIndex });
    }
    if (url.startsWith('/api/files/read')) {
      return Response.json({
        data: {
          content: `# ${documentTitle}\n\nRelease preview content.`,
          path: documentPath,
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  },
});

async function waitFor(assertion: () => void, message: string) {
  const deadline = Date.now() + 2_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw new Error(message, { cause: lastError });
}

async function main() {
  const [{ MarkdownRenderer }, { useWorkspaceStore }] = await Promise.all([
    import('../app/components/shared/MarkdownRenderer'),
    import('../app/store/workspace-store'),
  ]);
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const markdown = `[Social Posts](${documentPath})`;

  const renderMarkdown = (version: number) => (
    <NextIntlClientProvider locale="en" timeZone="Europe/Berlin" messages={messages}>
      <MarkdownRenderer content={markdown} className={`render-${version}`} />
    </NextIntlClientProvider>
  );

  await act(async () => {
    root.render(renderMarkdown(1));
  });
  await waitFor(() => {
    assert.ok(document.querySelector('button[data-canvas-wiki-status="resolved"]'));
  }, 'workspace document link should resolve');

  await act(async () => {
    (document.querySelector('button[data-canvas-wiki-status="resolved"]') as HTMLButtonElement).click();
  });
  await waitFor(() => {
    assert.ok(document.querySelector('[role="dialog"]'));
  }, 'document preview should open');

  await act(async () => {
    root.render(renderMarkdown(2));
  });
  assert.ok(
    document.querySelector('[role="dialog"]'),
    'an unrelated MarkdownRenderer rerender must not close an open document preview',
  );

  await act(async () => {
    root.unmount();
  });
  container.remove();

  console.log('markdown-document-preview-stability-test: ok');
}

void main();
