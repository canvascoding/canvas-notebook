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
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });

/** Actual Parent/Forms/Auth atom/Intl/Radix/Guard + client. Controlled HTTP/IPC are not provider or server-authority evidence. */
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
  const receipts: Receipt[] = [], transportErrors: unknown[] = [], bridgeRequests: unknown[] = [], barrierReleases: Array<() => void> = [];
  let actor: string | null = 'actor-a', sessionId = 'session-a', workspaceId = 'workspace-a', selectedRef = refs.a, locale: 'en' | 'de' = 'en';
  let ownership: SharedIntegrationConnectionOwnership = { type: 'organization', organizationId: 'fixture-org' };
  const statusData: unknown = { status: { connected: true } };
  let prompts = 0, bindingRevision = 7;
  let override: ((receipt: Receipt, url: URL) => Promise<Response | undefined>) | null = null;
  let expiresAt = new Date(Date.now() + 300_000).toISOString();
  const state = 'A'.repeat(43), authorizationUrl = 'https://login.fixture.invalid/authorize?client_id=public-client';
  function composioDesktopUiSession(userId: string, id: string) {
    return { user: { id: userId, name: userId, email: `${userId}@fixture.invalid`, emailVerified: true,
      createdAt: new Date(0), updatedAt: new Date(0), role: 'admin', banned: false }, session: { id, token: 'CONTROLLED_UI_IDENTITY_ONLY', userId,
      expiresAt: new Date('2099-01-01'), createdAt: new Date(0), updatedAt: new Date(0) } };
  }
  function composioDesktopDescriptor(): IntegrationConnectionDescriptor {
    return { resource: { connectionRef: selectedRef, source: 'composio', ownership, displayName: `${actor} Composio`,
      description: 'Saved shared description', application: 'canva', responsibleUserId: null, createdByUserId: actor, updatedByUserId: actor,
      metadataRevision: 3, grantsRevision: 5, bindingRevision, allowedToolNames: null, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
    access: { canRead: true, canUse: false, canManage: true }, grants: [] };
  }
  window.confirm = () => { prompts += 1; return true; };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    if (path === '/api/auth/get-session') return Response.json(actor ? composioDesktopUiSession(actor, sessionId) : null);
    const receipt: Receipt = { actor, path, method, workspace: new Headers(init?.headers).get('x-canvas-workspace-id'), query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    receipts.push(receipt);
    assert.equal(receipt.workspace, workspaceId);
    const replacement = await override?.(receipt, url); if (replacement) return replacement;
    try {
      if (path === '/api/integrations/shared-connections') return Response.json({ success: true, data: { connections: [composioDesktopDescriptor()] } });
      if (path === '/api/integrations/shared-connections/setup') return Response.json({ success: true, data: { scopes: [{ ownership, label: 'Own shared scope' }] } });
      if (path.endsWith('/targets')) return Response.json({ success: true, data: { targets: { users: [], workspaces: [], projects: [], agents: [] } } });
      if (path === `/api/integrations/shared-connections/${selectedRef}`) return Response.json({ success: true, data: { connection: composioDesktopDescriptor() } });
      if (path === `/api/composio/shared-connections/${selectedRef}/connect` && method === 'POST') return Response.json({ success: true, data: composioDesktopSummary('waiting') });
      if (path === `/api/composio/shared-connections/${selectedRef}/status` && method === 'GET') return Response.json({ success: true, data: statusData });
      throw new Error(`Unexpected controlled UI request ${method} ${path}`);
    } catch (error) { transportErrors.push(error); throw error; }
  };
  const { authClient } = await import('../app/lib/auth-client'), sessionAtom = authClient.$store.atoms.session, originalSession = sessionAtom.get();
  const { SharedConnectionsSection } = await import('../app/components/plugins/SharedConnectionsSection');
  function seedComposioDesktopIdentity(userId: string | null, id = sessionId) {
    actor = userId; sessionId = id;
    sessionAtom.set({ ...sessionAtom.get(), data: userId ? composioDesktopUiSession(userId, id) : null, error: null, isPending: false, isRefetching: false });
  }
  async function mountComposioDesktopEditor() {
    assert.equal(transportErrors.length, 0, 'No uncontrolled transport in the preceding case.');
    cleanup(); override = null; bindingRevision = 7; expiresAt = new Date(Date.now() + 300_000).toISOString();
    receipts.length = 0; transportErrors.length = 0; bridgeRequests.length = 0; prompts = 0; redirects = 0;
    seedComposioDesktopIdentity(actor, sessionId);
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
  function holdComposioDesktopResponse() {
    let release!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Controlled response barrier timed out.')), 20_000);
      release = () => { clearTimeout(timer); resolve(); };
    });
    barrierReleases.push(release); return { promise, release };
  }
  function assertComposioDesktopMutation(receipt: Receipt, body: Record<string, unknown>) {
    assert.equal(receipt.workspace, workspaceId); assert.equal(receipt.actor, actor);
    assert.equal(new URLSearchParams(receipt.query).get('workspaceId'), workspaceId); assert.deepEqual(receipt.body, body);
    assert(receipt.path.startsWith('/api/composio/shared-connections/')); assert(!receipt.path.includes('/api/composio/profiles'));
  }
  function assertComposioDesktopDisplay() { assert.doesNotMatch(document.body.textContent ?? '', /PRIVATE_|authSessionId|connectedAccountId|profileId|credentialRevision/u); }
  function composioDesktopSummary(status: 'starting' | 'waiting' | 'callback_received' | 'completed' | 'cancelled' | 'expired' | 'failed') {
    const codes = { starting: 'CONNECTION_DESKTOP_OAUTH_START_UNCONFIRMED', cancelled: 'CONNECTION_DESKTOP_OAUTH_CANCELLED',
      expired: 'CONNECTION_DESKTOP_OAUTH_EXPIRED', failed: 'CONNECTION_DESKTOP_OAUTH_FAILED' };
    const errors = { starting: 'Shared sign-in start is unconfirmed. Reload and check this sign-in.', cancelled: 'Shared sign-in was cancelled.',
      expired: 'Shared sign-in expired. Start again.', failed: 'Shared sign-in could not be completed. Reload and start again.' };
    return { connectionRef: selectedRef, state, expiresAt, status, ...(status === 'waiting' ? { authorizationUrl } : {}),
      ...(status in codes ? { code: codes[status as keyof typeof codes], error: errors[status as keyof typeof errors] } : {}) };
  }
  function composioDesktopBeforeUnloadPrevented() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
  function setComposioDesktopBridge(version = 1, open = true, behavior: (request: unknown) => Promise<{ ok: boolean }> = async () => {
    assert.equal(composioDesktopBeforeUnloadPrevented(), true, 'The issued attempt blocks navigation before IPC.'); return { ok: true };
  }) {
    Object.defineProperty(window, 'canvasDesktop', { configurable: true, value: { sharedComposioOAuthVersion: version,
      ...(open ? { openSharedComposioOAuth: async (request: unknown) => { bridgeRequests.push(request); return behavior(request); } } : {}) } });
  }
  function assertComposioDesktopWrites(count: number) {
    assert.equal(receipts.filter(receipt => receipt.method !== 'GET').length, count);
    for (const receipt of receipts.filter(receipt => receipt.method !== 'GET')) {
      assert(receipt.path.startsWith('/api/composio/shared-connections/')); assert.equal(new URLSearchParams(receipt.query).get('workspaceId'), receipt.workspace);
      assert.doesNotMatch(JSON.stringify(receipt.body), /authSessionId|connectedAccountId|profileId|credentialRevision|returnPath|returnLocale/u);
    }
  }
  try {
    for (const variant of ['old', 'missing'] as const) {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(variant === 'old' ? 0 : 1, variant !== 'missing');
      fireEvent.click(button); await screen.findByText(en.sharedConnections.desktopUpdateRequired);
      assertComposioDesktopWrites(0); assert.equal(bridgeRequests.length, 0); assert.equal(composioDesktopBeforeUnloadPrevented(), false); assert.equal(redirects, 0);
    }
    console.log('PASS unsupported Composio preload capability fails before HTTP/IPC.');

    for (const scope of ['organization', 'team'] as const) {
      ownership = scope === 'team' ? { type: 'team', organizationId: 'fixture-org', workspaceId: 'fixture-team' } : { type: 'organization', organizationId: 'fixture-org' };
      locale = scope === 'team' ? 'de' : 'en'; const labels = (locale === 'en' ? en : de).sharedConnections;
      const { dialog, button } = await mountComposioDesktopEditor(); setComposioDesktopBridge();
      override = async receipt => {
        if (!receipt.path.endsWith('/connect/desktop')) return;
        if (receipt.method === 'GET') return Response.json({ success: true, data: composioDesktopSummary('callback_received') });
        assert.deepEqual(receipt.body, { state, action: 'finalize' }); bindingRevision = 8;
        return Response.json({ success: true, data: composioDesktopSummary('completed') });
      };
      fireEvent.click(button); await waitFor(() => assert(within(dialog).queryByText(labels.connected)));
      assertComposioDesktopWrites(2); const start = receipts.find(receipt => receipt.method === 'POST')!;
      assert.match(String(start.body?.intent), /^[A-Za-z0-9_-]{43}$/u);
      assertComposioDesktopMutation(start, { expectedMetadataRevision: 3, expectedGrantsRevision: 5, expectedBindingRevision: 7, desktop: true, intent: start.body?.intent });
      assert.deepEqual(bridgeRequests, [{ state, authorizationUrl, expiresAt, target: { kind: 'shared', connectionRef: selectedRef, workspaceId } }]);
      assert.equal(composioDesktopBeforeUnloadPrevented(), false); assert.equal(confirmPluginNavigation(), true); assert.equal(redirects, 0); assertComposioDesktopDisplay();
    }
    locale = 'en'; ownership = { type: 'organization', organizationId: 'fixture-org' };
    console.log('PASS Org/Team exact start/finalize and fresh Connected truth, no renderer redirect.');

    {
      const { dialog, button } = await mountComposioDesktopEditor(); setComposioDesktopBridge();
      override = async receipt => {
        if (receipt.path.endsWith('/connect') && receipt.method === 'POST') { bindingRevision = 8; return Response.json({ success: true, data: { connectionRef: selectedRef, noAuth: true } }); }
      };
      fireEvent.click(button); await waitFor(() => assert(within(dialog).queryByText(en.sharedConnections.connected)));
      assertComposioDesktopWrites(1); assert.equal(bridgeRequests.length, 0); assert.equal(composioDesktopBeforeUnloadPrevented(), false); assert.equal(screen.queryByTestId('shared-desktop-cancel'), null);
    }
    console.log('PASS exact noAuth result performs no IPC and reloads real resource/provider status.');

    for (const boundary of ['http', 'json'] as const) {
      const { dialog, button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(); const held = holdComposioDesktopResponse();
      const captured = composioDesktopSummary('waiting');
      override = async receipt => {
        if (receipt.path.endsWith('/connect') && receipt.method === 'POST') {
          if (boundary === 'http') await held.promise;
          const response = Response.json({ success: true, data: captured });
          if (boundary === 'json') { const json = response.json.bind(response); Object.defineProperty(response, 'json', { value: async () => { await held.promise; return json(); } }); }
          return response;
        }
        if (receipt.path.endsWith('/connect/desktop')) {
          assert.equal(receipt.method, 'POST'); assert.match(String(receipt.body?.intent), /^[A-Za-z0-9_-]{43}$/u);
          assertComposioDesktopMutation(receipt, { intent: receipt.body?.intent, action: 'cancel', expectedMetadataRevision: 3, expectedGrantsRevision: 5, expectedBindingRevision: 7 });
          return Response.json({ success: true, data: composioDesktopSummary('cancelled') });
        }
      };
      fireEvent.click(button); await waitFor(() => assertComposioDesktopWrites(1));
      assert.equal(composioDesktopBeforeUnloadPrevented(), true); assert.equal(confirmPluginNavigation(), false);
      fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(within(dialog).getByRole('button', { name: 'Close', hidden: true }));
      assert(document.body.contains(dialog)); assert.equal(prompts, 0);
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.oauthCancelled);
      assert.equal(composioDesktopBeforeUnloadPrevented(), true, 'The original HTTP/JSON delivery still holds its parent write fence.');
      await act(async () => held.release()); await waitFor(() => assert.equal(composioDesktopBeforeUnloadPrevented(), false));
      assertComposioDesktopWrites(2); assert.equal(bridgeRequests.length, 0); assert.equal(redirects, 0);
    }
    console.log('PASS pre-ACK HTTP/JSON attempt fence and intent cancellation suppress late IPC.');

    {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(); let reads = 0;
      override = async receipt => {
        if (receipt.path.endsWith('/connect')) return Response.json({ success: false, code: 'provider_unavailable', error: 'PRIVATE_start_ACK_loss' }, { status: 503 });
        if (receipt.path.endsWith('/connect/desktop')) {
          if (receipt.method === 'GET') return ++reads === 1
            ? Response.json({ success: false, code: 'CONNECTION_DESKTOP_OAUTH_STATE_INVALID', error: 'PRIVATE_early404' }, { status: 404 })
            : Response.json({ success: true, data: composioDesktopSummary('starting') });
          return Response.json({ success: true, data: composioDesktopSummary('cancelled') });
        }
      };
      fireEvent.click(button); await screen.findByText(en.sharedConnections.desktopUnconfirmed);
      fireEvent.click(screen.getByTestId('shared-desktop-resume')); await waitFor(() => assert.equal(reads, 1));
      await waitFor(() => assert.equal((screen.getByTestId('shared-desktop-resume') as HTMLButtonElement).disabled, false));
      assert.equal(composioDesktopBeforeUnloadPrevented(), true); assert.equal(screen.queryByText(en.sharedConnections.oauthCancelled), null);
      fireEvent.click(screen.getByTestId('shared-desktop-resume')); await waitFor(() => assert.equal(reads, 2));
      await waitFor(() => assert.equal((screen.getByTestId('shared-desktop-resume') as HTMLButtonElement).disabled, false));
      assert.equal(composioDesktopBeforeUnloadPrevented(), true); assertComposioDesktopWrites(1); assert.equal(bridgeRequests.length, 0);
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.oauthCancelled); assertComposioDesktopWrites(2);
    }
    console.log('PASS start ACK loss, early404 and starting retain same intent/manual recovery without relink.');

    {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(1, true, async () => { throw new Error('PRIVATE_IPC_ACK_loss'); });
      override = async receipt => {
        if (!receipt.path.endsWith('/connect/desktop')) return;
        if (receipt.method === 'GET') return Response.json({ success: true, data: composioDesktopSummary('callback_received') });
        assert.equal(receipt.body?.action, 'finalize'); bindingRevision = 8; return Response.json({ success: true, data: composioDesktopSummary('completed') });
      };
      fireEvent.click(button); await screen.findByText(en.sharedConnections.desktopUnconfirmed);
      assertComposioDesktopWrites(1); assert.equal(bridgeRequests.length, 1); assert.equal(composioDesktopBeforeUnloadPrevented(), true);
      fireEvent.click(screen.getByTestId('shared-desktop-resume')); await screen.findByText(en.sharedConnections.connected);
      assertComposioDesktopWrites(2); assert.equal(bridgeRequests.length, 1); assert.equal(composioDesktopBeforeUnloadPrevented(), false);
    }
    console.log('PASS opener ACK loss does not auto-cancel; explicit callback recovery avoids another browser open.');

    for (const code of ['master_key_missing', 'decryption_failed', 'invalid_secret_format', 'mcp_credential_key_missing'] as const) {
      const { dialog, button } = await mountComposioDesktopEditor(); setComposioDesktopBridge();
      override = async receipt => receipt.path.endsWith('/connect')
        ? Response.json({ success: false, code, error: 'PRIVATE_credential_body' }, { status: 503 })
        : receipt.path.endsWith('/connect/desktop') ? Response.json({ success: true, data: composioDesktopSummary('cancelled') }) : undefined;
      fireEvent.click(button); await screen.findByText(en.sharedConnections.secretsRequired);
      const secrets = within(dialog).getByRole('link', { name: en.sharedConnections.openSecrets, hidden: true });
      assert.equal(secrets.getAttribute('href'), '/settings?tab=secrets'); assert.equal(secrets.getAttribute('target'), '_blank');
      assert.equal(secrets.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(composioDesktopBeforeUnloadPrevented(), true); assert.equal(bridgeRequests.length, 0); assertComposioDesktopDisplay();
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.oauthCancelled); assert.equal(composioDesktopBeforeUnloadPrevented(), false);
    }
    console.log('PASS safe readiness503 displays existing Secrets feedback/link while retaining attempt.');

    {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(); let finalized = false;
      override = async receipt => {
        if (!receipt.path.endsWith('/connect/desktop')) return;
        if (receipt.method === 'GET') return Response.json({ success: true, data: composioDesktopSummary(finalized ? 'completed' : 'callback_received') });
        assert.equal(receipt.body?.action, 'finalize'); finalized = true; bindingRevision = 8;
        return Response.json({ success: false, code: 'provider_unavailable', error: 'PRIVATE_finalize_ACK_loss' }, { status: 503 });
      };
      fireEvent.click(button); await screen.findByText(en.sharedConnections.desktopUnconfirmed);
      assertComposioDesktopWrites(2); assert.equal(composioDesktopBeforeUnloadPrevented(), true);
      fireEvent.click(screen.getByTestId('shared-desktop-resume')); await screen.findByText(en.sharedConnections.connected);
      assertComposioDesktopWrites(2); assert.equal(composioDesktopBeforeUnloadPrevented(), false);
    }
    {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(); const held = holdComposioDesktopResponse(); let cancelled = false;
      override = async receipt => {
        if (!receipt.path.endsWith('/connect/desktop')) return;
        if (receipt.method === 'GET') { if (!cancelled) await held.promise; return Response.json({ success: true, data: composioDesktopSummary(cancelled ? 'cancelled' : 'waiting') }); }
        assert.equal(receipt.body?.action, 'cancel'); cancelled = true;
        return Response.json({ success: false, code: 'provider_unavailable', error: 'PRIVATE_cancel_ACK_loss' }, { status: 503 });
      };
      fireEvent.click(button); await waitFor(() => assert(receipts.some(receipt => receipt.path.endsWith('/connect/desktop') && receipt.method === 'GET')));
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.desktopUnconfirmed);
      await act(async () => held.release()); assert.equal(composioDesktopBeforeUnloadPrevented(), true);
      fireEvent.click(screen.getByTestId('shared-desktop-resume')); await screen.findByText(en.sharedConnections.oauthCancelled);
      assertComposioDesktopWrites(2); assert.equal(composioDesktopBeforeUnloadPrevented(), false);
    }
    console.log('PASS Finalize/Cancel ACK loss retains flow and explicit read recovery sends no duplicate mutation.');

    {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(); const held = holdComposioDesktopResponse();
      override = async receipt => {
        if (!receipt.path.endsWith('/connect/desktop')) return;
        if (receipt.method === 'GET') return Response.json({ success: true, data: composioDesktopSummary('callback_received') });
        if (receipt.body?.action === 'finalize') await held.promise; else assert.equal(receipt.body?.action, 'cancel');
        bindingRevision = 8; return Response.json({ success: true, data: composioDesktopSummary('completed') });
      };
      fireEvent.click(button); await waitFor(() => assert(receipts.some(receipt => receipt.body?.action === 'finalize')));
      fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.connected);
      assert.equal(screen.queryByText(en.sharedConnections.oauthCancelled), null); assert.equal(screen.queryByTestId('shared-desktop-cancel'), null);
      assert.equal(composioDesktopBeforeUnloadPrevented(), true, 'Original finalize HTTP is protected until its ACK settles.');
      await act(async () => held.release()); await waitFor(() => assert.equal(composioDesktopBeforeUnloadPrevented(), false)); assertComposioDesktopWrites(3);
    }
    console.log('PASS cancel/completed overlap retains real in-flight write fence and fresh readiness truth.');

    for (const [code, status, permanent] of [['CONNECTION_ACCESS_DENIED', 403, true], ['CONNECTION_BINDING_CHANGED', 409, true],
      ['auth_required', 409, false], ['outcome_unknown', 409, false]] as const) {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge();
      override = async receipt => receipt.path.endsWith('/connect')
        ? Response.json({ success: false, code, error: 'PRIVATE_response' }, { status })
        : receipt.path.endsWith('/connect/desktop') ? Response.json({ success: true, data: composioDesktopSummary('cancelled') }) : undefined;
      fireEvent.click(button); await screen.findByText(en.sharedConnections[permanent ? status === 409 ? 'conflict' : 'oauthFailed' : 'desktopUnconfirmed']);
      assert.equal(composioDesktopBeforeUnloadPrevented(), !permanent); assertComposioDesktopWrites(1); assert.equal(bridgeRequests.length, 0); assertComposioDesktopDisplay();
      if (!permanent) { fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await screen.findByText(en.sharedConnections.oauthCancelled); }
    }
    console.log('PASS exact permanent denial vs auth_required/outcome_unknown does not classify every409 as cancellation.');

    for (const change of ['actor', 'session', 'workspace', 'ref', 'aba'] as const) {
      actor = 'actor-a'; sessionId = 'session-a'; workspaceId = 'workspace-a'; selectedRef = refs.a;
      const { view, button } = await mountComposioDesktopEditor(); setComposioDesktopBridge(); const held = holdComposioDesktopResponse();
      const captured = composioDesktopSummary('waiting');
      override = async receipt => { if (receipt.path.endsWith('/connect') && receipt.method === 'POST') { await held.promise; return Response.json({ success: true, data: captured }); } };
      fireEvent.click(button); await waitFor(() => assertComposioDesktopWrites(1));
      await act(async () => {
        if (change === 'actor' || change === 'aba') seedComposioDesktopIdentity('actor-b', 'session-b');
        if (change === 'session') seedComposioDesktopIdentity('actor-a', 'session-replacement');
        if (change === 'workspace') workspaceId = 'workspace-b';
        if (change === 'ref') selectedRef = refs.b;
        view.rerender(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC"><PluginNavigationGuard unsavedChangesMessage={en.skills.drafts.unsavedNavigation} />
          <SharedConnectionsSection workspaceId={workspaceId} ownership={ownership} initiallyOpen initialConnectionRef={selectedRef} /></NextIntlClientProvider>);
      });
      await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
      if (change === 'aba') { await act(async () => seedComposioDesktopIdentity('actor-a', 'session-a')); await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false)); }
      await act(async () => held.release()); assert.equal(bridgeRequests.length, 0); assertComposioDesktopWrites(1);
      assert.equal(screen.queryByTestId('shared-desktop-cancel'), null); assert.equal(composioDesktopBeforeUnloadPrevented(), false); assert.equal(redirects, 0);
    }
    actor = 'actor-a'; sessionId = 'session-a'; workspaceId = 'workspace-a'; selectedRef = refs.a;
    console.log('PASS actual Auth atom/session/workspace/ref/ABA replacement ignores old start ACK without IPC/mutations.');

    for (const boundary of ['ipc', 'poll', 'finalize', 'cancel'] as const) {
      const { view, button } = await mountComposioDesktopEditor(); const held = holdComposioDesktopResponse();
      const captured = composioDesktopSummary(boundary === 'poll' ? 'callback_received' : boundary === 'cancel' ? 'cancelled' : 'completed');
      setComposioDesktopBridge(1, true, boundary === 'ipc' ? async () => { await held.promise; return { ok: true }; } : undefined);
      override = async receipt => {
        if (!receipt.path.endsWith('/connect/desktop')) return;
        if (receipt.method === 'GET') {
          if (boundary === 'poll' || boundary === 'cancel') { await held.promise; return Response.json({ success: true, data: captured }); }
          return Response.json({ success: true, data: composioDesktopSummary('callback_received') });
        }
        await held.promise; return Response.json({ success: true, data: captured });
      };
      fireEvent.click(button); await screen.findByTestId('shared-desktop-cancel');
      if (boundary === 'poll' || boundary === 'cancel') await waitFor(() => assert(receipts.some(receipt => receipt.path.endsWith('/connect/desktop') && receipt.method === 'GET')));
      if (boundary === 'finalize') await waitFor(() => assert(receipts.some(receipt => receipt.body?.action === 'finalize')));
      if (boundary === 'cancel') { fireEvent.click(screen.getByTestId('shared-desktop-cancel')); await waitFor(() => assert(receipts.some(receipt => receipt.body?.action === 'cancel'))); }
      const expectedWrites = boundary === 'finalize' || boundary === 'cancel' ? 2 : 1;
      await act(async () => seedComposioDesktopIdentity('actor-b', 'session-b'));
      await waitFor(() => assert.equal((screen.getByTestId('shared-connection-save') as HTMLButtonElement).disabled, false));
      assert(view.container.textContent?.includes('actor-b Composio')); await act(async () => held.release()); assertComposioDesktopWrites(expectedWrites);
      assert.equal(receipts.filter(receipt => receipt.method !== 'GET' && receipt.actor !== 'actor-a').length, 0);
      assert.equal(screen.queryByTestId('shared-desktop-cancel'), null); assert.equal(screen.queryByText(en.sharedConnections.connected), null);
      assert.equal(screen.queryByText(en.sharedConnections.oauthCancelled), null); assert.equal(composioDesktopBeforeUnloadPrevented(), false); assert.equal(redirects, 0);
      if (boundary === 'ipc') assert.equal(receipts.filter(receipt => receipt.path.endsWith('/connect/desktop')).length, 0);
      if (boundary === 'poll') assert.equal(receipts.filter(receipt => receipt.body?.action === 'finalize').length, 0);
      actor = 'actor-a'; sessionId = 'session-a';
    }
    console.log('PASS late IPC/poll/finalize/cancel replies cannot hydrate or mutate under replacement identity.');

    {
      const { button } = await mountComposioDesktopEditor(); setComposioDesktopBridge();
      const name = document.getElementById('shared-edit-name'); assert(name);
      fireEvent.change(name, { target: { value: 'Retained dirty name' } }); fireEvent.click(button);
      await screen.findByText(en.sharedConnections.saveBeforeConnect); assertComposioDesktopWrites(0); assert.equal(bridgeRequests.length, 0);
      assert.equal((name as HTMLInputElement).value, 'Retained dirty name'); assert.equal(prompts, 0);
    }
    assert.equal(transportErrors.length, 0); assertComposioDesktopDisplay();
    console.log('PASS actual shared Composio Desktop React matrix (controlled transport only, no native/provider authority claim).');
  } finally {
    barrierReleases.forEach(release => release()); cleanup(); sessionAtom.set(originalSession); loader._load = originalLoad;
    globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
