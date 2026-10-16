import assert from 'node:assert/strict';
import Module from 'node:module';
import {JSDOM} from 'jsdom';
import React, {useMemo, useSyncExternalStore} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import type {PluginExtensionItem, PluginExtensionSearchResponse} from '../app/lib/plugins/plugin-extension-contracts';

// Actual navigation -> Workspace -> search hook -> Detail. Framework session /
// navigation delivery and metadata HTTP are controlled, not the components.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'http://canvas.test/en/plugins?view=browse&q=canva', pretendToBeVisual: true});
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
  'SVGElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'getComputedStyle'])
  Object.defineProperty(globalThis, key, {value: dom.window[key as keyof Window], configurable: true});
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)});
Object.defineProperty(globalThis, 'PointerEvent', {value: dom.window.MouseEvent, configurable: true});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.scrollTo = () => {};
class FixtureResizeObserver {observe() {} unobserve() {} disconnect() {}}
Object.defineProperty(globalThis, 'ResizeObserver', {value: FixtureResizeObserver, configurable: true});

async function main() {
  const loader = Module as typeof Module & {_load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown};
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const originalPush = window.history.pushState.bind(window.history), originalReplace = window.history.replaceState.bind(window.history);
  const navigationEvent = 'actual-plugin-row-navigation';
  window.history.pushState = (...args) => {originalPush(...args); window.dispatchEvent(new Event(navigationEvent));};
  window.history.replaceState = (...args) => {originalReplace(...args); window.dispatchEvent(new Event(navigationEvent));};
  const subscribe = (notify: () => void) => {window.addEventListener(navigationEvent, notify); return () => window.removeEventListener(navigationEvent, notify);};
  let workspaceId = 'row-workspace-a', actorId = 'row-actor', sessionId = 'row-session';
  const session = () => ({user: {id: actorId, name: actorId, email: `${actorId}@fixture.invalid`, role: 'admin', emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), banned: false},
    session: {id: sessionId, userId: actorId, token: 'CONTROLLED_UI_SESSION', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0)}});
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return {useSearchParams: () => {const search = useSyncExternalStore(subscribe, () => window.location.search); return useMemo(() => new URLSearchParams(search), [search]);},
      useRouter: () => ({push: (url: string) => window.history.pushState(null, '', url), replace: (url: string) => window.history.replaceState(null, '', url)})};
    if (name === '@/app/store/workspace-store') return {useWorkspaceStore: (select: (state: unknown) => unknown) => select({workspaces: [{id: workspaceId, name: 'Current workspace'}]})};
    if (name === '@/i18n/navigation') return {Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) {return <a {...props} ref={ref} />;}),
      useRouter: () => ({push: (url: string) => window.history.pushState(null, '', url), replace: (url: string) => window.history.replaceState(null, '', url)})};
    return originalLoad(name, parent, isMain);
  };
  const item: Extract<PluginExtensionItem, {kind: 'integration'}> = {id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva', description: 'Original catalogue metadata', source: 'composio', stock: 'available',
    access: {canRead: true, canUse: false, canManage: false}, toolkit: {slug: 'canva', noAuth: false}, connections: []};
  type Read = {url: URL; signal?: AbortSignal | null; resolve(response: Response): void; replies: Array<(response: Response) => void>; replied?: boolean};
  const searches: Read[] = [], setups: string[] = [];
  let denySetup = false;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/auth/get-session') return Promise.resolve(Response.json(session()));
    assert.equal(init?.method ?? 'GET', 'GET', 'Browsing cannot connect accounts or change defaults.');
    assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), url.searchParams.get('workspaceId') ?? workspaceId);
    if (url.pathname === '/api/plugins/search') {
      url.searchParams.delete('phase');
      return new Promise<Response>(resolve => {
        const current = searches.findLast(read => !read.replied && !read.signal?.aborted && read.url.href === url.href);
        if (current) { current.replies.push(resolve); return; }
        const read: Read = {url, signal: init?.signal, replies: [resolve], resolve(response) {
          read.replied = true; for (const reply of read.replies) reply(response.clone());
        }};
        searches.push(read);
      });
    }
    setups.push(url.pathname);
    if (url.pathname === '/api/integrations/shared-connections/setup') return Promise.resolve(denySetup ? Response.json({success: false, code: 'CONNECTION_ACCESS_DENIED'}, {status: 403})
      : Response.json({success: true, data: {scopes: [{ownership: {type: 'organization', organizationId: 'row-org'}, label: 'Organization'}]}}));
    if (url.pathname === '/api/composio/profiles') return Promise.resolve(Response.json({success: true, profiles: [], effectiveProfile: {id: 'profile', name: 'Default', workspaceId}, workspace: {id: workspaceId}}));
    throw new Error(`Unexpected row navigation transport: ${url.pathname}`);
  };
  const {render, screen, cleanup, waitFor, act, fireEvent} = await import('@testing-library/react');
  const {authClient} = await import('../app/lib/auth-client'), atom = authClient.$store.atoms.session, originalSession = atom.get();
  const seed = () => atom.set({...atom.get(), data: session(), error: null, isPending: false, isRefetching: false});
  const {PluginExtensionWorkspace} = await import('../app/components/plugins/PluginExtensionWorkspace');
  const App = () => <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginExtensionWorkspace workspaceId={workspaceId} /></NextIntlClientProvider>;
  const body = (read: Read, items: PluginExtensionItem[] = [item], nextCursor: string | null = null) => {
    const selected = read.url.searchParams.get('selected');
    const response: PluginExtensionSearchResponse = {schemaVersion: 1, query: {q: read.url.searchParams.get('q') ?? '', types: ['plugin', 'skill', 'integration', 'mcp'], scope: 'all', audience: null, teamId: null,
      stock: 'all', source: 'all', cursor: read.url.searchParams.get('cursor'), selected, limit: 20}, items, selectedItem: items.find(row => row.id === selected) ?? null,
      scopes: {choices: ['all', 'user', 'organization'], teams: []}, coverage: [{source: 'composio', status: 'complete'}], pagination: {hasNextPage: Boolean(nextCursor), nextCursor, loadedItems: items.length}};
    return Response.json({success: true, data: response});
  };
  const reply = async (read: Read, response = body(read)) => act(async () => read.resolve(response));
  const count = async (expected: number) => waitFor(() => assert.equal(searches.length, expected));
  const navigate = async (query: string) => act(async () => window.history.pushState(null, '', `/en/plugins?view=browse&q=canva${query}`));
  const noSetup = () => assert.equal(screen.queryByTestId('plugin-integration-new-shared'), null);
  seed(); const rendered = render(<App />); let cases = 0;
  try {
    await count(1); const originalQuery = searches[0].url.search;
    assert.equal(searches[0].url.searchParams.get('q'), 'canva'); assert.equal(searches[0].url.searchParams.has('selected'), false);
    await reply(searches[0]); await screen.findByTestId('plugin-extension-row-open');
    fireEvent.click(screen.getByTestId('plugin-extension-row-open')); await screen.findByTestId('plugin-integration-new-shared');
    assert.equal(searches.length, 1, 'Opening an actual received row must not perform a second serial all-source search.');
    assert(screen.getByText(item.description)); assert(setups.includes('/api/integrations/shared-connections/setup'));
    fireEvent.click(screen.getByTestId('plugin-extension-back')); await screen.findByTestId('plugin-extension-row-open');
    assert.equal(searches.length, 1, 'Back retains the actual original search.'); assert.equal(new URL(window.location.href).searchParams.get('q'), 'canva');
    assert.equal(searches[0].url.search, originalQuery, 'The received request query is not rewritten into a selected response.'); cases++;

    // Explicit refresh is never answered from a row snapshot; a new denial clears it.
    fireEvent.click(screen.getByRole('button', {name: /^Reload$/u})); await count(2);
    await reply(searches[1], Response.json({success: false, code: 'PLUGIN_ACCESS_DENIED'}, {status: 403}));
    await waitFor(() => assert.equal(screen.queryByTestId('plugin-extension-row-open'), null));
    await navigate('&extensionId=composio:canva'); await count(3); noSetup();
    assert.equal(searches[2].url.searchParams.get('selected'), item.id, 'A previously denied row cannot bypass a fresh selected read.');
    denySetup = true; await reply(searches[2]); await screen.findByTestId('plugin-setup-sharedSetupUnavailable'); noSetup(); cases++;

    denySetup = false; await navigate('&extensionId=composio:github'); await count(4); noSetup();
    assert.equal(searches[3].url.searchParams.get('selected'), 'composio:github');
    await reply(searches[3], body(searches[3], [])); await waitFor(() => assert.equal(screen.queryByTestId('plugin-integration-detail'), null)); cases++;

    await navigate(''); fireEvent.click(screen.getByRole('button', {name: /^Reload$/u})); await count(5);
    await reply(searches[4]); await screen.findByTestId('plugin-extension-row-open');
    fireEvent.click(screen.getByTestId('plugin-extension-row-open')); await screen.findByTestId('plugin-integration-new-shared'); assert.equal(searches.length, 5);
    await navigate('&extensionId=composio:canva&extensionCursor=bmV4dA'); await count(6); noSetup();
    assert.equal(searches[5].url.searchParams.get('cursor'), 'bmV4dA');
    workspaceId = 'row-workspace-b'; rendered.rerender(<App />); await count(7); assert(searches[5].signal?.aborted); noSetup();
    await reply(searches[5]); noSetup(); await reply(searches[6]); await screen.findByTestId('plugin-integration-new-shared'); cases++;

    await act(async () => {sessionId = 'row-session-replaced'; seed();}); await count(8); noSetup();
    await act(async () => {actorId = 'row-actor-replaced'; sessionId = 'row-actor-session'; seed();}); await count(9); assert(searches[7].signal?.aborted);
    await reply(searches[7]); noSetup();
    await reply(searches[8], Response.json({success: false, code: 'PLUGIN_ACCESS_DENIED'}, {status: 403}));
    await waitFor(() => assert(!screen.getByRole('button', {name: /^Reload$/u}).hasAttribute('disabled'))); noSetup(); cases++;

    cleanup(); await navigate(''); const beforeAppend = searches.length; render(<App />);
    await count(beforeAppend + 1); await reply(searches.at(-1)!, body(searches.at(-1)!, [item], 'bmV4dA'));
    fireEvent.click(await screen.findByTestId('plugin-extension-more')); await count(beforeAppend + 2);
    assert.equal(searches.at(-1)!.url.searchParams.get('cursor'), 'bmV4dA', 'More always makes a genuine next-page request.');
    const github = {...item, id: 'composio:github', name: 'github', displayName: 'GitHub', toolkit: {slug: 'github', noAuth: false}};
    await reply(searches.at(-1)!, body(searches.at(-1)!, [github], 'bmV4dDI'));
    await waitFor(() => assert.equal(screen.getAllByTestId('plugin-extension-row-open').length, 2));
    const olderRow = () => screen.getAllByTestId('plugin-extension-row-open').find(row => row.getAttribute('data-extension-id') === item.id)!;
    fireEvent.click(olderRow()); await screen.findByTestId('plugin-integration-new-shared');
    assert.equal(searches.length, beforeAppend + 2, 'A visible older-page row retains its exact original response, without another full search.');
    assert(screen.getByText(item.description)); fireEvent.click(screen.getByTestId('plugin-extension-back'));
    await waitFor(() => assert.equal(screen.getAllByTestId('plugin-extension-row-open').length, 2));
    assert.equal(searches.length, beforeAppend + 2); assert(new URL(window.location.href).searchParams.get('extensionCursor'), 'The phase cursor envelope survives detail navigation and Back.'); cases++;

    fireEvent.click(screen.getByTestId('plugin-extension-more')); await count(beforeAppend + 3);
    await reply(searches.at(-1)!, Response.json({success: false, code: 'PLUGIN_SEARCH_UNAVAILABLE'}, {status: 503}));
    await screen.findByTestId('plugin-extension-page-error'); assert.equal(screen.getAllByTestId('plugin-extension-row-open').length, 2);
    fireEvent.click(olderRow()); await count(beforeAppend + 4); noSetup();
    assert.equal(searches.at(-1)!.url.searchParams.get('selected'), item.id, 'An error discards previous row provenance even when result rows remain visible for retry.');
    await reply(searches.at(-1)!, Response.json({success: false, code: 'PLUGIN_ACCESS_DENIED'}, {status: 403}));
    await waitFor(() => assert(!screen.getByRole('button', {name: /^Reload$/u}).hasAttribute('disabled'))); noSetup(); cases++;
    console.log(`PASS ${cases} actual Workspace/search-hook/Detail row-navigation cases: one received row search, original query and Back, explicit epoch refresh/403, unknown links, pagination, workspace/session/actor fences, late denial and fresh setup denial. Controlled metadata/session transport; no browser/backend claim.`);
  } finally {cleanup(); atom.set(originalSession); globalThis.fetch = originalFetch; loader._load = originalLoad; dom.window.close();}
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
