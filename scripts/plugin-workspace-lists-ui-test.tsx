import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { PluginWorkspaceCatalogItem, PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreListResponse, CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';
import type { SafeActorSkillStoreResource } from '../app/lib/skills/actor-skill-store-state';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Actual React/next-intl lists consume SafeDTO fixtures; list rendering never fetches files/accounts/providers.
async function main() {
  const originalFetch = globalThis.fetch;
  const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
  const { PluginWorkspaceLists, pluginWorkspaceUpdateItem } = await import('../app/components/plugins/PluginWorkspaceLists');
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('Lists may not perform provider or content discovery.'); };
  const resource = (id: string, ownership: PluginWorkspaceCatalogItem['ownership']): PluginWorkspaceCatalogItem => ({ resourceRef: `canvas-resource:${id}`,
    legacyResourceId: `legacy-${id}`, kind: 'plugin', name: 'same-name', displayName: 'Same package', description: 'A safe package description', version: '1.0.0', revision: 1,
    ownership, ownershipLabel: ownership.type === 'team' ? 'Design team' : undefined,
    access: { canRead: true, canUse: false, canEdit: ownership.type === 'user', canManage: false },
    activation: { effectivePolicy: ownership.type === 'user' ? 'blocked' : 'optional', enabled: ownership.type !== 'user', readiness: ownership.type === 'user' ? 'blocked' : 'unknown',
      blockedReason: ownership.type === 'user' ? 'An organization package reserves this name.' : null } });
  const own = resource('exact-own', { type: 'user', ownerUserId: 'PRIVATE_ACTOR_ID', organizationId: 'PRIVATE_ORG_ID' });
  const org = resource('exact-org', { type: 'organization', organizationId: 'PRIVATE_ORG_ID' });
  const builtin = { ...resource('builtin', { type: 'system' }), kind: 'skill' as const, name: 'builtin', displayName: 'Built-in context', activation: undefined };
  const child = { ...resource('child', { type: 'team', organizationId: 'PRIVATE_ORG_ID', workspaceId: 'PRIVATE_TEAM_ID' }),
    kind: 'skill' as const, name: 'contained', displayName: 'Contained context', parentResourceRef: org.resourceRef };
  const catalog = (items: PluginWorkspaceCatalogItem[]): PluginWorkspaceCatalogResponse => ({ schemaVersion: 1,
    selection: { kind: null, scope: 'all', audience: null, teamId: null, q: '', page: 1, limit: 20, selectionRequired: null }, items,
    scopes: { choices: ['all', 'user', 'team', 'organization', 'system'], teams: [{ teamId: 'PRIVATE_TEAM_ID', label: 'Design team' }] },
    pagination: { page: 1, limit: 20, totalItems: items.length, totalPages: 1, hasNextPage: false, hasPreviousPage: false } });
  const current = catalog([own, org, builtin, child]);
  const opened: PluginWorkspaceCatalogItem[] = [], offerings: CapabilityPackageStoreSelection[] = [], pages: number[] = [];
  const props = { catalog: current, store: null, view: 'installed' as const, onOpenResource: (item: PluginWorkspaceCatalogItem) => opened.push(item),
    onOpenOffering: (source: CapabilityPackageStoreSelection) => offerings.push(source), onPage: (page: number) => pages.push(page) };
  const safeUpdate: SafeActorSkillStoreResource = { metadata: { resourceRef: 'canvas-resource:off-page-update', legacyResourceId: 'legacy-update', resourceType: 'skill',
    sourceType: 'standalone', sourcePluginId: null, ownership: { type: 'team', organizationId: 'PRIVATE_ORG_ID', workspaceId: 'PRIVATE_TEAM_ID' }, displayName: 'Off-page skill',
    description: 'Current exact update metadata', responsibleUserId: 'PRIVATE_RESPONSIBLE_ID', createdByUserId: 'PRIVATE_CREATOR_ID', updatedByUserId: null,
    metadataRevision: 2, grantsRevision: 3, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 2 },
    access: { canRead: true, canUse: true, canEdit: false, canManage: false }, artifact: { resourceType: 'skill', resourceId: 'legacy-update', scopeType: 'organization',
      name: 'off-page-skill', version: '1.0.0', revision: 2, sourceType: 'standalone', sourcePluginId: null }, ownershipLabel: 'Design team',
    people: { responsible: { userId: 'PRIVATE_RESPONSIBLE_ID', name: 'Designer' } },
    storeState: { origin: 'verified', localChanges: 'modified', upstream: 'update-available' } };
  const store: CapabilityPackageStoreListResponse = { schemaVersion: 1, selection: { ...current.selection, installedState: 'all' }, scopes: current.scopes,
    stores: ['plugin', 'skill'].map((kind, index) => ({ kind: kind as 'plugin' | 'skill', registry: { id: `registry-${kind}`, name: 'Store', updatedAt: 'today' }, availability: 'available',
      pagination: { page: 1, pageSize: 20, totalItems: index ? 160 : 40, totalPages: index ? 8 : 2, hasNextPage: true, hasPreviousPage: false },
      installedResources: [], offerings: [{ kind: kind as 'plugin' | 'skill', registryId: `registry-${kind}`, entryKey: `store-${kind}`, displayName: `Store ${kind}`,
        description: 'Safe Store description', latestVersion: '2.0.0', versions: [{ version: '2.0.0', checksum: 'a'.repeat(64) }],
        installedResourceRefs: index ? [] : [org.resourceRef], installedRefsTruncated: false, publisher: { name: 'Canvas publisher' } }] })),
    installed: { resources: [safeUpdate], pagination: { page: 2, limit: 20, totalItems: 30, totalPages: 2, hasNextPage: false, hasPreviousPage: true },
      summary: { total: 65, updates: 1, modified: 1, unknown: 33, observed: 32, comparison: 'partial' } } };
  const wrapped = (view: React.ReactNode, locale: 'en' | 'de' = 'en') => <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">{view}</NextIntlClientProvider>;
  try {
    render(wrapped(<PluginWorkspaceLists {...props} />));
    assert.equal(screen.getAllByTestId('plugin-workspace-resource').length, 4);
    const duplicateButtons = screen.getAllByRole('button', { name: 'Open Same package' });
    assert.equal(duplicateButtons.length, 2); fireEvent.click(duplicateButtons[0]); fireEvent.click(duplicateButtons[1]);
    assert.deepEqual(opened.map(item => item.resourceRef), [own.resourceRef, org.resourceRef], 'Same-name resources remain exact separate selections.');
    assert(screen.getByText('Blocked')); assert(screen.getByText('Can edit')); assert(screen.getByText('Read only')); assert(screen.getByText('Contained skill'));
    assert.equal(screen.queryByText('Can manage sharing'), null, 'CanEdit does not invent Manage.');
    fireEvent.click(screen.getByRole('button', { name: 'Open Contained context' })); assert.equal(opened.at(-1)?.parentResourceRef, org.resourceRef);
    for (const forbidden of ['PRIVATE_ACTOR_ID', 'PRIVATE_ORG_ID', 'PRIVATE_TEAM_ID', 'canvas-resource:exact', 'legacy-']) assert(!document.body.textContent?.includes(forbidden));
    cleanup();

    render(wrapped(<PluginWorkspaceLists {...props} store={store} view="store" />));
    assert(screen.getByText('Page 1 of 8'), 'Mixed lists expose the longest source pagination, not only the first source.');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); assert.equal(pages.at(-1), 2);
    fireEvent.click(screen.getByRole('button', { name: 'View Store plugin' }));
    assert.deepEqual(offerings[0], { kind: 'plugin', registryId: 'registry-plugin', entryKey: 'store-plugin', version: '2.0.0', checksum: 'a'.repeat(64) });
    assert.equal(screen.queryByText(/not installed/iu), null, 'Zero verified refs with partial coverage is not an absence claim.');
    assert(screen.getByTestId('plugin-workspace-comparison').textContent?.includes('32 of 65'));
    assert(screen.getByText('1 confirmed installed variants')); assert(screen.getAllByText('By Canvas publisher').length === 2);
    cleanup();

    render(wrapped(<PluginWorkspaceLists {...props} store={store} view="updates" />));
    assert(screen.getByText('Off-page skill')); assert(screen.getByText('Responsible: Designer'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Off-page skill' }));
    assert.equal(opened.at(-1)?.resourceRef, safeUpdate.metadata.resourceRef);
    assert.equal(opened.at(-1)?.ownership.type, 'team'); assert.deepEqual(opened.at(-1)?.people?.responsible, { name: 'Designer' });
    assert.equal(pluginWorkspaceUpdateItem(safeUpdate, current).revision, 2);
    assert(!document.body.textContent?.includes('PRIVATE_RESPONSIBLE_ID'));
    assert(screen.getByText('1 updates confirmed · 1 locally modified · 33 unknown'));
    cleanup();
    render(wrapped(<PluginWorkspaceLists {...props} store={null} view="updates" />));
    assert(screen.getByText('No updates are confirmed yet. Some installed versions could not be compared.'));
    assert.equal(screen.queryByText('No confirmed updates in this selection.'), null);
    cleanup();

    const outage = structuredClone(store); outage.stores[0].availability = 'unavailable'; outage.stores[0].offerings = [];
    render(wrapped(<PluginWorkspaceLists {...props} store={outage} view="store" />));
    assert(screen.getByText('Store availability is limited. Installed packages remain accessible.')); assert(screen.getByText('Store skill'));
    cleanup();
    const choose = catalog([]); choose.selection.scope = 'team'; choose.selection.selectionRequired = 'team';
    render(wrapped(<PluginWorkspaceLists {...props} catalog={choose} store={store} view="store" />));
    assert(screen.getByText('Choose a team to see its packages.')); assert.equal(screen.queryByText('Store plugin'), null);
    cleanup();
    render(wrapped(<PluginWorkspaceLists {...props} />, 'de'));
    assert(screen.getByText('Nur Lesen')); assert(screen.getByText('Enthaltener Skill')); assert(screen.getByText('Bearbeitbar'));
    assert.equal(calls, 0);
    console.log('Plugin workspace lists React/Intl PASS: exact instances, actual scopes and independent rights, built-ins/children, safe labels, mixed pagination and honest partial/outage/unknown states.');
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
