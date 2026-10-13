import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';
import type { PluginExtensionSearchData } from '../app/components/plugins/usePluginExtensionSearch';
import type { CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLImageElement', 'HTMLButtonElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function main() {
  const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
  const { PluginExtensionAvatar } = await import('../app/components/plugins/PluginExtensionAvatar');
  const { PluginExtensionSearchResults } = await import('../app/components/plugins/PluginExtensionSearchResults');
  const { PackageDetailPresentation } = await import('../app/components/plugins/PackageDetailPresentation');
  const firstIcon = { url: '/api/capabilities/packages/canvas-resource%3Aone/icon?workspaceId=first', sourceKey: 'canvas-resource:one:revision:1' };
  try {
    const rendered = render(<PluginExtensionAvatar name="Canva Workflow" identity="one:first" icon={firstIcon} />);
    const firstImage = screen.getByTestId('plugin-extension-avatar-image');
    assert.equal(firstImage.getAttribute('src'), firstIcon.url);
    assert.equal(firstImage.getAttribute('alt'), '');
    assert.equal(firstImage.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(screen.getByTestId('plugin-extension-avatar').getAttribute('aria-hidden'), 'true');
    fireEvent.error(firstImage);
    assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null);
    assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'CW');

    rendered.rerender(<PluginExtensionAvatar name="Canva Workflow" identity="two:second" icon={firstIcon} />);
    const secondImage = screen.getByTestId('plugin-extension-avatar-image');
    assert.notEqual(secondImage, firstImage, 'Another exact resource/workspace gets independent image state even when the URL and name match.');
    fireEvent.error(firstImage);
    assert.equal(screen.getByTestId('plugin-extension-avatar-image'), secondImage, 'A detached old image cannot fail the current resource.');
    fireEvent.error(secondImage);
    rendered.rerender(<PluginExtensionAvatar name="Canva Workflow" identity="two:second" icon={{ ...firstIcon, sourceKey: 'canvas-resource:one:revision:2' }} />);
    assert(screen.getByTestId('plugin-extension-avatar-image'), 'Fresh public asset revision retries a previously failed URL.');
    rendered.rerender(<PluginExtensionAvatar name="Canva Workflow" identity="two:second" icon={{ ...firstIcon, url: 'https://logos.test/new.svg' }} />);
    assert.equal(screen.getByTestId('plugin-extension-avatar-image').getAttribute('src'), 'https://logos.test/new.svg');

    for (const [name, initials] of [['éclair', 'ÉC'], ['E\u0301milie Weber', 'E\u0301W'], ['设计工具', '设计'], ['𐐀lpha Beta', '𐐀B'], ['  Canva-workflow  ', 'CW'], ['', '?']]) {
      rendered.rerender(<PluginExtensionAvatar name={name} identity="unicode" />);
      assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, initials);
    }
    for (const url of ['javascript:alert(1)', 'file:///data/private.png', 'data:image/svg+xml;base64,c2VjcmV0', '//logos.test/icon.svg',
      'http://logos.test/icon.svg', 'https://user:secret@logos.test/icon.svg', '/data/plugins/secret.png', '/api/integrations/env',
      '/images/agents/origami/../../private.svg', ' https://logos.test/icon.svg', 'https://logos.test/\nprivate.svg']) {
      rendered.rerender(<PluginExtensionAvatar name="Safe Name" identity="invalid" icon={{ url, sourceKey: 'safe' }} />);
      assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null, `Unsupported image URL falls back: ${url}`);
      assert.equal(screen.getByTestId('plugin-extension-avatar-initials').textContent, 'SN');
    }
    rendered.rerender(<PluginExtensionAvatar name="Actual Agent" identity="agent-one" icon={{ url: '/images/agents/origami/crane.svg', sourceKey: 'agent-one:crane' }} />);
    assert.equal(screen.getByTestId('plugin-extension-avatar-image').getAttribute('src'), '/images/agents/origami/crane.svg');
    cleanup();

    const common = { name: 'same-name', displayName: 'Same Name', description: '', stock: 'installed' as const,
      access: { canRead: true, canUse: false, canManage: false } };
    const items: PluginExtensionItem[] = [
      { ...common, kind: 'plugin', id: 'canvas-resource:one', source: 'local', icon: firstIcon },
      { ...common, kind: 'skill', id: 'canvas-resource:two', source: 'local', icon: { url: '/api/capabilities/packages/canvas-resource%3Atwo/icon?workspaceId=first', sourceKey: 'canvas-resource:two:revision:1' } },
      { ...common, kind: 'integration', id: 'composio:canva', source: 'composio', toolkit: { slug: 'canva', noAuth: false }, connections: [], icon: { url: 'https://logos.test/canva.svg', sourceKey: 'composio:canva' } },
      { ...common, kind: 'mcp', id: 'mcp-personal:one', source: 'mcp', mcp: { template: false, transport: 'http' }, connections: [] },
    ];
    const data: PluginExtensionSearchData = { key: 'first', status: 'ready', items, selectedItem: null, response: null, updating: false, error: null, retry() {} };
    const rows = render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PluginExtensionSearchResults data={data} workspaceId="first" onOpen={() => {}} onMore={() => {}} onRetry={() => {}} /></NextIntlClientProvider>);
    const actualRows = screen.getAllByTestId('plugin-extension-row');
    assert.equal(actualRows.length, 4);
    assert.equal(actualRows[0].querySelector('img')?.getAttribute('src'), firstIcon.url);
    assert.equal(actualRows[1].querySelector('img')?.getAttribute('src'), items[1].icon?.url);
    assert.equal(actualRows[3].querySelector('[data-testid="plugin-extension-avatar-initials"]')?.textContent, 'SN');
    fireEvent.error(actualRows[0].querySelector('img')!);
    assert.equal(actualRows[0].querySelector('img'), null);
    assert(actualRows[1].querySelector('img'), 'Same-name skill does not inherit the separate package image failure.');
    rows.rerender(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PluginExtensionSearchResults data={data} workspaceId="second" onOpen={() => {}} onMore={() => {}} onRetry={() => {}} /></NextIntlClientProvider>);
    assert(screen.getAllByTestId('plugin-extension-row')[0].querySelector('img'), 'A workspace transition remounts the exact row avatar.');
    assert.equal(screen.getAllByRole('button', { name: 'Open Same Name' }).length, 4, 'Decorative initials do not duplicate the accessible row label.');
    cleanup();

    const parentIdentity = JSON.stringify(['canvas-resource:exact-parent', 'first', 2]);
    const declarations: CapabilityPackagePresentation = { schemaVersion: 1, origin: 'installed', kind: 'plugin', name: 'workflow', title: 'Workflow',
      version: '1.0.0', description: '', resourceRef: 'canvas-resource:exact-parent', children: [], scripts: [], compatibility: [], requiredEnv: [], readOnly: false, sourceStampCurrent: true,
      capabilities: ['plugin', 'skill'].map(kind => ({ declaredBy: { kind: kind as 'plugin' | 'skill', name: 'same-name' }, id: 'same-capability', application: 'Design', required: true,
        alternatives: [{ source: 'mcp' as const, label: 'Design MCP', selector: { source: 'mcp' as const, connector: 'design-mcp' } }] })),
      requirements: ['first', 'second'].map(toolkit => ({ declaredBy: { kind: 'plugin' as const, name: 'workflow' }, source: 'composio' as const, label: 'Studio Design', required: true, recommended: false,
        selector: { source: 'composio' as const, toolkit } })),
    };
    const originalFetch = globalThis.fetch;
    let declarationCalls = 0;
    globalThis.fetch = async () => { declarationCalls += 1; throw new Error('Declaration initials must not discover provider icons or accounts.'); };
    try {
      const declarationView = render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PackageDetailPresentation presentation={declarations} identity={parentIdentity} /></NextIntlClientProvider>);
      const avatars = screen.getAllByTestId('plugin-extension-avatar');
      assert.equal(avatars.length, 6, 'Capabilities, alternatives and requirements all show initials.');
      assert.deepEqual(screen.getAllByTestId('plugin-extension-avatar-initials').map(value => value.textContent), ['DE', 'DM', 'DE', 'DM', 'SD', 'SD']);
      const identities = avatars.map(value => value.getAttribute('data-identity')!);
      assert.equal(new Set(identities).size, 6, 'Identical names and capability IDs remain bound to their exact declaration/selection.');
      assert(identities.every(identity => JSON.parse(identity)[0] === parentIdentity));
      assert.equal(screen.queryByTestId('plugin-extension-avatar-image'), null);
      const nextParent = JSON.stringify(['canvas-resource:exact-parent', 'second', 3]);
      declarationView.rerender(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PackageDetailPresentation presentation={declarations} identity={nextParent} /></NextIntlClientProvider>);
      assert(screen.getAllByTestId('plugin-extension-avatar').every(value => JSON.parse(value.getAttribute('data-identity')!)[0] === nextParent));
      assert.equal(declarationCalls, 0);
    } finally { globalThis.fetch = originalFetch; }
    console.log('Plugin extension avatar React PASS: source-bound exact mixed rows, image-error initials, independent identity/workspace/revision recovery, Unicode initials, decorative labels, safe URLs and declaration-bound capability/alternative/requirement initials without provider discovery. JSDOM events only; no real image/network/browser evidence.');
  } finally { cleanup(); dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
