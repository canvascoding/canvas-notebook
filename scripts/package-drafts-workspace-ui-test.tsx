import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { useMemo, useSyncExternalStore } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityPackageOwnedDraftStatus } from '../app/lib/capabilities/packages/contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/en/plugins?view=drafts', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLDetailsElement', 'Element', 'Node', 'Document', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
const navigationEvent = 'package-drafts-navigation';
const originalHistoryPush = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => { originalHistoryPush(...args); window.dispatchEvent(new Event(navigationEvent)); };
const subscribe = (listener: () => void) => {
  window.addEventListener(navigationEvent, listener); window.addEventListener('popstate', listener);
  return () => { window.removeEventListener(navigationEvent, listener); window.removeEventListener('popstate', listener); };
};
const sourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const targetRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
const draftRef = 'canvas-package-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignRef = 'canvas-package-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownership = { type: 'organization' as const, organizationId: 'ui-fixture' };
const stamp = { resourceId: 'canvas-capability:v1:plugin:org:ui-fixture:standalone:source', kind: 'plugin' as const, name: 'source', version: '1.0.0',
  artifactRevision: 1, registryChecksum: 'a'.repeat(64), checksum: 'a'.repeat(64), sourcePluginId: null };
const status: CapabilityPackageOwnedDraftStatus = { draftRef, resourceRef: targetRef, sourceResourceRef: sourceRef, kind: 'plugin', name: 'Private fork', operation: 'fork',
  draftRevision: 1, createdAt: 1, updatedAt: 1, targetOwnership: ownership };

async function main() {
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  loader._load = (name, parent, isMain) => {
    if (name === 'next/navigation') return { useSearchParams: () => {
      const search = useSyncExternalStore(subscribe, () => window.location.search);
      return useMemo(() => new URLSearchParams(search), [search]);
    } };
    return originalLoad(name, parent, isMain);
  };
  const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const { PluginsAppClient } = await import('../app/components/plugins/PluginsAppClient');
  const { confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const requests: Array<{ suffix: string; workspace: string | null; method: string; body?: Record<string, unknown> }> = [];
  const holds = new Map<string, Promise<void>>();
  let text = 'Saved fork README', revision = 1, confirmResult = false, confirmations = 0, holdWrite: Promise<void> | undefined, holdDiscard: Promise<void> | undefined;
  window.confirm = () => { confirmations += 1; return confirmResult; };
  const response = (value: unknown, code = 200) => Response.json({ success: code === 200, ...(code === 200 ? { data: value } : { code: 'PACKAGE_ACCESS_DENIED' }) }, { status: code });
  const draft = () => ({ contractVersion: 1, draftRef, resourceRef: targetRef, sourceResourceRef: sourceRef, kind: 'plugin', name: 'Private fork', operation: 'fork', actorUserId: 'creator',
    draftRevision: revision, basePackageRevision: 0, basePublishedRevisionRef: null, baseSourceStamp: stamp, sourceMetadataRevision: 1, sourceGrantsRevision: 1,
    sourcePackageRevision: 0, sourcePublishedRevisionRef: null, createdAt: 1, updatedAt: 1 });
  const target = { ownership, expectedMetadataRevision: 1, expectedGrantsRevision: 1 };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin), prefix = '/api/capabilities/packages';
    assert(url.pathname.startsWith(prefix), 'Only package SafeDTO transport is used.');
    const suffix = url.pathname.slice(prefix.length), workspace = url.searchParams.get('workspaceId'), method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ suffix, workspace, method, body });
    const parts = suffix.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'drafts' && parts.length === 1) {
      const value = { ...status, name: workspace === 'workspace-one' ? 'Previous workspace draft' : 'Private fork', draftRevision: revision };
      await holds.get(workspace || ''); return response({ drafts: [value], nextCursor: null });
    }
    if (parts[0] === 'drafts') {
      if (parts[1] !== draftRef) return response({}, 404);
      if (parts[2] === 'status') return response({ status: { ...status, draftRevision: revision } });
      if (parts[2] === 'tree') return response({ draft: draft(), target, files: [{ type: 'file', path: 'README.md', size: Buffer.byteLength(text), checksum: 'a'.repeat(64) }] });
      if (parts[2] === 'file') {
        if (method === 'PUT') { await holdWrite; assert.equal(body?.expectedDraftRevision, revision); text = Buffer.from(String(body?.content), 'base64').toString('utf8'); revision += 1; return response({ draft: draft() }); }
        return response({ draft: draft(), target, file: { path: 'README.md', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text), checksum: 'a'.repeat(64), offset: 0, byteLength: Buffer.byteLength(text), eof: true } });
      }
      if (method === 'DELETE') { await holdDiscard; assert.equal(body?.expectedDraftRevision, revision); return response({ discarded: true }); }
      throw new Error('Unexpected draft mutation.');
    }
    if (parts[0] === 'scopes') return response({ scopes: [{ type: 'user', label: 'Personal' }] });
    assert.equal(parts[0], sourceRef, 'Fork continuation must open its canonical SOURCE, never its new target.');
    if (parts[1] === 'versions') return response({ versions: [] });
    return response({ package: { resource: { resourceRef: sourceRef, legacyResourceId: stamp.resourceId, resourceType: 'plugin', sourceType: 'standalone', sourcePluginId: null, ownership,
      displayName: null, description: null, responsibleUserId: null, createdByUserId: 'creator', updatedByUserId: 'creator', metadataRevision: 1, grantsRevision: 1,
      accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 }, access: { canRead: true, canUse: true, canEdit: true, canManage: false },
      state: null, published: null, sourceStamp: stamp, readOnly: false, defaultEnabled: true } });
  };
  const App = () => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <PluginsAppClient canManageOrganizationCapabilities={false} />
  </NextIntlClientProvider>;
  try {
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-one' }); render(<App />);
    await screen.findByText('Previous workspace draft');
    let releaseOld!: () => void, releaseNew!: () => void;
    holds.set('workspace-one', new Promise<void>(resolve => { releaseOld = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.refresh }));
    await waitFor(() => assert.equal(requests.filter(request => request.workspace === 'workspace-one').length, 2));
    holds.set('workspace-two', new Promise<void>(resolve => { releaseNew = resolve; }));
    await act(async () => { useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-two' }); });
    assert.equal(Boolean(screen.queryByText('Previous workspace draft')), false, 'Old rows must disappear immediately after workspace identity changes.');
    await act(async () => { releaseNew(); }); await screen.findByText('Private fork');
    await act(async () => { releaseOld(); }); assert.equal(Boolean(screen.queryByText('Previous workspace draft')), false);
    holds.clear();
    fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.open }));
    await screen.findByTestId('package-file-picker');
    const selected = new URLSearchParams(window.location.search);
    assert.equal(selected.get('resourceRef'), sourceRef); assert.equal(selected.get('draftRef'), draftRef);
    assert.equal(localStorage.length, 0, 'Global continuation cannot require a remembered local draft reference.');
    fireEvent.change(screen.getByTestId('package-file-picker'), { target: { value: 'README.md' } });
    await screen.findByTestId('package-file-content');
    fireEvent.change(screen.getByTestId('package-file-content'), { target: { value: 'Unsaved fork text' } });
    const selectedHref = window.location.href, beforeCancel = requests.length;
    fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.backToDrafts }));
    assert.equal(window.location.href, selectedHref); assert.equal(confirmations, 1);
    assert.equal((screen.getByTestId('package-file-content') as HTMLTextAreaElement).value, 'Unsaved fork text');
    assert.equal(requests.length, beforeCancel); assert.equal(revision, 1, 'Cancelled navigation must not change request/CAS state or write.');
    let releaseWrite!: () => void; holdWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    fireEvent.click(screen.getByTestId('package-save-file'));
    await waitFor(() => assert.equal((screen.getByTestId('package-save-file') as HTMLButtonElement).disabled, true));
    const beforePendingConfirm = confirmations; fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.backToDrafts }));
    assert.equal(window.location.href, selectedHref); assert.equal(confirmations, beforePendingConfirm); assert.equal(confirmPluginNavigation(), false);
    await act(async () => { releaseWrite(); }); await screen.findByText(messages.skills.packageEditor.fileSaved);
    confirmResult = true; fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.backToDrafts }));
    await screen.findByText('Private fork'); assert.equal(new URLSearchParams(window.location.search).has('draftRef'), false);
    const discardRequestsBefore = requests.length; let releaseDiscard!: () => void; holdDiscard = new Promise<void>(resolve => { releaseDiscard = resolve; });
    fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.discard }));
    await waitFor(() => assert.equal(requests.length, discardRequestsBefore + 1));
    assert.equal(confirmPluginNavigation(), false, 'A pending own-draft discard must block navigation, just like a pending editor write.');
    const pendingHref = window.location.href, pendingConfirmations = confirmations;
    fireEvent.click(screen.getByRole('button', { name: messages.skills.drafts.backToInstalled }));
    assert.equal(window.location.href, pendingHref); assert.equal(confirmations, pendingConfirmations);
    await act(async () => { releaseDiscard(); }); await screen.findByText(messages.skills.drafts.discarded);
    const foreignStart = requests.length;
    await act(async () => { window.history.pushState(null, '', `/en/plugins?${new URLSearchParams({ view: 'drafts', resourceRef: sourceRef, draftRef: foreignRef, task: 'content' })}`); });
    await screen.findByText(messages.skills.packageEditor.accessError);
    assert.equal(requests.length, foreignStart + 1); assert(requests.at(-1)?.suffix.endsWith('/status'));
    assert.equal(Boolean(screen.queryByTestId('package-file-content')), false, 'Foreign creator status404 must not open source bytes.');
    console.log('PASS actual drafts workspace UI: context-fenced safe list, canonical fork continuation, unsaved/pending navigation, exact CAS and foreign status404 without source I/O.');
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
