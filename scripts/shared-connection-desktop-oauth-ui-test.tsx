import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { IntegrationConnectionDescriptor, SharedIntegrationConnectionOwnership } from '../app/lib/integration-tools/connections/contracts';

let redirects = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { if (error.message.includes('navigation')) redirects += 1; else throw error; });
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins?view=advanced&scope=organization', pretendToBeVisual: true, virtualConsole });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLBodyElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
  'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
Object.defineProperty(globalThis, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
Object.defineProperty(dom.window, 'PointerEvent', { value: dom.window.MouseEvent, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });

/** Actual Parent/Forms/Auth atom/Intl/Radix/Guard. HTTP and IPC are controlled transport, not server-authority evidence. */
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation'
    ? { Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) }
    : originalLoad(name, parent, isMain);
  const { render, screen, fireEvent, waitFor, cleanup, act, within } = await import('@testing-library/react');
  const { PluginNavigationGuard, confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const refs = { a: 'canvas-connection:11111111-1111-4111-8111-111111111111', b: 'canvas-connection:22222222-2222-4222-8222-222222222222' };
  type Receipt = { actor: string | null; path: string; method: string; workspace: string | null; query: string; body: Record<string, unknown> | null };
  const receipts: Receipt[] = [], transportErrors: unknown[] = [], bridgeRequests: unknown[] = [];
  let actor: string | null = 'actor-a', sessionId = 'session-a', workspaceId = 'workspace-a', selectedRef = refs.a, locale: 'en' | 'de' = 'en';
  let ownership: SharedIntegrationConnectionOwnership = { type: 'organization', organizationId: 'fixture-org' };
  let statusData: unknown = { configured: false, requiresAuth: false, authorized: false, authStatus: 'unavailable', code: 'unavailable' };
  let prompts = 0, bindingRevision = 7;
  let override: ((receipt: Receipt, url: URL) => Promise<Response | undefined>) | null = null;
  let expiresAt = new Date(Date.now() + 300_000).toISOString();
  const state = 'desktop_abcdefghijklmnopqrstuvwxyzABCDEF', authorizationUrl = 'https://login.fixture.invalid/authorize?client_id=public-client';
  const uiSession = (userId: string, id: string) => ({ user: { id: userId, name: userId, email: `${userId}@fixture.invalid`, emailVerified: true,
    createdAt: new Date(0), updatedAt: new Date(0), role: 'admin', banned: false }, session: { id, token: 'CONTROLLED_UI_IDENTITY_ONLY', userId,
    expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } });
  const descriptor = (): IntegrationConnectionDescriptor => ({ resource: { connectionRef: selectedRef, source: 'mcp', ownership,
    displayName: `${actor} MCP`, description: 'Saved shared description', application: null, responsibleUserId: null,
    createdByUserId: actor, updatedByUserId: actor, metadataRevision: 3, grantsRevision: 5, bindingRevision,
    allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
    access: { canRead: true, canUse: false, canManage: true }, grants: [] });
  window.confirm = () => { prompts += 1; return true; };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    if (path === '/api/auth/get-session') return Response.json(actor ? uiSession(actor, sessionId) : null);
    const receipt: Receipt = { actor, path, method, workspace: new Headers(init?.headers).get('x-canvas-workspace-id'), query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    receipts.push(receipt);
    try {
      assert.equal(receipt.workspace, workspaceId);
      const replacement = await override?.(receipt, url); if (replacement) return replacement;
      if (path === '/api/integrations/shared-connections') return Response.json({ success: true, data: { connections: [descriptor()] } });
      if (path === '/api/integrations/shared-connections/setup') return Response.json({ success: true, data: { scopes: [{ ownership, label: 'Own shared scope' }] } });
      if (path.endsWith('/targets')) return Response.json({ success: true, data: { targets: { users: [], workspaces: [], projects: [], agents: [] } } });
      if (path === `/api/integrations/shared-connections/${selectedRef}`) return Response.json({ success: true, data: { connection: descriptor() } });
      if (path === `/api/mcp/shared-connections/${selectedRef}/oauth` && method === 'POST') return Response.json({ success: true, data: { connectionRef: selectedRef, desktop: true, state, expiresAt, authorizationUrl } });
      if (path === `/api/mcp/shared-connections/${selectedRef}/oauth` && method === 'GET') return Response.json({ success: true, data: statusData });
      throw new Error(`Unexpected controlled UI request ${method} ${path}`);
    } catch (error) { transportErrors.push(error); throw error; }
  };
  // Auth-client transport must be installed before the real client/component imports.
  const { authClient } = await import('../app/lib/auth-client'), sessionAtom = authClient.$store.atoms.session, originalSession = sessionAtom.get();
  const { SharedConnectionsSection } = await import('../app/components/plugins/SharedConnectionsSection');
  function seedIdentity(userId: string | null, id = sessionId) {
    actor = userId; sessionId = id;
    sessionAtom.set({ ...sessionAtom.get(), data: userId ? uiSession(userId, id) : null, error: null, isPending: false, isRefetching: false });
  }
  async function mountSharedEditor() {
    assert.equal(transportErrors.length, 0, 'No uncontrolled transport errors in the preceding case.'); cleanup(); override = null; bindingRevision = 7; expiresAt = new Date(Date.now() + 300_000).toISOString(); receipts.length = 0; transportErrors.length = 0; bridgeRequests.length = 0; prompts = 0; redirects = 0; seedIdentity(actor, sessionId);
    const view = render(<NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
      <PluginNavigationGuard unsavedChangesMessage={(locale === 'en' ? en : de).skills.drafts.unsavedNavigation} />
      <SharedConnectionsSection workspaceId={workspaceId} ownership={ownership} initiallyOpen initialConnectionRef={selectedRef} />
    </NextIntlClientProvider>);
    const dialog = await screen.findByTestId('shared-connection-edit-dialog');
    await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
    const button = within(dialog).getByRole('button', { name: (locale === 'en' ? en : de).sharedConnections.connect, hidden: true });
    const details = button.closest('details'); assert(details); details.open = true;
    return { view, dialog, button };
  }
  function holdResponse() {
    let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release };
  }
  function assertScopedMutation(receipt: Receipt, body: Record<string, unknown>) {
    assert.equal(receipt.workspace, workspaceId); assert.equal(receipt.actor, actor); assert.equal(new URLSearchParams(receipt.query).get('workspaceId'), workspaceId); assert.deepEqual(receipt.body, body);
    assert(!receipt.path.includes('/api/integrations/mcp-status')); assert(!receipt.path.startsWith('/api/mcp/oauth/desktop'));
  }
  function assertNoSensitiveDisplay() { assert.doesNotMatch(document.body.textContent ?? '', /PRIVATE_|codeVerifier|authSessionId|backendConnectionId/u); }
  async function assertManualMcpStatus() {
    const { dialog } = await mountSharedEditor();
    fireEvent.click(within(dialog).getByRole('button', { name: en.sharedConnections.checkStatus, hidden: true }));
    await waitFor(() => assert(within(dialog).queryByText(en.sharedConnections.connected) || within(dialog).queryByText(en.sharedConnections.connectionRequired)));
    const connected = Boolean(within(dialog).queryByText(en.sharedConnections.connected));
    console.log(`Manual unavailable MCP status observed: Connected=${connected}; writes=${receipts.filter(receipt => receipt.method !== 'GET').length}; redirects=${redirects}.`);
    assert.equal(connected, false, 'Manual status must not infer Connected from an unavailable backend with requiresAuth=false.');
    assert.equal(receipts.filter(receipt => receipt.method !== 'GET').length, 0); assert.equal(redirects, 0); assertNoSensitiveDisplay();
  }
  function desktopSummary(status: 'waiting' | 'callback_received' | 'completed' | 'cancelled' | 'expired' | 'failed') {
    return { connectionRef: selectedRef, state, expiresAt, status, ...(status === 'waiting' ? { authorizationUrl } : {}) };
  }
  function beforeUnloadPrevented() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
  function setDesktopBridge(version = 1, open = true, behavior: (request: unknown) => Promise<{ ok: boolean }> = async () => { assert.equal(beforeUnloadPrevented(), true, 'Live flow guard is installed synchronously before IPC.'); return { ok: true }; }) {
    Object.defineProperty(window, 'canvasDesktop', { configurable: true, value: { sharedMcpOAuthVersion: version,
      ...(open ? { openMcpOAuth: async (request: unknown) => { bridgeRequests.push(request); return behavior(request); } } : {}) } });
  }
  function assertDesktopWrites(count: number) {
    assert.equal(receipts.filter(receipt => receipt.method !== 'GET').length, count);
    for (const receipt of receipts.filter(receipt => receipt.method !== 'GET')) {
      assert(receipt.path.startsWith('/api/mcp/shared-connections/')); assert(!receipt.path.includes('/api/mcp/oauth/desktop'));
      assert.equal(new URLSearchParams(receipt.query).get('workspaceId'), receipt.workspace);
      assert(!JSON.stringify(receipt.body).includes('authSessionId')); assert(!JSON.stringify(receipt.body).includes('backendConnectionId'));
    }
  }
  try {
    await assertManualMcpStatus();
    for (const [data, connected] of [
      [{ configured: true, requiresAuth: false, authorized: false, code: null }, true],
      [{ configured: true, requiresAuth: true, authorized: true }, true],
      [{ configured: true, requiresAuth: true, authorized: false, status: { connected: true } }, false],
      [{ configured: true, requiresAuth: false, code: 'unavailable' }, false],
    ] as const) {
      statusData = data; const { dialog } = await mountSharedEditor();
      fireEvent.click(within(dialog).getByRole('button', { name: en.sharedConnections.checkStatus, hidden: true }));
      await waitFor(() => assert(within(dialog).queryByText(en.sharedConnections[connected ? 'connected' : 'connectionRequired'])));
      assert.equal(receipts.filter(receipt => receipt.method !== 'GET').length, 0);
    }
    console.log('PASS manual MCP status uses exact configured/auth/code evidence.');

    for (const variant of ['old', 'missing'] as const) {
      const { button } = await mountSharedEditor(); setDesktopBridge(variant === 'old' ? 0 : 1, variant !== 'missing');
      fireEvent.click(button); await screen.findByText(en.sharedConnections.desktopUpdateRequired);
      assertDesktopWrites(0); assert.equal(bridgeRequests.length, 0); assert.equal(beforeUnloadPrevented(), false); assert.equal(redirects, 0);
    }
    console.log('PASS unsupported desktop preload sends zero API/IPC starts.');

    for (const scope of ['organization', 'team'] as const) {
      ownership = scope === 'team' ? { type: 'team', organizationId: 'fixture-org', workspaceId: 'fixture-team' } : { type: 'organization', organizationId: 'fixture-org' };
      locale = scope === 'team' ? 'de' : 'en'; statusData = { configured: true, requiresAuth: true, authorized: true };
      const { dialog, button } = await mountSharedEditor(); setDesktopBridge();
      override = async receipt => {
        if (receipt.path.endsWith('/oauth/desktop')) {
          if (receipt.method === 'GET') return Response.json({ success: true, data: desktopSummary('callback_received') });
          assert.deepEqual(receipt.body, { state, action: 'finalize' }); bindingRevision = 8;
          return Response.json({ success: true, data: desktopSummary('completed') });
        }
      };
      fireEvent.click(button); await waitFor(() => assert(within(dialog).queryByText((locale === 'en' ? en : de).sharedConnections.connected)));
      assertDesktopWrites(2); assertScopedMutation(receipts.find(receipt => receipt.method === 'POST')!, {
        expectedMetadataRevision: 3, expectedGrantsRevision: 5, expectedBindingRevision: 7, desktop: true, returnLocale: locale,
      });
      assert.deepEqual(bridgeRequests, [{ state, authorizationUrl, target: { kind: 'shared', connectionRef: selectedRef, workspaceId } }]);
      assert.equal(receipts.filter(receipt => receipt.path.endsWith('/oauth/desktop') && receipt.body?.action === 'finalize').length, 1);
      assert.equal(beforeUnloadPrevented(), false); assert.equal(confirmPluginNavigation(), true); assert.equal(redirects, 0); assertNoSensitiveDisplay();
    }
    locale = 'en'; ownership = { type: 'organization', organizationId: 'fixture-org' };
    console.log('PASS Org/Team locale exact start/finalize and fresh completion status; no renderer redirect.');

    for (const boundary of ['http', 'json'] as const) {
      const { dialog, button } = await mountSharedEditor(); const held = holdResponse(), polling = holdResponse(); setDesktopBridge();
      const captured = { connectionRef: selectedRef, desktop: true, state, expiresAt, authorizationUrl };
      override = async receipt => {
        if (receipt.path.endsWith('/oauth') && receipt.method === 'POST') {
          if (boundary === 'http') await held.promise;
          const response = Response.json({ success: true, data: captured });
          if (boundary === 'json') { const json = response.json.bind(response); Object.defineProperty(response, 'json', { value: async () => { await held.promise; return json(); } }); }
          return response;
        }
        if (receipt.path.endsWith('/oauth/desktop')) {
          if (receipt.method === 'GET') { await polling.promise; return Response.json({ success: true, data: desktopSummary('callback_received') }); }
          assert.deepEqual(receipt.body, { state, action: 'cancel' }); return Response.json({ success: true, data: desktopSummary('cancelled') });
        }
      };
      fireEvent.click(button); await waitFor(() => assertDesktopWrites(1));
      assert.equal(beforeUnloadPrevented(), true); assert.equal(confirmPluginNavigation(), false);
      fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(within(dialog).getByRole('button', { name: 'Close', hidden: true }));
      fireEvent.click(button); assertDesktopWrites(1); assert(document.body.contains(dialog)); assert.equal(prompts, 0);
      await act(async () => held.release()); await screen.findByTestId('shared-desktop-cancel');
      await waitFor(() => assert.equal(receipts.filter(receipt => receipt.path.endsWith('/oauth/desktop') && receipt.method === 'GET').length, 1));
      assert.equal(beforeUnloadPrevented(), true, 'Valid start ACK must synchronously keep navigation blocked before and after system-browser open.');
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.oauthCancelled);
      await act(async () => polling.release()); assertDesktopWrites(2); assert.equal(beforeUnloadPrevented(), false);
      assert.equal(receipts.filter(receipt => receipt.body?.action === 'finalize').length, 0); assert.equal(redirects, 0);
    }
    console.log('PASS held HTTP/JSON start ACK pending and explicit cancel suppresses late callback/finalize.');

    // Unconfirmed finalize is never automatically retried; explicit check recovers the same issued flow.
    {
      statusData = { configured: true, requiresAuth: false, authorized: false, code: null };
      const { dialog, button } = await mountSharedEditor(); setDesktopBridge(); let finalized = false;
      override = async receipt => {
        if (!receipt.path.endsWith('/oauth/desktop')) return;
        if (receipt.method === 'GET') return Response.json({ success: true, data: desktopSummary(finalized ? 'completed' : 'callback_received') });
        assert.equal(receipt.body?.action, 'finalize'); finalized = true;
        return Response.json({ success: false, code: 'provider_unavailable', error: 'PRIVATE_ACK_LOSS' }, { status: 503 });
      };
      fireEvent.click(button); await screen.findByText(en.sharedConnections.desktopUnconfirmed);
      assert.equal(beforeUnloadPrevented(), true); assertDesktopWrites(2); assert.equal(within(dialog).queryByText(en.sharedConnections.connected), null);
      fireEvent.click(screen.getByTestId('shared-desktop-resume')); await screen.findByText(en.sharedConnections.connected);
      assertDesktopWrites(2); assert.equal(beforeUnloadPrevented(), false); assert.equal(redirects, 0); assertNoSensitiveDisplay();
    }
    console.log('PASS ambiguous finalize ACK keeps flow; explicit status recovery uses zero duplicate mutations.');

    // Cancel may observe a concurrently committed finalization; it must display current readiness and keep the original HTTP-write fence until ACK.
    {
      statusData = { configured: true, requiresAuth: true, authorized: true };
      const { button } = await mountSharedEditor(); setDesktopBridge(); const held = holdResponse();
      override = async receipt => {
        if (!receipt.path.endsWith('/oauth/desktop')) return;
        if (receipt.method === 'GET') return Response.json({ success: true, data: desktopSummary('callback_received') });
        if (receipt.body?.action === 'finalize') await held.promise;
        else assert.equal(receipt.body?.action, 'cancel');
        bindingRevision = 8; return Response.json({ success: true, data: desktopSummary('completed') });
      };
      fireEvent.click(button); await waitFor(() => assert(receipts.some(receipt => receipt.body?.action === 'finalize')));
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.connected);
      assert.equal(screen.queryByText(en.sharedConnections.oauthCancelled), null); assert.equal(screen.queryByTestId('shared-desktop-cancel'), null);
      assert.equal(beforeUnloadPrevented(), true, 'Original in-flight finalize HTTP remains protected until its ACK settles.');
      await act(async () => held.release()); await waitFor(() => assert.equal(beforeUnloadPrevented(), false)); assertDesktopWrites(3);
    }
    console.log('PASS cancel/completed overlap preserves original mutation fence and fresh Connected truth.');

    for (const code of [403, 409, 503] as const) {
      const { button } = await mountSharedEditor(); setDesktopBridge();
      override = async receipt => receipt.path.endsWith('/oauth/desktop')
        ? Response.json({ success: false, code: 'binding_changed', error: 'PRIVATE_PROVIDER_BODY' }, { status: code }) : undefined;
      fireEvent.click(button); await screen.findByText(en.sharedConnections[code === 409 ? 'conflict' : code === 503 ? 'desktopUnconfirmed' : 'oauthFailed']);
      assertDesktopWrites(1); assert.equal(beforeUnloadPrevented(), code === 503); assertNoSensitiveDisplay();
      if (code === 503) {
        override = async receipt => receipt.path.endsWith('/oauth/desktop') ? Response.json({ success: true, data: desktopSummary('cancelled') }) : undefined;
        fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.oauthCancelled); assert.equal(beforeUnloadPrevented(), false);
      } else assert.equal(screen.queryByTestId('shared-desktop-cancel'), null);
    }
    console.log('PASS current denied/CAS vs unavailable failures preserve truthful recovery boundaries.');

    for (const succeeds of [true, false] as const) {
      const { button } = await mountSharedEditor(); setDesktopBridge(1, true, async () => ({ ok: false }));
      override = async receipt => receipt.path.endsWith('/oauth/desktop') ? succeeds
        ? Response.json({ success: true, data: desktopSummary('cancelled') })
        : Response.json({ success: false, code: 'provider_unavailable' }, { status: 503 }) : undefined;
      fireEvent.click(button); await screen.findByText(en.sharedConnections[succeeds ? 'oauthCancelled' : 'desktopUnconfirmed']);
      assertDesktopWrites(2); assert.equal(beforeUnloadPrevented(), !succeeds); assert.equal(redirects, 0);
      if (!succeeds) {
        override = async receipt => receipt.path.endsWith('/oauth/desktop') ? Response.json({ success: true, data: desktopSummary('completed') }) : undefined;
        statusData = { configured: false, requiresAuth: false, authorized: false, code: 'unavailable' };
        fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.connectionRequired);
        assert.equal(screen.queryByText(en.sharedConnections.oauthCancelled), null); assert.equal(beforeUnloadPrevented(), false);
      }
    }
    console.log('PASS failed opener cancellation ACK/unconfirmed and completed cancel use current truth.');

    for (const change of ['actor', 'session', 'workspace', 'ref', 'aba'] as const) {
      actor = 'actor-a'; sessionId = 'session-a'; workspaceId = 'workspace-a'; selectedRef = refs.a;
      const { view, button } = await mountSharedEditor(); setDesktopBridge(); const held = holdResponse();
      const old = { connectionRef: selectedRef, desktop: true, state, expiresAt, authorizationUrl };
      override = async receipt => { if (receipt.path.endsWith('/oauth') && receipt.method === 'POST') { await held.promise; return Response.json({ success: true, data: old }); } };
      fireEvent.click(button); await waitFor(() => assertDesktopWrites(1));
      await act(async () => {
        if (change === 'actor' || change === 'aba') seedIdentity('actor-b', 'session-b');
        if (change === 'session') seedIdentity('actor-a', 'session-replacement');
        if (change === 'workspace') workspaceId = 'workspace-b';
        if (change === 'ref') selectedRef = refs.b;
        view.rerender(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PluginNavigationGuard unsavedChangesMessage={en.skills.drafts.unsavedNavigation} />
          <SharedConnectionsSection workspaceId={workspaceId} ownership={ownership} initiallyOpen initialConnectionRef={selectedRef} /></NextIntlClientProvider>);
      });
      await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
      if (change === 'aba') { await act(async () => seedIdentity('actor-a', 'session-a')); await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false)); }
      await act(async () => held.release()); assert.equal(bridgeRequests.length, 0); assertDesktopWrites(1);
      assert.equal(screen.queryByTestId('shared-desktop-cancel'), null); assert.equal(beforeUnloadPrevented(), false); assert.equal(redirects, 0);
    }
    actor = 'actor-a'; sessionId = 'session-a'; workspaceId = 'workspace-a'; selectedRef = refs.a;
    console.log('PASS actual session/ref/workspace/ABA replacement ignores late start ACK without old IPC/finalize/cancel.');

    for (const boundary of ['ipc', 'poll', 'finalize', 'cancel'] as const) {
      actor = 'actor-a'; sessionId = 'session-a'; workspaceId = 'workspace-a'; selectedRef = refs.a;
      const { view, button } = await mountSharedEditor(); const held = holdResponse();
      const captured = desktopSummary(boundary === 'poll' ? 'callback_received' : boundary === 'cancel' ? 'cancelled' : 'completed');
      setDesktopBridge(1, true, boundary === 'ipc' ? async () => { assert.equal(beforeUnloadPrevented(), true); await held.promise; return { ok: true }; } : undefined);
      override = async receipt => {
        if (!receipt.path.endsWith('/oauth/desktop')) return;
        if (receipt.method === 'GET') {
          if (boundary === 'poll' || boundary === 'cancel') { await held.promise; return Response.json({ success: true, data: captured }); }
          return Response.json({ success: true, data: desktopSummary('callback_received') });
        }
        await held.promise; return Response.json({ success: true, data: captured });
      };
      fireEvent.click(button); await screen.findByTestId('shared-desktop-cancel');
      if (boundary === 'poll' || boundary === 'cancel') await waitFor(() => assert(receipts.some(receipt => receipt.path.endsWith('/oauth/desktop') && receipt.method === 'GET')));
      if (boundary === 'finalize') await waitFor(() => assert(receipts.some(receipt => receipt.body?.action === 'finalize')));
      if (boundary === 'cancel') { fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await waitFor(() => assert(receipts.some(receipt => receipt.body?.action === 'cancel'))); }
      const expectedWrites = boundary === 'finalize' || boundary === 'cancel' ? 2 : 1;
      await act(async () => seedIdentity('actor-b', 'session-b'));
      await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
      // Actual atom-driven keyed Parent remount; no private state or callbacks are invoked.
      assert(view.container.textContent?.includes('actor-b MCP')); await act(async () => held.release());
      assertDesktopWrites(expectedWrites); assert.equal(receipts.filter(receipt => receipt.method !== 'GET' && receipt.actor !== 'actor-a').length, 0);
      assert.equal(screen.queryByTestId('shared-desktop-cancel'), null); assert.equal(screen.queryByText(en.sharedConnections.connected), null);
      assert.equal(screen.queryByText(en.sharedConnections.oauthCancelled), null); assert.equal(beforeUnloadPrevented(), false); assert.equal(redirects, 0);
      if (boundary === 'ipc') assert.equal(receipts.filter(receipt => receipt.path.endsWith('/oauth/desktop')).length, 0);
      if (boundary === 'poll') assert.equal(receipts.filter(receipt => receipt.body?.action === 'finalize').length, 0);
    }
    actor = 'actor-a'; sessionId = 'session-a';
    console.log('PASS late IPC/poll/finalize/cancel ACK cannot act or hydrate under a replacement actual session.');

    for (const invalid of ['ref', 'state', 'deadline'] as const) {
      const { button } = await mountSharedEditor(); setDesktopBridge();
      override = async receipt => receipt.method === 'POST' ? Response.json({ success: true, data: {
        connectionRef: invalid === 'ref' ? refs.b : selectedRef, desktop: true, state: invalid === 'state' ? 'invalid' : state,
        expiresAt: invalid === 'deadline' ? new Date(0).toISOString() : expiresAt, authorizationUrl,
      } }) : undefined;
      fireEvent.click(button); await screen.findByText(en.sharedConnections.oauthFailed);
      assertDesktopWrites(1); assert.equal(bridgeRequests.length, 0); assert.equal(beforeUnloadPrevented(), false);
    }
    console.log('PASS invalid exact-ref/state/expiry start ACK never reaches the system-browser bridge.');

    {
      const { button } = await mountSharedEditor(); setDesktopBridge();
      const name = document.getElementById('shared-edit-name'); assert(name);
      fireEvent.change(name, { target: { value: 'Retained dirty name' } }); fireEvent.click(button);
      await screen.findByText(en.sharedConnections.saveBeforeConnect); assertDesktopWrites(0); assert.equal(bridgeRequests.length, 0);
      assert.equal((name as HTMLInputElement).value, 'Retained dirty name'); assert.equal(prompts, 0);
    }
    assert.equal(transportErrors.length, 0); assertNoSensitiveDisplay();
    console.log('PASS actual SharedConnection desktop UI matrix (controlled HTTP/IPC only; no server/provider/Electron acceptance).');
  } finally { cleanup(); sessionAtom.set(originalSession); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
