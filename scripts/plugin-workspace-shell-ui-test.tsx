import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { useMemo, useState, useSyncExternalStore } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { PluginWorkspaceCatalogItem, PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CapabilityPackageStoreListResponse } from '../app/lib/capabilities/packages/store-contracts';
import type { PackageDetailWorkspaceProps } from '../app/components/plugins/PackageDetailWorkspace';
import type { StorePackageWizardProps } from '../app/components/plugins/StorePackageWizard';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

// Actual shell/navigation/history guard/data hook/rows. Controlled SafeDTO transport proves UI behavior, never server authority.
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  const navigationEvent = 'plugin-shell-router-fixture', workspaceEvent = 'plugin-shell-workspace-fixture';
  const originalPush = window.history.pushState.bind(window.history), originalReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = (...args) => { originalPush(...args); window.dispatchEvent(new Event(navigationEvent)); };
  window.history.replaceState = (...args) => { originalReplace(...args); window.dispatchEvent(new Event(navigationEvent)); };
  const subscribeNavigation = (callback: () => void) => { window.addEventListener(navigationEvent, callback); window.addEventListener('popstate', callback);
    return () => { window.removeEventListener(navigationEvent, callback); window.removeEventListener('popstate', callback); }; };
  const subscribeWorkspace = (callback: () => void) => { window.addEventListener(workspaceEvent, callback); return () => window.removeEventListener(workspaceEvent, callback); };
  let workspace = { initialized: true, activeWorkspaceId: 'own-workspace', organizationId: 'fixture-org',
    workspaces: [{ id: 'own-workspace', name: 'Own workspace' }, { id: 'other-readable', name: 'Other readable workspace' }, { id: 'new-workspace', name: 'New workspace' }] };
  let rejectsDirty = true;
  const confirmations: string[] = [], detailSelections: PackageDetailWorkspaceProps[] = [], wizardSelections: StorePackageWizardProps[] = [];
  function DetailBoundary(props: PackageDetailWorkspaceProps) {
    const [dirty, setDirty] = useState(false), [pending, setPending] = useState(false);
    useGuard({ dirty, pending }); detailSelections.push(props);
    return <section data-testid="shell-detail-boundary" data-dirty={dirty} data-pending={pending}><output data-testid="detail-ref">{props.resourceRef}</output><output data-testid="detail-workspace">{props.workspaceId}</output>
      <button type="button" onClick={props.onClose}>Back from exact detail</button><button type="button" onClick={() => setDirty(true)}>Make detail dirty</button>
      <button type="button" onClick={() => setPending(true)}>Make detail pending</button><button type="button" onClick={() => { setDirty(false); setPending(false); }}>Clear detail guard</button>
      <button type="button" onClick={() => props.onStoreUpdate({ kind: 'plugin', registryId: 'fixture-store', entryKey: 'design-bundle', version: '2.0.0', checksum: 'b'.repeat(64) },
        props.resourceRef === ownLegacyAlias ? ownRef : props.resourceRef)}>Open reviewed update</button>
    </section>;
  }
  function WizardBoundary(props: StorePackageWizardProps) {
    const [pending, setPending] = useState(false); useGuard({ dirty: false, pending }); wizardSelections.push(props);
    return <section data-testid="shell-wizard-boundary"><output data-testid="wizard-source">{JSON.stringify(props.source)}</output><output data-testid="wizard-workspace">{props.workspaceId}</output>
      <button type="button" onClick={props.onClose}>Close selected source</button><button type="button" onClick={() => setPending(true)}>Make wizard pending</button>
      <button type="button" onClick={() => setPending(false)}>Clear wizard guard</button></section>;
  }
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => { const search = useSyncExternalStore(subscribeNavigation, () => window.location.search); return useMemo(() => new URLSearchParams(search), [search]); } };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: (select: (value: typeof workspace) => unknown) => select(useSyncExternalStore(subscribeWorkspace, () => workspace)) };
    if (name === '@/i18n/navigation') return { Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
    if (parent?.filename.endsWith('/PluginWorkspace.tsx') && /(?:^|\/)PackageDetailWorkspace(?:\.tsx)?$/u.test(name)) return { PackageDetailWorkspace: DetailBoundary };
    if (parent?.filename.endsWith('/PluginWorkspace.tsx') && /(?:^|\/)StorePackageWizard(?:\.tsx)?$/u.test(name)) return { StorePackageWizard: WizardBoundary };
    return originalLoad(name, parent, isMain);
  };
  window.confirm = value => { confirmations.push(value ?? ''); return !rejectsDirty; };
  const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
  const { PluginNavigationGuard, usePluginEditorNavigationGuard: useGuard } = await import('../app/components/plugins/plugin-navigation-guard');
  const ownRef = 'canvas-resource:11111111-1111-4111-8111-111111111111', orgRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
  const ownLegacyAlias = 'canvas-capability:v1:plugin:user:fixture-user:standalone:design-bundle';
  const childRef = 'canvas-resource:33333333-3333-4333-8333-333333333333', teamRef = 'canvas-resource:44444444-4444-4444-8444-444444444444';
  const sourceRef = 'canvas-resource:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', draftRef = 'canvas-package-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const item = (resourceRef: string, name: string, kind: 'plugin' | 'skill', owner: PluginWorkspaceCatalogItem['ownership']): PluginWorkspaceCatalogItem => ({ resourceRef, legacyResourceId: `legacy-${name}-${owner.type}`,
    kind, name, displayName: name === 'design-bundle' ? 'Design bundle' : name, description: 'Safe management metadata', version: '1.0.0', revision: 1, ownership: owner,
    access: { canRead: true, canUse: false, canEdit: false, canManage: false } });
  const rows = [item(ownRef, 'design-bundle', 'plugin', { type: 'user', ownerUserId: 'fixture-user', organizationId: 'fixture-org' }),
    item(orgRef, 'design-bundle', 'plugin', { type: 'organization', organizationId: 'fixture-org' }),
    { ...item(childRef, 'design-context', 'skill', { type: 'user', ownerUserId: 'fixture-user', organizationId: 'fixture-org' }), parentResourceRef: ownRef },
    item(teamRef, 'team-context', 'skill', { type: 'team', organizationId: 'fixture-org', workspaceId: 'readable-team' })];
  type Seen = { url: URL; init?: RequestInit };
  const requests: Seen[] = [];
  const authRequests: Array<{ path: string; method: string }> = [];
  const holds = new Map<string, { promise: Promise<void>; release(): void }>();
  let catalogError = false, storeError = false;
  const hold = (key: string) => { let release!: () => void; holds.set(key, { promise: new Promise<void>(resolve => { release = resolve; }), release }); return release; };
  const success = (data: unknown) => Response.json({ success: true, data });
  const catalog = (url: URL): PluginWorkspaceCatalogResponse => {
    const scope = url.searchParams.get('scope') as PluginWorkspaceCatalogResponse['selection']['scope'], audience = url.searchParams.get('audience') as 'own' | 'shared' | null;
    let items = rows.filter(row => scope === 'user' ? audience === 'shared' ? row.ownership.type !== 'user' : row.ownership.type === 'user'
      : scope === 'organization' ? row.ownership.type === 'organization' : scope === 'team' ? url.searchParams.get('teamId') === 'readable-team' && row.ownership.type === 'team' : true);
    const kind = url.searchParams.get('kind') as 'plugin' | 'skill' | null, q = url.searchParams.get('q') ?? '', page = Number(url.searchParams.get('page')) || 1;
    items = items.filter(row => (!kind || row.kind === kind) && (!q || [row.name, row.displayName].some(value => value.includes(q))));
    const prefix = url.searchParams.get('workspaceId') === 'new-workspace' ? 'New workspace ' : '';
    const legacyLookup = url.searchParams.get('limit') === '50';
    return { schemaVersion: 1, selection: { scope, audience, teamId: url.searchParams.get('teamId'), kind, q, page, limit: 20, selectionRequired: scope === 'team' && !url.searchParams.get('teamId') ? 'team' : null },
      items: items.map(row => ({ ...row, displayName: prefix + row.displayName })), scopes: { choices: ['all', 'user', 'team', 'organization', 'system'], teams: [{ teamId: 'readable-team', label: 'Readable design team' }] },
      pagination: legacyLookup
        ? { page, limit: 50, totalItems: items.length, totalPages: items.length ? 1 : 0, hasNextPage: false, hasPreviousPage: false }
        : { page, limit: 20, totalItems: 21, totalPages: 2, hasNextPage: page < 2, hasPreviousPage: page > 1 } };
  };
  const store = (url: URL): CapabilityPackageStoreListResponse => {
    const current = catalog(url);
    const offeringLabel = `${url.searchParams.get('workspaceId') === 'new-workspace' ? 'New workspace ' : ''}${url.searchParams.get('scope') === 'organization' ? 'Organization ' : ''}Design offering`;
    return { schemaVersion: 1, selection: { ...current.selection, installedState: url.searchParams.get('installedState') === 'updates' ? 'updates' : 'all' }, scopes: current.scopes,
      stores: [{ kind: 'plugin', registry: { id: 'fixture-store', name: 'Store', updatedAt: 'today' }, availability: 'available',
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false }, installedResources: [],
        offerings: [{ kind: 'plugin', registryId: 'fixture-store', entryKey: 'design-bundle', displayName: offeringLabel, description: 'Safe public offering', latestVersion: '2.0.0',
          versions: [{ version: '2.0.0', checksum: 'b'.repeat(64), notes: 'Current source release two' },
            { version: '1.0.0', checksum: 'a'.repeat(64), notes: 'Current source release one' }], installedResourceRefs: [], installedRefsTruncated: false }] }],
      installed: { resources: [], pagination: { ...current.pagination, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
        summary: { total: 21, updates: 0, modified: 0, unknown: 21, observed: 0, comparison: 'unknown' } } };
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/auth/get-session') {
      assert.equal(url.origin, window.location.origin); assert.equal(init?.method ?? 'GET', 'GET');
      authRequests.push({ path: url.pathname, method: init?.method ?? 'GET' }); return Response.json(null);
    }
    requests.push({ url, init });
    const pathname = decodeURIComponent(url.pathname);
    const workspaceId = url.searchParams.get('workspaceId'); assert(workspaceId);
    if (url.pathname === '/api/plugins/catalog' || url.pathname === '/api/capabilities/packages/store') {
      assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), workspaceId);
      const payload = url.pathname.endsWith('/catalog') ? catalog(url) : store(url);
      const failed = url.pathname.endsWith('/catalog') ? catalogError : storeError;
      const requestKey = `${url.pathname}:${workspaceId}:${url.searchParams.get('scope')}`;
      await (url.searchParams.get('limit') === '50' ? holds.get(`${requestKey}:legacy:${url.searchParams.get('q')}`) : undefined)?.promise;
      await holds.get(requestKey)?.promise;
      return failed ? Response.json({ success: false, code: 'PACKAGE_SNAPSHOT_UNAVAILABLE', error: 'PRIVATE_BACKEND_BODY' }, { status: 503 }) : success(payload);
    }
    if (url.pathname === '/api/capabilities/packages/drafts') return success({ drafts: [{ draftRef, resourceRef: sourceRef, sourceResourceRef: sourceRef,
      kind: 'plugin', name: 'Private draft after source removal', operation: 'edit', draftRevision: 1, targetOwnership: { type: 'organization', organizationId: 'fixture-org' }, createdAt: 1, updatedAt: 1 }], nextCursor: null });
    if (pathname.endsWith(`/${draftRef}/status`)) return success({ status: { draftRef, resourceRef: sourceRef, sourceResourceRef: sourceRef, kind: 'plugin', name: 'Private draft after source removal',
      operation: 'edit', draftRevision: 1, targetOwnership: { type: 'organization', organizationId: 'fixture-org' }, createdAt: 1, updatedAt: 1 } });
    if (pathname === `/api/capabilities/packages/${sourceRef}`) return Response.json({ success: false, code: 'PACKAGE_ACCESS_DENIED' }, { status: 403 });
    throw new Error(`Unexpected UI metadata endpoint: ${url.pathname}`);
  };
  // The imported real SharedSection constructs BetterAuth even though this gate never mounts it.
  // Register its nullable controlled auth transport before importing the shell, without a hook mock.
  const { PluginWorkspace } = await import('../app/components/plugins/PluginWorkspace');
  const App = ({ locale = 'en' }: { locale?: 'en' | 'de' }) => <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
    <PluginNavigationGuard unsavedChangesMessage={(locale === 'en' ? en : de).skills.drafts.unsavedNavigation} /><PluginWorkspace canManageOrganizationCapabilities={false} />
  </NextIntlClientProvider>;
  const setHref = async (search: string) => { await act(async () => { window.history.pushState(null, '', `/en/plugins${search ? `?${search}` : ''}`); }); };
  const waitRows = async () => { await screen.findByTestId('plugin-workspace-resources'); };
  try {
    const rendered = render(<App />);
    await waitRows(); assert.equal(new URLSearchParams(window.location.search).get('view'), null);
    assert.equal(screen.getAllByTestId('plugin-workspace-resource').length, 2, 'Default installed view includes both plugin and child skill without a global Manage gate.');
    assert.equal(requests.some(request => request.url.pathname.endsWith('/store')), false);
    assert.equal(requests[0].url.searchParams.has('kind'), false);
    fireEvent.click(screen.getByTestId('plugin-workspace-scope-organization')); await waitRows();
    assert.equal(new URLSearchParams(window.location.search).get('scope'), 'organization');
    assert(screen.getByRole('button', { name: 'Open Design bundle' }), 'Readable Organization is browseable when canManageOrganizationCapabilities=false.');
    fireEvent.click(screen.getByTestId('plugin-workspace-scope-team'));
    await screen.findByText('Choose a team to see its packages.');
    fireEvent.click(screen.getByTestId('plugin-workspace-team-picker'));
    await screen.findByTestId('plugin-workspace-team-picker-option-readable-team');
    assert.equal(screen.queryByTestId('plugin-workspace-team-picker-option-private-team'), null);
    fireEvent.click(screen.getByTestId('plugin-workspace-team-picker-option-readable-team')); await waitRows();
    assert.equal(new URLSearchParams(window.location.search).get('teamId'), 'readable-team'); assert(screen.getByRole('button', { name: 'Open team-context' }));

    fireEvent.click(screen.getByTestId('plugin-workspace-scope-user')); await waitRows();
    fireEvent.click(screen.getByRole('button', { name: 'Open Design bundle' })); await screen.findByTestId('shell-detail-boundary');
    assert.equal(detailSelections.at(-1)?.resourceRef, ownRef); assert.equal(new URLSearchParams(window.location.search).get('resourceRef'), ownRef);
    await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole('button', { name: 'Make detail dirty' }));
    const dirtyRefreshRequests = requests.length, dirtyRefreshConfirms = confirmations.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(requests.length, dirtyRefreshRequests, 'Rejected dirty Header Refresh must not issue any reload requests.');
    assert.equal(confirmations.length, dirtyRefreshConfirms + 1, 'Header Refresh checks the existing unsaved-navigation guard.');
    assert.equal(screen.getByTestId('shell-detail-boundary').getAttribute('data-dirty'), 'true', 'Rejected Header Refresh cannot remount and silently discard dirty detail state.');
    const dirtyHref = window.location.href;
    fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); assert.equal(window.location.href, dirtyHref); assert(confirmations.length > 0);
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 40)); });
    await waitFor(() => assert.equal(window.location.href, dirtyHref), { timeout: 2000 }); assert(screen.getByTestId('shell-detail-boundary'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear detail guard' })); fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();
    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' })); await waitRows();
    fireEvent.click(screen.getByRole('button', { name: 'Open Design bundle' })); await screen.findByTestId('shell-detail-boundary');
    assert.equal(detailSelections.at(-1)?.resourceRef, orgRef, 'Shared same-name opening uses the exact Organization resource, not the personal instance.');
    await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled, false));
    fireEvent.click(screen.getByRole('button', { name: 'Make detail pending' }));
    const runningRefreshRequests = requests.length, runningRefreshConfirms = confirmations.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(requests.length, runningRefreshRequests, 'Running Header Refresh is denied before reload requests.');
    assert.equal(confirmations.length, runningRefreshConfirms, 'Running operation is not bypassed by a dirty-confirmation dialog.');
    assert.equal(screen.getByTestId('shell-detail-boundary').getAttribute('data-pending'), 'true');
    const pendingHref = window.location.href; fireEvent.keyDown(screen.getByTestId('plugin-workspace-view-store'), { key: 'Enter' }); assert.equal(window.location.href, pendingHref);
    fireEvent.click(screen.getByRole('button', { name: 'Clear detail guard' })); fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 20)); });
    await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.resourceRef, orgRef);
    await act(async () => { window.history.forward(); await new Promise(resolve => setTimeout(resolve, 20)); }); await waitRows();

    // Old links identify names/legacy aliases only; the actual resolver must first obtain one exact readable Ref.
    await setHref('view=installed&plugin=design-bundle&source=installed');
    await screen.findByTestId('shell-detail-boundary');
    assert.equal(detailSelections.at(-1)?.resourceRef, ownRef, 'Unique personal old link passes its exact readable Ref to detail.');
    const uniqueLookup = requests.findLast(request => request.url.searchParams.get('limit') === '50');
    assert.equal(uniqueLookup?.url.pathname, '/api/plugins/catalog');
    assert.equal(uniqueLookup?.url.searchParams.get('kind'), 'plugin'); assert.equal(uniqueLookup?.url.searchParams.get('q'), 'design-bundle');
    fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();

    const beforeAmbiguous = detailSelections.length;
    await setHref('view=installed&scope=all&plugin=design-bundle&source=installed');
    await screen.findByText(en.skills.workspace.shell.chooseVariant);
    assert.equal(screen.queryByTestId('shell-detail-boundary'), null); assert.equal(detailSelections.length, beforeAmbiguous, 'Same-name ambiguity never guesses an instance.');
    fireEvent.click(screen.getByRole('button', { name: en.skills.workspace.shell.showVariants })); await waitRows();
    assert.equal(screen.getAllByRole('button', { name: 'Open Design bundle' }).length, 2);
    assert.equal(new URLSearchParams(window.location.search).get('resourceRef'), null);

    const beforeAbsent = detailSelections.length;
    await setHref('view=installed&scope=all&plugin=missing-package&source=installed');
    await screen.findByText(en.skills.workspace.shell.accessError);
    assert.equal(screen.queryByTestId('shell-detail-boundary'), null); assert.equal(detailSelections.length, beforeAbsent, 'No match cannot call an unchecked detail with the old name.');

    const releaseLegacy = hold('/api/plugins/catalog:own-workspace:user:legacy:design-bundle');
    await setHref('view=installed&plugin=design-bundle&source=installed');
    await waitFor(() => assert(requests.at(-1)?.url.searchParams.get('scope') === 'user'));
    const delayedLegacy = requests.findLast(request => request.url.searchParams.get('limit') === '50' && request.url.searchParams.get('scope') === 'user');
    assert(delayedLegacy); assert.equal(screen.queryByTestId('shell-detail-boundary'), null);
    await setHref('view=installed&scope=organization&plugin=design-bundle&source=installed');
    await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.resourceRef, orgRef);
    const afterNewScope = detailSelections.length;
    await act(async () => releaseLegacy()); holds.clear();
    assert.equal(delayedLegacy.init?.signal?.aborted, true);
    assert.equal(detailSelections.at(-1)?.resourceRef, orgRef);
    assert(detailSelections.slice(afterNewScope).every(selection => selection.resourceRef === orgRef), 'Late User legacy Ref cannot replace the newer Organization selection.');
    fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();
    fireEvent.click(screen.getByTestId('plugin-workspace-scope-user')); await waitRows();
    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' })); await waitRows();

    fireEvent.change(screen.getByRole('combobox', { name: 'Package type' }), { target: { value: 'skill' } }); await waitRows();
    assert.equal(new URLSearchParams(window.location.search).get('kind'), 'skill');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'team-context' } }); fireEvent.submit(screen.getByRole('search'));
    await waitRows(); assert.equal(new URLSearchParams(window.location.search).get('q'), 'team-context');
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); await waitRows(); assert.equal(new URLSearchParams(window.location.search).get('page'), '2');
    assert.equal(new URLSearchParams(window.location.search).get('kind'), 'skill');

    await setHref('view=discover'); await screen.findByRole('button', { name: 'View Design offering' });
    fireEvent.click(screen.getByRole('button', { name: 'View Design offering' })); await screen.findByTestId('shell-wizard-boundary');
    const source = { kind: 'plugin', registryId: 'fixture-store', entryKey: 'design-bundle', version: '2.0.0', checksum: 'b'.repeat(64) };
    assert.deepEqual(wizardSelections.at(-1)?.source, source);
    const picker = await screen.findByRole('combobox', { name: en.skills.workspace.shell.version });
    assert.equal(wizardSelections.at(-1)?.releaseNotes, 'Current source release two');
    fireEvent.change(picker, { target: { value: '1.0.0' } });
    await waitFor(() => assert.deepEqual(wizardSelections.at(-1)?.source, { ...source, version: '1.0.0', checksum: 'a'.repeat(64) }));
    assert.equal(wizardSelections.at(-1)?.releaseNotes, 'Current source release one');
    assert.equal(new URLSearchParams(window.location.search).get('storeChecksum'), 'a'.repeat(64));

    const foreignSource = { ...source, registryId: 'another-fixture-store' };
    await setHref(`view=discover&plugin=design-bundle&source=store&storeRegistryId=${foreignSource.registryId}&storeVersion=${foreignSource.version}&storeChecksum=${foreignSource.checksum}`);
    await waitFor(() => assert.deepEqual(wizardSelections.at(-1)?.source, foreignSource));
    assert.equal(screen.queryByRole('combobox', { name: en.skills.workspace.shell.version }), null, 'Pinned Registry A cannot offer versions or digests from same-name current Registry B.');
    assert.equal(wizardSelections.at(-1)?.releaseNotes, undefined, 'Same-name current registry notes do not describe a different pinned source.');

    const changedDigest = { ...source, checksum: 'c'.repeat(64) };
    await setHref(`view=discover&plugin=design-bundle&source=store&storeRegistryId=${changedDigest.registryId}&storeVersion=${changedDigest.version}&storeChecksum=${changedDigest.checksum}`);
    await waitFor(() => assert.deepEqual(wizardSelections.at(-1)?.source, changedDigest));
    assert.equal(screen.queryByRole('combobox', { name: en.skills.workspace.shell.version }), null, 'The same version with an old pinned digest cannot adopt current offering checksums.');
    assert.equal(wizardSelections.at(-1)?.releaseNotes, undefined);

    await setHref(`view=discover&plugin=design-bundle&source=store&storeRegistryId=${source.registryId}&storeVersion=${source.version}&storeChecksum=${source.checksum}`);
    await screen.findByRole('combobox', { name: en.skills.workspace.shell.version });
    assert.deepEqual(wizardSelections.at(-1)?.source, source);
    assert.equal(wizardSelections.at(-1)?.releaseNotes, 'Current source release two');
    const sourceParams = new URLSearchParams(window.location.search);
    assert.equal(sourceParams.get('storeRegistryId'), source.registryId); assert.equal(sourceParams.get('storeVersion'), source.version); assert.equal(sourceParams.get('storeChecksum'), source.checksum);
    rendered.unmount(); const refreshed = render(<App />); await screen.findByTestId('shell-wizard-boundary');
    assert.deepEqual(wizardSelections.at(-1)?.source, source, 'Refreshing the shell preserves the exact selected source tuple.');
    fireEvent.click(screen.getByRole('button', { name: 'Make wizard pending' })); const sourceHref = window.location.href;
    fireEvent.click(await screen.findByTestId('plugin-workspace-scope-organization')); assert.equal(window.location.href, sourceHref);
    fireEvent.click(screen.getByRole('button', { name: 'Clear wizard guard' })); fireEvent.click(screen.getByRole('button', { name: 'Close selected source' }));
    await screen.findByRole('button', { name: 'View Design offering' });

    await setHref('view=installed&scope=organization&workspaceId=other-readable'); await waitRows();
    assert(screen.getByText('Workspace: Other readable workspace'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Design bundle' })); await screen.findByTestId('shell-detail-boundary');
    assert.equal(detailSelections.at(-1)?.workspaceId, 'other-readable');
    fireEvent.click(screen.getByRole('button', { name: 'Open reviewed update' })); await screen.findByTestId('shell-wizard-boundary');
    assert.equal(wizardSelections.at(-1)?.workspaceId, 'other-readable'); assert.equal(wizardSelections.at(-1)?.resourceRef, orgRef);
    fireEvent.click(screen.getByTestId('plugin-workspace-scope-user')); await waitRows();
    assert.equal(screen.queryByTestId('shell-wizard-boundary'), null, 'Changing scope drops the old root update source.');
    const explicit = requests.filter(request => request.url.searchParams.get('workspaceId') === 'other-readable'); assert(explicit.length > 0);
    assert(explicit.every(request => new Headers(request.init?.headers).get('x-canvas-workspace-id') === 'other-readable'));

    await setHref(`view=installed&resourceRef=${encodeURIComponent(ownLegacyAlias)}`);
    await screen.findByTestId('shell-detail-boundary'); assert.equal(detailSelections.at(-1)?.resourceRef, ownLegacyAlias);
    // This narrow Detail boundary supplies the canonical Ref from its safe inspected descriptor, as the actual Detail service does.
    fireEvent.click(screen.getByRole('button', { name: 'Open reviewed update' })); await screen.findByTestId('shell-wizard-boundary');
    assert.equal(wizardSelections.at(-1)?.resourceRef, ownRef, 'Reviewing an aliased installed resource must pass its inspected canonical Ref to the atomic update Wizard.');
    assert.equal(new URLSearchParams(window.location.search).get('resourceRef'), ownLegacyAlias, 'Canonical update binding does not silently rewrite the user selection URL.');
    fireEvent.click(screen.getByRole('button', { name: 'Close selected source' })); await screen.findByTestId('shell-detail-boundary');
    fireEvent.click(screen.getByRole('button', { name: 'Back from exact detail' })); await waitRows();

    await setHref('view=discover'); await screen.findByRole('button', { name: 'View Design offering' });
    const releaseOld = hold('/api/capabilities/packages/store:own-workspace:user');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => assert(requests.at(-1)?.url.pathname.endsWith('/store')));
    await act(async () => { workspace = { ...workspace, activeWorkspaceId: 'new-workspace' }; window.dispatchEvent(new Event(workspaceEvent)); });
    await screen.findByRole('button', { name: 'View New workspace Design offering' });
    assert(screen.getByText('Workspace: New workspace'));
    await act(async () => releaseOld()); holds.clear();
    assert(screen.getByText('Workspace: New workspace')); assert.equal(screen.queryByText('Workspace: Own workspace'), null);
    assert.equal(screen.queryByRole('button', { name: 'View Design offering' }), null, 'Old workspace offerings must not return after the delayed response.');
    const releaseScope = hold('/api/capabilities/packages/store:new-workspace:user');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => assert(requests.at(-1)?.url.searchParams.get('scope') === 'user'));
    // Current catalog rows and scope choices are intentionally cleared during this pending load.
    // A real URL/history navigation must still fence the late Store response.
    await setHref('view=discover&scope=organization');
    await screen.findByRole('button', { name: 'View New workspace Organization Design offering' });
    await act(async () => releaseScope()); holds.clear();
    assert.equal(screen.getByTestId('plugin-workspace-scope-organization').getAttribute('aria-pressed'), 'true');
    assert.equal(screen.queryByRole('button', { name: 'View New workspace Design offering' }), null, 'Old ownership-scope offerings must not return after the delayed response.');
    assert.equal(screen.getByTestId('plugin-workspace-view-updates').textContent, en.skills.workspace.shell.view_updates, 'Unknown observations do not create a false zero/current or Update badge.');

    storeError = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('The Store comparison is unavailable. Your installed packages remain accessible.');
    assert.equal(screen.queryByText('This selection could not be loaded. Try again.'), null);
    fireEvent.keyDown(screen.getByTestId('plugin-workspace-view-installed'), { key: 'Enter' }); await waitRows();
    assert(screen.getByRole('button', { name: 'Open New workspace Design bundle' })); assert(!document.body.textContent?.includes('PRIVATE_BACKEND_BODY'));
    storeError = false;

    catalogError = true; fireEvent.keyDown(screen.getByTestId('plugin-workspace-view-drafts'), { key: 'Enter' });
    await screen.findByText('Private draft after source removal');
    fireEvent.click(screen.getByRole('button', { name: en.skills.drafts.open }));
    await screen.findByText(en.skills.packageEditor.accessError);
    assert(screen.getByTestId('package-discard')); assert(screen.getByRole('button', { name: en.skills.packageEditor.discard }));
    assert.equal(screen.queryByTestId('package-file-content'), null);
    assert.equal(requests.some(request => decodeURIComponent(request.url.pathname).endsWith(`/${draftRef}/tree`) || decodeURIComponent(request.url.pathname).endsWith(`/${draftRef}/file`)), false, 'Blocked resume does not probe source-dependent files.');
    const draftCalls = requests.filter(request => request.url.pathname.includes('/drafts'));
    assert(draftCalls.every(request => request.url.searchParams.get('workspaceId') === 'new-workspace'));
    assert.equal(requests.some(request => /mcp|composio|accounts|toolkits|env/u.test(request.url.pathname)), false);
    catalogError = false; await setHref('view=installed'); await waitRows();
    refreshed.rerender(<App locale="de" />); await screen.findByRole('heading', { name: de.skills.workspace.shell.title, level: 1 });
    assert(screen.getByRole('button', { name: 'Organisation' }));
    rejectsDirty = false;
    assert(authRequests.length > 0); assert(authRequests.every(request => request.path === '/api/auth/get-session' && request.method === 'GET'));
    console.log('Plugin workspace shell React/history/Intl PASS: default mixed installed, readonly Org/Team selection, exact/unique/ambiguous/missing/late legacy links, dirty/pending Back and Header Refresh fences, source tuples, explicit workspace forwarding, late-response denial and private-draft recovery. Controlled HTTP transport only; no server-authority or responsive-browser claims.');
  } finally {
    for (const value of holds.values()) value.release(); cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
