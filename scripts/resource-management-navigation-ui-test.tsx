import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityResourceDescriptor, CapabilityResourceMutation } from '../app/lib/capabilities/resources/contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://canvas.test/plugins?task=sharing', pretendToBeVisual: true,
});
const globals = ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'SVGElement', 'Element', 'Node', 'NodeFilter',
  'Document', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent',
  'FocusEvent', 'getComputedStyle', 'PointerEvent', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT',
  'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const previous = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
for (const name of globals) {
  const value = name === 'IS_REACT_ACT_ENVIRONMENT' ? true
    : name === 'PointerEvent' ? dom.window.MouseEvent
      : name === 'ResizeObserver' ? class { observe() {} unobserve() {} disconnect() {} }
        : name === 'requestAnimationFrame' || name === 'cancelAnimationFrame' ? dom.window[name].bind(dom.window)
          : dom.window[name as keyof Window];
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
function descriptor(): CapabilityResourceDescriptor {
  return {
    metadata: { resourceRef, legacyResourceId: 'canvas-capability:v1:plugin:organization:fixture:standalone:design',
      resourceType: 'plugin', sourceType: 'standalone', sourcePluginId: null,
      ownership: { type: 'organization', organizationId: 'fixture-org' }, displayName: 'Saved title',
      description: 'Saved description', responsibleUserId: null, createdByUserId: 'creator', updatedByUserId: 'creator',
      metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
    artifact: { resourceId: 'canvas-capability:v1:plugin:organization:fixture:standalone:design', resourceType: 'plugin',
      scopeType: 'organization', name: 'design', version: '1.0.0', revision: 1, checksum: 'a'.repeat(64), sourceType: 'standalone', sourcePluginId: null },
    access: { canRead: true, canUse: false, canEdit: true, canManage: true }, grants: [],
  };
}

async function main() {
  const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const { ResourceManagementSection } = await import('../app/components/plugins/ResourceManagementSection');
  const { PluginNavigationGuard, confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  let current = descriptor(), reads = 0, updates = 0, accepts = false, confirmations = 0;
  let nextWriteStatus = 200, barrier: Promise<void> | undefined;
  const writes: Array<{ method: string; workspace: string | null; input: CapabilityResourceMutation & { ownership?: { type: string; workspaceId?: string } } }> = [];
  window.confirm = () => { confirmations += 1; return accepts; };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test');
    const method = init?.method || 'GET';
    assert(url.pathname.startsWith(`/api/capabilities/resources/${encodeURIComponent(resourceRef)}`));
    if (method === 'GET') {
      reads += 1;
      assert.equal(init?.cache, 'no-store');
      const data = url.pathname.endsWith('/targets') ? { targets: {
        users: [{ userId: 'recipient', name: 'Recipient', email: null, role: 'member' }],
        workspaces: [{ workspaceId: 'design-team', name: 'Design team', type: 'team' }], projects: [],
      } } : { resource: structuredClone(current) };
      return Response.json({ success: true, data });
    }
    assert(['PATCH', 'POST'].includes(method), 'the fixture accepts only the explicit resource Save');
    const mutation = JSON.parse(String(init?.body)) as typeof writes[number]['input'];
    writes.push({ method, workspace: url.searchParams.get('workspaceId'), input: mutation });
    await barrier;
    if (nextWriteStatus === 409) {
      nextWriteStatus = 200;
      current.metadata.metadataRevision += 1;
      current.metadata.displayName = 'Concurrent title';
      return Response.json({ success: false, code: 'RESOURCE_REVISION_CONFLICT' }, { status: 409 });
    }
    if (mutation.metadata) {
      Object.assign(current.metadata, mutation.metadata);
      current.metadata.metadataRevision += 1;
    }
    if (mutation.accessMode) current.metadata.accessMode = mutation.accessMode;
    if (mutation.grants) {
      current.grants = mutation.grants.map((grant, index) => ({ ...grant, id: `grant-${index}`, resourceRef,
        createdByUserId: 'creator', updatedByUserId: 'creator', createdAt: 1, updatedAt: 1 }));
      current.metadata.grantsRevision += 1;
    }
    return Response.json({ success: true, data: { resource: structuredClone(current) } });
  };
  function Harness() {
    const [epoch, setEpoch] = React.useState(0), [workspace, setWorkspace] = React.useState('workspace-a');
    return <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <PluginNavigationGuard unsavedChangesMessage="Discard sharing changes?" />
      <button data-testid="header-reload" onClick={() => { if (confirmPluginNavigation()) setEpoch(value => value + 1); }}>Header reload</button>
      <button data-testid="change-scope" onClick={() => { if (confirmPluginNavigation()) setWorkspace('workspace-b'); }}>Change scope</button>
      <output data-testid="current-scope">{workspace}</output>
      <ResourceManagementSection key={`${workspace}:${epoch}`} resourceRef={resourceRef} workspaceId={workspace} onUpdated={() => { updates += 1; }} />
    </NextIntlClientProvider>;
  }
  const reset = () => {
    cleanup(); current = descriptor(); reads = 0; writes.length = 0; updates = 0;
    accepts = false; confirmations = 0; barrier = undefined; nextWriteStatus = 200;
    window.history.replaceState(null, '', '/plugins?view=installed');
    window.history.pushState(null, '', '/plugins?task=sharing');
  };
  async function mount() {
    render(<Harness />);
    await screen.findByTestId('resource-display-name');
    await waitFor(() => assert.equal((screen.getByTestId('resource-save') as HTMLButtonElement).disabled, false));
    (screen.getByTestId('resource-management').querySelector('details') as HTMLDetailsElement).open = true;
    assert.equal(confirmPluginNavigation(), true, 'the loaded form has no unsaved draft');
  }
  try {
    reset(); await mount();
    const name = screen.getByTestId('resource-display-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Keep local title' } });
    const initialReads = reads;
    fireEvent.click(screen.getByTestId('header-reload'));
    fireEvent.click(screen.getByTestId('change-scope'));
    assert.equal(confirmations, 2); assert.equal(reads, initialReads); assert.equal(writes.length, 0);
    assert.equal(name.value, 'Keep local title'); assert.equal(screen.getByTestId('current-scope').textContent, 'workspace-a');
    const href = window.location.href, beforeHistory = confirmations;
    let routerTraversals = 0;
    const router = () => { routerTraversals += 1; };
    window.addEventListener('popstate', router);
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 40)); });
    await waitFor(() => assert.equal(confirmations, beforeHistory + 1));
    await waitFor(() => assert.equal(window.location.href, href));
    window.removeEventListener('popstate', router);
    assert.equal(routerTraversals, 0, 'cancelled history and restoration never reach router consumers');
    assert.equal(name.value, 'Keep local title'); assert.equal(writes.length, 0);
    fireEvent.change(name, { target: { value: 'Saved title' } });
    assert.equal(confirmPluginNavigation(), true, 'reverting the actual draft unregisters dirty state');
    fireEvent.change(screen.getByTestId('resource-description'), { target: { value: 'Local business description' } });
    assert.equal(confirmPluginNavigation(), false);
    fireEvent.change(screen.getByTestId('resource-description'), { target: { value: 'Saved description' } });
    fireEvent.change(screen.getByTestId('resource-access-mode'), { target: { value: 'inherit' } });
    assert.equal(confirmPluginNavigation(), false);
    fireEvent.change(screen.getByTestId('resource-access-mode'), { target: { value: 'restricted' } });
    fireEvent.click(screen.getByTestId('resource-new-canUse'));
    assert.equal(confirmPluginNavigation(), false, 'rights not yet added to a grant are still local input');
    fireEvent.click(screen.getByTestId('resource-new-canUse'));
    fireEvent.click(screen.getByTestId('resource-grant-target'));
    await screen.findByTestId('resource-grant-target-option-recipient');
    fireEvent.click(screen.getByTestId('resource-grant-target-option-recipient'));
    assert.equal(confirmPluginNavigation(), false, 'an unstaged chosen recipient is retained');
    assert.equal(writes.length, 0);

    reset(); await mount();
    fireEvent.change(screen.getByTestId('resource-display-name'), { target: { value: 'Saved through explicit CAS' } });
    let release!: () => void;
    barrier = new Promise<void>(resolve => { release = resolve; });
    fireEvent.click(screen.getByTestId('resource-save'));
    await waitFor(() => assert.equal(writes.length, 1));
    assert.deepEqual(writes[0], { method: 'PATCH', workspace: 'workspace-a', input: {
      expectedMetadataRevision: 1, expectedGrantsRevision: 1,
      metadata: { displayName: 'Saved through explicit CAS' },
    } });
    const pendingReads = reads, pendingConfirmations = confirmations;
    accepts = true;
    fireEvent.click(screen.getByTestId('header-reload')); fireEvent.click(screen.getByTestId('change-scope'));
    assert.equal(confirmPluginNavigation(), false); assert.equal(confirmations, pendingConfirmations);
    assert.equal(reads, pendingReads); assert.equal(screen.getByTestId('current-scope').textContent, 'workspace-a');
    assert.equal(writes.length, 1, 'pending navigation cannot launch a duplicate Save');
    await act(async () => { release(); });
    await waitFor(() => assert.equal(updates, 1));
    await waitFor(() => assert.equal((screen.getByTestId('resource-save') as HTMLButtonElement).disabled, false));
    assert.equal(confirmPluginNavigation(), true, 'successful Save refresh is internal and clears the saved draft');
    assert.equal(confirmations, pendingConfirmations);

    reset(); await mount();
    fireEvent.change(screen.getByTestId('resource-display-name'), { target: { value: 'Conflict draft survives' } });
    // The target composer can already contain input when the CAS conflict is returned.
    fireEvent.click(screen.getByTestId('resource-new-canUse'));
    fireEvent.click(screen.getByTestId('resource-grant-target'));
    await screen.findByTestId('resource-grant-target-option-recipient');
    fireEvent.click(screen.getByTestId('resource-grant-target-option-recipient'));
    nextWriteStatus = 409; fireEvent.click(screen.getByTestId('resource-save'));
    await screen.findByText(messages.skills.resourceManagement.conflict);
    await waitFor(() => assert.equal((screen.getByTestId('resource-display-name') as HTMLInputElement).value, 'Conflict draft survives'));
    const conflictReads = reads;
    fireEvent.click(screen.getByText(messages.skills.resourceManagement.reload));
    assert.equal(reads, conflictReads); assert.equal(writes.length, 1);
    assert.equal((screen.getByTestId('resource-new-canUse') as HTMLInputElement).checked, true);
    assert(screen.getByTestId('resource-grant-target').textContent?.includes('Recipient'));
    assert(screen.getByText(messages.skills.resourceManagement.conflict), 'cancelled section Reload retains conflict and draft');
    accepts = true; fireEvent.click(screen.getByText(messages.skills.resourceManagement.reload));
    await waitFor(() => assert.equal((screen.getByTestId('resource-display-name') as HTMLInputElement).value, 'Concurrent title'));
    await waitFor(() => assert.equal((screen.getByTestId('resource-save') as HTMLButtonElement).disabled, false));
    assert.equal((screen.getByTestId('resource-new-canUse') as HTMLInputElement).checked, false);
    assert(!screen.getByTestId('resource-grant-target').textContent?.includes('Recipient'));
    assert.equal(confirmPluginNavigation(), true);
    fireEvent.change(screen.getByTestId('resource-description'), { target: { value: 'New explicit draft' } });
    fireEvent.click(screen.getByTestId('resource-save'));
    await waitFor(() => assert.equal(writes.length, 2));
    assert.equal(writes[1].input.expectedMetadataRevision, 2, 'explicit conflict reload uses fresh CAS without blind compensation');
    assert.equal(writes[1].input.expectedGrantsRevision, 1);
    assert.deepEqual(writes[1].input.metadata, { description: 'New explicit draft' }, 'description-only changes omit the unchanged display name');
    await waitFor(() => assert.equal(updates, 1));

    reset(); await mount();
    fireEvent.click(screen.getByTestId('resource-grant-target'));
    await screen.findByTestId('resource-grant-target-option-recipient');
    fireEvent.click(screen.getByTestId('resource-grant-target-option-recipient'));
    fireEvent.click(screen.getByTestId('resource-new-canUse'));
    fireEvent.click(screen.getByText(messages.skills.resourceManagement.addGrant));
    fireEvent.click(screen.getByTestId('resource-save'));
    await waitFor(() => assert.equal(updates, 1));
    assert.deepEqual(writes[0].input, { expectedMetadataRevision: 1, expectedGrantsRevision: 1,
      grants: [{ targetType: 'user', targetId: 'recipient', canUse: true, canEdit: false, canManage: false }] },
    'grants-only Save omits metadata entirely even when the actor can also edit metadata');
    assert.equal(current.metadata.metadataRevision, 1);
    assert.equal(current.metadata.grantsRevision, 2);
    assert.equal(confirmPluginNavigation(), true);

    reset(); current.metadata.metadataRevision = 0; current.metadata.grantsRevision = 0;
    await mount();
    fireEvent.change(screen.getByTestId('resource-owner-scope'), { target: { value: 'team' } });
    assert.equal(confirmPluginNavigation(), false, 'unmanaged ownership selection is unsaved configuration');
    fireEvent.click(screen.getByTestId('header-reload'));
    assert.equal((screen.getByTestId('resource-owner-scope') as HTMLSelectElement).value, 'team');
    assert.equal(writes.length, 0);

    reset(); current.access.canEdit = false;
    await mount();
    assert.equal((screen.getByTestId('resource-display-name') as HTMLInputElement).disabled, true);
    fireEvent.change(screen.getByTestId('resource-access-mode'), { target: { value: 'inherit' } });
    fireEvent.click(screen.getByTestId('resource-save'));
    await waitFor(() => assert.equal(updates, 1));
    assert.deepEqual(writes[0].input, { expectedMetadataRevision: 1, expectedGrantsRevision: 1, accessMode: 'inherit' },
      'manage-only changes still send no metadata edit or implicit Use rights');
    cleanup(); assert.equal(confirmPluginNavigation(), true, 'unmount removes only this editor registration');
    console.log('PASS actual ResourceManagement/PluginGuard: dirty reload/scope/history, staged recipients, pending CAS Save, retained409 draft and independent rights.');
  } finally {
    cleanup(); globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close();
    globals.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
