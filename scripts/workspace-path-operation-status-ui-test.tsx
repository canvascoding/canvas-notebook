import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import enMessages from '../messages/en.json';
import deMessages from '../messages/de.json';
import type * as StatusUi from '../app/components/file-browser/WorkspacePathOperationStatusHost';
import type { OpenedDocumentAuthScope } from '../app/lib/collaboration/opened-document-registry';
import type { WorkspacePathOperationLegacyReviewStatus, WorkspacePathOperationStatusRequest, WorkspacePathOperationStatusResponse, WorkspacePathOperationStatusTarget } from '../app/store/workspace-path-operation-store';
import type { WorkspacePathOperationProblem } from '../app/lib/files/workspace-path-operation-problems';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/notebook?workspaceId=workspace-ui' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'CustomEvent', 'Event', 'MouseEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const scope: OpenedDocumentAuthScope = { userId: 'ui-user', sessionId: 'ui-session', epoch: 1 };
const workspaceId = 'workspace-ui';
const batchId = 'ui-batch-1234567890';
const request: WorkspacePathOperationStatusRequest = { workspaceId, batchId, authScope: scope };
const result = (status: WorkspacePathOperationStatusResponse['operation']['status'] = 'blocked'): WorkspacePathOperationStatusResponse => ({
  operation: { batchId, workspaceId, planId: 'a'.repeat(64), kind: 'move', status,
    completedActions: status === 'applied' ? 2 : 0, totalActions: 2, phase: status === 'applied' ? 'complete' : 'preparing',
    errorCode: 'CURRENT_CONTENT_CHANGED', selections: [{ sourcePath: 'Docs/target.md', destinationPath: 'Archive/target.md' }] },
});
type State = { request: WorkspacePathOperationStatusRequest | null; response: WorkspacePathOperationStatusResponse | null;
  problem: WorkspacePathOperationProblem | null; review: WorkspacePathOperationLegacyReviewStatus | null; loading: boolean; busy: boolean; pendingAction: 'resume' | 'undo' | null;
  error: 'load' | 'action' | 'access' | 'identity' | null; errorCode: string | null };
const empty = (): State => ({ request: null, response: null, problem: null, review: null, loading: false, busy: false, pendingAction: null, error: null, errorCode: null });
type Controls = { state: State; auth: OpenedDocumentAuthScope | null; workspace: string; params: URLSearchParams;
  listeners: Set<() => void>; opened: WorkspacePathOperationStatusTarget[]; recoveries: string[]; loads: number; closes: number };

async function compileUi(controls: Controls, locale: 'en' | 'de') {
  const filename = path.resolve('app/components/file-browser/WorkspacePathOperationStatusHost.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const subscribe = (listener: () => void) => { controls.listeners.add(listener); return () => { controls.listeners.delete(listener); }; };
  const emit = () => { for (const listener of controls.listeners) listener(); };
  const useStore = Object.assign(() => React.useSyncExternalStore(subscribe, () => controls.state), { getState: () => controls.state });
  const translate = (key: string, values?: Record<string, string | number>) => {
    const messages = locale === 'en' ? enMessages.workspacePathOperationStatus : deMessages.workspacePathOperationStatus;
    const value = key.split('.').reduce<unknown>((object, part) => object && typeof object === 'object' ? (object as Record<string, unknown>)[part] : null, messages);
    assert.equal(typeof value, 'string', `missing ${locale} status translation: ${key}`);
    return String(value).replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? `{${name}}`));
  };
  const mocks: Record<string, unknown> = {
    'next/navigation': { useSearchParams: () => controls.params },
    'next-intl': { useTranslations: () => translate },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    'sonner': { toast: { error: () => {} } },
    '@/app/lib/auth-client': { authClient: { $store: { atoms: { session: { listen: subscribe } } } } },
    '@/app/lib/collaboration/opened-document-registry': { openedDocumentAuthScope: () => controls.auth, subscribeOpenedDocumentAuthInvalidation: subscribe },
    '@/app/store/workspace-store': { useWorkspaceStore: (selector: (state: {activeWorkspaceId: string}) => string) =>
      React.useSyncExternalStore(subscribe, () => selector({ activeWorkspaceId: controls.workspace })) },
    '@/app/store/workspace-path-operation-store': {
      useWorkspacePathOperationStore: useStore,
      closeWorkspacePathOperationStatus: () => { controls.closes++; controls.state = empty(); emit(); },
      openWorkspacePathOperationStatus: async (target: WorkspacePathOperationStatusTarget) => { controls.opened.push(target); return true; },
      reloadWorkspacePathOperationStatus: async () => { controls.loads++; },
      recoverWorkspacePathOperation: async (action: string) => { controls.recoveries.push(action); },
    },
    '@/components/ui/button': { Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {variant?: string; size?: string}) => <button {...props}>{children}</button> },
    '@/components/ui/dialog': {
      Dialog: ({ open, children }: React.PropsWithChildren<{open: boolean}>) => open ? <>{children}</> : null,
      DialogContent: ({ children, layout, showCloseButton: _showCloseButton, onCloseAutoFocus: _onCloseAutoFocus, ...props }: React.HTMLAttributes<HTMLDivElement> & {
        layout: string; showCloseButton: boolean; onCloseAutoFocus: unknown }) => <div role="dialog" data-layout={layout} {...props}>{children}</div>,
      DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
      DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
    },
  };
  const exports = {} as typeof StatusUi;
  new Function('require', 'module', 'exports', source)((name: string) => name in mocks ? mocks[name] : load(name), { exports }, exports);
  return exports.WorkspacePathOperationStatusHost;
}

async function main() {
  const { fireEvent, render } = await import('@testing-library/react');
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  for (const locale of ['en', 'de'] as const) {
    const controls: Controls = { state: { ...empty(), request, response: result() }, auth: scope, workspace: workspaceId,
      params: new URLSearchParams({ workspaceId }), listeners: new Set(), opened: [], recoveries: [], loads: 0, closes: 0 };
    const Host = await compileUi(controls, locale);
    const screen = render(<Host />);
    const update = async (patch: Partial<State>) => act(async () => {
      controls.state = { ...controls.state, ...patch }; for (const listener of controls.listeners) listener();
    });
    await settle();
    assert.equal(screen.getByTestId('workspace-path-operation-status').getAttribute('data-layout'), 'viewport', 'dialog uses bounded, scrollable mobile viewport layout');
    assert.equal(screen.getByRole('heading', { name: locale === 'en' ? 'File action' : 'Dateiaktion' }).textContent, locale === 'en' ? 'File action' : 'Dateiaktion');
    assert.ok(screen.getByText('CURRENT_CONTENT_CHANGED'));
    assert.ok(screen.getByText('Docs/target.md'));
    assert.equal(screen.queryByTestId('workspace-path-operation-resume'), null);
    assert.equal(screen.queryByTestId('workspace-path-operation-undo'), null);
    assert.equal(controls.recoveries.length, 0, 'opening blocked status cannot run the action');
    assert.ok(!document.body.textContent?.includes('workspacePathOperationStatus.'), 'all product copy is localized');
    const messages = locale === 'en' ? enMessages.workspacePathOperationStatus : deMessages.workspacePathOperationStatus;
    const blocked = { ...result(), operation: { ...result().operation, errorCode: 'PREVIEW_BLOCKED',
      selections: [{ sourcePath: 'ek-fuchs-transkript.md', destinationPath: 'Koenenstrasse_8/WEG/Waermepumpe/Notizen/2026-10-07_EK-Fuchs_Waermepumpe_Besprechung_Transkript.md' }],
      issues: [{ code: 'destination-collision', path: 'Notes/transcript.md' },
        { code: 'uninspected-source', path: 'Notes/unreadable.md' },
        { code: 'resolution-changed', path: 'Notes/link.md' }, { code: 'future-conflict', path: '' }] } };
    await update({ response: blocked });
    assert.ok(screen.getByRole('region', { name: messages.blockers }));
    assert.ok(screen.getByTestId('workspace-path-operation-issues').parentElement?.classList.contains('overflow-y-auto'),
      'long lists of blockers stay in the scrollable dialog body');
    for (const key of ['destinationCollision', 'uninspectedSource', 'resolutionChanged', 'unknown'] as const) {
      assert.ok(screen.getByText(messages.issue[key]), 'each reason has localized corrective guidance');
    }
    assert.ok(screen.getByText(`${messages.sourcePath}:`).parentElement?.textContent?.includes('ek-fuchs-transkript.md'));
    assert.ok(screen.getByText(/2026-10-07_EK-Fuchs_Waermepumpe_Besprechung_Transkript\.md/u).textContent?.startsWith(`${messages.destinationPath}:`));
    assert.equal(screen.queryByTestId('workspace-path-operation-resume'), null);
    assert.equal(controls.recoveries.length, 0, 'showing blocker details cannot execute or resume the action');

    await update({ response: { ...result('needs_recovery'), recovery: { canResume: true, canUndo: false } } });
    fireEvent.click(screen.getByTestId('workspace-path-operation-resume'));
    assert.deepEqual(controls.recoveries, ['resume']);
    assert.equal(screen.queryByTestId('workspace-path-operation-undo'), null, 'Undo requires genuine server capability');
    await update({ response: { ...result('queued'), recovery: { canResume: true, canUndo: true } }, busy: true, pendingAction: 'resume' });
    assert.equal((screen.getByTestId('workspace-path-operation-resume') as HTMLButtonElement).disabled, true);
    assert.equal((screen.getByTestId('workspace-path-operation-undo') as HTMLButtonElement).disabled, true);
    assert.equal(screen.queryByText(locale === 'en' ? 'Files and links updated' : 'Dateien und Links aktualisiert'), null, 'queued work is not presented as success');
    await update({ response: { ...result('applied'), recovery: { canResume: false, canUndo: true } }, busy: false, pendingAction: null });
    assert.ok(screen.getByText(locale === 'en' ? 'Files and links updated' : 'Dateien und Links aktualisiert'));
    fireEvent.click(screen.getByTestId('workspace-path-operation-undo'));
    assert.deepEqual(controls.recoveries, ['resume', 'undo']);

    const reviewId = 'legacy-ui-review-123456';
    await update({ request: { workspaceId, reviewId, authScope: scope }, response: null,
      review: { reviewId, kind: 'move', status: 'pending', selections: [{ sourcePath: 'stored.md' }], batchId: null, errorCode: null } });
    assert.ok(screen.getByText(locale === 'en' ? 'Reviews paused' : 'Reviews pausiert'));
    assert.ok(screen.getByText(locale === 'en' ? enMessages.workspacePathOperationStatus.reviewPausedGuidance : deMessages.workspacePathOperationStatus.reviewPausedGuidance));
    assert.equal(screen.queryByTestId('workspace-path-operation-resume'), null);
    assert.equal(screen.queryByTestId('workspace-path-operation-undo'), null);
    assert.equal(screen.queryByRole('button', { name: /Accept|Annehmen/u }), null, 'disabled proposals have no approval action');
    await update({ request: { workspaceId, documentReviewPaused: true, authScope: scope }, review: null });
    assert.ok(screen.getByText(locale === 'en' ? 'Reviews paused' : 'Reviews pausiert'));
    assert.equal(screen.queryByRole('button', { name: locale === 'en' ? 'Refresh' : 'Aktualisieren' }), null, 'document-review pause notice has no misleading action');

    const problemRequest: WorkspacePathOperationStatusRequest = { workspaceId, problemId: 'c'.repeat(64), authScope: scope };
    const problem: WorkspacePathOperationProblem = { problemId: 'c'.repeat(64), workspaceId, kind: 'delete', selections: [],
      errorCode: 'BATCH_JOURNAL_UNAVAILABLE', createdAt: 1, updatedAt: 1 };
    await update({ request: problemRequest, response: null, problem });
    assert.ok(screen.getByText('BATCH_JOURNAL_UNAVAILABLE'));
    assert.equal(screen.queryByTestId('workspace-path-operation-resume'), null);
    assert.equal(screen.queryByTestId('workspace-path-operation-undo'), null);
    assert.ok(screen.getByText(locale === 'en' ? enMessages.workspacePathOperationStatus.problemGuidance : deMessages.workspacePathOperationStatus.problemGuidance));
    await update({ problem: { ...problem, errorCode: 'BATCH_AUDIT_FAILED' } });
    assert.ok(screen.getByText(locale === 'en' ? enMessages.workspacePathOperationStatus.auditFailed : deMessages.workspacePathOperationStatus.auditFailed));
    await act(async () => { controls.workspace = 'foreign-workspace'; for (const listener of controls.listeners) listener(); });
    assert.equal(screen.queryByRole('dialog'), null, 'workspace switching immediately hides and resets private status');
    assert.equal(controls.state.request, null);
    await act(async () => { controls.workspace = workspaceId; controls.state = { ...empty(), request, response: result() }; for (const listener of controls.listeners) listener(); });
    await act(async () => { controls.auth = { ...scope, epoch: 2 }; for (const listener of controls.listeners) listener(); });
    assert.equal(screen.queryByRole('dialog'), null, 'auth epoch changes cannot reuse another session status');
    assert.equal(controls.state.request, null);
    screen.unmount();
  }
  const controls: Controls = { state: empty(), auth: null, workspace: workspaceId,
    params: new URLSearchParams({ workspaceId, workspacePathBatch: batchId }), listeners: new Set(), opened: [], recoveries: [], loads: 0, closes: 0 };
  window.history.replaceState(null, '', `/en/notebook?${controls.params}`);
  const Host = await compileUi(controls, 'en');
  const screen = render(<Host />);
  await settle();
  assert.equal(controls.opened.length, 0, 'cold deep link waits for authentication');
  await act(async () => { controls.auth = scope; for (const listener of controls.listeners) listener(); });
  await settle();
  assert.deepEqual(controls.opened, [{ workspaceId, batchId }]);
  assert.equal(new URL(window.location.href).searchParams.has('workspacePathBatch'), false, 'one-shot link is consumed before asynchronous navigation');
  screen.rerender(<Host />); await settle();
  assert.equal(controls.opened.length, 1, 'delayed route snapshots cannot reopen a consumed target');
  screen.unmount(); dom.window.close();
  console.log('workspace path status UI: localized independent dialog, capability gates, truthful progress, auth/workspace isolation and cold links passed');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
