import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackageOwnedDraftStatus } from '../app/lib/capabilities/packages/contracts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://canvas.test/plugins', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'localStorage', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLDetailsElement', 'Element', 'Node', 'Document', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });

const sourceRef = 'canvas-resource:11111111-1111-4111-8111-111111111111';
const otherRef = 'canvas-resource:22222222-2222-4222-8222-222222222222';
const targetRef = 'canvas-resource:33333333-3333-4333-8333-333333333333';
const legacyRef = 'canvas-capability:v1:organization:fixture:plugin:editor-source';
const draftRef = (letter: string) => `canvas-package-draft:${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`;
const stamp = { resourceId: legacyRef, kind: 'plugin' as const, name: 'editor-source', version: '1.0.0', artifactRevision: 1,
  registryChecksum: 'a'.repeat(64), checksum: 'a'.repeat(64), sourcePluginId: null };
const ownership = { type: 'organization' as const, organizationId: 'fixture-org' };
function descriptor(): CapabilityPackageDescriptor {
  return { resource: { resourceRef: sourceRef, legacyResourceId: legacyRef, resourceType: 'plugin', sourceType: 'standalone', sourcePluginId: null,
    ownership, displayName: null, description: null, responsibleUserId: null, createdByUserId: 'editor', updatedByUserId: 'editor',
    metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', status: 'active', createdAt: 1, updatedAt: 1 },
  access: { canRead: true, canUse: true, canEdit: true, canManage: false }, state: null, published: null,
  sourceStamp: stamp, readOnly: false, defaultEnabled: true };
}
function fixture(reference: string, source = sourceRef, target = sourceRef) {
  const draft: CapabilityPackageDraft = { contractVersion: 1, draftRef: reference, resourceRef: target, kind: 'plugin', name: target === source ? 'editor-source' : 'editor-variant',
    operation: target === source ? 'edit' : 'fork', actorUserId: 'editor', draftRevision: 1, basePackageRevision: 0, basePublishedRevisionRef: null,
    baseSourceStamp: stamp, sourceResourceRef: source, sourceMetadataRevision: 1, sourceGrantsRevision: 1,
    sourcePackageRevision: 0, sourcePublishedRevisionRef: null, createdAt: 1, updatedAt: 1 };
  const status: CapabilityPackageOwnedDraftStatus = { draftRef: reference, resourceRef: target, sourceResourceRef: source, kind: 'plugin', name: draft.name,
    operation: draft.operation, draftRevision: 1, createdAt: 1, updatedAt: 1, targetOwnership: ownership };
  return { draft, status, content: `saved-${reference}`, target: { ownership, expectedMetadataRevision: 1, expectedGrantsRevision: 1 },
    files: [{ type: 'file' as const, path: 'README.md', size: 10, checksum: 'a'.repeat(64) }] };
}

async function main() {
  const loader = Module as typeof Module & { _load(name: string, parent: NodeModule | null, main: boolean): unknown };
  const originalLoad = loader._load;
  loader._load = (name, parent, isMain) => name === '@/i18n/navigation'
    ? { useRouter: () => ({ push: () => { throw new Error('This editor test does not navigate to chat.'); } }) }
    : originalLoad(name, parent, isMain);
  const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
  const { PackageEditorSection } = await import('../app/components/plugins/PackageEditorSection');
  const { confirmPluginNavigation } = await import('../app/components/plugins/plugin-navigation-guard');
  const originalFetch = globalThis.fetch, originalConfirm = window.confirm;
  const requests: Array<{ suffix: string; method: string; workspace: string | null }> = [];
  const fixtures = new Map<string, ReturnType<typeof fixture>>();
  const heldStatuses = new Map<string, Promise<void>>();
  let unavailablePackage = false, deniedTree = false, failedFileRead = false, confirmations = 0, holdWrite: Promise<void> | undefined;
  let recoveredPublished: string | null = null;
  let holdCreate: Promise<void> | undefined;
  window.confirm = () => { confirmations += 1; return false; };
  const body = (value: unknown, status = 200) => Response.json({ success: status === 200, ...(status === 200 ? { data: value } : { code: 'PACKAGE_ACCESS_DENIED' }) }, { status });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://canvas.test'), prefix = '/api/capabilities/packages';
    assert(url.pathname.startsWith(prefix));
    const suffix = url.pathname.slice(prefix.length), method = init?.method || 'GET';
    // This transport-focused harness leaves the independently tested structured preview unavailable.
    if (suffix.endsWith('/presentation')) return body({}, 503);
    requests.push({ suffix, method, workspace: url.searchParams.get('workspaceId') });
    const segments = suffix.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] === 'operations') return recoveredPublished === url.searchParams.get('draftRef')
      ? body({ operation: { status: 'published', resourceRef: targetRef } }) : body({}, 404);
    if (segments[0] === 'drafts') {
      if (method === 'POST' && segments.length === 1) {
        await holdCreate;
        const input = JSON.parse(String(init?.body));
        const created = fixture(draftRef('d'), input.resourceRef, input.operation === 'fork' ? otherRef : input.resourceRef);
        fixtures.set(created.draft.draftRef, created);
        return body({ draft: created.draft });
      }
      const reference = segments[1], value = fixtures.get(reference);
      if (segments[2] === 'status') {
        await heldStatuses.get(reference);
        return value ? body({ status: value.status }) : body({}, 404);
      }
      if (!value) return body({}, 404);
      if (segments[2] === 'tree') return deniedTree ? body({}, 403) : body({ draft: value.draft, target: value.target, files: value.files });
      if (segments[2] === 'file') {
        if (method === 'PUT') {
          await holdWrite; const input = JSON.parse(String(init?.body));
          assert.equal(input.expectedDraftRevision, value.draft.draftRevision);
          value.content = Buffer.from(input.content, 'base64').toString('utf8'); value.draft.draftRevision += 1; value.status.draftRevision += 1;
          return body({ draft: value.draft });
        }
        if (failedFileRead) { failedFileRead = false; return body({}, 503); }
        return body({ draft: value.draft, target: value.target, file: { path: 'README.md', encoding: 'base64', content: Buffer.from(value.content).toString('base64'),
          size: Buffer.byteLength(value.content), checksum: 'a'.repeat(64), offset: 0, byteLength: Buffer.byteLength(value.content), eof: true } });
      }
      if (method === 'DELETE') { fixtures.delete(reference); return body({ discarded: true }); }
      throw new Error(`Unexpected draft request ${method}:${segments[2]}`);
    }
    if (segments[0] === 'scopes') return body({ scopes: [{ type: 'user', label: 'Personal' }] });
    if (segments[0] === sourceRef || segments[0] === legacyRef || segments[0] === targetRef) {
      if (unavailablePackage) return body({}, 403);
      if (segments[1] === 'versions') return body({ versions: [] });
      if (segments[1] === 'tree') return body({ files: [] });
      const value = descriptor();
      if (segments[0] === targetRef) value.resource.resourceRef = targetRef;
      return body({ package: value });
    }
    throw new Error('The editor requested an unrelated package.');
  };
  const form = (props: React.ComponentProps<typeof PackageEditorSection>) => <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <PackageEditorSection {...props} />
  </NextIntlClientProvider>;
  const reset = () => { cleanup(); requests.length = 0; fixtures.clear(); localStorage.clear(); heldStatuses.clear(); unavailablePackage = false; deniedTree = false; failedFileRead = false; holdWrite = undefined; holdCreate = undefined; confirmations = 0; recoveredPublished = null; };
  try {
    const first = draftRef('a'); fixtures.set(first, fixture(first));
    render(form({ resourceRef: sourceRef, initialDraftRef: first }));
    assert.equal(requests.length, 0, 'Collapsed editor must remain lazy even with a resume reference.'); cleanup();
    render(form({ resourceRef: sourceRef, initialDraftRef: first, initiallyOpen: true, workspaceId: 'team-one' }));
    await screen.findByTestId('package-file-picker');
    assert.equal(requests[0].suffix, `/drafts/${encodeURIComponent(first)}/status`);
    assert(requests.findIndex(request => request.suffix.endsWith('/tree')) > requests.findIndex(request => request.suffix === `/${encodeURIComponent(sourceRef)}`));
    fireEvent.change(screen.getByTestId('package-file-picker'), { target: { value: 'README.md' } });
    const editor = await screen.findByTestId('package-file-content') as HTMLTextAreaElement;
    await waitFor(() => assert.equal(editor.value, fixtures.get(first)!.content));
    fireEvent.change(editor, { target: { value: 'unsaved editor text' } });
    assert.equal(confirmPluginNavigation(), false); assert.equal(confirmations, 1);
    const disclosure = screen.getByTestId('package-editor').querySelector('details')!;
    disclosure.open = false; fireEvent(disclosure, new Event('toggle')); assert.equal(confirmPluginNavigation(), false);
    disclosure.open = true; fireEvent(disclosure, new Event('toggle'));
    failedFileRead = true; fireEvent.click(screen.getByTestId('package-reload'));
    await screen.findByText(messages.skills.packageEditor.requestError);
    assert.equal(editor.value, 'unsaved editor text'); assert.equal(confirmPluginNavigation(), false);
    let releaseWrite!: () => void; holdWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    fireEvent.click(screen.getByTestId('package-save-file'));
    await waitFor(() => assert.equal((screen.getByTestId('package-save-file') as HTMLButtonElement).disabled, true));
    const beforePending = confirmations; assert.equal(confirmPluginNavigation(), false); assert.equal(confirmations, beforePending, 'Pending writes cannot be discarded through navigation.');
    await act(async () => { releaseWrite(); }); await screen.findByText(messages.skills.packageEditor.fileSaved);
    assert.equal(confirmPluginNavigation(), true); cleanup(); assert.equal(confirmPluginNavigation(), true);

    reset(); const fork = draftRef('b'); fixtures.set(fork, fixture(fork, sourceRef, targetRef));
    localStorage.setItem(`canvas-private-package-draft:${legacyRef}:team-one`, fork);
    render(form({ resourceRef: legacyRef, initiallyOpen: true, workspaceId: 'team-one' }));
    await screen.findByTestId('package-file-picker'); await screen.findByText('Draft: editor-variant');
    assert.equal(requests[0].suffix, `/drafts/${encodeURIComponent(fork)}/status`); assert(requests.some(request => request.suffix === `/${encodeURIComponent(legacyRef)}`));
    reset(); fixtures.set(fork, fixture(fork, otherRef, targetRef));
    render(form({ resourceRef: sourceRef, initialDraftRef: fork, initiallyOpen: true }));
    await screen.findByText(messages.skills.packageEditor.accessError);
    assert.equal(requests.length, 1, 'Explicit wrong-source draft must never trigger package or tree reads.');
    assert.equal(Boolean(screen.queryByTestId('package-discard')), false); assert.equal(Boolean(screen.queryByTestId('package-file-picker')), false);
    reset(); render(form({ resourceRef: sourceRef, initialDraftRef: draftRef('f'), initiallyOpen: true }));
    await screen.findByText(messages.skills.packageEditor.accessError);
    assert.deepEqual(requests.map(value => value.suffix), [`/drafts/${encodeURIComponent(draftRef('f'))}/status`, '/operations'],
      'A foreign/missing draft only checks its actor-private receipt; it never reads a package.');
    reset(); fixtures.set(fork, fixture(fork, otherRef, targetRef)); localStorage.setItem(`canvas-private-package-draft:${legacyRef}:`, fork);
    render(form({ resourceRef: legacyRef, initiallyOpen: true })); await screen.findByText(messages.skills.packageEditor.accessError);
    assert.equal(requests.length, 2, 'Legacy aliases are matched only through the fresh descriptor, before any draft tree reads.');

    reset(); fixtures.set(first, fixture(first)); unavailablePackage = true;
    render(form({ resourceRef: sourceRef, initialDraftRef: first, initiallyOpen: true }));
    await screen.findByText(messages.skills.packageEditor.revokedDraft);
    assert.equal(Boolean(screen.queryByTestId('package-file-content')), false); assert.equal(Boolean(screen.queryByTestId('package-validate')), false); assert.equal(Boolean(screen.queryByTestId('package-publish')), false);
    assert(!requests.some(request => request.suffix.endsWith('/tree') || request.suffix.endsWith('/file')));
    fireEvent.click(screen.getByTestId('package-discard')); await screen.findByText(messages.skills.packageEditor.discarded);
    assert.equal(fixtures.has(first), false); assert.equal(requests.filter(request => request.method === 'DELETE').length, 1);

    reset(); fixtures.set(first, fixture(first));
    render(form({ resourceRef: sourceRef, initialDraftRef: first, initiallyOpen: true })); await screen.findByTestId('package-file-picker');
    fireEvent.change(screen.getByTestId('package-file-picker'), { target: { value: 'README.md' } }); await screen.findByTestId('package-file-content');
    fireEvent.change(screen.getByTestId('package-file-content'), { target: { value: 'revoked unsaved' } }); deniedTree = true;
    fireEvent.click(screen.getByTestId('package-reload')); await screen.findByText(messages.skills.packageEditor.revokedDraft);
    assert.equal(Boolean(screen.queryByTestId('package-file-content')), false); assert.equal(confirmPluginNavigation(), true, 'Revocation removes the stale byte editor and its dirty registration.');

    reset(); fixtures.set(first, fixture(first));
    render(form({ resourceRef: sourceRef, initialDraftRef: first, initiallyOpen: true })); await screen.findByTestId('package-file-picker');
    fireEvent.change(screen.getByTestId('package-file-picker'), { target: { value: 'README.md' } }); await screen.findByTestId('package-file-content');
    fixtures.delete(first); requests.length = 0; fireEvent.click(screen.getByTestId('package-reload'));
    await screen.findByText(messages.skills.packageEditor.accessError);
    assert.equal(Boolean(screen.queryByTestId('package-file-content')), false); assert.equal(Boolean(screen.queryByTestId('package-publish')), false);
    assert.equal(requests.length, 3, 'A disappeared explicit draft stops after tree404/status404 and private receipt404, with no source fallback.');

    reset(); recoveredPublished = draftRef('e');
    render(form({ initialDraftRef: recoveredPublished, initiallyOpen: true, workspaceId: 'team-one' }));
    await screen.findByText(messages.skills.packageEditor.recoveredPublished);
    await screen.findByTestId('package-create-edit');
    fireEvent.click(screen.getByTestId('package-reload'));
    await waitFor(() => assert.equal(requests.filter(value => value.suffix === `/${encodeURIComponent(targetRef)}`).length, 2));
    await waitFor(() => assert.equal((screen.getByTestId('package-reload') as HTMLButtonElement).disabled, false));
    assert(screen.getByTestId('package-create-edit'), 'Repeated reload retains the recovered source-free published package.');
    assert.equal(requests.filter(value => value.suffix === '/operations').length, 1, 'The recovered reference is reauthorized directly without replaying publication.');
    unavailablePackage = true; fireEvent.click(screen.getByTestId('package-reload'));
    await screen.findByText(messages.skills.packageEditor.accessError);
    unavailablePackage = false; fireEvent.click(screen.getByTestId('package-reload'));
    await screen.findByTestId('package-create-edit');
    assert.equal(requests.filter(value => value.suffix === `/${encodeURIComponent(targetRef)}`).length, 4, 'A denied read does not forget the recovered identity or prevent a later authorized retry.');

    reset(); const started: CapabilityPackageDraft[] = [];
    render(form({ resourceRef: sourceRef, initiallyOpen: true, onDraftStarted: draft => {
      assert.equal(confirmPluginNavigation(), true, 'Canonical draft navigation waits until the pending guard is released.'); started.push(draft);
    } }));
    await screen.findByTestId('package-create-edit');
    let releaseCreate!: () => void; holdCreate = new Promise<void>(resolve => { releaseCreate = resolve; });
    fireEvent.click(screen.getByTestId('package-create-edit'));
    await waitFor(() => assert.equal(confirmPluginNavigation(), false)); assert.equal(started.length, 0);
    await act(async () => { releaseCreate(); });
    await waitFor(() => assert.equal(started.length, 1)); assert.equal(started[0].draftRef, draftRef('d'));
    assert.equal(started[0].sourceResourceRef, sourceRef);
    await act(async () => {}); assert.equal(started.length, 1, 'The acknowledged new draft emits one navigation intent.');

    reset(); const forkStarted: CapabilityPackageDraft[] = [];
    render(form({ resourceRef: sourceRef, initiallyOpen: true, onDraftStarted: draft => {
      assert.equal(confirmPluginNavigation(), true); forkStarted.push(draft);
    } }));
    await screen.findByTestId('package-create-edit');
    fireEvent.change(screen.getByTestId('package-variant-name'), { target: { value: 'new-variant' } });
    fireEvent.click(screen.getByTestId('package-create-fork'));
    await waitFor(() => assert.equal(forkStarted.length, 1));
    assert.equal(forkStarted[0].operation, 'fork'); assert.equal(forkStarted[0].sourceResourceRef, sourceRef);
    assert.equal(forkStarted[0].resourceRef, otherRef, 'Fork navigation receives separate exact source and target identities.');

    reset(); const second = draftRef('b'), third = draftRef('c');
    for (const reference of [first, second, third]) fixtures.set(reference, fixture(reference));
    let releaseFirst!: () => void, releaseSecond!: () => void;
    heldStatuses.set(first, new Promise<void>(resolve => { releaseFirst = resolve; })); heldStatuses.set(second, new Promise<void>(resolve => { releaseSecond = resolve; }));
    const view = render(form({ resourceRef: sourceRef, initialDraftRef: first, initiallyOpen: true, workspaceId: 'team-one' }));
    await waitFor(() => assert.equal(requests.length, 1));
    view.rerender(form({ resourceRef: sourceRef, initialDraftRef: second, initiallyOpen: true, workspaceId: 'team-one' }));
    await waitFor(() => assert.equal(requests.length, 2));
    view.rerender(form({ resourceRef: sourceRef, initialDraftRef: third, initiallyOpen: true, workspaceId: 'team-two' }));
    await screen.findByTestId('package-file-picker'); fireEvent.change(screen.getByTestId('package-file-picker'), { target: { value: 'README.md' } });
    await waitFor(() => assert.equal((screen.getByTestId('package-file-content') as HTMLTextAreaElement).value, fixtures.get(third)!.content));
    await act(async () => { releaseSecond(); releaseFirst(); });
    assert.equal((screen.getByTestId('package-file-content') as HTMLTextAreaElement).value, fixtures.get(third)!.content);
    assert.equal(requests.filter(request => request.workspace === 'team-one').length, 2, 'Stale status completions must not start source reads or restore old draft/CAS.');
    assert(!requests.some(request => request.suffix.includes(encodeURIComponent(first)) && request.suffix.endsWith('/tree')));
    console.log('PASS package editor UI: lazy canonical resume, safe status/source match, legacy alias fork, creator denial, revoke/discard, dirty+pending guard and A→B→C workspace/ref races.');
  } finally { cleanup(); loader._load = originalLoad; globalThis.fetch = originalFetch; window.confirm = originalConfirm; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
