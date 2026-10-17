import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { PluginExtensionSelectionMetadata } from '../app/components/plugins/usePluginExtensionSearch';

// Actual BetterAuth session atom, React detail, scoped request helper and
// guards. Only session/metadata HTTP delivery and the 30s deadline are controlled.
// No server, browser, authority issuer or provider is started here.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins?view=browse&extensionId=composio:canva', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const deadlines = new Map<ReturnType<typeof setTimeout>, () => void>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    if (delay === 30_000) deadlines.set(handle, () => { originalClearTimeout(handle); deadlines.delete(handle); callback(...args); });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => { deadlines.delete(handle); originalClearTimeout(handle); }) as typeof clearTimeout;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation'
    ? { Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) }
    : originalLoad(name, parent, isMain);
  const workspaceId = 'load-workspace'; let actor = 'actor-a';
  const session = () => ({ user: { id: actor, name: actor, email: `${actor}@fixture.invalid`, role: 'admin', emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), banned: false },
    session: { id: `session-${actor}`, userId: actor, token: 'CONTROLLED_UI_SESSION', expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } });
  const item = { id: 'composio:canva', kind: 'integration' as const, name: 'canva', displayName: 'Canva', description: 'Fresh catalogue description', source: 'composio' as const, stock: 'installed' as const,
    access: { canRead: true, canUse: true, canManage: true }, toolkit: { slug: 'canva', noAuth: false }, connections: [] };
  const selectedBody = (): {success: true; data: PluginExtensionSearchResponse} => ({ success: true, data: {
    schemaVersion: 1, query: {q: 'canva', types: ['integration'], scope: 'all', audience: null, teamId: null, selected: item.id, cursor: null, stock: 'all', source: 'all', limit: 20},
    selectedItem: item, items: [item], scopes: {choices: ['all', 'user', 'organization'], teams: []},
    coverage: [{ source: 'composio', status: 'complete' }], pagination: { hasNextPage: false, nextCursor: null, loadedItems: 1 } } });
  const profilesBody = () => ({ success: true, profiles: [{ id: 'owned-profile', name: 'Owned profile', status: 'active' }],
    effectiveProfile: { id: 'owned-profile', name: 'Owned profile', workspaceId }, workspace: { id: workspaceId } });
  const scopeBody = (allowed = true) => ({ success: true, data: { scopes: allowed ? [{ ownership: { type: 'organization', organizationId: 'fixture-org' }, label: 'Organization' }] : [] } });
  const reads: Array<{ path: string; signal: AbortSignal | null | undefined; query: URLSearchParams }> = [];
  let override: ((path: string) => Response | Promise<Response> | undefined) | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test');
    if (url.pathname === '/api/auth/get-session') return Response.json(session());
    assert.equal(init?.method ?? 'GET', 'GET', 'Loading/retrying must not mutate profiles or connect providers.');
    assert.equal(new Headers(init?.headers).get('x-canvas-workspace-id'), workspaceId);
    reads.push({ path: url.pathname, signal: init?.signal, query: url.searchParams });
    const result = override?.(url.pathname); if (result) return result;
    if (url.pathname === '/api/plugins/search') return Response.json(selectedBody());
    if (url.pathname === '/api/integrations/shared-connections/setup') return Response.json(scopeBody());
    if (url.pathname === '/api/composio/profiles') return Response.json(profilesBody());
    throw new Error(`Unexpected metadata read ${url.pathname}`);
  };
  const { render, screen, act, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const { authClient } = await import('../app/lib/auth-client'), atom = authClient.$store.atoms.session, originalSession = atom.get();
  const { PluginIntegrationDetail } = await import('../app/components/plugins/PluginIntegrationDetail');
  const { usePluginExtensionSearch } = await import('../app/components/plugins/usePluginExtensionSearch');
  const seed = () => atom.set({ ...atom.get(), data: session(), error: null, isPending: false, isRefetching: false });
  const mount = (selectionMetadata?: PluginExtensionSelectionMetadata | null) => render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginIntegrationDetail item={item} workspaceId={workspaceId}
    selectionMetadata={selectionMetadata} returnPath="/en/plugins?view=browse&extensionId=composio:canva" onUpdated={() => {}} onClose={() => {}} /></NextIntlClientProvider>);
  let receivedMetadata: PluginExtensionSelectionMetadata | null = null;
  function ActualCatalogueDetail() {
    const data = usePluginExtensionSearch({navigation: {area: 'plugins', view: 'browse', scope: 'all', extensionId: item.id}, workspaceId, epoch: 0});
    receivedMetadata = data.selectionMetadata ?? null;
    return data.selectedItem?.kind === 'integration' ? <PluginIntegrationDetail item={data.selectedItem} selectionMetadata={data.selectionMetadata} workspaceId={workspaceId}
      returnPath="/en/plugins?view=browse&extensionId=composio:canva" onUpdated={() => {}} onClose={() => {}} /> : <p>Waiting for catalogue metadata</p>;
  }
  const expire = async () => { assert(deadlines.size > 0); await act(async () => { for (const fire of [...deadlines.values()]) fire(); }); };
  const noActions = () => { assert.equal(screen.queryByTestId('plugin-integration-new-shared'), null); assert.equal(screen.queryByTestId('plugin-integration-connect'), null); };
  const failed = async () => { await screen.findByText(en.skills.workspace.setup.loadError); noActions(); assert.equal(screen.getByTestId<HTMLButtonElement>('plugin-integration-reload').disabled, false); assert.equal(screen.queryByText(en.skills.workspace.setup.loading), null); };
  const ready = async (shared = true) => { await screen.findByTestId('plugin-integration-connect'); assert.equal(Boolean(screen.queryByTestId('plugin-integration-new-shared')), shared); };
  let cases = 0;
  try {
    seed(); mount(); await ready(); cases++;
    cleanup(); reads.length = 0; seed();
    atom.set({ ...atom.get(), error: { message: 'Controlled session denial', status: 401, statusText: 'Unauthorized' } });
    mount(); await failed(); assert.equal(reads.length, 0, 'Session denial cannot be bypassed by the metadata loader.');
    fireEvent.click(screen.getByTestId('plugin-integration-reload')); await ready(); cases++;

    cleanup(); reads.length = 0; seed(); atom.set({ ...atom.get(), isPending: true });
    mount(); await screen.findByText(en.skills.workspace.setup.loading); noActions(); assert.equal(reads.length, 0);
    await expire(); await failed(); assert.equal(reads.length, 0, 'The pending-session deadline only exposes Retry, never protected setup.');
    fireEvent.click(screen.getByTestId('plugin-integration-reload')); await ready(); cases++;

    for (const stage of ['selected-headers', 'selected-body', 'scopes', 'profiles'] as const) {
      cleanup(); reads.length = 0; seed();
      const delayed = deferred<Response>(), delayedBody = deferred<ReturnType<typeof selectedBody>>();
      override = current => {
        if (stage === 'selected-headers' && current === '/api/plugins/search') return delayed.promise;
        if (stage === 'selected-body' && current === '/api/plugins/search') { const response = Response.json(selectedBody()); response.json = () => delayedBody.promise; return response; }
        if (stage === 'scopes' && current === '/api/integrations/shared-connections/setup' || stage === 'profiles' && current === '/api/composio/profiles') return delayed.promise;
      };
      mount(); await waitFor(() => assert(reads.some(read => read.path === (stage === 'scopes' ? '/api/integrations/shared-connections/setup' : stage === 'profiles' ? '/api/composio/profiles' : '/api/plugins/search'))));
      if (stage === 'scopes') { await screen.findByTestId('plugin-integration-connect'); assert.equal(screen.queryByTestId('plugin-integration-new-shared'), null); }
      if (stage === 'profiles') { await screen.findByTestId('plugin-integration-new-shared'); assert.equal(screen.queryByTestId('plugin-integration-connect'), null); }
      await expire();
      if (stage === 'selected-headers' || stage === 'selected-body') await failed();
      else {
        await screen.findByTestId(stage === 'scopes' ? 'plugin-setup-sharedSetupUnavailable' : 'plugin-setup-profilesUnavailable');
        assert.equal(screen.queryByText(en.skills.workspace.setup.loadError), null, 'An independent metadata timeout cannot erase the successful setup branch.');
        if (stage === 'scopes') await screen.findByTestId('plugin-integration-connect'); else await screen.findByTestId('plugin-integration-new-shared');
      }
      const stalled = reads.find(read => read.path === (stage === 'scopes' ? '/api/integrations/shared-connections/setup' : stage === 'profiles' ? '/api/composio/profiles' : '/api/plugins/search'));
      assert(stalled?.signal?.aborted, `The stalled ${stage} metadata transport must be aborted.`);
      // A timed-out transport may ignore abort and return later. Retry has fresh
      // scopes denying shared creation; old allowed scopes must never appear.
      override = current => current === '/api/integrations/shared-connections/setup' ? Response.json(scopeBody(false)) : undefined;
      fireEvent.click(screen.getByTestId('plugin-integration-reload')); await ready(false);
      await act(async () => { delayed.resolve(Response.json(stage === 'scopes' ? scopeBody() : stage === 'profiles' ? profilesBody() : selectedBody())); delayedBody.resolve(selectedBody()); });
      await ready(false); cases++;
    }

    cleanup(); reads.length = 0; seed(); const oldScopes = deferred<Response>();
    override = current => current === '/api/integrations/shared-connections/setup' ? oldScopes.promise : undefined;
    mount(); await waitFor(() => assert(reads.some(read => read.path.endsWith('/setup')))); const oldRead = reads.find(read => read.path.endsWith('/setup'));
    override = current => current === '/api/integrations/shared-connections/setup' ? Response.json(scopeBody(false)) : undefined;
    await act(async () => { actor = 'actor-b'; seed(); }); await ready(false); assert(oldRead?.signal?.aborted);
    await act(async () => oldScopes.resolve(Response.json(scopeBody()))); await ready(false); cases++;

    cleanup(); reads.length = 0; seed(); override = undefined;
    const catalogue = deferred<Response>(), personal = deferred<Response>();
    override = current => current === '/api/plugins/search' ? catalogue.promise : current === '/api/composio/profiles' ? personal.promise : undefined;
    render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><ActualCatalogueDetail /></NextIntlClientProvider>);
    await waitFor(() => assert.equal(reads.filter(read => read.path === '/api/plugins/search').length, 1));
    assert.equal(reads.length, 1, 'The real detail waits for the actual parent response, not a fabricated selection.');
    await act(async () => catalogue.resolve(Response.json(selectedBody())));
    await screen.findByTestId('plugin-integration-new-shared'); assert(screen.getByTestId('plugin-integration-personal-loading'));
    assert.equal(reads.filter(read => read.path === '/api/plugins/search').length, 1, 'The real hook response is reused instead of a second serial full-catalogue request.');
    assert.equal(screen.queryByTestId('plugin-integration-connect'), null, 'Fresh shared setup rights do not manufacture personal profile metadata.');
    const snapshot = receivedMetadata; assert(snapshot);
    override = undefined; fireEvent.click(screen.getByTestId('plugin-integration-reload')); await ready();
    assert.equal(reads.filter(read => read.path === '/api/plugins/search').length, 2, 'An explicit refresh always fetches fresh selection metadata.');
    assert.equal(reads.filter(read => read.path === '/api/plugins/search').at(-1)?.query.get('q'), 'canva', 'Detail refresh targets the exact toolkit rather than browsing the full catalogue.');
    await act(async () => personal.resolve(Response.json(profilesBody()))); await ready(); cases++;

    cleanup(); reads.length = 0; actor = 'actor-c'; seed(); const freshSelection = deferred<Response>();
    override = current => current === '/api/plugins/search' ? freshSelection.promise : undefined;
    mount(snapshot); await waitFor(() => assert(reads.some(read => read.path === '/api/plugins/search'))); noActions();
    assert.equal(screen.queryByText(item.description), null, 'A previous actor’s catalogue response cannot enable setup for this actor.');
    await act(async () => freshSelection.resolve(Response.json(selectedBody()))); await ready(); cases++;
    console.log(`PASS ${cases} real React integration-load cases: single actual hook/detail catalogue response, independent shared/personal setup, explicit targeted refresh, session error/refetch, bounded metadata, retry and late actor/scope fences. Controlled session/HTTP/deadline; no backend or browser claim.`);
  } finally {
    cleanup(); atom.set(originalSession); globalThis.fetch = originalFetch; loader._load = originalLoad;
    for (const handle of deadlines.keys()) originalClearTimeout(handle); deadlines.clear();
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
