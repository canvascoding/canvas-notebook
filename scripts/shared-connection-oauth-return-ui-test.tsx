import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { IntegrationConnectionDescriptor, SharedIntegrationConnectionOwnership } from '../app/lib/integration-tools/connections/contracts';

let observeNavigation: (() => void) | undefined;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { if (error.message.includes('navigation')) observeNavigation?.(); else throw error; });
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://canvas.test/en/plugins?view=advanced&scope=organization', pretendToBeVisual: true, virtualConsole,
});
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLBodyElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
  'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

/** Actual BetterAuth atom/Parent/Forms/Radix/Guard; controlled HTTP identity and SafeDTOs are not server-authority evidence. */
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation'
    ? { Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) }
    : originalLoad(name, parent, isMain);
  const { render, screen, fireEvent, waitFor, cleanup, act, within } = await import('@testing-library/react');
  const { PluginNavigationGuard, confirmPluginNavigation, usePluginEditorNavigationGuard } = await import('../app/components/plugins/plugin-navigation-guard');
  const refs = { mcp: 'canvas-connection:11111111-1111-4111-8111-111111111111', composio: 'canvas-connection:22222222-2222-4222-8222-222222222222',
    wrong: 'canvas-connection:33333333-3333-4333-8333-333333333333', missing: 'canvas-connection:44444444-4444-4444-8444-444444444444' };
  type Source = 'mcp' | 'composio';
  type Seen = { actor: string | null; path: string; method: string; body: Record<string, unknown> | null; workspace: string | null };
  const receipts: Seen[] = [];
  let actor: string | null = 'actor-a', identityPending = false, locale: 'en' | 'de' = 'en', redirects = 0, prompts = 0;
  let heldList: { release: () => void; started: boolean } | null = null, heldOAuth: { release: () => void; started: boolean } | null = null;
  let listGate: Promise<void> | undefined, oauthGate: Promise<void> | undefined, oauthError = false, providerConnected = false;
  let mcpStatusOverride: { data: unknown } | null = null;
  let ownership: SharedIntegrationConnectionOwnership = { type: 'organization', organizationId: 'fixture-org' }, sameNames = false, omitComposio = false;
  function heldSlot(kind: 'list' | 'oauth'): { release: () => void; started: boolean } | null { return kind === 'list' ? heldList : heldOAuth; }
  const uiSession = (userId: string) => ({ user: { id: userId, name: userId, email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0), role: 'admin', banned: false },
    session: { id: `ui-session-${userId}`, token: 'CONTROLLED_UI_IDENTITY_ONLY', userId, expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } });
  function seedIdentity(userId: string | null, pending = false) {
    actor = userId; identityPending = pending;
    sessionAtom.set({ ...sessionAtom.get(), data: userId ? uiSession(userId) : null, error: null, isPending: pending, isRefetching: false });
  }
  function exactConnection(source: Source, userId = actor ?? 'actor-a'): IntegrationConnectionDescriptor {
    return { resource: { connectionRef: refs[source], source, ownership,
      displayName: sameNames ? `${userId} same name` : `${userId} ${source}`, description: 'Current saved description', application: source === 'composio' ? 'canva' : null,
      responsibleUserId: null, createdByUserId: userId, updatedByUserId: userId, metadataRevision: 3, grantsRevision: 5, bindingRevision: 7,
      allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 }, access: { canRead: true, canUse: false, canManage: true }, grants: [] };
  }
  const oauthWrites = () => receipts.filter(receipt => receipt.method === 'POST' && (receipt.path.endsWith('/oauth') || receipt.path.endsWith('/connect')));
  window.confirm = () => { prompts++; return true; };
  observeNavigation = () => { redirects++; };
  const ok = (data: unknown) => Response.json({ success: true, data });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    if (path === '/api/auth/get-session') return Response.json(actor && !identityPending ? uiSession(actor) : null);
    const receipt: Seen = { actor, path, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      workspace: new Headers(init?.headers).get('x-canvas-workspace-id') };
    receipts.push(receipt); assert.equal(receipt.workspace, 'fixture-workspace');
    if (path === '/api/integrations/shared-connections/setup') return ok({ scopes: [{ ownership, label: 'Readable fixture scope' }] });
    if (path === '/api/integrations/shared-connections') {
      const values = [exactConnection('mcp'), ...(omitComposio ? [] : [exactConnection('composio')])], gate = listGate;
      if (heldList && receipt.actor === 'actor-a') { heldList.started = true; listGate = undefined; }
      await gate; return ok({ connections: values });
    }
    const source: Source = path.includes(refs.composio) ? 'composio' : 'mcp';
    if (path.endsWith('/targets')) return ok({ targets: { users: [{ userId: 'fixture-reader', name: 'Reader', email: 'reader@fixture.invalid', role: 'member' }], workspaces: [], projects: [], agents: [] } });
    if (path.startsWith('/api/integrations/shared-connections/')) {
      if (path.includes(refs.missing)) return Response.json({ success: false, code: 'connection_unavailable' }, { status: 404 });
      const connection = exactConnection(source);
      if (path.includes(refs.wrong)) connection.resource = { ...connection.resource, connectionRef: refs.wrong, ownership: { type: 'team', organizationId: 'fixture-org', workspaceId: 'foreign-team' } };
      return ok({ connection });
    }
    if (path.endsWith('/accounts')) return ok({ accounts: [{ accountRef: 'opaque-account', label: 'Owned account', selectable: true }] });
    if (method === 'POST' && (path.endsWith('/oauth') || path.endsWith('/connect'))) {
      if (heldOAuth) heldOAuth.started = true;
      await oauthGate;
      if (oauthError) throw new Error('PRIVATE_OLD_ACTOR_ACK');
      return ok(source === 'mcp' ? { authorizationUrl: 'https://login.fixture.invalid/oauth' } : { redirectUrl: 'https://login.fixture.invalid/connect' });
    }
    if (method === 'GET' && (path.endsWith('/oauth') || path.endsWith('/status'))) return ok(source === 'mcp'
      ? mcpStatusOverride ? mcpStatusOverride.data : { configured: true, authorized: providerConnected, requiresAuth: !providerConnected, authStatus: providerConnected ? 'authorized' : 'not_authorized', code: null }
      : { status: { state: providerConnected ? 'ready' : 'auth_required', connected: providerConnected, application: 'canva', profileName: 'Fixture profile' } });
    throw new Error(`Unexpected controlled UI request ${method} ${path}`);
  };
  // The real BetterAuth client captures its HTTP transport at construction.
  const { authClient } = await import('../app/lib/auth-client');
  const sessionAtom = authClient.$store.atoms.session, originalSession = sessionAtom.get();
  const { SharedConnectionsSection } = await import('../app/components/plugins/SharedConnectionsSection');
  type ReturnProps = React.ComponentProps<typeof SharedConnectionsSection>;
  function Form({ initialConnectionRef, returnStatus }: Pick<ReturnProps, 'initialConnectionRef' | 'returnStatus'>) {
    const props: ReturnProps = { workspaceId: 'fixture-workspace', ownership, initiallyOpen: true, initialConnectionRef, returnStatus };
    return <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
      <PluginNavigationGuard unsavedChangesMessage={(locale === 'en' ? en : de).skills.drafts.unsavedNavigation} />
      {React.createElement(SharedConnectionsSection, props)}
    </NextIntlClientProvider>;
  }
  async function mountReturn(initialConnectionRef?: string, returnStatus?: 'connected' | 'cancelled' | 'failed', wait = true) {
    cleanup(); receipts.length = 0; redirects = 0; prompts = 0; seedIdentity('actor-a');
    const view = render(<Form initialConnectionRef={initialConnectionRef} returnStatus={returnStatus} />);
    if (wait) await waitFor(() => assert(initialConnectionRef
      ? receipts.some(value => value.path === `/api/integrations/shared-connections/${initialConnectionRef}`)
      : screen.queryAllByTestId('shared-connection-row').some(row => row.textContent?.includes('actor-a'))));
    return view;
  }
  async function beginConnect(source: Source = 'mcp') {
    if (!screen.queryByTestId('shared-connection-edit-dialog')) fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${actor} ${source}`, 'u') }));
    const dialog = await screen.findByTestId('shared-connection-edit-dialog');
    await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
    const button = within(dialog).getByRole('button', { name: (locale === 'en' ? en : de).sharedConnections.connect, hidden: true });
    const details = button.closest('details'); assert(details); details.open = true;
    return { dialog, button };
  }
  async function settleHeld(kind: 'list' | 'oauth') { await act(async () => { if (kind === 'list') { heldList?.release(); listGate = undefined; heldList = null; } else { heldOAuth?.release(); oauthGate = undefined; heldOAuth = null; } }); }
  function assertNoStaleState() { assert.equal(document.body.textContent?.includes('actor-a mcp'), false); assert.equal(document.body.textContent?.includes('PRIVATE_OLD_ACTOR_ACK'), false); assert.equal(redirects, 0); }
  function OtherDirtyEditor() { usePluginEditorNavigationGuard({ dirty: true, pending: false }); return <p>Other dirty editor</p>; }
  const assertMcpStatusMatrix = async () => {
    const cases: Array<{ name: string; data: unknown; connected: boolean }> = [
      { name: 'unconfigured unavailable', data: { configured: false, requiresAuth: false, authorized: false, authStatus: 'unavailable', code: 'unavailable' }, connected: false },
      { name: 'configured unavailable', data: { configured: true, requiresAuth: false, authorized: false, authStatus: 'not_authorized', code: 'unavailable' }, connected: false },
      { name: 'error despite authorized', data: { configured: true, requiresAuth: true, authorized: true, authStatus: 'authorized', code: 'unavailable' }, connected: false },
      { name: 'missing configured', data: { requiresAuth: false, authorized: false, code: null }, connected: false },
      { name: 'string configured', data: { configured: 'true', requiresAuth: false, authorized: false, code: null }, connected: false },
      { name: 'missing auth requirement', data: { configured: true, authorized: true, code: null }, connected: false },
      { name: 'string auth requirement', data: { configured: true, requiresAuth: 'false', authorized: false, code: null }, connected: false },
      { name: 'required but unauthorized', data: { configured: true, requiresAuth: true, authorized: false, authStatus: 'not_authorized', code: 'reauth_required' }, connected: false },
      { name: 'empty status', data: {}, connected: false }, { name: 'null status', data: null, connected: false },
      { name: 'wrong provider fields', data: { configured: false, requiresAuth: true, authorized: false, status: { connected: true }, code: null }, connected: false },
      { name: 'authorized current OAuth', data: { configured: true, requiresAuth: true, authorized: true, authStatus: 'authorized', code: null }, connected: true },
      { name: 'configured auth not required', data: { configured: true, requiresAuth: false, authorized: false, authStatus: 'not_authorized', code: null }, connected: true },
      { name: 'configured no error property', data: { configured: true, requiresAuth: false, authorized: false, authStatus: 'not_authorized' }, connected: true },
    ];
    for (const test of cases) {
      mcpStatusOverride = { data: test.data }; await mountReturn(refs.mcp, 'connected');
      const dialog = await screen.findByTestId('shared-connection-edit-dialog');
      await waitFor(() => assert(within(dialog).queryByText(en.sharedConnections.connected)
        || within(dialog).queryByText(en.sharedConnections.connectionRequired) || within(dialog).queryByText(en.sharedConnections.loadError)));
      const actual = Boolean(within(dialog).queryByText(en.sharedConnections.connected));
      console.log(`OBSERVED MCP status ${test.name}`, JSON.stringify({ connected: actual, statusReads: receipts.filter(value => value.method === 'GET' && value.path === `/api/mcp/shared-connections/${refs.mcp}/oauth`).length,
        writes: receipts.filter(value => value.method !== 'GET').length, redirects }));
      assert.equal(actual, test.connected, `Fresh MCP ${test.name} cannot produce an unsupported connected claim.`);
      assert(receipts.some(value => value.method === 'GET' && value.path === `/api/mcp/shared-connections/${refs.mcp}/oauth`));
      assert.equal(receipts.filter(value => value.method !== 'GET').length, 0); assert.equal(redirects, 0); assert.equal(prompts, 0);
    }
    mcpStatusOverride = null;
    console.log('PASS strict fresh MCP status: unavailable/malformed/error denies Connected; configured no-auth and current authorization remain valid. No POST/assign.');
  };
  try {
    if (process.argv.includes('--status-readiness')) {
      await assertMcpStatusMatrix();
    } else if (process.argv.includes('--red-locale')) {
      await mountReturn(); const { button } = await beginConnect(); fireEvent.click(button); await waitFor(() => assert.equal(redirects, 1));
      console.log('OBSERVED OAuth body', JSON.stringify(oauthWrites()[0].body));
      assert.deepEqual(oauthWrites()[0].body, { expectedMetadataRevision: 3, expectedGrantsRevision: 5, expectedBindingRevision: 7, returnLocale: 'en' });
    } else if (process.argv.includes('--red-dirty')) {
      await mountReturn(); const { dialog, button } = await beginConnect();
      const name = document.getElementById('shared-edit-name'); assert(name);
      fireEvent.change(name, { target: { value: 'Unsaved exact draft' } });
      fireEvent.click(button); await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      console.log('OBSERVED dirty OAuth', JSON.stringify({ writes: oauthWrites().length, redirects, prompts }));
      assert.equal(oauthWrites().length, 0, 'Dirty OAuth start must be rejected even when confirmation would accept.');
      assert.equal(redirects, 0); assert.equal(prompts, 0); assert(document.body.contains(dialog));
    } else if (process.argv.includes('--red-actor')) {
      await mountReturn(); const { button } = await beginConnect(); oauthGate = new Promise(resolve => { heldOAuth = { release: resolve, started: false }; });
      fireEvent.click(button); await waitFor(() => assert.equal(heldOAuth?.started, true));
      await act(async () => seedIdentity('actor-b')); await settleHeld('oauth');
      console.log('OBSERVED late actor', JSON.stringify({ redirects, oldLabel: document.body.textContent?.includes('actor-a mcp') }));
      assertNoStaleState();
    } else if (process.argv.includes('--red-return')) {
      await mountReturn(refs.composio, 'connected');
      console.log('OBSERVED exact return', JSON.stringify({ opened: Boolean(screen.queryByTestId('shared-connection-edit-dialog')), refs: receipts.map(value => value.path) }));
      assert(screen.queryByTestId('shared-connection-edit-dialog'), 'An exact returned connection must be freshly inspected and opened.');
      assert(receipts.some(value => value.method === 'GET' && value.path === `/api/integrations/shared-connections/${refs.composio}`));
    } else {
      for (const language of ['en', 'de'] as const) for (const source of ['mcp', 'composio'] as const) {
        locale = language; await mountReturn(); const { button } = await beginConnect(source); fireEvent.click(button);
        await waitFor(() => assert.equal(redirects, 1)); assert.equal(prompts, 0); assert.equal(oauthWrites().length, 1);
        assert.deepEqual(oauthWrites()[0], { actor: 'actor-a', path: `/api/${source}/shared-connections/${refs[source]}/${source === 'mcp' ? 'oauth' : 'connect'}`,
          method: 'POST', workspace: 'fixture-workspace', body: { expectedMetadataRevision: 3, expectedGrantsRevision: 5, expectedBindingRevision: 7, returnLocale: language } });
        console.log(`PASS clean ${language}/${source}: exact scoped CAS+locale, one assign and zero discard confirmation.`);
      }
      locale = 'en';
      const dirtyCases: Array<{ label: string; source: Source; field?: string; text?: string; staged?: true; account?: true }> = [
        { label: 'metadata', source: 'mcp', field: 'shared-edit-name', text: 'Unsaved exact draft' },
        { label: 'configuration', source: 'mcp', field: 'shared-repair-config', text: '{"url":"https://fixture.invalid/mcp"}' },
        { label: 'hidden secrets', source: 'mcp', field: 'shared-repair-secrets', text: '[{"name":"TOKEN","value":"FAKE_ONLY"}]' },
        { label: 'tool restrictions', source: 'mcp', field: 'shared-allowed-tools', text: 'one.staged.tool' },
        { label: 'staged grant target', source: 'mcp', staged: true }, { label: 'selected account', source: 'composio', account: true },
      ];
      for (const test of dirtyCases) {
        await mountReturn(); const { dialog, button } = await beginConnect(test.source);
        let edited: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (test.staged) {
          fireEvent.click(screen.getByTestId('shared-grant-target')); fireEvent.click(await screen.findByTestId('shared-grant-target-option-fixture-reader'));
          edited = within(dialog).getByRole('textbox', { name: en.sharedConnections.grantToolLimits, hidden: true }) as HTMLTextAreaElement;
          fireEvent.change(edited, { target: { value: 'staged.grant.tool' } });
        } else if (test.account) {
          fireEvent.click(within(dialog).getByRole('button', { name: en.sharedConnections.loadAccounts, hidden: true }));
          await screen.findByRole('option', { name: 'Owned account' }); const input = document.getElementById('shared-account'); assert(input);
          edited = input as HTMLSelectElement; fireEvent.change(edited, { target: { value: 'opaque-account' } });
        } else {
          if (test.field === 'shared-allowed-tools') { const mode = document.getElementById('shared-tool-mode'); assert(mode); fireEvent.change(mode, { target: { value: 'selected' } }); }
          const input = document.getElementById(test.field ?? ''); assert(input); edited = input as HTMLInputElement | HTMLTextAreaElement;
          fireEvent.change(edited, { target: { value: test.text } });
        }
        const retained = edited.value; fireEvent.click(button); await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        assert(within(dialog).getByText(en.sharedConnections.saveBeforeConnect));
        assert.equal(oauthWrites().length, 0, `${test.label} cannot be discarded implicitly by OAuth.`); assert.equal(redirects, 0); assert.equal(prompts, 0);
        assert.equal(receipts.filter(receipt => receipt.method !== 'GET').length, 0);
        assert.equal(edited.value, retained); assert(document.body.contains(dialog));
        console.log(`PASS dirty ${test.label}: zero OAuth POST/assign/prompt with draft retained despite accepting confirm callback.`);
      }
      await mountReturn(); let current = await beginConnect(); const other = render(<OtherDirtyEditor />);
      fireEvent.click(current.button); await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.equal(oauthWrites().length, 0); assert.equal(redirects, 0); assert.equal(prompts, 0); other.unmount(); assert.equal(confirmPluginNavigation(), true);
      console.log('PASS other dirty editor blocks OAuth without a discard confirmation or general navigation exemption.');

      for (const scope of ['organization', 'team'] as const) for (const connected of [false, true]) {
        ownership = scope === 'organization' ? { type: 'organization', organizationId: 'fixture-org' } : { type: 'team', organizationId: 'fixture-org', workspaceId: 'fixture-team' };
        sameNames = true; omitComposio = true; providerConnected = connected; await mountReturn(refs.composio, 'connected');
        const dialog = await screen.findByTestId('shared-connection-edit-dialog');
        await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
        await waitFor(() => assert(receipts.some(value => value.method === 'GET' && value.path === `/api/composio/shared-connections/${refs.composio}/status`)));
        assert(receipts.some(value => value.method === 'GET' && value.path === `/api/integrations/shared-connections/${refs.composio}`));
        assert.equal(receipts.some(value => value.path.startsWith(`/api/mcp/shared-connections/${refs.mcp}`)), false, 'Same-name first row cannot replace the returned ref.');
        await within(dialog).findByText(connected ? en.sharedConnections.connected : en.sharedConnections.connectionRequired);
        assert.equal(Boolean(within(dialog).queryByText(en.sharedConnections.connected)), connected);
        assert.equal(oauthWrites().length, 0); assert.equal(redirects, 0);
        console.log(`PASS exact ${scope} return: omitted/same-name row never substitutes ref; connected claim follows fresh provider status=${connected}.`);
      }
      ownership = { type: 'organization', organizationId: 'fixture-org' }; sameNames = false; omitComposio = false;
      for (const connected of [false, true]) {
        providerConnected = connected; await mountReturn(refs.mcp, 'connected'); const dialog = await screen.findByTestId('shared-connection-edit-dialog');
        await within(dialog).findByText(connected ? en.sharedConnections.connected : en.sharedConnections.connectionRequired);
        assert(receipts.some(value => value.method === 'GET' && value.path === `/api/mcp/shared-connections/${refs.mcp}/oauth`));
        assert.equal(oauthWrites().length, 0); assert.equal(redirects, 0);
      }
      for (const outcome of ['cancelled', 'failed'] as const) {
        await mountReturn(refs.mcp, outcome); const dialog = await screen.findByTestId('shared-connection-edit-dialog');
        await within(dialog).findByText(outcome === 'cancelled' ? en.sharedConnections.oauthCancelled : en.sharedConnections.oauthFailed);
        assert.equal(within(dialog).queryByText(en.sharedConnections.connected), null); assert.equal(oauthWrites().length, 0); assert.equal(redirects, 0);
      }
      console.log('PASS MCP fresh status plus cancelled/failed feedback: query marker grants no connected assertion or automatic retry.');
      await assertMcpStatusMatrix();
      for (const returnedRef of [refs.wrong, refs.missing]) {
        await mountReturn(returnedRef, 'connected');
        await waitFor(() => assert(receipts.some(value => value.path === `/api/integrations/shared-connections/${returnedRef}`)));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        assert.equal(screen.queryByTestId('shared-connection-edit-dialog'), null); assert.equal(receipts.some(value => value.path.startsWith('/api/mcp/') || value.path.startsWith('/api/composio/')), false);
        assert.equal(oauthWrites().length, 0); assert.equal(redirects, 0);
        console.log('PASS unavailable/ownership-mismatched exact return: no fallback editor, status probe, OAuth or redirect.');
      }
      for (const outcome of ['url', 'error', 'aba'] as const) {
        await mountReturn(); current = await beginConnect(); oauthError = outcome === 'error';
        oauthGate = new Promise(resolve => { heldOAuth = { release: resolve, started: false }; }); fireEvent.click(current.button);
        await waitFor(() => assert.equal(heldOAuth?.started, true)); await act(async () => seedIdentity('actor-b'));
        await waitFor(() => assert(screen.queryByRole('button', { name: /actor-b mcp/u }))); assertNoStaleState();
        if (outcome === 'aba') { await act(async () => seedIdentity('actor-a')); await waitFor(() => assert(screen.queryByRole('button', { name: /actor-a mcp/u }))); }
        await settleHeld('oauth'); assert.equal(redirects, 0); assert.equal(document.body.textContent?.includes('PRIVATE_OLD_ACTOR_ACK'), false);
        assert.equal(screen.queryByTestId('shared-connection-edit-dialog'), null); assert.equal(confirmPluginNavigation(), true); assert.equal(prompts, 0);
        oauthError = false; console.log(`PASS actual identity ${outcome}: old actor ACK/error cannot redirect, reopen or pollute current clean session.`);
      }
      listGate = new Promise(resolve => { heldList = { release: resolve, started: false }; }); await mountReturn(undefined, undefined, false);
      await waitFor(() => assert.equal(heldList?.started, true)); await act(async () => seedIdentity('actor-b'));
      await waitFor(() => assert(screen.queryByRole('button', { name: /actor-b mcp/u }))); await settleHeld('list'); assertNoStaleState();
      for (const state of ['pending', 'anonymous'] as const) {
        await act(async () => seedIdentity(state === 'pending' ? 'actor-b' : null, state === 'pending'));
        assert.equal(screen.queryAllByTestId('shared-connection-row').length, 0); assert.equal(screen.queryByTestId('shared-connection-edit-dialog'), null);
        assert.equal(screen.queryByTestId('shared-connection-create'), null); assert.equal(confirmPluginNavigation(), true);
      }
      console.log('PASS held list + pending/anonymous identity: no old private rows/editor/create controls. Controlled UI identity/HTTP only; no backend OAuth or native browser claim.');
      const { readPluginNavigation, updatePluginNavigation } = await import('../app/lib/plugins/plugin-navigation');
      const query = new URLSearchParams({ view: 'advanced', scope: 'organization', workspaceId: 'fixture-workspace', connectionRef: refs.mcp, sharedOAuth: 'connected' });
      for (const scope of ['organization', 'team'] as const) {
        const params = new URLSearchParams(query); params.set('scope', scope); if (scope === 'team') params.set('teamId', 'fixture-team');
        const navigation = readPluginNavigation(params); assert.equal(navigation.connectionRef, refs.mcp); assert.equal(navigation.sharedOAuth, 'connected');
        const rebuilt = new URL(updatePluginNavigation(params.toString(), {}), window.location.origin);
        assert.equal(rebuilt.searchParams.get('connectionRef'), refs.mcp); assert.equal(rebuilt.searchParams.get('workspaceId'), 'fixture-workspace');
      }
      for (const patch of [{ scope: 'user' }, { scope: 'all' }, { scope: 'system' }, { view: 'installed' }, { area: 'skills' }, { workspaceId: '' },
        { scope: 'team' }, { connectionRef: 'canvas-connection:wrong' }]) {
        const params = new URLSearchParams(query); for (const [key, value] of Object.entries(patch)) params.set(key, value);
        const navigation = readPluginNavigation(params); assert.equal(navigation.connectionRef, undefined); assert.equal(navigation.sharedOAuth, undefined);
      }
      for (const patch of [{ view: 'installed' as const }, { scope: 'user' as const }, { workspaceId: 'different-workspace' }]) {
        const changed = readPluginNavigation(new URL(updatePluginNavigation(query.toString(), patch), window.location.origin).searchParams);
        assert.equal(changed.connectionRef, undefined); assert.equal(changed.sharedOAuth, undefined);
      }
      console.log('PASS actual navigation parser: canonical return only plugins/advanced/Org or Team with explicit workspace; context changes discard return selection.');
    }
  } finally {
    heldSlot('list')?.release(); heldSlot('oauth')?.release(); cleanup(); sessionAtom.set(originalSession); observeNavigation = undefined;
    loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
