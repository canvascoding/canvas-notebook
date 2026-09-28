import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { CodeEditorProps } from '../app/components/editor/CodeEditor';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const require = createRequire(path.join(process.cwd(), 'package.json'));
require.extensions['.css'] = () => undefined;

async function main() {
  const { PublicFilePreview } = await import('../app/components/public-sharing/PublicFilePreview');
  const { ImageViewer } = await import('../app/components/editor/ImageViewer');
  const { CodeEditor } = await import('../app/components/editor/CodeEditor');
  const root = createRoot(document.getElementById('root')!);
  const originalFetch = globalThis.fetch;
  let finishOfficeRequest: ((response: Response) => void) | null = null;
  globalThis.fetch = () => new Promise<Response>((resolve) => { finishOfficeRequest = resolve; });

  try {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <PublicFilePreview fileName="report.docx" mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          sizeBytes={1200} previewKind="office" assetUrl="/shared/report.docx" downloadUrl="/shared/report.docx" />
      </NextIntlClientProvider>);
    });
    const publicShell = document.querySelector('main');
    assert.ok(publicShell);
    assert.equal(publicShell.querySelectorAll('header').length, 1, 'public preview keeps one real header during module loading');
    assert.ok(publicShell.querySelector('section [data-testid="file-loading-skeleton"]'), 'office module starts with the shared body skeleton');
    assert.equal(publicShell.querySelector('section [data-testid="file-loading-skeleton"] header'), null, 'inner loader does not duplicate the preview header');

    for (let attempt = 0; !finishOfficeRequest && attempt < 30; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    assert.ok(finishOfficeRequest, 'office module proceeds to the document request');
    assert.ok(publicShell.querySelector('section [data-testid="file-loading-skeleton"]'), 'the same silhouette survives the module-to-document phase');
    await act(async () => { finishOfficeRequest!(new Response('Unavailable', { status: 503 })); });
    assert.equal(publicShell.querySelector('section [data-testid="file-loading-skeleton"]'), null, 'loading ends on a real error');
    assert.match(publicShell.querySelector('section')?.textContent ?? '', /Fetch failed: 503/, 'the error remains visible');

    finishOfficeRequest = null;
    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <PublicFilePreview fileName="report.docx" mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        sizeBytes={1200} previewKind="office" assetUrl="/shared/new-report.docx" downloadUrl="/shared/new-report.docx" />
    </NextIntlClientProvider>); });
    assert.ok(document.querySelector('section [data-testid="file-loading-skeleton"]'), 'new asset identity resets the failed preview to loading');
    assert.doesNotMatch(document.querySelector('section')?.textContent ?? '', /Fetch failed: 503/, 'old document errors do not flash for the new asset');

    await act(async () => { root.render(<ImageViewer path="first.png" previewSrc="/first.png" fullSrc="/first.png" />); });
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'image decode uses the same skeleton body');
    await act(async () => { document.querySelector('img')!.dispatchEvent(new dom.window.Event('load')); });
    assert.equal(document.querySelector('[data-testid="file-loading-skeleton"]'), null, 'decoded image replaces the skeleton');
    await act(async () => { root.render(<ImageViewer path="second.png" previewSrc="/second.png" fullSrc="/second.png" />); });
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'new image identity gets a fresh loading state');

    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <CodeEditor value="Unready file snapshot" onChange={() => undefined} path="notes.txt" collaborationEnabled
        collaborationDocument={null} collaborationSession={{ permission: 'write' } as NonNullable<CodeEditorProps['collaborationSession']>} collaborationIssuesManagedExternally />
    </NextIntlClientProvider>); });
    assert.ok(document.querySelector('[data-testid="file-loading-skeleton"]'), 'source editor waits on the same skeleton for its live document');
    assert.doesNotMatch(document.body.textContent ?? '', /Unready file snapshot/, 'source editor does not expose the fallback snapshot before collaboration is ready');
    console.log('editor-loading-continuity-test: ok');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
