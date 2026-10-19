import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import type { WorkspaceFileOperationDryRun } from '../app/lib/files/client';

function deleteDialogDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function deleteDialogPreview(planId: string, selectedPath: string, incomingPath: string, blocked = false
): WorkspaceFileOperationDryRun & { plan: Extract<WorkspaceFileOperationDryRun['plan'], { kind: 'native-path-import-preparation' }> } {
  return { dryRun: true, requiresRevalidation: true, plan: {
    version: 1, kind: 'native-path-import-preparation', executionReady: false,
    workspaceId: 'delete-dialog-a', planId, readiness: blocked ? 'blocked' : 'requires-import-rebinding',
    pathMappings: [], linkEdits: [], coverage: { complete: !blocked, omittedSources: [], unresolvedLinks: [] },
    issues: blocked ? [{ code: 'source-unreadable', path: selectedPath }] : [],
    imports: [{ path: selectedPath, reasons: ['selected'] }, { path: incomingPath, reasons: ['link-change'] }],
    physicalLinkChanges: Array.from({ length: 3 }, () => ({ sourcePathBefore: incomingPath, sourcePathAfter: incomingPath,
      previousTargetLiteral: `[Target](${selectedPath})`, targetPathAfter: null, action: 'unlink' as const })),
  } };
}

async function deleteDialogFlush() {
  for (let index = 0; index < 3; index++) await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
}

function deleteDialogButton() {
  const button = document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]');
  assert(button, 'the actual Radix AlertDialog action is mounted');
  return button;
}

/** Rendered unit test: actual Dialog/Radix/client/store/translation modules.
 * Only HTTP responses and parent callbacks are fixtures; no authentication,
 * native receipt, route/PG, browser or mutation acceptance is claimed. */
export async function workspaceDeleteConfirmDialogTest(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://canvas.test/en/files', pretendToBeVisual: true,
  });
  const names = ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement',
    'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), originalFetch = globalThis.fetch;
  for (const name of names) {
    const value = name === 'IS_REACT_ACT_ENVIRONMENT' ? true : name === 'self' || name === 'window' ? dom.window
      : name === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window)
      : name === 'requestAnimationFrame' ? dom.window.requestAnimationFrame.bind(dom.window)
      : name === 'cancelAnimationFrame' ? dom.window.cancelAnimationFrame.bind(dom.window) : dom.window[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const requests: Array<{ workspaceId: string | null; path: string[]; response: ReturnType<typeof deleteDialogDeferred<Response>> }> = [];
  const confirmations: Array<string | undefined> = [], opened: boolean[] = [];
  let confirmation = deleteDialogDeferred<void>(), groups = 0, authReads = 0, fixtureAuthenticated = true;
  const fixtureSession = {
    user: { id: 'dialog-unit-user', name: 'Dialog unit user', email: 'dialog-unit@example.test', emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', image: null },
    session: { id: 'dialog-unit-session', userId: 'dialog-unit-user', token: 'unit-fixture-only-not-a-credential',
      expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      ipAddress: null, userAgent: 'DeleteDialog unit fixture' },
  };
  // BetterAuth captures fetch while the actual auth client is constructed.
  // Install its read-only HTTP fixture before importing any App module.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, dom.window.location.origin);
    assert.equal(url.origin, dom.window.location.origin);
    if (url.pathname === '/api/auth/get-session') {
      assert(++authReads <= 12); assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.credentials, 'include');
      return Response.json(fixtureAuthenticated ? fixtureSession : null);
    }
    assert.equal(url.pathname + url.search, '/api/files/delete');
    assert.equal(init?.method, 'DELETE'); assert.equal(init?.credentials, 'include');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['dryRun', 'path']);
    assert.equal(body.dryRun, true, 'the real Dialog may only send a read-only preview');
    assert(Array.isArray(body.path) && body.path.every((value: unknown) => typeof value === 'string'));
    const response = deleteDialogDeferred<Response>();
    requests.push({ workspaceId: new Headers(init?.headers).get(WORKSPACE_ID_HEADER), path: body.path, response });
    return response.promise;
  };
  // Import real DOM consumers only after JSDOM, so Radix takes its DOM path.
  const { createRoot } = await import('react-dom/client');
  const { DeleteConfirmDialog } = await import('../app/components/file-browser/DeleteConfirmDialog');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { openedDocumentAuthScope } = await import('../app/lib/collaboration/opened-document-registry');
  const { authClient } = await import('../app/lib/auth-client');
  const { WORKSPACE_ID_HEADER } = await import('../app/lib/workspaces/constants');
  const originalWorkspace = useWorkspaceStore.getState(), sessionAtom = authClient.$store.atoms.session;
  const root = createRoot(document.getElementById('root')!);
  useWorkspaceStore.setState({ activeWorkspaceId: 'delete-dialog-a' });
  const deleteDialogRender = async (open: boolean, paths: string[]) => {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <DeleteConfirmDialog open={open} paths={paths} skippedCount={0} onOpenChange={value => { opened.push(value); }}
        onConfirm={async planId => { confirmations.push(planId); await confirmation.promise; }} />
    </NextIntlClientProvider>));
    await deleteDialogFlush();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let stop: (() => void) | undefined = undefined, settled = false;
      const timeout = setTimeout(() => { settled = true; stop?.(); reject(new Error('The real BetterAuth session did not hydrate.')); }, 3_000);
      const deleteDialogSessionObservation = (value: ReturnType<typeof sessionAtom.get>) => {
        if (settled || value.isPending || value.isRefetching) return;
        settled = true; clearTimeout(timeout); stop?.();
        if (value.error || value.data?.user.id !== fixtureSession.user.id || value.data.session.id !== fixtureSession.session.id
          || openedDocumentAuthScope()?.userId !== fixtureSession.user.id || openedDocumentAuthScope()?.sessionId !== fixtureSession.session.id) {
          reject(new Error('The real BetterAuth atom and App auth observation do not match the unit session.'));
        } else resolve();
      };
      stop = sessionAtom.listen(deleteDialogSessionObservation);
      deleteDialogSessionObservation(sessionAtom.get());
    });
    assert(authReads > 0, 'the real BetterAuth client read the session HTTP fixture');
    assert.equal(sessionAtom.get().isPending, false); assert.equal(sessionAtom.get().error, null);
    // 1. Genuine asynchronous UI state and the exact original preview binding.
    await deleteDialogRender(true, ['raw-target.md']);
    assert.equal(requests.length, 1); assert.deepEqual(requests[0].path, ['raw-target.md']);
    assert.equal(requests[0].workspaceId, 'delete-dialog-a');
    assert.equal(deleteDialogButton().disabled, true);
    assert.equal(document.querySelector('[role="status"]')?.textContent?.trim(), messages.notebook.fileOperationPreview);
    await act(async () => deleteDialogButton().click()); assert.equal(confirmations.length, 0);
    await act(async () => requests[0].response.resolve(Response.json(deleteDialogPreview('a'.repeat(64), 'raw-target.md', 'incoming.md'))));
    await deleteDialogFlush();
    const summary = document.querySelector('[role="alertdialog"]'); assert(summary);
    assert(summary.textContent?.includes(messages.notebook.fileOperationImportSummary.replace('{count}', '2')),
      JSON.stringify({ summaryText: summary.textContent, bodyText: document.body.textContent,
        signedIn: Boolean(openedDocumentAuthScope()), workspaceId: useWorkspaceStore.getState().activeWorkspaceId }));
    assert(summary.textContent?.includes(messages.notebook.fileOperationImportLinks.replace('{count}', '3')));
    assert(summary.textContent?.includes(messages.notebook.fileOperationImportRevalidate));
    assert(summary.textContent?.includes('raw-target.md')); assert(summary.textContent?.includes('incoming.md'));
    assert.equal(deleteDialogButton().disabled, false);
    await act(async () => deleteDialogButton().click());
    assert.deepEqual(confirmations, ['a'.repeat(64)]); assert.equal(deleteDialogButton().disabled, true);
    await act(async () => deleteDialogButton().click()); assert.equal(confirmations.length, 1);
    assert.equal(requests.length, 1, 'confirmation never retries or mutates through the preview client');
    await act(async () => confirmation.resolve()); await deleteDialogFlush(); assert.deepEqual(opened, [false]);
    await deleteDialogRender(false, ['raw-target.md']); assert.equal(document.querySelector('[role="alertdialog"]'), null); groups++;

    // 2. Blocked and failed previews never invoke the parent Apply callback.
    await deleteDialogRender(true, ['blocked.md']); assert.equal(requests.length, 2);
    await act(async () => requests[1].response.resolve(Response.json(deleteDialogPreview('b'.repeat(64), 'blocked.md', 'blocked-incoming.md', true))));
    await deleteDialogFlush(); assert.equal(deleteDialogButton().disabled, true);
    assert(document.querySelector('[role="alertdialog"]')?.textContent?.includes(messages.notebook.fileOperationPreviewBlockedApply));
    await act(async () => deleteDialogButton().click()); assert.equal(confirmations.length, 1);
    await deleteDialogRender(false, ['blocked.md']);
    await deleteDialogRender(true, ['failed.md']); assert.equal(requests.length, 3);
    await act(async () => requests[2].response.resolve(Response.json({ error: 'The original file cannot be inspected.' }, { status: 409 })));
    await deleteDialogFlush(); assert.equal(deleteDialogButton().disabled, true);
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'The original file cannot be inspected.');
    await act(async () => deleteDialogButton().click()); assert.equal(confirmations.length, 1);
    assert.equal(requests.length, 3, 'blocked/error states never automatically re-preview or dispatch Apply');
    await deleteDialogRender(false, ['failed.md']); groups++;

    // 3. Late results cannot populate a closed dialog or replace newer paths/scope.
    await deleteDialogRender(true, ['closed-old.md']); assert.equal(requests.length, 4);
    await deleteDialogRender(false, ['closed-old.md']);
    await act(async () => requests[3].response.resolve(Response.json(deleteDialogPreview('c'.repeat(64), 'closed-old.md', 'CLOSED-STALE.md'))));
    await deleteDialogFlush(); assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.equal(confirmations.length, 1); assert.equal(requests.length, 4);

    confirmation = deleteDialogDeferred<void>();
    await deleteDialogRender(true, ['paths-old.md']); assert.equal(requests.length, 5);
    await deleteDialogRender(true, ['paths-new.md']); assert.equal(requests.length, 6);
    assert.deepEqual(requests[4].path, ['paths-old.md']); assert.deepEqual(requests[5].path, ['paths-new.md']);
    await act(async () => requests[4].response.resolve(Response.json(deleteDialogPreview('d'.repeat(64), 'paths-old.md', 'PATHS-STALE.md'))));
    await deleteDialogFlush(); assert.equal(deleteDialogButton().disabled, true);
    assert.equal(document.body.textContent?.includes('PATHS-STALE.md'), false);
    await act(async () => requests[5].response.resolve(Response.json(deleteDialogPreview('e'.repeat(64), 'paths-new.md', 'paths-current.md'))));
    await deleteDialogFlush(); assert.equal(deleteDialogButton().disabled, false);
    assert.equal(document.body.textContent?.includes('PATHS-STALE.md'), false);
    await act(async () => deleteDialogButton().click()); assert.equal(confirmations.at(-1), 'e'.repeat(64));
    await act(async () => confirmation.resolve()); await deleteDialogFlush(); await deleteDialogRender(false, ['paths-new.md']);

    confirmation = deleteDialogDeferred<void>();
    await deleteDialogRender(true, ['scope.md']); assert.equal(requests.length, 7);
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'delete-dialog-b' })); await deleteDialogFlush();
    assert.equal(requests.length, 8); assert.equal(requests[6].workspaceId, 'delete-dialog-a'); assert.equal(requests[7].workspaceId, 'delete-dialog-b');
    await act(async () => requests[6].response.resolve(Response.json(deleteDialogPreview('f'.repeat(64), 'scope.md', 'SCOPE-STALE.md'))));
    await deleteDialogFlush(); assert.equal(deleteDialogButton().disabled, true);
    assert.equal(document.body.textContent?.includes('SCOPE-STALE.md'), false);
    const current = deleteDialogPreview('1'.repeat(64), 'scope.md', 'scope-current.md'); current.plan.workspaceId = 'delete-dialog-b';
    await act(async () => requests[7].response.resolve(Response.json(current))); await deleteDialogFlush();
    assert.equal(deleteDialogButton().disabled, false); assert.equal(document.body.textContent?.includes('SCOPE-STALE.md'), false);
    await act(async () => deleteDialogButton().click()); assert.equal(confirmations.at(-1), '1'.repeat(64));
    await act(async () => confirmation.resolve()); await deleteDialogFlush(); await deleteDialogRender(false, ['scope.md']);
    assert.deepEqual(confirmations, ['a'.repeat(64), 'e'.repeat(64), '1'.repeat(64)]);
    assert.deepEqual(opened, [false, false, false], 'only the three explicit completed confirmations request closure');
    assert.equal(requests.length, 8, 'each open/path/scope preview dispatches once, with no mutation or retry'); groups++;
    console.log(JSON.stringify({ suite: 'workspace-delete-confirm-dialog', groups, passed: true,
      scope: 'actual React/Radix Dialog/client/store with unit HTTP fixtures; no PG/authentication/browser/mutation acceptance' }));
  } finally {
    await act(async () => root.unmount());
    // Radix FocusScope dispatches its unmount autofocus CustomEvent on a real
    // zero timer. Keep JSDOM constructors installed until that cleanup runs.
    await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
    fixtureAuthenticated = false;
    await sessionAtom.get().refetch();
    assert.equal(sessionAtom.get().data, null); assert.equal(openedDocumentAuthScope(), null);
    globalThis.fetch = originalFetch; useWorkspaceStore.setState(originalWorkspace, true);
    dom.window.close();
    names.forEach((name, index) => { if (prior[index]) Object.defineProperty(globalThis, name, prior[index]!); else Reflect.deleteProperty(globalThis, name); });
  }
}
