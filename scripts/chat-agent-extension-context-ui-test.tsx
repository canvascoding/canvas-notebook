import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import germanMessages from '../messages/de.json';
import type { AgentProfile } from '../app/lib/chat/types';
import type { CreateAgentInput, CreatedAgent } from '../app/components/settings/CreateAgentDialog';
import type { AgentExtensionEditorContext } from '../app/components/agents/AgentExtensionEditor';
import { DEFAULT_WORKSPACE_COLOR } from '../app/lib/workspaces/colors';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLSelectElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
class FixtureResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const input: CreateAgentInput = { name: 'Chat-created agent', scopeType: 'user', iconId: 'bot', enabledTools: null,
  defaultProviderInstallationId: null, defaultProvider: null, defaultModel: null, defaultThinking: null,
  extensions: { version: 1, origin: 'agent_configuration', mode: 'fixed', selections: [], workflow: null, standalone: [] }, files: {} };
async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch;
  let actorId: string | null = 'actor-a', authPending = false, authError: Error | null = null;
  let lastContext: AgentExtensionEditorContext | undefined;
  const capturedContext = (): AgentExtensionEditorContext | undefined => lastContext;
  function ControlledCreate({ open, context, onCreate }: { open: boolean; context?: AgentExtensionEditorContext; onCreate(input: CreateAgentInput): Promise<CreatedAgent | null> }) {
    const [ack, setAck] = React.useState<string | null>(null); lastContext = context;
    return open ? <div><button type="button" onClick={() => { void onCreate(input).then(value => setAck(value?.agentId ?? null)); }}>Submit controlled creation</button>
      {ack ? <p>Created {ack}</p> : null}</div> : null;
  }
  loader._load = (name, parent, isMain) => {
    if (name.endsWith('/auth-client')) return { authClient: { useSession: () => ({ data: actorId ? { user: { id: actorId, role: 'member' }, session: { id: 'session' } } : null,
      isPending: authPending, error: authError }) } };
    if (name.endsWith('/CreateAgentDialog')) return { CreateAgentDialog: ControlledCreate };
    if (name.endsWith('/EditAgentProfileDialog')) return { EditAgentProfileDialog: ({ open, context }: { open: boolean; context: AgentExtensionEditorContext }) => open ? <p data-testid="edit-context">{JSON.stringify(context)}</p> : null };
    if (name.endsWith('/AgentWorkflowChoiceDialog')) return { AgentWorkflowChoiceDialog: ({ open, context }: { open: boolean; context: AgentExtensionEditorContext }) => open ? <p data-testid="choice-context">{JSON.stringify(context)}</p> : null };
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const { ChatAgentSelector } = await import('../app/components/canvas-agent-chat/ChatAgentSelector');
  const { useWorkspaceStore, selectActiveWorkspace } = await import('../app/store/workspace-store');
  const profile: AgentProfile = { agentId: 'fixed-v2', name: 'Fixed V2', iconId: 'bot', type: 'special', removable: true,
    workflowVersion: 2, workflowRevision: 1, revision: 1, access: { canUse: true, canEdit: true, canManage: false } };
  const forcedWorkspace = { id: 'forced-workspace', type: 'project' as const, organizationId: 'forced-org', projectId: 'forced-project', name: 'Forced',
    status: 'active' as const, color: DEFAULT_WORKSPACE_COLOR, permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
  const newForcedWorkspace = { ...forcedWorkspace, id: 'new-forced-workspace', organizationId: 'next-org', projectId: 'next-project', name: 'New forced' };
  useWorkspaceStore.setState({ activeWorkspaceId: 'global-workspace', initialized: true, isLoading: false, error: null,
    workspaces: [forcedWorkspace, newForcedWorkspace] });
  const writes: Array<{ url: URL; body: unknown }> = [], selected: string[] = [], accepted: string[] = [];
  let refreshCount = 0, release: ((response: Response) => void) | null = null, hold = false;
  globalThis.fetch = async (url, init) => {
    writes.push({ url: new URL(String(url), 'http://localhost'), body: JSON.parse(String(init?.body)) });
    assert.equal(init?.method, 'POST'); assert.equal(init.credentials, 'include'); assert.equal(init.signal, undefined);
    if (hold) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ success: true, data: { agent: { ...profile, agentId: 'created-chat-agent', scopeType: 'user' } } });
  };
  const form = (workspaceId: string | null = 'forced-workspace', options: { context?: AgentExtensionEditorContext; locale?: 'en' | 'de' } = {}) => <NextIntlClientProvider
    locale={options.locale ?? 'en'} timeZone="UTC" messages={options.locale === 'de' ? germanMessages : messages}>
    <ChatAgentSelector variant="desktop" context={options.context ?? { workspaceId }} activeAgentId={profile.agentId} activeAgentName={profile.name} agents={[profile]}
      onAgentCreated={agent => { accepted.push(agent.agentId); return true; }}
      onSelectAgent={id => { assert(accepted.includes(id)); selected.push(id); }} onReloadAgents={async () => { refreshCount += 1; throw new Error('Controlled refresh outage'); }} />
  </NextIntlClientProvider>;
  // The actual Home caller derives its ID from selectActiveWorkspace; the chat
  // caller can already hold its forced ID before that row is hydrated.
  function ScopeHarness({ surface }: { surface: 'home' | 'chat' }) {
    const activeId = useWorkspaceStore(state => selectActiveWorkspace(state)?.id ?? null);
    return form(surface === 'home' ? activeId : 'forced-workspace');
  }
  const openCreate = async () => { fireEvent.click(screen.getByTestId('chat-agent-id')); fireEvent.click(await screen.findByRole('button', { name: messages.chat.createAgent })); };
  let readinessCases = 0;
  try {
    const view = render(form()); await openCreate();
    assert.deepEqual(lastContext, { actorId, workspaceId: 'forced-workspace', organizationId: 'forced-org', projectId: 'forced-project' });
    const submit = screen.getByRole('button', { name: 'Submit controlled creation' }); fireEvent.click(submit); fireEvent.click(submit);
    await screen.findByText('Created created-chat-agent'); assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, input);
    assert.equal(writes[0].url.searchParams.get('workspaceId'), 'forced-workspace'); assert.equal(writes[0].url.searchParams.get('organizationId'), 'forced-org');
    assert.equal(writes[0].url.searchParams.get('projectId'), 'forced-project'); assert(!writes[0].url.searchParams.has('actorId'));
    assert.deepEqual(selected, ['created-chat-agent']); assert(refreshCount >= 1);
    // A forced scope is stable when the global workspace changes.
    await act(async () => { useWorkspaceStore.setState({ activeWorkspaceId: 'another-global-workspace' }); });
    assert.equal(lastContext?.workspaceId, 'forced-workspace');
    // An acknowledged old-scope creation may not change the new selector or trigger its refresh.
    cleanup(); hold = true; selected.length = 0; refreshCount = 0; const next = render(form()); await openCreate();
    fireEvent.click(screen.getByRole('button', { name: 'Submit controlled creation' })); await waitFor(() => assert(release));
    const oldRefresh = refreshCount; next.rerender(form('new-forced-workspace'));
    await act(async () => { release!(Response.json({ success: true, data: { agent: { ...profile, agentId: 'old-scope-created', scopeType: 'user' } } })); });
    assert.deepEqual(selected, []); assert.equal(refreshCount, oldRefresh); assert.equal(lastContext?.workspaceId, 'new-forced-workspace');
    actorId = 'actor-b'; next.rerender(form('new-forced-workspace')); assert.equal(lastContext?.actorId, 'actor-b');
    next.unmount(); view.unmount();

    for (const surface of ['home', 'chat'] as const) {
      cleanup(); actorId = 'actor-a'; authPending = true; hold = false; refreshCount = 0;
      useWorkspaceStore.setState({ activeWorkspaceId: 'forced-workspace', workspaces: [], initialized: false, isLoading: false, error: null });
      const hydration = render(<ScopeHarness surface={surface} />);
      let trigger = screen.getByTestId('chat-agent-id') as HTMLButtonElement;
      assert.equal(trigger.disabled, true); assert.equal(trigger.getAttribute('aria-busy'), 'true');
      assert.equal(trigger.textContent?.includes(messages.chat.agentContextLoading), true);
      fireEvent.click(trigger); assert.equal(screen.queryByTestId('chat-agent-selector-popover'), null); assert.equal(refreshCount, 0);
      authPending = false; hydration.rerender(<ScopeHarness surface={surface} />);
      assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, true, 'Auth alone must not unlock an unresolved workspace.');
      await act(async () => useWorkspaceStore.setState({ workspaces: [forcedWorkspace], initialized: true, isLoading: false }));
      trigger = screen.getByTestId('chat-agent-id') as HTMLButtonElement;
      assert.equal(trigger.disabled, false); assert.equal(trigger.dataset.contextStatus, 'ready');
      fireEvent.click(trigger); await screen.findByTestId('chat-agent-selector-popover');
      assert.deepEqual(lastContext, { actorId, workspaceId: forcedWorkspace.id, organizationId: 'forced-org', projectId: 'forced-project' });
      await act(async () => useWorkspaceStore.setState({ isLoading: true }));
      await act(async () => useWorkspaceStore.setState({ isLoading: false, workspaces: [structuredClone(forcedWorkspace)] }));
      assert(screen.getByTestId('chat-agent-selector-popover'), 'An opened ready selector survives metadata refresh with the same actual scope.');
      authPending = true; hydration.rerender(<ScopeHarness surface={surface} />);
      assert.equal(screen.queryByTestId('chat-agent-selector-popover'), null); assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, true);
      authPending = false; hydration.rerender(<ScopeHarness surface={surface} />); await openCreate();
      assert(screen.getByRole('button', { name: 'Submit controlled creation' }));
      actorId = 'actor-b'; hydration.rerender(<ScopeHarness surface={surface} />);
      assert.equal(screen.queryByRole('button', { name: 'Submit controlled creation' }), null);
      assert.equal(lastContext?.actorId, 'actor-b'); readinessCases++;
    }

    cleanup(); actorId = 'actor-a'; authPending = false;
    const personalWorkspace = { ...forcedWorkspace, type: 'personal' as const, organizationId: null, projectId: null };
    useWorkspaceStore.setState({ initialized: true, isLoading: false, error: null, workspaces: [personalWorkspace] });
    const nullable = render(form()); assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, false);
    await openCreate(); assert.deepEqual(lastContext, { actorId, workspaceId: 'forced-workspace', organizationId: null, projectId: null });
    await act(async () => useWorkspaceStore.setState({ workspaces: [forcedWorkspace] }));
    assert.equal(screen.queryByRole('button', { name: 'Submit controlled creation' }), null, 'An actual organization/project change closes the previous context dialog.');
    assert.equal(capturedContext()?.organizationId, 'forced-org'); readinessCases++;

    authError = new Error('Controlled authentication read failure'); nullable.rerender(form());
    let unavailable = screen.getByTestId('chat-agent-id') as HTMLButtonElement;
    assert.equal(unavailable.disabled, true); assert.equal(unavailable.dataset.contextStatus, 'auth_error');
    assert.equal(unavailable.title, messages.chat.agentContextAuthUnavailable); fireEvent.click(unavailable);
    assert.equal(screen.queryByTestId('chat-agent-selector-popover'), null);
    authError = null; actorId = null; nullable.rerender(form()); assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, true); readinessCases++;

    actorId = 'actor-a'; nullable.rerender(form()); await openCreate();
    await act(async () => useWorkspaceStore.setState({ workspaces: [{ ...forcedWorkspace, permissions: { ...forcedWorkspace.permissions, canRead: false } }] }));
    assert.equal(screen.queryByRole('button', { name: 'Submit controlled creation' }), null);
    assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, true); readinessCases++;

    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'global-workspace', workspaces: [{ ...forcedWorkspace, id: 'global-workspace' }] }));
    nullable.rerender(form('missing-forced-workspace'));
    unavailable = screen.getByTestId('chat-agent-id') as HTMLButtonElement;
    assert.equal(unavailable.disabled, true); assert.equal(unavailable.dataset.contextStatus, 'unavailable');
    assert.equal(unavailable.title, messages.chat.agentContextUnavailable); assert.equal(capturedContext()?.workspaceId, 'missing-forced-workspace');
    assert.equal(capturedContext()?.organizationId, null, 'An unavailable forced workspace never borrows the global organization.'); readinessCases++;

    const exact = { workspaceId: 'explicit-workspace-not-in-list', organizationId: null, projectId: null };
    nullable.rerender(form(exact.workspaceId, { context: exact }));
    assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, false);
    await openCreate(); assert.deepEqual(lastContext, { actorId, ...exact }, 'A complete explicit context need not be in the unrelated global list.'); readinessCases++;

    cleanup(); useWorkspaceStore.setState({ initialized: true, error: 'Controlled workspace load error', workspaces: [forcedWorkspace] });
    const failed = render(form('forced-workspace', { locale: 'de' }));
    unavailable = screen.getByTestId('chat-agent-id') as HTMLButtonElement;
    assert.equal(unavailable.disabled, true); assert.equal(unavailable.title, germanMessages.chat.agentContextUnavailable);
    await act(async () => useWorkspaceStore.setState({ error: null }));
    assert.equal((screen.getByTestId('chat-agent-id') as HTMLButtonElement).disabled, false); failed.unmount(); readinessCases++;
    console.log(`chat-agent-extension-context-ui-test: PASS (${readinessCases} additional actual readiness groups: Home/forced-chat hydration and auth fences, stable ready open, nullable org, actor/scope/revocation/error changes, no forced fallback, complete explicit context; original complete POST/duplicate/ACK/late-scope assertions retained. Actual Zustand/selector/Popover, child dialogs and HTTP controlled, no browser/SQL/authority claim)`);
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
