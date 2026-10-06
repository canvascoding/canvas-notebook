import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { AgentWorkflowDescriptor } from '../app/lib/agents/workflow-contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window', 'self', 'document', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
  'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'FocusEvent']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });

const capabilityKey = `agent-capability:${'a'.repeat(43)}`;
const snapshot = (): AgentWorkflowDescriptor => ({ agentId: 'workflow-agent', revision: 2, workflowVersion: 1, workflowRevision: 1, preferenceRevision: 1,
  access: { canUse: true, canEdit: false, canManage: false }, packages: [{ resourceRef: 'canvas-resource:owned', publishedRevisionRef: 'canvas-package-revision:owned', checksum: 'a'.repeat(64), name: 'Design workflow',
    declarations: [{ declarationPath: 'skills/design/agents/canvas.yaml', capabilities: [{ capabilityKey, capabilityId: 'design', application: 'canva', required: true,
      selectionMode: 'selectable', selectionOrigin: 'default', selectedKind: 'shared', selectedChoiceId: 'a', personalChoiceAllowed: false,
      selectedConnection: { label: 'Studio design account', availability: 'available', status: 'unknown', scopeLabel: 'organization', source: 'mcp' }, choices: [
        { choiceId: 'a', kind: 'shared', label: 'Studio design account', availability: 'available', status: 'unknown', scopeLabel: 'organization', source: 'mcp' },
        { choiceId: 'b', kind: 'shared', label: 'Campaign account', availability: 'available', status: 'unknown', scopeLabel: 'team', source: 'composio' },
        { choiceId: 'revoked', kind: 'shared', label: 'Unavailable connection', availability: 'unavailable', status: 'unavailable' },
      ] }, { capabilityKey: 'fixed-design', capabilityId: 'fixed', application: 'library', required: true, selectionMode: 'fixed', selectionOrigin: 'fixed', selectedKind: 'shared', selectedChoiceId: null,
        personalChoiceAllowed: false, choices: [], selectedConnection: { label: 'Brand library', availability: 'available', status: 'unknown', scopeLabel: 'organization' } }] }] }] });

async function main() {
  const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
  const { AgentWorkflowChoiceDialog } = await import('../app/components/agents/AgentWorkflowChoiceDialog');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useWorkspaceStore.setState({ activeWorkspaceId: 'personal-workflow' });
  const originalFetch = globalThis.fetch;
  let current = snapshot(), conflict = false, failedRead = false, failedProbe = false;
  const writes: Record<string, unknown>[] = [], reads: URL[] = [];
  let personalReads = 0, accountProbes = 0;
  const response = (value: unknown, status = 200) => Response.json(value, { status });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost'); assert.equal(url.pathname, '/api/agents/workflow');
    assert.equal(url.searchParams.get('workspaceId'), 'personal-workflow'); assert.equal(init?.credentials, 'include');
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push(body);
      assert.deepEqual(Object.keys(body).sort(), ['agentId', 'capabilityKey', body.personalSelection ? 'personalSelection' : 'choiceId', 'expectedPreferenceRevision', 'expectedWorkflowRevision'].sort());
      if (conflict) { conflict = false; current.preferenceRevision += 1; current.workflowRevision += 1; return response({ success: false, code: 'AGENT_WORKFLOW_REVISION_CONFLICT' }, 409); }
      assert.equal(body.expectedPreferenceRevision, current.preferenceRevision); assert.equal(body.expectedWorkflowRevision, current.workflowRevision);
      current.preferenceRevision += 1;
      const capability = current.packages[0].declarations[0].capabilities[0];
      if (body.personalSelection) {
        assert.deepEqual(body.personalSelection, { alternativeKey: 'composio:canva', target: { kind: 'personal', source: 'composio', providerRef: 'opaque-provider-design', accountSelectionRef: 'sealed-second-account' } });
        capability.selectionOrigin = 'user'; capability.selectedKind = 'personal'; capability.selectedChoiceId = null;
        capability.selectedConnection = { label: 'Personal Composio connection', availability: 'available', status: 'unknown', scopeLabel: 'personal', source: 'composio' };
        return response({ success: true, data: current });
      }
      capability.selectionOrigin = body.choiceId === null ? 'default' : 'user'; capability.selectedChoiceId = body.choiceId === null ? 'a' : String(body.choiceId);
      const selected = capability.choices.find(choice => choice.choiceId === capability.selectedChoiceId)!;
      capability.selectedConnection = { ...selected }; return response({ success: true, data: current });
    }
    if (url.searchParams.get('view') === 'personal-options') {
      personalReads += 1; const probe = url.searchParams.get('providerRef');
      if (probe) { accountProbes += 1; assert.equal(probe, 'opaque-provider-design'); assert.equal(url.searchParams.get('alternativeKey'), 'composio:canva'); }
      if (probe && failedProbe) { failedProbe = false; return response({ success: false, code: 'AGENT_WORKFLOW_PERSONAL_PROVIDER_UNAVAILABLE' }, 503); }
      return response({ success: true, data: { agentId: 'workflow-agent', workflowRevision: current.workflowRevision, preferenceRevision: current.preferenceRevision,
        capabilityKey, alternatives: [{ alternativeKey: 'composio:canva', source: 'composio', providers: probe ? [
          { providerRef: probe, label: 'Canva', profileLabel: 'Design profile', origin: 'personal', status: 'available', noAuth: false, accounts: [
            { accountSelectionRef: 'sealed-first-account', label: 'First design account', status: 'ACTIVE', selectable: true },
            { accountSelectionRef: 'sealed-second-account', label: 'Second design account', status: 'ACTIVE', selectable: true },
          ] },
        ] : [
          { providerRef: 'opaque-provider-design', label: 'Canva', profileLabel: 'Design profile', origin: 'personal', status: 'unverified' },
          { providerRef: 'opaque-provider-campaign', label: 'Canva', profileLabel: 'Campaign profile', origin: 'personal', status: 'unverified' },
        ] }] } });
    }
    reads.push(url);
    if (failedRead) { failedRead = false; return response({ success: false }, 503); }
    return response({ success: true, data: current });
  };
  const form = () => <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <AgentWorkflowChoiceDialog open agentId="workflow-agent" agentName="Design Agent" onOpenChange={() => {}} />
  </NextIntlClientProvider>;
  try {
    render(form());
    const select = await screen.findByRole('combobox', { name: 'Connection for canva' }) as HTMLSelectElement;
    assert.equal(select.value, 'default'); assert.equal(screen.getAllByRole('combobox').length, 1, 'The centrally fixed binding must never become an editor.');
    assert((screen.getByRole('option', { name: /Unavailable connection/u }) as HTMLOptionElement).disabled);
    assert(!document.body.textContent?.includes('canvas-resource:owned')); assert(!document.body.textContent?.includes('agent-capability:'));
    fireEvent.change(select, { target: { value: 'choice:b' } }); conflict = true; fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await screen.findByRole('alert'); assert.equal(select.value, 'choice:b'); assert.equal(writes.length, 1);
    assert((screen.getByRole('button', { name: 'Save choice' }) as HTMLButtonElement).disabled, '409 must fence retries until a successful reload.');
    failedRead = true; fireEvent.click(screen.getByRole('button', { name: 'Reload current choices' }));
    await screen.findByText(messages.agentWorkflow.errors.load); assert.equal(select.value, 'choice:b');
    assert((screen.getByRole('button', { name: 'Save choice' }) as HTMLButtonElement).disabled, 'A failed reload may not refresh the draft CAS.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload current choices' }));
    await waitFor(() => assert.equal(Boolean(screen.queryByRole('alert')), false)); assert.equal(select.value, 'choice:b');
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await screen.findByRole('button', { name: 'Saved' }); assert.equal(writes.length, 2); assert.equal(writes[1].expectedWorkflowRevision, 2); assert.equal(writes[1].expectedPreferenceRevision, 2);
    fireEvent.change(select, { target: { value: 'default' } }); fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(() => assert.equal(writes.length, 3)); assert.equal(writes[2].choiceId, null, 'Default reset must send explicit null.');
    await screen.findByRole('button', { name: 'Saved' });
    cleanup();
    current = snapshot(); current.packages[0].declarations[0].capabilities[0].personalChoiceAllowed = true;
    render(form()); await screen.findByRole('combobox', { name: 'Connection for canva' });
    assert.equal(personalReads, 0, 'Opening the shared chooser must not load personal providers or probe accounts.');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a personal connection' }));
    const providers = await screen.findByRole('combobox', { name: 'Personal connection' }) as HTMLSelectElement;
    assert.equal(personalReads, 1); assert.equal(accountProbes, 0);
    assert(screen.getByRole('option', { name: 'Canva · Design profile · Composio' })); assert(screen.getByRole('option', { name: 'Canva · Campaign profile · Composio' }));
    fireEvent.change(providers, { target: { value: JSON.stringify(['composio:canva', 'opaque-provider-design']) } });
    const account = await screen.findByRole('combobox', { name: 'Connected account' }) as HTMLSelectElement;
    assert.equal(accountProbes, 1); assert.equal(account.value, '', 'Multiple ACTIVE accounts must never produce an implicit default selection.');
    assert((screen.getByRole('button', { name: 'Use this connection' }) as HTMLButtonElement).disabled);
    fireEvent.change(account, { target: { value: 'sealed-second-account' } }); fireEvent.click(screen.getByRole('button', { name: 'Use this connection' }));
    await waitFor(() => assert.equal(writes.length, 4)); await screen.findByText('Personal Composio connection');
    assert.equal((screen.getByRole('combobox', { name: 'Connection for canva' }) as HTMLSelectElement).value, 'personal');
    assert(!JSON.stringify(writes[3]).includes('ownerUserId')); assert(!JSON.stringify(writes[3]).includes('profileId')); assert(!JSON.stringify(writes[3]).includes('connectedAccountId'));
    cleanup();
    current = snapshot(); current.packages[0].declarations[0].capabilities[0].personalChoiceAllowed = true;
    render(form()); const sharedDraft = await screen.findByRole('combobox', { name: 'Connection for canva' }) as HTMLSelectElement;
    fireEvent.change(sharedDraft, { target: { value: 'choice:b' } });
    const probesBeforeFailure = accountProbes, writesBeforeFailure = writes.length;
    fireEvent.click(screen.getByRole('button', { name: 'Choose a personal connection' }));
    const unavailableProvider = await screen.findByRole('combobox', { name: 'Personal connection' }); failedProbe = true;
    fireEvent.change(unavailableProvider, { target: { value: JSON.stringify(['composio:canva', 'opaque-provider-design']) } });
    const credentialsLink = await screen.findByRole('link', { name: 'Check credentials' });
    assert.equal(credentialsLink.getAttribute('href'), '/settings?tab=secrets');
    assert.equal(accountProbes, probesBeforeFailure + 1); assert.equal(writes.length, writesBeforeFailure);
    assert.equal(current.preferenceRevision, 1); assert.equal(sharedDraft.value, 'choice:b');
    assert.equal(Boolean(screen.queryByRole('button', { name: 'Use this connection' })), false); cleanup();
    current = snapshot(); const capability = current.packages[0].declarations[0].capabilities[0]; capability.selectionOrigin = 'stale'; capability.selectedChoiceId = null; capability.selectedConnection = undefined;
    render(form()); const stale = await screen.findByRole('combobox') as HTMLSelectElement;
    assert.equal(stale.value, 'unavailable', 'An explicit stale choice must not appear as the admin default.'); cleanup();
    current = snapshot(); current.access.canUse = false;
    render(form()); assert((await screen.findByRole('combobox') as HTMLSelectElement).disabled); cleanup();
    current = snapshot(); current.unavailablePackageCount = 1; current.packages[0].declarations[0].capabilities[0].personalChoiceAllowed = true;
    render(form()); await screen.findByText(messages.agentWorkflow.packagesUnavailable);
    assert((screen.getByRole('combobox', { name: 'Connection for canva' }) as HTMLSelectElement).disabled);
    const personalReadsBeforeBlock = personalReads, writesBeforeBlock = writes.length;
    const blockedPersonal = screen.getByRole('button', { name: 'Choose a personal connection' }) as HTMLButtonElement;
    assert(blockedPersonal.disabled); assert((screen.getByRole('button', { name: 'Save choice' }) as HTMLButtonElement).disabled);
    fireEvent.click(blockedPersonal); fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    assert.equal(personalReads, personalReadsBeforeBlock); assert.equal(writes.length, writesBeforeBlock);
    assert(!(screen.getByRole('button', { name: 'Reload current choices' }) as HTMLButtonElement).disabled);
    assert(screen.getAllByRole('button', { name: 'Close' }).every(button => !(button as HTMLButtonElement).disabled)); cleanup();
    current.packages = []; render(form()); await screen.findByText(messages.agentWorkflow.packagesUnavailable);
    assert.equal(Boolean(screen.queryByText(messages.agentWorkflow.noSlots)), false); cleanup();
    current = snapshot();
    function FocusHarness() {
      const [open, setOpen] = React.useState(true);
      const trigger = React.useRef<HTMLButtonElement>(null);
      return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <button ref={trigger} type="button" onClick={() => setOpen(true)}>Workflow trigger</button>
        <AgentWorkflowChoiceDialog open={open} agentId="workflow-agent" agentName="Design Agent" onOpenChange={setOpen} onRestoreFocus={() => trigger.current?.focus()} />
      </NextIntlClientProvider>;
    }
    render(<FocusHarness />); await screen.findByRole('combobox');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => assert.equal(Boolean(screen.queryByRole('dialog')), false));
    await waitFor(() => assert.equal(document.activeElement === screen.getByRole('button', { name: 'Workflow trigger' }), true));
    cleanup();
    console.log(`PASS workflow-choice UI: shared/personal exact selection, lazy account probes, 409/503 draft+CAS fence, explicit null reset, stale no-fallback, unavailable-package fence and Escape/focus (${reads.length} reads/${writes.length} writes).`);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
