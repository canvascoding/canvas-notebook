import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection, CapabilityPackageStoreUpdateReview } from '../app/lib/capabilities/packages/store-contracts';
import type { CapabilityPackageStoreInstallOptions } from '../app/lib/capabilities/packages/store-install-options-contracts';
import type { StorePackageWizardProps } from '../app/components/plugins/StorePackageWizard';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement',
  'HTMLDetailsElement', 'Element', 'Node', 'NodeFilter', 'Document', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
const source: CapabilityPackageStoreSelection = { kind: 'plugin', registryId: 'store', entryKey: 'design-package', version: '2.0.0', checksum: 'b'.repeat(64) };
const resourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const revisionRef = 'canvas-package-revision:22222222-2222-4222-8222-222222222222';
const preview: CapabilityPackagePresentation = { schemaVersion: 1, origin: 'store', kind: 'plugin', name: source.entryKey, version: source.version,
  title: 'Design package', description: 'A complete design workflow.', source, children: [{ name: 'design-skill', title: 'Design skill', description: 'Prepare designs.', version: '2.0.0' }],
  scripts: [{ skillName: 'design-skill', id: 'prepare', title: 'Prepare assets', runtime: { kind: 'node', minimumVersion: '22' } }],
  capabilities: [{ declaredBy: { kind: 'plugin', name: source.entryKey }, id: 'design', application: 'Canva', required: true, alternatives: [{ source: 'composio', label: 'Composio' }, { source: 'mcp', label: 'MCP' }] }],
  requirements: [{ declaredBy: { kind: 'skill', name: 'design-skill' }, source: 'canvas-email', label: 'Canvas email', required: false, recommended: true }],
  compatibility: ['Web'], minCanvasVersion: '2026.10.4.1', requiredEnv: ['DESIGN_KEY'], readOnly: false, sourceStampCurrent: true };
const installed: CapabilityPackagePresentation = { ...preview, origin: 'installed', source: undefined, resourceRef, version: '1.0.0',
  children: [{ name: 'design-skill', title: 'Design skill', description: 'Prepare designs.', version: '1.0.0' }], scripts: [], requirements: [], capabilities: [] };
const review: CapabilityPackageStoreUpdateReview = { schemaVersion: 1, resourceRef, source, current: { version: '1.0.0', checksum: 'c'.repeat(64), upstreamVersion: '1.0.0' },
  localChanges: 'modified', expectedMetadataRevision: 7, expectedGrantsRevision: 9, expectedPackageRevision: 3, expectedPublishedRevisionRef: revisionRef,
  expectedLocalChecksum: 'c'.repeat(64), requiresLocalChangesConfirmation: true, canUpdate: true };
const options: CapabilityPackageStoreInstallOptions = { schemaVersion: 1, source, ownership: { type: 'team', organizationId: 'own-org', workspaceId: 'own-team' }, ownershipLabel: 'Design team',
  targets: { users: [{ userId: 'bob', name: 'Bob', email: 'bob@example.test', role: 'member' }, { userId: 'cara', name: 'Cara', email: 'cara@example.test', role: 'member' }], workspaces: [], projects: [] } };
const applicationResult: CapabilityPackageStoreApplicationResult = {
  schemaVersion: 1,
  resource: { resourceRef, legacyResourceId: 'canvas-capability:v1:plugin:org:own-org:standalone:design-package', resourceType: 'plugin', sourceType: 'standalone', sourcePluginId: null,
    ownership: { type: 'team', organizationId: 'own-org', workspaceId: 'own-team' }, displayName: null, description: null, responsibleUserId: 'bob', createdByUserId: 'creator', updatedByUserId: 'creator',
    metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
  state: { contractVersion: 1, resourceRef, kind: 'plugin', name: source.entryKey, packageRevision: 1, currentPublishedRevisionRef: revisionRef, updatedByUserId: 'creator', updatedAt: 1,
    currentSourceStamp: { resourceId: 'canvas-capability:v1:plugin:org:own-org:standalone:design-package', kind: 'plugin', name: source.entryKey, version: source.version,
      artifactRevision: 1, registryChecksum: source.checksum, checksum: source.checksum, sourcePluginId: null } },
  published: { revisionRef, resourceRef, kind: 'plugin', name: source.entryKey, version: source.version, checksum: source.checksum,
    publishedByUserId: 'creator', publishedAt: 1, baseRevisionRef: null, fileCount: 3, totalBytes: 100 },
};

type Request = { path: string; workspace: string | null; headerWorkspace: string | null; method: string; body?: Record<string, unknown>; signal?: AbortSignal | null };
function deferred() { let release!: () => void; return { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }

async function main() {
  const { render, screen, fireEvent, cleanup, waitFor, act, within } = await import('@testing-library/react');
  const { StorePackageWizard } = await import('../app/components/plugins/StorePackageWizard');
  const { confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  const requests: Request[] = [];
  let handler: (request: Request) => Promise<Response>;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin), headers = new Headers(init?.headers);
    const request: Request = { path: url.pathname, workspace: url.searchParams.get('workspaceId'), headerWorkspace: headers.get('x-canvas-workspace-id'), method: init?.method || 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined, signal: init?.signal };
    assert(url.pathname.startsWith('/api/capabilities/packages/'), 'Focused component fixture substitutes only SafeDTO HTTP transport.');
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'same-origin'); assert.equal(request.headerWorkspace, request.workspace);
    requests.push(request); return handler(request);
  };
  const success = (data: unknown) => Response.json({ success: true, data });
  const failure = (status: number, code: string) => Response.json({ success: false, code, error: 'SECRET_PROVIDER_MESSAGE' }, { status });
  const base = async (request: Request) => {
    if (request.path.endsWith('/store/preview')) { assert.deepEqual(request.body, { source }); return success({ presentation: preview }); }
    if (request.path.endsWith('/scopes')) return success({ scopes: [{ type: 'user', label: 'Personal' }, { type: 'organization', label: 'Organization' }, { type: 'team', workspaceId: 'own-team', label: 'Design team' }] });
    if (request.path.endsWith('/store/install-options')) { assert.deepEqual(request.body, { source, ownership: { type: 'team', workspaceId: 'own-team' } }); return success(options); }
    if (request.path.endsWith('/presentation')) return success({ presentation: installed });
    if (request.path.endsWith('/store-update/review')) { assert.deepEqual(request.body, { source }); return success(review); }
    throw new Error(`Unexpected component request ${request.path}`);
  };
  const labels = messages.skills.workspace.storeWizard;
  const installedResults: CapabilityPackageStoreApplicationResult[] = [], updatedResults: CapabilityPackageStoreApplicationResult[] = [];
  let closed = 0, confirmations = 0;
  window.confirm = () => { confirmations += 1; return false; };
  const props: StorePackageWizardProps = { source, workspaceId: 'execution-workspace', initialOwnership: { type: 'team', workspaceId: 'own-team' },
    onInstalled: (value: CapabilityPackageStoreApplicationResult) => { assert.equal(confirmPluginNavigation(), true, 'Success callback runs after the committed pending guard clears.'); installedResults.push(value); },
    onUpdated: (value: CapabilityPackageStoreApplicationResult) => { assert.equal(confirmPluginNavigation(), true); updatedResults.push(value); }, onClose: () => { closed += 1; } };
  const view = (values: StorePackageWizardProps) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><StorePackageWizard {...values} /></NextIntlClientProvider>;
  const pick = async (testId: string, name: string) => {
    fireEvent.click(screen.getByTestId(testId));
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-content"][data-state="open"]'); assert(popup, 'Picker owns an open scoped popup.');
    const search = within(popup).getByRole('combobox', { name: labels.searchPeople }); assert.equal(search.getAttribute('placeholder'), labels.searchPeople);
    fireEvent.change(search, { target: { value: name } });
    fireEvent.click(within(popup).getByRole('option', { name: new RegExp(name) }));
  };
  try {
    // New symbols are unindexed; scope is this real component + actual picker/guard, with HTTP transport only substituted.
    const installHold = deferred();
    handler = async request => request.path.endsWith('/store/install') ? (await installHold.wait, success(applicationResult)) : base(request);
    render(view(props));
    await screen.findByRole('button', { name: labels.confirmTarget });
    await waitFor(() => assert.equal((screen.getByTestId('store-wizard-target') as HTMLSelectElement).value, 'team:own-team'));
    assert.equal(requests.some(request => request.path.endsWith('/store/install-options')), false, 'The directory is lazy until explicit target confirmation.');
    fireEvent.click(screen.getByText(labels.packageDetails));
    await screen.findByText('Prepare assets'); assert(screen.getByText('Canva')); assert(screen.getByText('Canvas email'));
    assert(screen.getByText(labels.configurationHint));
    fireEvent.click(screen.getByRole('button', { name: labels.confirmTarget }));
    await screen.findByTestId('store-wizard-sharing');
    await pick('store-wizard-responsible', 'Bob'); await pick('store-wizard-add-user', 'Bob'); await pick('store-wizard-add-user', 'Cara');
    assert.equal(screen.getAllByRole('switch').length, 6); for (const control of screen.getAllByRole('switch')) assert.equal(control.getAttribute('aria-checked'), 'false');
    fireEvent.click(screen.getByRole('switch', { name: 'Bob: Edit' })); fireEvent.click(screen.getByRole('switch', { name: 'Cara: Use' }));
    fireEvent.click(screen.getByRole('button', { name: labels.install }));
    await waitFor(() => assert.equal(requests.filter(request => request.path.endsWith('/store/install')).length, 1));
    assert.equal(confirmPluginNavigation(), false); assert.equal(confirmations, 0); assert.equal((screen.getByRole('button', { name: labels.cancel }) as HTMLButtonElement).disabled, true);
    const install = requests.find(request => request.path.endsWith('/store/install'))!;
    assert.deepEqual(install.body, { source, ownership: { type: 'team', workspaceId: 'own-team' }, responsibleUserId: 'bob', grants: [
      { targetType: 'user', targetId: 'bob', canUse: false, canEdit: true, canManage: false }, { targetType: 'user', targetId: 'cara', canUse: true, canEdit: false, canManage: false }] });
    await act(async () => { installHold.release(); }); await screen.findByTestId('store-wizard-complete');
    assert.equal(installedResults.length, 1); assert.equal(updatedResults.length, 0); assert.equal(confirmPluginNavigation(), true); assert(screen.getByText(labels.remainingSetup));
    assert.equal(requests.filter(request => request.method === 'POST' && !['/store/preview', '/store/install-options', '/store/install'].some(suffix => request.path.endsWith(suffix))).length, 0, 'No implicit activation or workflow binding.');
    cleanup(); requests.length = 0;
    console.log('Store wizard explicit target, independent grants, pending navigation and one-shot install PASS');

    let currentReview = review, updateAttempts = 0;
    handler = async request => {
      if (request.path.endsWith('/store-update/review')) return success(currentReview);
      if (request.path.endsWith('/store-update')) { updateAttempts += 1; return updateAttempts === 1 ? failure(409, 'PACKAGE_REVISION_CONFLICT') : success(applicationResult); }
      return base(request);
    };
    render(view({ ...props, resourceRef }));
    await screen.findByTestId('store-wizard-replace-local');
    const apply = screen.getByRole('button', { name: labels.applyUpdate }); assert.equal((apply as HTMLButtonElement).disabled, true);
    assert(screen.getByText('Installed 1.0.0')); assert(screen.getByTestId('store-wizard-changes').textContent?.includes('Prepare assets'));
    assert.equal(requests.some(request => request.path.endsWith('/scopes') || request.path.endsWith('/store/install-options')), false, 'Update does not query or change ownership.');
    fireEvent.click(screen.getByTestId('store-wizard-replace-local')); fireEvent.click(apply);
    await screen.findByTestId('store-wizard-error');
    assert.equal(updateAttempts, 1); assert(screen.getByText('Installed 1.0.0')); assert.equal(updatedResults.length, 0); assert.equal(screen.queryByText('SECRET_PROVIDER_MESSAGE'), null);
    assert.equal((screen.getByRole('button', { name: labels.applyUpdate }) as HTMLButtonElement).disabled, true);
    currentReview = { ...review, expectedMetadataRevision: 8, expectedGrantsRevision: 10, expectedPackageRevision: 4, expectedLocalChecksum: 'd'.repeat(64) };
    fireEvent.click(screen.getByRole('button', { name: labels.reviewAgain })); await screen.findByTestId('store-wizard-replace-local');
    assert.equal((screen.getByTestId('store-wizard-replace-local') as HTMLInputElement).checked, false, 'Replacement must be confirmed for the refreshed review.');
    fireEvent.click(screen.getByTestId('store-wizard-replace-local')); fireEvent.click(screen.getByRole('button', { name: labels.applyUpdate }));
    await screen.findByTestId('store-wizard-complete'); assert.equal(updatedResults.length, 1); assert.equal(updateAttempts, 2);
    const updates = requests.filter(request => request.path.endsWith('/store-update'));
    assert.deepEqual(updates[1].body, { source, expectedMetadataRevision: 8, expectedGrantsRevision: 10, expectedPackageRevision: 4,
      expectedPublishedRevisionRef: revisionRef, expectedLocalChecksum: 'd'.repeat(64), replaceLocalChanges: true });
    assert.equal('ownership' in updates[1].body!, false); assert.equal('grants' in updates[1].body!, false);
    cleanup(); requests.length = 0;
    console.log('Store wizard exact update review, declaration comparison and explicit conflict refresh PASS');

    const oldPreviewHold = deferred(); const nextSource = { ...source, version: '3.0.0', checksum: 'e'.repeat(64) };
    handler = async request => {
      if (request.path.endsWith('/store/preview') && request.workspace === 'old-workspace') { await oldPreviewHold.wait; return success({ presentation: { ...preview, title: 'Old private preview' } }); }
      if (request.path.endsWith('/store/preview')) return success({ presentation: { ...preview, source: nextSource, version: nextSource.version, title: 'Current preview' } });
      if (request.path.endsWith('/scopes')) return success({ scopes: [{ type: 'user', label: 'Personal' }] });
      throw new Error('No stale target directory or mutation is permitted.');
    };
    const rendered = render(view({ ...props, workspaceId: 'old-workspace' }));
    await waitFor(() => assert.equal(requests.length, 1)); const previousSignal = requests[0].signal;
    rendered.rerender(view({ ...props, source: nextSource, workspaceId: 'new-workspace', initialOwnership: { type: 'user' } }));
    assert.equal(previousSignal?.aborted, true); await screen.findByText('Current preview');
    await act(async () => { oldPreviewHold.release(); }); assert.equal(screen.queryByText('Old private preview'), null);
    assert.equal(requests.some(request => request.workspace === 'old-workspace' && request.path.endsWith('/scopes')), false);
    cleanup(); requests.length = 0;
    console.log('Store wizard source/workspace replacement aborts and suppresses late private responses PASS');

    handler = async request => request.path.endsWith('/scopes') ? success({ scopes: [{ type: 'user', label: 'Personal' }] }) : request.path.endsWith('/store/install-options') ? failure(403, 'PACKAGE_ACCESS_DENIED') : base(request);
    render(view(props)); await waitFor(() => assert.equal((screen.getByTestId('store-wizard-target') as HTMLSelectElement).value, ''));
    assert.equal((screen.getByRole('button', { name: labels.confirmTarget }) as HTMLButtonElement).disabled, true, 'An unavailable prefilled target cannot silently fall back to personal.');
    fireEvent.change(screen.getByTestId('store-wizard-target'), { target: { value: 'user' } }); fireEvent.click(screen.getByRole('button', { name: labels.confirmTarget }));
    await screen.findByTestId('store-wizard-error'); assert.equal(screen.queryByTestId('store-wizard-sharing'), null); assert.equal(screen.queryByText('SECRET_PROVIDER_MESSAGE'), null);
    assert.equal(requests.some(request => request.path.endsWith('/store/install')), false);
    fireEvent.click(screen.getByRole('button', { name: labels.cancel })); assert.equal(closed, 1);
    cleanup(); assert.equal(confirmPluginNavigation(), true);
    console.log('Store wizard no target fallback, current denial and safe errors PASS');
  } finally { cleanup(); globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
