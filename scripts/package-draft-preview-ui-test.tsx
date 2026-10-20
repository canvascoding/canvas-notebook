import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { CapabilityPackageDraftPresentation } from '../app/lib/capabilities/packages/draft-presentation-contracts';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDetailsElement', 'MutationObserver', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const draftRef = 'canvas-package-draft:11111111-1111-4111-8111-111111111111';
const fixture: CapabilityPackageDraftPresentation = { schemaVersion: 1, origin: 'draft', draftRef, draftRevision: 5,
  checksum: 'a'.repeat(64), kind: 'plugin', name: 'account-brief', title: 'Account Brief', description: 'Research and CRM facts', version: '1.0.0',
  ownership: { type: 'organization', organizationId: 'verified-org' }, presentation: null, previewIncomplete: true, imageAvailable: true,
  authoring: { operation: 'create', intendedAudience: 'not_specified', capturesTruncated: false, captures: [
    { source: 'package', sourceName: 'original-facts', sourceVersion: '1.0.0', parent: { name: 'source-suite', version: '3.0.0' },
      targetName: 'copied-facts', targetVersionAtCapture: '1.0.1', versionChangedAtCapture: true, adjustmentsAtCapture: ['name', 'skill_references'] },
    { source: 'workspace', sourceName: 'legacy-brief', sourceVersion: '2.0.0', targetName: 'legacy-brief', targetVersionAtCapture: '2.0.0',
      versionChangedAtCapture: false, adjustmentsAtCapture: [] } ] },
  skills: [{ name: 'copied-facts', title: 'Current facts', description: 'Manually revised after capture', version: '2.0.0', path: 'skills/copied-facts/SKILL.md', origin: 'captured' },
    { name: 'new-brief', title: 'New brief', description: 'Directly authored instructions', version: '1.0.0', path: 'skills/new-brief/SKILL.md', origin: 'not_recorded' }], skillsTruncated: false };
async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input), window.location.origin);
    assert(url.pathname.endsWith('/presentation')); assert.equal(url.searchParams.get('expectedDraftRevision'), '5');
    assert.equal(url.searchParams.get('workspaceId'), 'preview-workspace');
    return Response.json({ success: true, data: fixture });
  };
  const { PackageDraftPreview } = await import('../app/components/plugins/PackageDraftPreview');
  const root = createRoot(document.getElementById('root')!);
  const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  try {
    for (const [locale, messages] of [['en', en], ['de', de]] as const) {
      await act(async () => root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <PackageDraftPreview key={locale} draftRef={draftRef} revision={5} workspaceId="preview-workspace" />
      </NextIntlClientProvider>)); await tick();
      const section = document.querySelector('[data-testid="package-draft-preview"]'); assert(section);
      assert(!section.querySelector('h3')?.parentElement?.textContent?.includes('verified-org'), 'The main preview uses the readable ownership label.');
      const audience = section.querySelector('[data-testid="package-draft-audience"]')!;
      assert(audience.textContent?.includes(messages.skills.packageEditor.audienceNotSpecified));
      assert(audience.textContent?.includes(messages.skills.packageEditor.draftDoesNotGrantUse));
      assert(section.textContent?.includes(messages.skills.packageEditor.skillCaptured));
      assert(section.textContent?.includes(messages.skills.packageEditor.skillAuthoredInDraft));
      const details = section.querySelector<HTMLDetailsElement>('[data-testid="package-draft-provenance"]')!;
      assert.equal(details.open, false, 'Capture details remain progressively disclosed.');
      assert(details.textContent?.includes('verified-org'), 'The exact organization identifier remains available for target verification under details.');
      await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
      assert(details.textContent?.includes('original-facts')); assert(details.textContent?.includes('source-suite'));
      assert(details.textContent?.includes('1.0.0 → 1.0.1')); assert(details.textContent?.includes('2.0.0'));
      assert(details.textContent?.includes(messages.skills.packageEditor.captureHistoryHint), 'The UI distinguishes at-capture facts from current manually edited versions.');
      assert(details.textContent?.includes(messages.skills.packageEditor.captureAdjustments.name));
      assert(details.textContent?.includes(messages.skills.packageEditor.captureAdjustments.skill_references));
      const img = section.querySelector('img')!; assert.equal(img.alt, '');
      assert.equal(img.getAttribute('src'), `/api/capabilities/packages/drafts/${encodeURIComponent(draftRef)}/image?expectedDraftRevision=5&workspaceId=preview-workspace`);
    }
    fixture.authoring.captures = []; fixture.authoring.capturesTruncated = true;
    await act(async () => root.render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PackageDraftPreview key="empty" draftRef={draftRef} revision={5} workspaceId="preview-workspace" /></NextIntlClientProvider>));
    await tick(); assert(document.body.textContent?.includes(en.skills.packageEditor.noCaptureHistory));
    assert(document.body.textContent?.includes(en.skills.packageEditor.captureHistoryTruncated));
    console.log('PASS Draft preview UI: DE/EN actual organization identity, explicit unresolved audience/no draft grant, captured vs unrecorded skills, historical capture vs current version, progressive details and exact decorative image URL.');
  } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
