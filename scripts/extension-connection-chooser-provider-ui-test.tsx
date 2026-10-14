import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { ExtensionConnectionChooser, type ExtensionConnectionChooserData, type ExtensionConnectionChooserProvider,
  type ExtensionConnectionChooserQuery, type AgentExtensionChosenConnection } from '../app/components/agents/AgentExtensionConnectionChooser';
import type { StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';

// Genuine common chooser, with an independently supplied metadata boundary. No
// configure target, SQL/source authority, account probe or provider request is mocked as successful.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://chooser-provider.fixture.invalid', pretendToBeVisual: true });
for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node',
  'MutationObserver', 'Event', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const selection = (accountId: string): ExtensionConnectionChooserData['accounts'][number]['selection'] => ({ kind: 'composio', source: 'composio', toolkit: 'canva',
  target: { kind: 'personal', profileId: 'profile-a', accountBinding: 'account', accountId, connectionRef: `composio-personal:profile-a:${accountId}` } });
const base = (contextKey = 'scope-a'): ExtensionConnectionChooserData => ({ contextKey, connections: [], profiles: [], accounts: [],
  pagination: { nextCursor: null, hasNextPage: false, loadedItems: 0 } });
type Pending = { query: ExtensionConnectionChooserQuery; signal: AbortSignal; resolve: (data: ExtensionConnectionChooserData) => void; reject: (error: Error) => void };

async function main() {
  const { render, screen, within, fireEvent, act, waitFor, cleanup } = await import('@testing-library/react');
  const previousFetch = globalThis.fetch;
  const pending: Pending[] = [], chosen: AgentExtensionChosenConnection[] = [];
  let forbiddenRequests = 0, metadata = 0, cases = 0;
  globalThis.fetch = async () => { forbiddenRequests++; throw new Error('The neutral chooser cannot invoke an Agent endpoint.'); };
  const provider = (key = 'actual-user-a/session-a/agent-a/workspace-a/selector-canva'): ExtensionConnectionChooserProvider => ({ key,
    workspaceId: 'workspace-a', purpose: 'chat', load: (query, signal) => new Promise((resolve, reject) => pending.push({ query, signal, resolve, reject })) });
  const component = (source = provider(), locked: StandaloneExtensionSelection = selection('account-a')) => <NextIntlClientProvider locale="en" timeZone="UTC">
    <ExtensionConnectionChooser provider={source} lockedSelection={locked} onSelect={choice => { chosen.push(choice); }} onMetadata={() => { metadata++; }} />
  </NextIntlClientProvider>;
  const check = (name: string) => { cases++; console.log(`PASS ${name}`); };
  const respond = async (request: Pending, data: ExtensionConnectionChooserData) => { await act(async () => request.resolve(data)); };
  try {
    const view = render(component());
    await waitFor(() => assert.equal(pending.length, 1));
    assert.deepEqual(pending[0].query, { q: '', cursor: null, limit: 20 });
    assert.equal(Object.hasOwn(pending[0].query, 'target'), false);
    await respond(pending[0], { ...base(), profiles: [{ profileId: 'profile-a', label: 'My original profile', status: 'unverified' },
      { profileId: 'other-profile', label: 'Other profile', status: 'unverified' }],
    setupAlternatives: [{ source: 'composio', toolkit: 'canva', label: 'Canva' }] });
    assert.equal(pending.length, 1); assert.equal(chosen.length, 0);
    assert.equal((screen.getByRole('button', { name: /Other profile/u }) as HTMLButtonElement).disabled, true);
    assert(screen.getByText(/Your message draft stays here/u));
    const setup = screen.getByRole('link', { name: /Canva.*Set up/u });
    assert.equal(new URL(setup.getAttribute('href')!, dom.window.location.origin).searchParams.get('extensionId'), 'composio:canva');
    fireEvent.click(screen.getByRole('button', { name: /My original profile/u }));
    await waitFor(() => assert.equal(pending.length, 2));
    assert.deepEqual(pending[1].query, { q: '', profileId: 'profile-a', cursor: null, limit: 20 });
    await respond(pending[1], { ...base(), accounts: [{ selection: selection('account-a'), label: 'Original account', status: 'ACTIVE', selectable: true,
      accountSelectionRef: 'fresh-original-receipt' }, { selection: selection('account-b'), label: 'Other account', status: 'ACTIVE', selectable: true,
      accountSelectionRef: 'fresh-other-receipt' }], noAuthSelection: { kind: 'composio', source: 'composio', toolkit: 'duckduckgo',
      target: { kind: 'personal', profileId: 'profile-a', accountBinding: 'no_auth' } } });
    const rows = screen.getAllByRole('button', { name: 'This account' });
    assert.equal((rows[0] as HTMLButtonElement).disabled, false); assert.equal((rows[1] as HTMLButtonElement).disabled, true);
    assert.equal((screen.getByRole('button', { name: 'Use without sign-in' }) as HTMLButtonElement).disabled, true);
    fireEvent.click(rows[1]); assert.equal(chosen.length, 0);
    fireEvent.click(rows[0]); await waitFor(() => assert.equal(chosen.length, 1));
    assert.deepEqual(chosen[0], { selection: selection('account-a'), label: 'Original account', accountSelectionRef: 'fresh-original-receipt' });
    assert.equal(forbiddenRequests, 0); assert.equal(metadata, 2);
    check('chat provider uses no Agent configuration target, profiles are deliberate, and exact-account renewal never falls back');

    fireEvent.change(screen.getByRole('textbox', { name: 'Search connections' }), { target: { value: 'pending-search' } });
    await waitFor(() => assert.equal(pending.length, 3));
    const abandoned = pending[2], previousMetadata = metadata;
    view.rerender(component(provider('actual-user-b/session-b/agent-b/workspace-b/selector-canva')));
    await waitFor(() => assert.equal(pending.length, 4));
    assert.equal(abandoned.signal.aborted, true);
    await respond(abandoned, { ...base('scope-old'), profiles: [{ profileId: 'profile-a', label: 'STALE PROFILE', status: 'unverified' }] });
    assert.equal(screen.queryByText('STALE PROFILE'), null); assert.equal(metadata, previousMetadata);
    assert.deepEqual(pending[3].query, { q: '', cursor: null, limit: 20 });
    await respond(pending[3], { ...base('scope-new'), profiles: [{ profileId: 'profile-a', label: 'Fresh profile', status: 'unverified' }] });
    assert(screen.getByText('Fresh profile')); assert.equal(metadata, previousMetadata + 1);
    check('provider identity resets query/profile state, aborts previous requests and excludes late old-scope metadata callbacks');

    cleanup(); pending.length = 0;
    render(component(provider('pagination')));
    await waitFor(() => assert.equal(pending.length, 1));
    await respond(pending[0], { ...base(), profiles: [{ profileId: 'profile-a', label: 'Page profile', status: 'unverified' }],
      pagination: { hasNextPage: true, nextCursor: 'next', loadedItems: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => assert.equal(pending.length, 2));
    await act(async () => pending[1].reject(new Error('Actual page denied')));
    await screen.findByText('Actual page denied');
    assert.equal((screen.getByRole('button', { name: /Page profile/u }) as HTMLButtonElement).disabled, true);
    const before = chosen.length; fireEvent.click(screen.getByRole('button', { name: /Page profile/u })); assert.equal(chosen.length, before);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => assert.equal(pending.length, 3));
    await respond(pending[2], { ...base('fresh-context'), profiles: [{ profileId: 'profile-a', label: 'Reloaded profile', status: 'unverified' }] });
    assert.equal((screen.getByRole('button', { name: /Reloaded profile/u }) as HTMLButtonElement).disabled, false);
    assert.equal(screen.queryByText('Page profile'), null);
    check('shared provider preserves pagination failure fencing and requires explicit fresh reload');

    cleanup(); pending.length = 0;
    const synchronousFailure: ExtensionConnectionChooserProvider = { ...provider('sync-failure'), load: () => { throw new Error('Synchronous metadata denial'); } };
    const failed = render(component(synchronousFailure));
    await screen.findByText('Synchronous metadata denial');
    failed.rerender(component(provider('new-provider-after-denial')));
    await waitFor(() => assert.equal(pending.length, 1));
    const mcpSelection: StandaloneExtensionSelection = { kind: 'mcp', source: 'mcp', target: { kind: 'shared',
      connectionRef: 'canvas-connection:00000000-0000-4000-8000-000000000001', bindingRevision: 3 } };
    failed.rerender(component(provider('mcp-exact-revision'), mcpSelection));
    await waitFor(() => assert.equal(pending.length, 2));
    await respond(pending[1], { ...base(), connections: [2, 3].map(revision => ({ id: `revision-${revision}`, label: `MCP revision ${revision}`,
      selection: { ...mcpSelection, target: { ...mcpSelection.target, bindingRevision: revision } }, scopeLabel: 'team', allowedToolNames: null,
      eligibility: { action: 'select' }, authorization: 'unknown', health: 'unknown', mappingRequired: false })) });
    for (const revision of [2, 3]) {
      const row = screen.getByText(`MCP revision ${revision}`).closest('.rounded-md')!;
      assert.equal((within(row as HTMLElement).getByRole('button', { name: 'Choose' }) as HTMLButtonElement).disabled, revision !== 3);
    }
    assert.equal(forbiddenRequests, 0);
    check('synchronous loader failures stay finite and fixed shared renewal also matches binding revision');
    console.log(JSON.stringify({ status: 'PASS', cases, forbiddenRequests, browser: false, authority: false }));
  } finally { cleanup(); globalThis.fetch = previousFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
