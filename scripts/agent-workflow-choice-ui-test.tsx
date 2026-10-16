import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { EXTENSION_SELECTION_LIMITS } from '../app/lib/capabilities/extensions/contracts';
import { updateAgentWorkflowChoiceSchema } from '../app/lib/agents/workflow-api-contracts';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';
import type { AgentExtensionOptionsRequest, AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';

// Real dialog, V1/V2 parser, common chooser and client transports. Only the HTTP DTO boundary is controlled.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
  'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });

const capabilityKey = `agent-capability:${'a'.repeat(43)}`, standaloneKey = `agent-extension:${'s'.repeat(43)}`;
const receipt = `cmp_personal_account_${'b'.repeat(43)}`;
const snapshot = (v2 = false): AgentWorkflowDescriptor => ({ agentId: 'workflow-agent', revision: 2, workflowVersion: v2 ? 2 : 1, workflowRevision: 1, preferenceRevision: 1,
  access: { canUse: true, canEdit: false, canManage: false }, packages: [{ resourceRef: 'canvas-resource:11111111-1111-4111-8111-111111111111',
    publishedRevisionRef: 'canvas-package-revision:22222222-2222-4222-8222-222222222222', checksum: 'a'.repeat(64), name: 'Design workflow',
    declarations: [{ declarationPath: 'skills/design/agents/canvas.yaml', capabilities: [{ capabilityKey, capabilityId: 'design', application: 'canva', required: true,
      selectionMode: 'selectable', selectionOrigin: 'default', selectedKind: 'shared', selectedChoiceId: 'a', personalChoiceAllowed: true,
      selectedConnection: { label: 'Studio design account', availability: 'available', status: 'unknown', scopeLabel: 'organization', source: 'mcp' }, choices: [
        { choiceId: 'a', kind: 'shared', label: 'Studio design account', availability: 'available', status: 'unknown', scopeLabel: 'organization', source: 'mcp' },
        { choiceId: 'b', kind: 'shared', label: 'Campaign account', availability: 'available', status: 'unknown', scopeLabel: 'team', source: 'composio' },
        { choiceId: 'revoked', kind: 'shared', label: 'Unavailable connection', availability: 'unavailable', status: 'unavailable' },
      ] }, { capabilityKey: `agent-capability:${'f'.repeat(43)}`, capabilityId: 'fixed', application: 'library', required: true,
        selectionMode: 'fixed', selectionOrigin: 'fixed', selectedKind: 'shared', selectedChoiceId: null,
        personalChoiceAllowed: false, choices: [], selectedConnection: { label: 'Brand library', availability: 'available', status: 'unknown', scopeLabel: 'organization' } }] }] }],
  ...(v2 ? { standalone: [{ capabilityKey: standaloneKey, source: 'composio', toolkit: 'linkedin', required: true,
    selectionMode: 'selectable', selectionOrigin: 'missing', selectedChoiceId: null, choices: [],
    personalPolicy: { source: 'composio', toolkit: 'linkedin', toolCap: ['LIST_POSTS'] } }] } : {}) });

async function main() {
  const { render, screen, fireEvent, cleanup, waitFor, act, within } = await import('@testing-library/react');
  const { AgentWorkflowChoiceDialog } = await import('../app/components/agents/AgentWorkflowChoiceDialog');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useWorkspaceStore.setState({ activeWorkspaceId: 'global-personal-workspace' });
  type Context = { workspaceId: string; organizationId: string; projectId: string; actorId: string };
  const team: Context = { workspaceId: 'team-workflow', organizationId: 'workflow-org', projectId: 'workflow-project', actorId: 'actor-a' };
  let context = team, current = snapshot(), conflict = false, failedRead = false, failedProbe = false;
  let holdRead = false, held: { resolve(value: Response): void; signal?: AbortSignal | null } | null = null;
  const writes: Record<string, unknown>[] = [], requests: Array<{ url: URL; body: Record<string, unknown> | null }> = [];
  let metadataReads = 0, accountProbes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost'), body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, body });
    assert.equal(url.searchParams.get('workspaceId'), context.workspaceId); assert.equal(url.searchParams.get('organizationId'), context.organizationId);
    assert.equal(url.searchParams.get('projectId'), context.projectId); assert(!url.searchParams.has('actorId'));
    if (url.pathname === '/api/agents/extension-options') {
      assert.equal(init?.method, 'POST'); assert.equal(init.credentials, 'same-origin');
      const request = body as AgentExtensionOptionsRequest;
      assert.equal(request.operation, 'connection_choices'); assert.equal(request.target.kind, 'user_choice');
      if (request.operation !== 'connection_choices' || request.target.kind !== 'user_choice') throw new Error('Unexpected options request');
      assert.equal(request.target.expectedWorkflowRevision, current.workflowRevision); assert.equal(request.target.expectedPreferenceRevision, current.preferenceRevision);
      metadataReads += 1; const isStandalone = request.target.capabilityKey === standaloneKey, toolkit = isStandalone ? 'linkedin' : 'canva';
      if (request.profileId) accountProbes += 1;
      if (request.profileId && failedProbe) { failedProbe = false; return Response.json({ success: false, code: 'PROVIDER_UNAVAILABLE', error: 'Provider temporarily unavailable' }, { status: 503 }); }
      const data: AgentExtensionOptionsResponse = { schemaVersion: 1, operation: 'connection_choices', target: request.target, selector: { kind: 'slot' },
        contextKey: `${context.actorId}:${context.workspaceId}:${current.workflowRevision}:${current.preferenceRevision}`, limits: EXTENSION_SELECTION_LIMITS, coverage: [],
        pagination: { nextCursor: null, hasNextPage: false, loadedItems: request.profileId ? 2 : 1 }, connections: [],
        profiles: request.profileId ? [] : [{ profileId: 'design-profile', label: 'Design profile', status: 'unverified', alternativeKey: `composio:${toolkit}` }],
        accounts: request.profileId ? ['first', 'second'].map(accountId => ({
          label: `${accountId === 'first' ? 'First' : 'Second'} design account`, status: 'ACTIVE', selectable: true, accountSelectionRef: receipt,
          selection: { kind: 'composio' as const, source: 'composio' as const, toolkit,
            target: { kind: 'personal' as const, profileId: 'design-profile', accountBinding: 'account' as const,
              accountId, connectionRef: `composio-personal:design-profile:${accountId}` } },
          ...(!isStandalone ? { packageBinding: { alternativeKey: `composio:${toolkit}`, target: { kind: 'personal' as const, source: 'composio' as const,
            ownerUserId: context.actorId, providerRef: `actual-returned-provider:${accountId}`, accountSelectionRef: receipt } } } : {}),
        })) : [],
      };
      return Response.json({ success: true, data });
    }
    assert.equal(url.pathname, '/api/agents/workflow'); assert.equal(init?.credentials, 'include');
    if (init?.method === 'PATCH') {
      assert(body); assert(updateAgentWorkflowChoiceSchema.safeParse(body).success); writes.push(body);
      assert(!Object.hasOwn(body, 'extensions')); assert(!Object.hasOwn(body, 'enabledTools'));
      if (conflict) { conflict = false; current.preferenceRevision += 1; current.workflowRevision += 1;
        return Response.json({ success: false, code: 'AGENT_WORKFLOW_REVISION_CONFLICT' }, { status: 409 }); }
      assert.equal(body.expectedPreferenceRevision, current.preferenceRevision); assert.equal(body.expectedWorkflowRevision, current.workflowRevision);
      current.preferenceRevision += 1;
      if (body.capabilityKey === standaloneKey) {
        const slot = current.standalone![0]; assert(body.standaloneSelection);
        const choice = body.standaloneSelection as { selection: NonNullable<typeof slot.selectedSelection>; toolCap: string[]; requirement: string };
        assert.deepEqual(choice.toolCap, ['LIST_POSTS']); assert.equal(choice.requirement, 'required');
        slot.selectionOrigin = 'user'; slot.selectedSelection = choice.selection;
        slot.selectedConnection = { label: 'Second LinkedIn account', availability: 'available', status: 'unknown', scopeLabel: 'personal', source: 'composio' };
      } else {
        const slot = current.packages[0].declarations[0].capabilities[0];
        if (body.personalSelection) {
          slot.selectionOrigin = 'user'; slot.selectedKind = 'personal'; slot.selectedChoiceId = null;
          slot.selectedConnection = { label: 'Personal Composio connection', availability: 'available', status: 'unknown', scopeLabel: 'personal', source: 'composio' };
        } else {
          slot.selectionOrigin = body.choiceId === null ? 'default' : 'user'; slot.selectedChoiceId = body.choiceId === null ? 'a' : String(body.choiceId);
          slot.selectedConnection = { ...slot.choices.find(choice => choice.choiceId === slot.selectedChoiceId)! };
        }
      }
      return Response.json({ success: true, data: current });
    }
    if (failedRead) { failedRead = false; return Response.json({ success: false }, { status: 503 }); }
    if (holdRead) { holdRead = false; return new Promise<Response>(resolve => { held = { resolve, signal: init?.signal }; }); }
    return Response.json({ success: true, data: current });
  };
  const form = (scope = context) => <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <AgentWorkflowChoiceDialog open agentId="workflow-agent" agentName="Design Agent" context={scope} onOpenChange={() => {}} />
  </NextIntlClientProvider>;
  const reopen = () => { cleanup(); render(form()); };
  const designSlot = () => screen.getByRole('heading', { name: 'canva' }).closest('section')!;
  const choosePersonal = async (section = designSlot()) => {
    fireEvent.click(within(section).getByRole('button', { name: /Choose my connection|Set up my connection/u }));
    const profile = await within(section).findByRole('button', { name: /Design profile/u });
    return { section, profile };
  };
  try {
    render(form());
    let select = await screen.findByRole('combobox', { name: 'Connection for canva' }) as HTMLSelectElement;
    assert.equal(select.value, 'default'); assert.equal(screen.getAllByRole('combobox').length, 1); assert.equal(metadataReads, 0);
    assert.equal(screen.queryByTestId('agent-workflow-required-setup'), null, 'Unknown provider health alone does not block a valid saved choice.');
    assert.equal(screen.queryByTestId('agent-workflow-choice-issue'), null);
    assert((screen.getByRole('option', { name: /Unavailable connection/u }) as HTMLOptionElement).disabled);
    fireEvent.change(select, { target: { value: 'choice:b' } }); conflict = true;
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' })); await screen.findByRole('alert'); assert.equal(writes.length, 1);
    assert((screen.getByRole('button', { name: 'Save choice' }) as HTMLButtonElement).disabled);
    failedRead = true; fireEvent.click(screen.getByRole('button', { name: 'Reload current choices' }));
    await screen.findByText(messages.agentWorkflow.errors.load); assert.equal(select.value, 'choice:b');
    assert((screen.getByRole('button', { name: 'Save choice' }) as HTMLButtonElement).disabled);
    fireEvent.click(screen.getByRole('button', { name: 'Reload current choices' })); await waitFor(() => assert.equal(Boolean(screen.queryByRole('alert')), false));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' })); await screen.findByRole('button', { name: 'Saved' });
    assert.equal(writes.length, 2); assert.equal(writes[1].expectedWorkflowRevision, 2); assert.equal(writes[1].expectedPreferenceRevision, 2);
    fireEvent.change(select, { target: { value: 'default' } }); fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(() => assert.equal(writes.length, 3)); assert.equal(writes[2].choiceId, null); await screen.findByRole('button', { name: 'Saved' });
    console.log('PASS V1 finite choices, explicit null reset and 409/503 draft/CAS fencing.');

    current = snapshot(); const beforeMetadata = metadataReads, beforeProbe = accountProbes; reopen();
    await screen.findByRole('combobox'); assert.equal(metadataReads, beforeMetadata);
    const personal = await choosePersonal(); assert.equal(metadataReads, beforeMetadata + 1); assert.equal(accountProbes, beforeProbe);
    fireEvent.click(personal.profile); await within(personal.section).findByText('Second design account');
    assert.equal(accountProbes, beforeProbe + 1); const count = writes.length;
    assert.equal(writes.length, count, 'Displaying two accounts never selects the first.');
    fireEvent.click(within(personal.section).getAllByRole('button', { name: 'This account' })[1]);
    await screen.findByText('Personal Composio connection'); assert.equal(writes.length, count + 1);
    assert.deepEqual(writes.at(-1)?.personalSelection, { alternativeKey: 'composio:canva', target: { kind: 'personal', source: 'composio',
      ownerUserId: team.actorId, providerRef: 'actual-returned-provider:second', accountSelectionRef: receipt } });
    assert.equal((screen.getByRole('combobox', { name: 'Connection for canva' }) as HTMLSelectElement).value, 'personal');
    console.log('PASS common chooser, explicit profile/account probes and exact second-account package payload.');

    current = snapshot(); reopen(); select = await screen.findByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'choice:b' } }); failedProbe = true;
    const failed = await choosePersonal(), beforeFailed = writes.length; fireEvent.click(failed.profile);
    await within(failed.section).findByText('Provider temporarily unavailable');
    assert.equal(writes.length, beforeFailed); assert.equal(current.preferenceRevision, 1); assert.equal(select.value, 'choice:b');
    assert.equal(within(failed.section).queryAllByRole('button', { name: 'This account' }).length, 0);
    fireEvent.click(within(failed.section).getByRole('button', { name: 'Reload' }));
    await within(failed.section).findByText('Second design account'); assert.equal(writes.length, beforeFailed);
    console.log('PASS provider failure preserves finite draft and has no account/default or mutation fallback.');

    current = snapshot(true); reopen(); await screen.findByRole('combobox', { name: 'Connection for linkedin' });
    const standaloneSection = screen.getByRole('heading', { name: 'linkedin' }).closest('section')!;
    assert.equal((within(standaloneSection).getByRole('combobox') as HTMLSelectElement).value, 'unavailable');
    assert.match(screen.getByTestId('agent-workflow-required-setup').textContent!, /External workflow actions remain blocked; permitted local skills are still available/u);
    assert(within(standaloneSection).getByRole('button', { name: 'Set up my connection' }));
    assert.match(within(standaloneSection).getByTestId('agent-workflow-choice-issue').textContent!, /No connection is saved yet/u);
    const own = await choosePersonal(standaloneSection), beforeStandalone = writes.length; fireEvent.click(own.profile);
    await within(own.section).findByText('Second design account');
    assert(screen.getByTestId('agent-workflow-required-setup'), 'Viewing accounts is not a saved selection.');
    fireEvent.click(within(own.section).getAllByRole('button', { name: 'This account' })[1]);
    await screen.findByText('Second LinkedIn account'); assert.equal(writes.length, beforeStandalone + 1);
    const standaloneWrite = writes.at(-1)!; assert.equal(standaloneWrite.capabilityKey, standaloneKey);
    assert.equal((standaloneWrite.standaloneSelection as { selection: { target: { accountId: string } } }).selection.target.accountId, 'second');
    assert.equal((within(own.section).getByRole('combobox') as HTMLSelectElement).value, 'personal');
    assert.equal(screen.queryByTestId('agent-workflow-required-setup'), null, 'Only the acknowledged current descriptor clears missing setup.');
    console.log('PASS V2 standalone Use-only exact account selection with required/toolcap rule preserved.');

    current = snapshot(); current.packages[0].declarations[0].capabilities[0].selectionOrigin = 'stale';
    current.packages[0].declarations[0].capabilities[0].selectedChoiceId = null; reopen();
    assert.equal((await screen.findByRole('combobox') as HTMLSelectElement).value, 'unavailable');
    assert(screen.getByText('Selection needs confirmation')); assert(screen.getByTestId('agent-workflow-required-setup'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'choice:b' } });
    assert(screen.getByTestId('agent-workflow-required-setup'), 'An unsaved finite draft does not remove the required setup warning.');

    current = snapshot(); const fixed = current.packages[0].declarations[0].capabilities[1];
    fixed.selectedConnection = { ...fixed.selectedConnection!, status: 'setup_required' }; reopen();
    await screen.findByTestId('agent-workflow-required-setup');
    const fixedSection = screen.getByRole('heading', { name: 'library' }).closest('section')!;
    assert(within(fixedSection).getByTestId('agent-workflow-choice-issue').textContent!.includes('Connection setup required'));
    assert.match(within(fixedSection).getByTestId('agent-workflow-choice-issue').textContent!, /Ask its owner to review it/u);
    assert.equal(within(fixedSection).queryByRole('button', { name: /my connection/u }), null, 'Fixed setup never offers an unauthorized personal choice.');
    assert(screen.getByTestId('agent-workflow-required-setup'));

    current = snapshot(true); current.standalone![0].required = false; reopen();
    await screen.findByRole('combobox', { name: 'Connection for linkedin' });
    assert.equal(screen.queryByTestId('agent-workflow-required-setup'), null, 'An optional missing connection does not claim all external actions are blocked.');
    assert(screen.getByText('No connection is saved yet. Choose a permitted connection and confirm the choice.'));
    console.log('PASS missing/stale/setup-required/optional/unknown states and acknowledged setup semantics.');

    current = snapshot(); current.access.canUse = false; reopen(); assert((await screen.findByRole('combobox') as HTMLSelectElement).disabled);
    assert((screen.getByRole('button', { name: 'Choose my connection' }) as HTMLButtonElement).disabled);
    current = snapshot(); current.unavailablePackageCount = 1; reopen(); await screen.findByText(messages.agentWorkflow.packagesUnavailable);
    assert((screen.getByRole('button', { name: 'Choose my connection' }) as HTMLButtonElement).disabled);
    const beforeBlocked = metadataReads; fireEvent.click(screen.getByRole('button', { name: 'Choose my connection' })); assert.equal(metadataReads, beforeBlocked);
    current.packages = []; reopen(); await screen.findByText(messages.agentWorkflow.packagesUnavailable); assert.equal(Boolean(screen.queryByText(messages.agentWorkflow.noSlots)), false);
    console.log('PASS stale no-fallback, Use denial and unavailable package fences.');

    cleanup(); current = snapshot(); holdRead = true; const view = render(form()); await waitFor(() => assert(held));
    const old = held as { resolve(value: Response): void; signal?: AbortSignal | null } | null; assert(old);
    context = { ...team, workspaceId: 'other-team', projectId: 'other-project' };
    current = snapshot(); current.packages[0].declarations[0].capabilities[0].choices[0].label = 'Current team account'; view.rerender(form());
    await screen.findByRole('option', { name: 'Current team account · Organization' }); assert.equal(old.signal?.aborted, true);
    const late = snapshot(); late.packages[0].declarations[0].capabilities[0].choices[0].label = 'Late old team account';
    await act(async () => { old.resolve(Response.json({ success: true, data: late })); }); assert.equal(Boolean(screen.queryByRole('option', { name: /Late old team/u })), false);
    holdRead = true; held = null; context = { ...context, projectId: 'pending-project' }; view.rerender(form()); await waitFor(() => assert(held));
    const oldActor = held as { resolve(value: Response): void; signal?: AbortSignal | null } | null; assert(oldActor);
    context = { ...context, actorId: 'actor-b' }; current = snapshot(); view.rerender(form()); await screen.findByRole('combobox');
    assert.equal(oldActor.signal?.aborted, true); await act(async () => { oldActor.resolve(Response.json({ success: true, data: late })); });
    assert.equal(Boolean(screen.queryByRole('option', { name: /Late old team/u })), false);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'global-personal-workspace');
    console.log('PASS explicit scope overrides global workspace, late workspace/actor replies discarded.');

    cleanup(); current = snapshot();
    function FocusHarness() {
      const [open, setOpen] = React.useState(true), trigger = React.useRef<HTMLButtonElement>(null);
      return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><button type="button" ref={trigger} onClick={() => setOpen(true)}>Workflow trigger</button>
        <AgentWorkflowChoiceDialog open={open} agentId="workflow-agent" agentName="Design Agent" context={context} onOpenChange={setOpen} onRestoreFocus={() => trigger.current?.focus()} /></NextIntlClientProvider>;
    }
    render(<FocusHarness />); await screen.findByRole('combobox'); fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => assert.equal(Boolean(screen.queryByRole('dialog')), false)); await waitFor(() => assert.equal(document.activeElement === screen.getByRole('button', { name: 'Workflow trigger' }), true));
    console.log(`PASS workflow-choice UI (${writes.length} writes): actual V1/V2 dialog/common chooser/codec, explicit account, failure/CAS/authority/scope/focus; controlled HTTP only, no SQL/provider/browser/model claim.`);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
