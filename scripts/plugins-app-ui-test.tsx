import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act, useMemo, useSyncExternalStore } from 'react';
import de from '../messages/de.json';
import en from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/de/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const pushState = dom.window.history.pushState.bind(dom.window.history);
dom.window.history.pushState = (data, unused, url) => {
  const internalNavigation = data?.__NA || data?._N;
  pushState(internalNavigation ? data : { ...data, __NA: true }, unused, url);
  if (!internalNavigation) dom.window.dispatchEvent(new dom.window.Event('navigation-test'));
};
dom.window.history.replaceState({ __NA: true }, '', dom.window.location.href);
const subscribe = (onChange: () => void) => {
  dom.window.addEventListener('navigation-test', onChange);
  dom.window.addEventListener('popstate', onChange);
  return () => { dom.window.removeEventListener('navigation-test', onChange); dom.window.removeEventListener('popstate', onChange); };
};

async function main() {
  const internals = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const originalFetch = globalThis.fetch;
  let locale: 'de' | 'en' = 'de';
  const fetches: string[] = [];
  const preferenceWrites: Array<{ resourceId: string; enabled: boolean }> = [];
  let Panel: React.ComponentType<{ canManageOrganizationCapabilities?: boolean }>;
  let installedPlugins: Record<string, unknown>[] = [];
  let installedMetadata: Record<string, unknown>[] = [];
  let paginationFixture = false;
  let storeFixtures: Record<string, unknown>[] = [];
  let storeFixtureOffPage = false;
  let storePending: Promise<void> | undefined;
  let storeUnavailable = false;
  let skillsUnavailable = false;
  let skillStoreUnavailable = false;
  let organizationAllowed = false;
  let scopeFixtures = false;
  let studioBulkEnabled = false;
  type Translate = (key: string, values?: Record<string, string | number>) => string;
  const translations = new Map<string, Translate>();
  const translate = (namespace: string): Translate => {
    const cacheKey = `${locale}:${namespace}`;
    const cached = translations.get(cacheKey);
    if (cached) return cached;
    const messages = locale === 'de' ? de : en;
    const fn: Translate = (key, values = {}) => {
    let text: unknown = messages;
    for (const part of `${namespace}.${key}`.split('.')) text = (text as Record<string, unknown>)?.[part];
    assert.equal(typeof text, 'string', `Missing ${locale} translation: ${namespace}.${key}`);
    return String(text).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
    };
    translations.set(cacheKey, fn);
    return fn;
  };
  internals._load = (name, parent, isMain) => {
    if (name === 'next/dynamic') return () => function MockDynamicPanel(props: { canManageOrganizationCapabilities?: boolean }) { return <Panel {...props} />; };
    if (name === 'next/navigation') return { useSearchParams: () => {
      const query = useSyncExternalStore(subscribe, () => dom.window.location.search);
      return useMemo(() => new URLSearchParams(query), [query]);
    } };
    if (name === 'next-intl') return { useTranslations: translate, useLocale: () => locale };
    if (name === '@/i18n/navigation') return {
      Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function MockLink(props, ref) { return <a {...props} ref={ref} href={`/${locale}${props.href}`} />; }),
      usePathname: () => '/plugins',
      useRouter: () => ({ push: (href: string) => { dom.window.history.pushState(null, '', `/${locale}${href}`); } }),
      getPathname: ({ href }: { href: string }) => `/${locale}${href}`,
    };
    if (name === '@/app/store/workspace-store') return { useWorkspaceStore: (select: (state: unknown) => unknown) => select({ activeWorkspaceId: 'workspace-one', workspaces: [{ id: 'workspace-one', name: 'Marketing team' }] }) };
    if (name === '@/app/components/terminal/TerminalAvailabilityProvider') return { useTerminalAvailability: () => ({ terminalEnabled: false }) };
    if (name === '@/app/apps/studio/components/StudioBulkAvailabilityProvider') return { useStudioBulkAvailability: () => ({ studioBulkEnabled }) };
    if (name === '@/app/components/editor/MarkdownEditorClient') return { MarkdownEditor: () => null };
    return originalLoad(name, parent, isMain);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.window.location.origin);
    fetches.push(url.pathname + url.search);
    if (url.pathname === '/api/skills') return skillsUnavailable
      ? Response.json({ success: false, error: 'Skill service unavailable' }, { status: 503 })
      : Response.json({ success: true, skills: [], canManageOrganizationCapabilities: organizationAllowed });
    if (url.pathname === '/api/skills/status') return Response.json({ success: true, enabledSkills: [] });
    if (url.pathname === '/api/skills/tree') return Response.json({ success: true, data: [] });
    if (url.pathname === '/api/plugins') {
      const scope = url.searchParams.get('scope') || 'user';
      return Response.json({ success: true, plugins: scopeFixtures
        ? [{ name: `${scope}-plugin`, description: `${scope} package`, version: '1.0.0', enabled: true, scopeType: scope, skills: [] }]
        : installedPlugins });
    }
    if (url.pathname === '/api/plugins/store') {
      await storePending;
      const catalogPage = Math.min(2, Number(url.searchParams.get('page')) || 1);
      return storeUnavailable
        ? Response.json({ success: false, error: 'Plugin catalog unavailable' }, { status: 503 })
        : Response.json({ success: true, plugins: storeFixtureOffPage && !url.searchParams.has('name') ? [] : storeFixtures, installedPlugins: installedMetadata, facets: { categories: ['Team', 'Tools'], connectionTypes: ['email', 'mcp'] }, stats: { updates: installedMetadata.length }, ...(paginationFixture ? { pagination: { page: catalogPage, pageSize: 12, totalItems: 13, totalPages: 2, hasPreviousPage: catalogPage > 1, hasNextPage: catalogPage < 2 } } : {}) });
    }
    if (url.pathname === '/api/plugins/store/preflight') return Response.json({ success: true, preflight: { ready: true, hasRequiredMissing: false, items: [], summary: { total: 0, ready: 0, requiredMissing: 0, recommendedMissing: 0 } } });
    if (url.pathname === '/api/plugins/store/install') {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.name, 'install-fixture');
      const installed = { name: body.name, version: '1.0.0', description: 'Fixture package', enabled: true, scopeType: 'user', resourceId: 'user:install-fixture', skills: [] };
      installedPlugins = [installed];
      storeFixtures = storeFixtures.map(plugin => ({ ...plugin, installed: { installed: true, enabled: true, version: '1.0.0', updateAvailable: false, installedPlugin: installed } }));
      return Response.json({ success: true, plugin: installed });
    }
    if (url.pathname === '/api/skills/preferences') {
      assert.equal(init?.method, 'PUT');
      const body = JSON.parse(String(init?.body)) as { resourceId: string; enabled: boolean };
      preferenceWrites.push(body);
      installedPlugins = installedPlugins.map(plugin => plugin.resourceId === body.resourceId ? { ...plugin, enabled: body.enabled } : plugin);
      return Response.json({ success: true });
    }
    if (url.pathname === '/api/skills/store') return skillStoreUnavailable
      ? Response.json({ success: false, error: 'Skill catalog unavailable' }, { status: 503 })
      : Response.json({ success: true, skills: [], stats: { updates: 0 } });
    if (url.pathname === '/api/skills/effective') return Response.json({ success: true, snapshot: { organizationId: 'organization-test', capabilities: [] } });
    if (url.pathname === '/api/skills/policies') return Response.json({ success: true, policies: [] });
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  };
  try {
    const { render, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
    const { SkillsPanel } = await import('../app/components/plugins/PluginsPanel');
    Panel = SkillsPanel;
    const { PluginsAppClient } = await import('../app/components/plugins/PluginsAppClient');
    const { AppLauncher } = await import('../app/components/AppLauncher');
    const { PluginsSettingsLink } = await import('../app/components/plugins/PluginsSettingsLink');
    dom.window.localStorage.setItem('canvas.skills.panelTab', 'skills');
    dom.window.localStorage.setItem('canvas.skills.pluginStoreTab', 'advanced');
    let view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.equal(view.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected'), 'true'));
    assert.equal(view.getByRole('tab', { name: 'Entdecken' }).getAttribute('aria-selected'), 'true', 'the app entry opens plugins despite obsolete stored tabs');
    await waitFor(() => assert.ok(view.getByText(de.skills.plugins.emptyStore)));
    assert.ok(!fetches.some(url => /^\/api\/skills(?:\?|\/status|\/tree)/.test(url)), 'opening Plugins does not eagerly load skills');
    fireEvent.mouseDown(view.getByRole('tab', { name: 'Installiert' }), { button: 0 });
    await waitFor(() => assert.equal(new URLSearchParams(dom.window.location.search).get('view'), 'installed'));
    assert.equal(view.getByRole('tab', { name: 'Installiert' }).getAttribute('aria-selected'), 'true');
    await act(async () => { dom.window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => assert.equal(view.getByRole('tab', { name: 'Entdecken' }).getAttribute('aria-selected'), 'true'));
    cleanup();

    dom.window.history.replaceState(null, '', '/de/plugins?area=skills&view=library');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.equal(view.getByRole('tab', { name: 'Skills' }).getAttribute('aria-selected'), 'true'));
    assert.equal(view.getByRole('tab', { name: de.skills.skillLibrary.tabs.library }).getAttribute('aria-selected'), 'true');
    assert.ok(fetches.some(url => url.startsWith('/api/skills/store?')));
    cleanup();

    installedPlugins = [{ name: 'connection-plugin', version: '1.0.0', description: 'Needs a personal account', enabled: true, readiness: 'personal-connection-required', skills: [] }];
    let releaseStore!: () => void;
    storePending = new Promise<void>(resolve => { releaseStore = resolve; });
    dom.window.history.replaceState(null, '', '/de/plugins?view=installed');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.ok(view.getByText(de.skills.plugins.readiness['personal-connection-required'])));
    assert.ok(view.getByText(de.skills.plugins.readinessHints['personal-connection-required']));
    assert.ok(view.getByRole('button', { name: de.skills.plugins.preflight.setup }), 'an installed plugin can be set up while the catalog is pending');
    storeUnavailable = true;
    await act(async () => { releaseStore(); });
    await waitFor(() => assert.ok(view.getByText('Plugin catalog unavailable')));
    assert.ok(view.getByText('/connection-plugin'), 'a catalog error keeps installed plugins usable');
    fireEvent.mouseDown(view.getByRole('tab', { name: /^Updates/ }), { button: 0 });
    await waitFor(() => assert.ok(view.getByText('Plugin catalog unavailable')));
    assert.equal(view.queryByText(de.skills.plugins.noUpdates), null, 'catalog errors cannot claim all packages are current');
    cleanup();
    storePending = undefined;
    storeUnavailable = false;
    installedPlugins = [];

    skillsUnavailable = true;
    dom.window.history.replaceState(null, '', '/de/plugins?area=skills');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.ok(view.getByText('Skill service unavailable')));
    const beforeRetry = fetches.filter(url => /^\/api\/skills\?/.test(url)).length;
    skillsUnavailable = false;
    fireEvent.click(view.getByRole('button', { name: de.skills.loading.retry }));
    await waitFor(() => assert.equal(view.queryByText('Skill service unavailable'), null));
    assert.ok(fetches.filter(url => /^\/api\/skills\?/.test(url)).length > beforeRetry);
    cleanup();

    skillStoreUnavailable = true;
    dom.window.history.replaceState(null, '', '/de/plugins?area=skills&view=updates');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.ok(view.getByText('Skill catalog unavailable')));
    assert.equal(view.queryByText(de.skills.skillLibrary.noUpdates), null);
    assert.equal(view.queryByText(de.skills.skillLibrary.emptyStore), null);
    cleanup();
    skillStoreUnavailable = false;

    fetches.length = 0;
    dom.window.history.replaceState(null, '', '/de/plugins?scope=organization');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.ok(view.getByText(de.skills.plugins.emptyStore)));
    assert.ok(view.getByText(de.skills.scope.organizationDenied));
    assert.equal(view.queryByRole('button', { name: de.skills.scope.organization }), null);
    assert.ok(!fetches.some(url => url.includes('scope=organization')), 'a URL cannot grant organization management rights');
    cleanup();

    organizationAllowed = true;
    scopeFixtures = true;
    dom.window.history.replaceState(null, '', '/de/plugins?scope=organization&view=installed');
    view = render(<PluginsAppClient canManageOrganizationCapabilities />);
    await waitFor(() => assert.ok(view.getByText('/organization-plugin')));
    fireEvent.click(view.getByRole('button', { name: de.skills.scope.personal }));
    await waitFor(() => assert.ok(view.getByText('/user-plugin')));
    assert.equal(new URLSearchParams(dom.window.location.search).get('scope'), null);
    assert.equal(view.queryByText('/organization-plugin'), null);
    await act(async () => { dom.window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => assert.ok(view.getByText('/organization-plugin')));
    assert.equal(view.queryByText('/user-plugin'), null, 'history scope changes reset the prior scope data');
    cleanup();
    organizationAllowed = false;
    scopeFixtures = false;

    locale = 'en';
    for (storeFixtureOffPage of [false, true]) {
      installedPlugins = [];
      storeFixtures = [{ name: 'install-fixture', displayName: 'Install fixture', description: 'Fixture package', latestVersion: '1.0.0', skills: [], installed: { installed: false, enabled: false, updateAvailable: false } }];
      dom.window.history.replaceState(null, '', '/en/plugins?plugin=install-fixture&source=store');
      view = render(<PluginsAppClient canManageOrganizationCapabilities />);
      const detail = within(view.getByRole('dialog'));
      await waitFor(() => assert.equal((detail.getByRole('button', { name: en.skills.plugins.addPlugin }) as HTMLButtonElement).disabled, false));
      const exactLoadsBefore = fetches.filter(url => url.startsWith('/api/plugins/store?name=install-fixture')).length;
      fireEvent.click(detail.getByRole('button', { name: en.skills.plugins.addPlugin }));
      await waitFor(() => assert.equal((detail.getByRole('button', { name: en.skills.plugins.installed }) as HTMLButtonElement).disabled, true));
      assert.equal(detail.queryByRole('button', { name: en.skills.plugins.addPlugin }), null, 'fresh installation state replaces the older exact-detail snapshot');
      assert.ok(fetches.filter(url => url.startsWith('/api/plugins/store?name=install-fixture')).length > exactLoadsBefore, 'installation refreshes the exact detail even beyond the current page');
      cleanup();
    }
    storeFixtures = [];
    storeFixtureOffPage = false;
    installedPlugins = [];

    const needsConnection = { name: 'filtered-plugin', version: '1.0.0', description: 'Filter fixture', enabled: false, scopeType: 'user', resourceId: 'user:filtered-plugin', readiness: 'personal-connection-required', skills: [] };
    installedPlugins = [needsConnection,
      { name: 'ready-plugin', version: '1.0.0', description: 'Ready fixture', enabled: true, readiness: 'available', skills: [] },
      { name: 'disabled-plugin', version: '1.0.0', description: 'Disabled fixture', enabled: false, readiness: 'disabled', skills: [] },
    ];
    installedMetadata = [{ name: 'filtered-plugin', displayName: 'Filtered plugin', description: 'Filter fixture', latestVersion: '2.0.0', installed: { installed: true, enabled: false, version: '1.0.0', updateAvailable: true, installedPlugin: needsConnection } }];
    dom.window.history.replaceState(null, '', '/en/plugins?view=installed&readiness=personal-connection-required&enabled=disabled');
    view = render(<PluginsAppClient canManageOrganizationCapabilities />);
    await waitFor(() => assert.ok(view.getByText('/filtered-plugin')));
    await waitFor(() => assert.ok(view.getByText(en.skills.plugins.updateAvailable), 'unpaginated metadata supplies update info outside the catalog page'));
    assert.equal(view.queryByText('/ready-plugin'), null);
    assert.equal(view.queryByText('/disabled-plugin'), null);
    const installedLoads = fetches.filter(url => url.startsWith('/api/plugins?')).length;
    fireEvent.change(view.getByRole('combobox', { name: en.skills.plugins.filters.enabled }), { target: { value: 'enabled' } });
    await waitFor(() => assert.ok(view.getByText(en.skills.plugins.noMatches)));
    assert.equal(fetches.filter(url => url.startsWith('/api/plugins?')).length, installedLoads, 'local readiness and activation filters do not refetch fresh installed state');
    await act(async () => { dom.window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => assert.ok(view.getByText('/filtered-plugin')));
    assert.equal((view.getByRole('combobox', { name: en.skills.plugins.filters.enabled }) as HTMLSelectElement).value, 'disabled');
    fireEvent.click(view.getByRole('button', { name: en.skills.plugins.filters.clear }));
    await waitFor(() => assert.ok(view.getByText('/ready-plugin')));
    fireEvent.mouseDown(view.getByRole('tab', { name: en.skills.plugins.storeTabs.discover }), { button: 0 });
    fireEvent.change(view.getByRole('combobox', { name: en.skills.plugins.filters.category }), { target: { value: 'Team' } });
    fireEvent.change(view.getByRole('combobox', { name: en.skills.plugins.filters.connection }), { target: { value: 'email' } });
    fireEvent.change(view.getByRole('textbox', { name: en.skills.plugins.searchPlaceholder }), { target: { value: 'team' } });
    await waitFor(() => assert.ok(fetches.some(url => url.startsWith('/api/plugins/store?') && new URL(url, 'https://canvas.test').searchParams.get('q') === 'team' && new URL(url, 'https://canvas.test').searchParams.get('category') === 'Team' && new URL(url, 'https://canvas.test').searchParams.get('connection') === 'email')));
    assert.equal(fetches.filter(url => url.startsWith('/api/plugins?')).length, installedLoads, 'catalog search and filter navigation never repeats fresh installed readiness checks');
    await act(async () => { dom.window.history.pushState(null, '', '/en/plugins?view=discover&q=team&category=Team&connection=email&page=3'); });
    fireEvent.change(view.getByRole('combobox', { name: en.skills.plugins.filters.category }), { target: { value: 'Tools' } });
    assert.equal(new URLSearchParams(dom.window.location.search).has('page'), false);
    await act(async () => { dom.window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => assert.equal(new URLSearchParams(dom.window.location.search).get('page'), '3'));
    assert.equal((view.getByRole('textbox', { name: en.skills.plugins.searchPlaceholder }) as HTMLInputElement).value, 'team');
    assert.equal((view.getByRole('combobox', { name: en.skills.plugins.filters.category }) as HTMLSelectElement).value, 'Team');
    cleanup();
    installedPlugins = [];
    installedMetadata = [];

    paginationFixture = true;
    storeFixtures = [{ name: 'page-plugin', displayName: 'Page plugin', description: 'Page fixture', latestVersion: '1.0.0', skills: [], installed: { installed: false, enabled: false, updateAvailable: false } }];
    dom.window.history.replaceState(null, '', '/en/plugins?view=discover&page=99');
    view = render(<PluginsAppClient canManageOrganizationCapabilities />);
    await waitFor(() => assert.ok(view.getByText('/page-plugin')));
    const previousPage = view.getByRole('button', { name: en.skills.plugins.pagination.previous });
    assert.equal((previousPage as HTMLButtonElement).disabled, false);
    fireEvent.click(previousPage);
    await waitFor(() => assert.equal(new URLSearchParams(dom.window.location.search).has('page'), false, 'Previous leaves a clamped out-of-range URL using the server page'));
    await waitFor(() => assert.equal((view.getByRole('button', { name: en.skills.plugins.pagination.previous }) as HTMLButtonElement).disabled, true));
    cleanup();
    paginationFixture = false;
    storeFixtures = [];

    const personalPackage = {
      name: 'document-suite', version: '1.0.0', description: 'Personal installed description', enabled: true,
      scopeType: 'user', resourceId: 'user:document-suite', sourceType: 'standalone', installedBy: 'installer-user',
      interface: { displayName: 'Personal document suite', icon: 'assets/personal.svg' }, skills: [],
    };
    const organizationPackage = {
      ...personalPackage, resourceId: 'organization:document-suite', scopeType: 'organization', enabled: false,
      installedBy: undefined, effectivePolicy: 'optional', description: 'Organization installed description',
      interface: { displayName: 'Organization document suite', icon: 'assets/organization.svg' },
    };
    installedPlugins = [personalPackage, organizationPackage,
      { ...organizationPackage, name: 'required-suite', resourceId: 'organization:required-suite', enabled: true, effectivePolicy: 'required', interface: { displayName: 'Required suite' } },
      { ...organizationPackage, name: 'blocked-suite', resourceId: 'organization:blocked-suite', readiness: 'blocked', interface: { displayName: 'Blocked suite' } },
      { ...organizationPackage, name: 'conflict-suite', resourceId: 'organization:conflict-suite', readiness: 'conflict', interface: { displayName: 'Conflict suite' } },
    ];
    storeFixtures = [{ name: 'document-suite', displayName: 'Different catalog title', description: 'Different catalog description', latestVersion: '2.0.0', installed: { installed: true, enabled: true, updateAvailable: true, installedPlugin: personalPackage } }];
    installedMetadata = storeFixtures;
    dom.window.history.replaceState(null, '', '/en/plugins?view=installed');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.ok(view.getByText('Personal document suite')));
    await waitFor(() => assert.ok(view.getByText(en.skills.plugins.updateAvailable)));
    const personalCard = within(view.getByText('Personal document suite').closest('[role="button"]') as HTMLElement);
    assert.equal((personalCard.getByRole('switch') as HTMLButtonElement).disabled, true);
    assert.equal((personalCard.getByRole('button', { name: en.skills.plugins.update }) as HTMLButtonElement).disabled, true);
    assert.equal((personalCard.getByRole('button', { name: en.skills.plugins.delete }) as HTMLButtonElement).disabled, true);
    assert.ok(personalCard.getByText(en.skills.plugins.permissions.askAdmin));
    assert.equal(view.queryByText('standalone'), null, 'internal source values are absent from the primary cards');
    const organizationCard = within(view.getByText('Organization document suite').closest('[role="button"]') as HTMLElement);
    assert.equal((organizationCard.getByRole('switch') as HTMLButtonElement).disabled, false, 'members retain optional personal activation');
    assert.ok(organizationCard.getByText(en.skills.plugins.permissions.personalActivation));
    fireEvent.click(organizationCard.getByRole('switch'));
    await waitFor(() => assert.deepEqual(preferenceWrites, [{ resourceId: 'organization:document-suite', enabled: true }]));
    for (const [title, key] of [['Required suite', 'required'], ['Blocked suite', 'blocked'], ['Conflict suite', 'conflict']] as const) {
      const lockedCard = within(view.getByText(title).closest('[role="button"]') as HTMLElement);
      assert.equal((lockedCard.getByRole('switch') as HTMLButtonElement).disabled, true);
      assert.ok(lockedCard.getByText(en.skills.plugins.permissions[key]));
    }
    cleanup();

    for (const [record, expectedInstaller] of [[personalPackage, 'installer-user'], [organizationPackage, en.skills.plugins.details.installedByUnknown]] as const) {
      dom.window.history.replaceState(null, '', `/en/plugins?view=installed&plugin=document-suite&source=installed&resourceId=${record.resourceId}`);
      view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
      const detail = within(view.getByRole('dialog'));
      await waitFor(() => assert.ok(detail.getByText(record.interface.displayName)));
      assert.ok(detail.getByText(record.description));
      assert.equal(detail.queryByText('Different catalog title'), null, 'installed identity supplies its own display name');
      assert.equal(detail.queryByText('Different catalog description'), null, 'same-name catalog text never replaces installed provenance');
      assert.ok(detail.getByText(en.skills.plugins.details.ownership));
      assert.ok(detail.getByText(en.skills.plugins.details.installedBy));
      assert.ok(detail.getByText(expectedInstaller));
      assert.ok(detail.getByText(en.skills.plugins.connectors.activeWorkspace.replace('{name}', 'Marketing team')));
      const icon = new URL(view.getByRole('dialog').querySelector('img')!.getAttribute('src')!, dom.window.location.origin);
      assert.equal(icon.pathname, '/api/plugins/asset');
      assert.equal(icon.searchParams.get('scope'), record.scopeType);
      assert.equal(icon.searchParams.get('resourceId'), record.resourceId);
      assert.equal(icon.searchParams.get('workspaceId'), 'workspace-one');
      assert.equal(icon.searchParams.get('version'), record.version);
      assert.equal(icon.searchParams.get('path'), record.interface.icon, 'installed detail renders its exact asset, independent of the same-name catalog entry');
      cleanup();
    }
    dom.window.history.replaceState(null, '', '/en/plugins?view=advanced');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    assert.equal((view.getByPlaceholderText(en.skills.plugins.sourcePathPlaceholder) as HTMLInputElement).disabled, true);
    assert.equal((view.getByRole('button', { name: en.skills.plugins.install }) as HTMLButtonElement).disabled, true);
    assert.ok(view.getByText(en.skills.plugins.permissions.askAdmin));
    cleanup();
    installedPlugins = [];
    installedMetadata = [];
    storeFixtures = [{ name: 'available-suite', displayName: 'Available suite', description: 'Available fixture', latestVersion: '1.0.0', installed: { installed: false, enabled: false, updateAvailable: false } }];
    dom.window.history.replaceState(null, '', '/en/plugins');
    view = render(<PluginsAppClient canManageOrganizationCapabilities={false} />);
    await waitFor(() => assert.ok(view.getByText('Available suite')));
    assert.equal((view.getByRole('button', { name: en.skills.plugins.addPlugin }) as HTMLButtonElement).disabled, true);
    assert.ok(view.getByText(en.skills.plugins.permissions.askAdmin));
    cleanup();
    storeFixtures = [];

    for (locale of ['de', 'en'] as const) {
      view = render(<PluginsSettingsLink />);
      assert.equal(view.getByRole('link').getAttribute('href'), `/${locale}/plugins`);
      cleanup();
      view = render(<AppLauncher />);
      fireEvent.pointerDown(view.getByRole('button', { name: locale === 'de' ? 'Apps öffnen' : 'Open apps' }), { button: 0, isPrimary: true });
      await waitFor(() => assert.ok(view.getByRole('menuitem', { name: 'Plugins' })));
      assert.equal(view.getByRole('menuitem', { name: 'Plugins' }).getAttribute('href'), `/${locale}/plugins`);
      assert.ok(view.getByRole('menuitem', { name: 'Notebook' }));
      fireEvent.contextMenu(view.getByRole('menuitem', { name: 'Plugins' }));
      await waitFor(() => assert.equal(view.getByRole('menuitem', { name: locale === 'de' ? 'Installiert' : 'Installed' }).getAttribute('href'), `/${locale}/plugins?view=installed`));
      assert.equal(view.getByRole('menuitem', { name: 'Skills' }).getAttribute('href'), `/${locale}/plugins?area=skills`);
      cleanup();
      for (studioBulkEnabled of [false, true]) {
        view = render(<AppLauncher />);
        fireEvent.pointerDown(view.getByRole('button', { name: locale === 'de' ? 'Apps öffnen' : 'Open apps' }), { button: 0, isPrimary: true });
        await waitFor(() => assert.ok(view.getByRole('menuitem', { name: 'Studio' })));
        fireEvent.contextMenu(view.getByRole('menuitem', { name: 'Studio' }));
        const bulkLabel = (locale === 'de' ? de : en).studio.tabs.bulk;
        await waitFor(() => assert.ok(view.getByRole('menuitem', { name: (locale === 'de' ? de : en).studio.tabs.models })));
        if (studioBulkEnabled) assert.equal(view.getByRole('menuitem', { name: bulkLabel }).getAttribute('href'), `/${locale}/studio/bulk`);
        else assert.equal(view.queryByRole('menuitem', { name: bulkLabel }), null, 'plugin quick actions preserve the Studio Bulk feature gate');
        cleanup();
      }
    }
    console.log('Plugins UI: launcher in both locales, direct views and history, lazy skill loading, delayed/failed catalog, readable connection status, skill retry and organization scope boundaries passed');
  } finally {
    internals._load = originalLoad;
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
