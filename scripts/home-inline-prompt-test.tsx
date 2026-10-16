import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { NextIntlClientProvider } from 'next-intl';
import de from '../messages/de.json';
import { DEFAULT_AGENT_ID } from '../app/lib/channels/constants';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '../app/lib/chat/constants';
import { readPromptHandoff } from '../app/lib/chat/prompt-handoff';
import { observeOpenedDocumentAuth, openedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '../app/store/workspace-store';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

// Actual Home, shared editor, picker and chooser. Auth observation, navigation
// and metadata HTTP are controlled UI boundaries, not source/SQL authority.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://home-inline.fixture.invalid', pretendToBeVisual: true });
const domErrors: Error[] = [];
dom.virtualConsole.on('jsdomError', error => { domErrors.push(error); });
Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { value: () => [], configurable: true });
Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { value: () => new dom.window.DOMRect(), configurable: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), configurable: true });
for (const key of ['window', 'self', 'document', 'navigator', 'Document', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'SVGElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent',
  'MouseEvent', 'DOMParser', 'DOMRect', 'DocumentFragment', 'Text', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const session = { user: { id: 'home-user', role: 'user' }, session: { id: 'home-auth' } };
const navigations: unknown[] = [];
const router = { push: (href: unknown) => { navigations.push(href); } };
const loader = Module as unknown as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, isMain) => {
  if (name === '@/i18n/navigation') return { useRouter: () => router,
    getPathname: ({ href, locale }: { href: string; locale: string }) => `/${locale}${href}`,
    Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
  if (name.endsWith('/auth-client')) return { authClient: { useSession: () => ({ data: session, isPending: false, error: null }) } };
  return originalLoad(name, parent, isMain);
};
const workspace: ClientWorkspaceSummary = { id: 'one', type: 'personal', name: 'Home workspace', color: 'gray' as ClientWorkspaceSummary['color'],
  status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
const selection = { kind: 'composio', source: 'composio', toolkit: 'canva', target: { kind: 'personal', profileId: 'profile-B',
  accountBinding: 'account', accountId: 'account-B', connectionRef: 'composio-personal:profile-B:account-B' } };
const seal = `cmp_personal_account_${'b'.repeat(40)}`;
const requests: Record<string, unknown>[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), dom.window.location.href);
  if (url.pathname === '/api/agents') return Response.json({ success: true, data: { agents: [{ agentId: DEFAULT_AGENT_ID, name: 'Bradley', iconId: 'bot', type: 'main', removable: false }] } });
  if (url.pathname === '/api/user-preferences') return Response.json({ success: true, data: { lastActiveAgentId: DEFAULT_AGENT_ID } });
  if (url.pathname !== '/api/chat/extension-options') throw new Error(`Unexpected UI fetch ${url.pathname}`);
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push(request);
  assert.deepEqual(request.target, { kind: 'draft_turn', agentId: DEFAULT_AGENT_ID, workspaceId: 'one' });
  const header = { schemaVersion: 1, target: request.target, contextKey: 'home-context', agentRevision: 1, workflowRevision: 0,
    preferenceRevision: 0, coverage: [], limits: EXTENSION_SELECTION_LIMITS, finalSendValidationRequired: true, operation: request.operation };
  const pagination = { nextCursor: null, hasNextPage: false, loadedItems: 1 };
  let data: Record<string, unknown>;
  if (request.operation === 'search') {
    data = { query: request, items: [{ item: { id: 'composio:canva', kind: 'integration', displayName: 'Canva', source: 'composio', stock: 'available',
      description: 'Design toolkit', toolkit: { slug: 'canva', name: 'Canva' }, access: { canRead: true, canUse: true, canManage: false }, ownership: { type: 'system' } },
    eligibility: { action: 'select' } }], selectedItem: null, recents: [], scopes: {}, pagination };
  } else if (request.operation === 'connection_choices') {
    data = { selector: request.selector, connections: [], profiles: request.profileId ? [] : [{ profileId: 'profile-B', label: 'Profile B' }],
      accounts: request.profileId ? [{ selection, label: 'Marketing', status: 'ACTIVE', selectable: true, accountSelectionRef: seal,
        expiresAt: new Date(Date.now() + 300_000).toISOString() }] : [], setupAlternatives: [], pagination };
  } else if (request.operation === 'preview') {
    assert.equal(JSON.stringify(request.intakeSelection).includes(seal), true, 'Only the transient preview envelope carries the real account seal.');
    data = { preview: { issues: [], configurationReadiness: 'unknown' } };
  } else if (request.operation === 'presentation') {
    data = { entries: (request.selections as unknown[]).map(value => ({ selection: value })) };
  } else throw new Error(`Unexpected metadata operation ${String(request.operation)}`);
  return Response.json({ success: true, data: { ...header, ...data } });
};

async function main() {
  const { render, screen, fireEvent, act, waitFor, cleanup } = await import('@testing-library/react');
  const { PromptHero } = await import('../app/components/home/PromptHero');
  observeOpenedDocumentAuth({ data: session });
  useWorkspaceStore.setState({ activeWorkspaceId: 'one', workspaces: [workspace], initialized: true, error: null });
  const wrap = (children: React.ReactNode) => <NextIntlClientProvider locale="de" timeZone="Europe/Berlin" messages={de}>{children}</NextIntlClientProvider>;
  const editor = () => (screen.getByRole('textbox', { name: de.home.start.aiPlaceholder }) as HTMLElement & { editor: Editor }).editor;
  try {
    render(wrap(<PromptHero compact />));
    await waitFor(() => assert(editor()));
    await act(async () => { editor().commands.insertContent('/Can'); });
    await waitFor(() => assert(screen.getByRole('button', { name: /Canva.*Design toolkit/u })));
    fireEvent.click(screen.getByRole('button', { name: /Canva.*Design toolkit/u }));
    await waitFor(() => assert(screen.getByRole('button', { name: /Profile B/u })));
    fireEvent.click(screen.getByRole('button', { name: /Profile B/u }));
    await waitFor(() => assert(screen.getByRole('button', { name: 'Dieses Konto' })));
    fireEvent.click(screen.getByRole('button', { name: 'Dieses Konto' }));
    await waitFor(() => assert.equal(Boolean(screen.queryByTestId('chat-extension-reference-dialog')), false));
    assert.equal(editor().getText(), 'Canva · Marketing');
    assert.equal(screen.getByRole('textbox', { name: de.home.start.aiPlaceholder }).querySelectorAll('[data-type="extension-reference"]').length, 1);
    fireEvent.click(screen.getByRole('button', { name: de.home.hero.submit }));
    await waitFor(() => assert.equal(navigations.length, 1));
    const handoff = readPromptHandoff(window.sessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY,
      { workspaceId: 'one', auth: openedDocumentAuthScope() });
    assert(handoff?.body); assert.equal(handoff.prompt, 'Canva · Marketing');
    assert.deepEqual(handoff.body.bundles[0].primary.selection, selection);
    assert.deepEqual(navigations[0], { pathname: '/notebook', query: { workspaceId: 'one', chat: 'open', handoff: handoff.handoffId } });
    assert.doesNotMatch(JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage } }), /accountSelectionRef|cmp_personal_account_/u);
    assert.equal(requests.filter(value => value.operation === 'preview').length, 1);
    console.log('PASS actual Home → shared slash picker → profile/account B → inline atom → exact receipt-free structured handoff');
    cleanup(); window.sessionStorage.clear(); navigations.length = 0;

    const quick = render(wrap(<PromptHero compact plainTextRequest={{ id: 'first', workspaceId: 'one', text: '🙂 Plain /Canva' }} />));
    await waitFor(() => assert.equal(editor().getText(), '🙂 Plain /Canva'));
    assert.equal(screen.getByRole('textbox').querySelector('[data-type="extension-reference"]'), null, 'Quick actions are explicit plain text, never reconstructed references.');
    quick.rerender(wrap(<PromptHero compact plainTextRequest={{ id: 'wrong', workspaceId: 'two', text: 'Wrong workspace' }} />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(editor().getText(), '🙂 Plain /Canva');
    quick.rerender(wrap(<PromptHero compact plainTextRequest={{ id: 'second', workspaceId: 'one', text: 'Second prompt' }} />));
    await waitFor(() => assert.equal(editor().getText(), 'Second prompt'));
    fireEvent.click(screen.getByRole('button', { name: de.home.hero.submit }));
    await waitFor(() => assert.equal(navigations.length, 1));
    const plain = readPromptHandoff(window.sessionStorage, CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY, { workspaceId: 'one', auth: openedDocumentAuthScope() });
    assert.deepEqual(plain?.body, { version: 1, parts: [{ type: 'text', text: 'Second prompt' }], bundles: [] });
    console.log('PASS structured Home quick actions preserve UTF16 plain text and reject a request from another workspace');
    cleanup(); window.sessionStorage.clear(); navigations.length = 0;

    render(wrap(<PromptHero plainTextRequest={{ id: 'race', workspaceId: 'one', text: 'Keep my draft' }} />));
    await waitFor(() => assert.equal(editor().getText(), 'Keep my draft'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: de.home.hero.submit }));
      useWorkspaceStore.setState({ activeWorkspaceId: 'two', workspaces: [workspace, { ...workspace, id: 'two' }] });
    });
    await waitFor(() => assert(screen.getByRole('alert')));
    assert.equal(navigations.length, 0); assert.equal(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY), null);
    assert.equal(editor().getText(), 'Keep my draft');
    assert.equal((screen.getByRole('button', { name: de.home.hero.submit }) as HTMLButtonElement).disabled, false);
    assert.equal(domErrors.length, 0, domErrors.map(error => error.message).join('\n'));
    console.log('PASS actual workspace change during async Home submit keeps the draft editable and saves no handoff');
  } finally {
    cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch;
    const { getNotebookQueryClient } = await import('../app/lib/queries/client'); getNotebookQueryClient().clear();
    dom.window.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
