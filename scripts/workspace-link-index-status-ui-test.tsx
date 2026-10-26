import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import { WorkspaceLinkIndexStatus } from '../app/components/shared/WorkspaceLinkIndexStatus';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import type { WorkspaceLinkReadIndex } from '../app/lib/markdown/workspace-document-link-index-contract';

const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
for (const name of ['window','document','navigator','HTMLElement','Node','Event'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
async function main() {
  const root = createRoot(document.getElementById('root')!);
  const index: WorkspaceLinkReadIndex = { ...buildWorkspaceLinkIndexFromDocuments([{ path: 'source.md', content: '[Missing](missing.md)' }]),
    diagnostics: { sourcesComplete: true, sourceGaps: [], metadataErrors: ['source.md'], htmlSources: ['page.html'] } };
  const render = async (value: WorkspaceLinkReadIndex, locale: 'en' | 'de') => act(async () => root.render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
      <WorkspaceLinkIndexStatus index={value} />
    </NextIntlClientProvider>));
  try {
    await render(index, 'en');
    assert.equal(document.querySelectorAll('details').length, 3);
    assert(!document.body.textContent?.includes(en.documentLinkIndex.incomplete));
    assert.match(document.body.textContent!, /metadata.*1 document/u);
    assert.match(document.body.textContent!, /HTML links.*1 file/u);
    assert.match(document.body.textContent!, /1 link has no unambiguous target/u);
    assert(document.body.textContent?.includes('source.md → missing.md'));
    const missing = { ...index, diagnostics: { ...index.diagnostics!, sourcesComplete: false,
      sourceGaps: [{ code: 'missing-native-state', path: 'legacy.md' }] } };
    await render(missing, 'de');
    assert(document.body.textContent?.includes(de.documentLinkIndex.incomplete));
    assert(document.body.textContent?.includes('legacy.md'));
    const healthy = { ...index, brokenLinks: [], diagnostics: { sourcesComplete: true, sourceGaps: [], metadataErrors: [], htmlSources: [] } };
    await render(healthy, 'de'); assert.equal(document.querySelector('[role="status"]'), null);
    await render({ ...healthy, coverage: { ...healthy.coverage, complete: false }, diagnostics: undefined }, 'en');
    assert(document.body.textContent?.includes(en.documentLinkIndex.incomplete), 'older incomplete responses stay conservative');
    console.log('Link index status UI: distinct source/metadata/HTML/target messages, affected paths, English/German and healthy/legacy states passed.');
  } finally { await act(async () => root.unmount()); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
