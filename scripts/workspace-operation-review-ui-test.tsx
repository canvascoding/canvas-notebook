import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

import messages from '../messages/en.json';
import deMessages from '../messages/de.json';
import type { WorkspaceOperationReviewPublic } from '../app/lib/files/workspace-operation-review-contract';
import type { WorkspaceOperationBatchPublic } from '../app/lib/files/workspace-operation-batch-public';
import type { WorkspaceOperationCheckPublic, WorkspaceOperationCheckResponse } from '../app/lib/files/workspace-operation-check-contract';
import type * as Ui from '../app/components/file-version-center/WorkspaceOperationReviewPanel';

const workspaceId = 'workspace-one';
const reviewId = 'review-one';

function review(status: WorkspaceOperationReviewPublic['status'] = 'pending'): WorkspaceOperationReviewPublic {
  return {
    reviewId, planId: 'plan-sha-123', kind: 'move',
    selections: [{ sourcePath: 'Docs/target.md', destinationPath: 'Archive/target.md' }],
    sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId,
    status, actor: { type: 'agent', id: 'agent-one' }, reasonCodes: ['policy_required'],
    preview: {
      contractVersion: 1, planId: 'plan-sha-123', kind: 'move', status: 'planned',
      readiness: status === 'blocked' ? 'blocked' : 'ready',
      pathMappings: [{ sourceWorkspaceId: workspaceId, sourcePath: 'Docs/target.md',
        destinationWorkspaceId: workspaceId, destinationPath: 'Archive/target.md', sourceIdentity: 'file-one' }],
      linkEdits: [{ sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId,
        sourcePathBefore: 'Docs/index.md', sourcePathAfter: 'Docs/index.md', expectedContentHash: 'before',
        targetRange: { startUtf16: 4, endUtf16: 15, startUtf8Byte: 4, endUtf8Byte: 15 },
        previousTargetLiteral: './target.md', nextTargetLiteral: '../Archive/target.md' }],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
      expectedPathState: [], collisions: [], recoveryReady: false, issues: [],
    },
    createdAt: 1, updatedAt: 1, operationId: null, errorCode: null, trashEntryIds: [],
  };
}

function translate(key: string, values?: Record<string, string | number>): string {
  const value = (messages.workspaceOperationReview as Record<string, unknown>)[key];
  return (typeof value === 'string' ? value : key)
    .replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? `{${name}}`));
}

async function compileUi(controls: {
  reads: string[];
  decisions: Array<{ reviewId: string; planId: string; action: string }>;
  opens: string[];
  undoChecks: string[];
  undoCalls: string[];
  current: () => WorkspaceOperationReviewPublic;
  decide: (action: 'accept' | 'reject') => Promise<WorkspaceOperationReviewPublic>;
  list?: () => WorkspaceOperationReviewPublic[];
  currentBatch?: () => WorkspaceOperationBatchPublic;
  batchReads?: string[];
  batchPreviews?: string[][];
  batchAccepts?: Array<{ batchId: string; planId: string; workspaceId: string }>;
  previewBatch?: () => WorkspaceOperationBatchPublic;
  acceptBatch?: () => WorkspaceOperationBatchPublic;
  acceptFailure?: { message: string; status: number; code: string };
  batchUpdates?: Array<{ batchId: string; planId: string; workspaceId: string; action: 'resume' | 'undo' }>;
  updateBatch?: () => WorkspaceOperationBatchPublic;
  refreshCalls?: string[];
  refreshed?: () => WorkspaceOperationReviewPublic;
  closes?: number;
  openList?: (workspaceId: string) => void;
  checkReads?: string[];
  readCheck?: (check: WorkspaceOperationCheckPublic) => Promise<WorkspaceOperationCheckResponse>;
  documentOpens?: Array<{ path: string; workspaceId: string }>;
  changeDocument?: () => void;
  savedCheck?: WorkspaceOperationCheckPublic;
  authScope?: { userId: string; sessionId: string; epoch: number };
}) {
  const filename = path.resolve('app/components/file-version-center/WorkspaceOperationReviewPanel.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {} as typeof Ui & { disposeChecks: () => void };
  const authScope = controls.authScope ?? { userId: 'user-one', sessionId: 'session-one', epoch: 1 };
  const authListeners: Array<() => void> = [];
  const editorListeners: Array<(state: { activePath: string; draft: string }, prior: { activePath: string; draft: string }) => void> = [];
  const checks = new Map<string, WorkspaceOperationCheckPublic>();
  let nextCheck = 0;
  const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const button = ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string; size?: string;
  }) => <button type="button" {...props}>{children}</button>;
  class ReviewClientError extends Error {
    constructor(message: string, readonly status: number, readonly code: string | null) { super(message); }
  }
  const mocks: Record<string, unknown> = {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    'next-intl': { useTranslations: () => translate },
    '@/components/ui/button': { Button: button },
    '@/components/ui/dialog': {
      DialogContent: ({ children, layout: _layout, ...props }: React.HTMLAttributes<HTMLDivElement> & { layout?: string }) =>
        <div role="dialog" {...props}>{children}</div>,
      DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
      DialogFooter: passthrough, DialogHeader: passthrough,
      DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
    },
    '@/app/lib/files/workspace-operation-review-client': {
      WorkspaceOperationReviewClientError: ReviewClientError,
      listWorkspaceOperationReviews: async () => controls.list?.() ?? [review(), { ...review('blocked'), reviewId: 'review-blocked' }],
      readWorkspaceOperationReview: async (id: string) => { controls.reads.push(id); return controls.current(); },
      decideWorkspaceOperationReview: async (input: { reviewId: string; planId: string; action: 'accept' | 'reject' }) => {
        controls.decisions.push(input);
        return controls.decide(input.action);
      },
      previewWorkspaceOperationBatch: async (ids: string[]) => {
        controls.batchPreviews?.push(ids);
        return controls.previewBatch?.();
      },
      startWorkspaceOperationCheck: async (ids: string[]) => {
        controls.batchPreviews?.push(ids);
        const check: WorkspaceOperationCheckPublic = { checkId: `check-${++nextCheck}`, workspaceId, reviewIds: ids,
          status: 'queued', batchId: null, errorCode: null, createdAt: 1, updatedAt: 1 };
        checks.set(check.checkId, check);
        return check;
      },
      readWorkspaceOperationCheck: async (id: string) => {
        controls.checkReads?.push(id);
        const check = checks.get(id) ?? controls.savedCheck!;
        if (controls.readCheck) return controls.readCheck(check);
        const value = controls.previewBatch?.() ?? controls.currentBatch?.() ?? batchPreview();
        return { check: { ...check, status: value.status === 'blocked' ? 'blocked' : 'ready', batchId: value.batchId },
          batch: { ...value, reviewIds: check.reviewIds } };
      },
      acceptWorkspaceOperationBatch: async (input: { batchId: string; planId: string; workspaceId: string }) => {
        controls.batchAccepts?.push(input);
        if (controls.acceptFailure) throw new ReviewClientError(controls.acceptFailure.message, controls.acceptFailure.status, controls.acceptFailure.code);
        return controls.acceptBatch?.();
      },
      readWorkspaceOperationBatch: async (id: string) => {
        controls.batchReads?.push(id);
        return controls.currentBatch?.();
      },
      updateWorkspaceOperationBatch: async (input: { batchId: string; planId: string; workspaceId: string; action: 'resume' | 'undo' }) => {
        controls.batchUpdates?.push(input);
        return controls.updateBatch?.() ?? controls.currentBatch?.();
      },
      refreshWorkspaceOperationReview: async (input: { reviewId: string }) => {
        controls.refreshCalls?.push(input.reviewId);
        return controls.refreshed?.();
      },
    },
    '@/app/lib/files/workspace-operation-undo-client': {
      readWorkspaceOperationUndoAvailability: async (id: string) => {
        controls.undoChecks.push(id);
        return controls.undoCalls.length
          ? { available: false, reason: 'Operation already undone.', reasonCode: 'ALREADY_UNDONE', undoOperationId: 'undo-one' }
          : { available: true, reason: null, reasonCode: null, undoOperationId: 'undo-one' };
      },
      undoWorkspaceOperation: async (id: string) => {
        controls.undoCalls.push(id);
        return { originalOperationId: id, undoOperationId: 'undo-one', kind: 'move',
          status: 'applied', restoredPaths: ['Docs/target.md'], linkStatus: 'complete' };
      },
    },
    './WorkspaceOperationBackupPanel': {
      WorkspaceOperationBackupPanel: () => <section data-testid="workspace-operation-backups" />,
    },
    '@/app/lib/collaboration/opened-document-registry': {
      openedDocumentAuthScope: () => authScope,
      subscribeOpenedDocumentAuthInvalidation: (listener: () => void) => { authListeners.push(listener); return () => undefined; },
    },
    '@/app/store/editor-store': { useEditorStore: { subscribe: (listener: typeof editorListeners[number]) => { editorListeners.push(listener); return () => undefined; } } },
    '@/app/store/workspace-store': { useWorkspaceStore: { getState: () => ({ activeWorkspaceId: workspaceId }) } },
    '@/app/lib/file-watcher/client': { getFileWatcherClient: () => ({ addEventListener: () => undefined }) },
    './workspaceOperationDocumentNavigation': {
      openWorkspaceOperationSourceDocument: async (path: string, workspaceId: string) => { controls.documentOpens?.push({ path, workspaceId }); },
    },
    '@/app/store/file-store': { useFileStore: { getState: () => ({ refreshVisibleTree: async () => undefined }), subscribe: () => () => undefined } },
    '@/app/store/workspace-operation-review-store': {
      closeWorkspaceOperationReview: () => { controls.closes = (controls.closes ?? 0) + 1; },
      openWorkspaceOperationReview: (id: string) => controls.opens.push(id),
      openWorkspaceOperationReviewList: (workspaceId: string) => controls.openList?.(workspaceId),
    },
  };
  controls.changeDocument = () => editorListeners.forEach((listener) => listener({ activePath: 'Docs/index.md', draft: 'edited' }, { activePath: 'Docs/index.md', draft: 'before' }));
  const batchFilename = path.resolve('app/components/file-version-center/WorkspaceOperationBatchDetails.tsx');
  const batchSource = ts.transpileModule(await fs.readFile(batchFilename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const batchExports = {};
  new Function('require', 'module', 'exports', batchSource)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports: batchExports }, batchExports,
  );
  mocks['./WorkspaceOperationBatchDetails'] = batchExports;
  for (const component of ['workspaceOperationCheckController', 'WorkspaceOperationCheckDetails']) {
    const content = ts.transpileModule(await fs.readFile(path.resolve(`app/components/file-version-center/${component}.${component.endsWith('Controller') ? 'ts' : 'tsx'}`), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const componentExports = {};
    new Function('require', 'module', 'exports', content)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports: componentExports }, componentExports);
    mocks[`./${component}`] = componentExports;
  }
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports }, exports,
  );
  exports.disposeChecks = () => authListeners.forEach((listener) => listener());
  return exports;
}

test('workspace operation review shows all decisions against the displayed plan and masks stale apply', async () => {
  assert.equal(messages.workspaceOperationReview.dismiss, 'Dismiss');
  assert.equal(deMessages.workspaceOperationReview.dismiss, 'Verwerfen');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [] as string[], decisions: [] as Array<{ reviewId: string; planId: string; action: string }>,
    opens: [] as string[], undoChecks: [] as string[], undoCalls: [] as string[], current: () => ({ ...review(), kind: 'copy' }),
    decide: async (_action: 'accept' | 'reject') => ({ ...review('applied'), operationId: 'operation-one' }),
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const findButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);

  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'list', workspaceId }} />));
    assert.match(document.body.textContent ?? '', /Review file actions/u);
    const dialogClasses = document.querySelector('[data-testid="workspace-operation-review-center"]')?.classList;
    assert.ok(dialogClasses?.contains('transition-none'), 'viewport resizing must not animate dialog bounds');
    assert.ok(dialogClasses?.contains('data-[state=open]:animate-none'), 'opening must not scale viewport dialog bounds');
    assert.ok(dialogClasses?.contains('data-[state=closed]:animate-none'), 'closing must not scale viewport dialog bounds');
    assert.equal(document.querySelectorAll('button .font-mono').length, 2);
    await act(async () => document.querySelector<HTMLButtonElement>('button .font-mono')?.closest('button')?.click());
    assert.deepEqual(controls.opens, [reviewId]);

    const folderReview = review();
    folderReview.kind = 'copy';
    assert.ok(!('deletedPaths' in folderReview.preview));
    folderReview.selections = [{ sourcePath: 'Docs', destinationPath: 'Archive/Docs' }];
    const originalMapping = folderReview.preview.pathMappings[0];
    folderReview.preview.pathMappings = [
      { ...originalMapping, sourcePath: 'Docs', destinationPath: 'Archive/Docs', sourceIdentity: 'folder-one' },
      { ...originalMapping, destinationPath: 'Archive/Docs/target.md' },
      { ...originalMapping, sourcePath: 'Docs/other.md', destinationPath: 'Archive/Docs/other.md', sourceIdentity: 'file-two' },
    ];
    folderReview.preview.linkEdits.push({ ...folderReview.preview.linkEdits[0],
      targetRange: { startUtf16: 24, endUtf16: 35, startUtf8Byte: 24, endUtf8Byte: 35 },
      previousTargetLiteral: './other.md', nextTargetLiteral: '../Archive/Docs/other.md',
    });
    controls.current = () => folderReview;
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="folder" request={{ mode: 'detail', reviewId, workspaceId }} />));
    const childDetails = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-path-children"]');
    assert.equal(childDetails?.open, false, 'directory descendants start collapsed');
    assert.match(childDetails?.querySelector('summary')?.textContent ?? '', /Show 2 contained paths/u);
    assert.equal(document.querySelectorAll('[data-testid="workspace-operation-link-groups"] .divide-y').length, 1,
      'edits in one document are grouped together');
    const technical = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-technical-details"]');
    assert.equal(technical?.open, false, 'technical identifiers and warnings start collapsed');
    assert.ok(technical?.contains(document.querySelector('[data-testid="workspace-operation-plan-id"]')));
    assert.ok(document.querySelector('[data-testid="workspace-operation-link-groups"]')!.compareDocumentPosition(technical!)
      & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'technical details follow the changes');
    controls.current = () => ({ ...review(), kind: 'copy' });

    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="detail" request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.match(document.body.textContent ?? '', /Docs\/target\.md → Archive\/target\.md/u);
    assert.match(document.body.textContent ?? '', /\.\/target\.md/u);
    assert.match(document.body.textContent ?? '', /\.\.\/Archive\/target\.md/u);
    assert.match(document.body.textContent ?? '', /plan-sha-123/u);
    assert.match(document.body.textContent ?? '', /backup is checked and created during apply/u);
    await act(async () => findButton(translate('accept'))?.click());
    assert.deepEqual(controls.decisions, [{ reviewId, workspaceId, planId: 'plan-sha-123', action: 'accept' }]);
    assert.match(document.body.textContent ?? '', /Applied/u);
    assert.equal(findButton(translate('accept')), undefined);
    assert.deepEqual(controls.undoChecks, ['operation-one']);
    assert.ok(findButton(translate('undo')), 'applied operation exposes a checked undo action');
    await act(async () => findButton(translate('undo'))?.click());
    assert.deepEqual(controls.undoCalls, ['operation-one']);
    assert.match(document.body.textContent ?? '', /file action was undone/u);
    assert.equal(findButton(translate('undo')), undefined);

    controls.current = () => ({ ...review('stale'), kind: 'copy' });
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="stale" request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.match(document.body.textContent ?? '', /The plan is stale/u);
    assert.equal(findButton(translate('accept')), undefined);
    assert.equal(controls.decisions.length, 1);

    const warningReview = review();
    warningReview.kind = 'copy';
    assert.ok(!('deletedPaths' in warningReview.preview));
    warningReview.preview = { ...warningReview.preview,
      coverage: { complete: false, omittedSources: [], unresolvedLinks: [
        { sourcePath: 'Archive/old.md', targetLiteral: 'missing.md', status: 'missing' },
      ] },
      linkAssessment: { version: 1, complete: true, blockers: [], warnings: [
        { sourcePath: 'Archive/old.md', targetLiteral: 'missing.md', status: 'missing', reason: 'unaffected-existing-link' },
      ] },
    };
    controls.current = () => warningReview;
    controls.decide = async () => ({ ...warningReview, status: 'applied' });
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="warning-only" request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.match(document.querySelector('[data-testid="workspace-operation-readiness"]')?.textContent ?? '', /Ready for approval/u);
    assert.ok(findButton(translate('accept')), 'unaffected workspace warnings do not disable approval');
    const warningDetails = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-link-warnings"]');
    assert.equal(warningDetails?.open, false, 'unaffected warnings start collapsed');
    assert.match(warningDetails?.textContent ?? '', /Archive\/old\.md: missing\.md/u);
    const coverageDetails = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-link-coverage"]');
    assert.equal(coverageDetails?.open, false, 'workspace diagnostics start collapsed');
    assert.match(coverageDetails?.textContent ?? '', /Link coverage: Incomplete/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-link-blockers"]'), null);
    await act(async () => findButton(translate('accept'))?.click());
    assert.equal(controls.decisions.length, 2, 'warning-only plan can be accepted');

    const affectedReview = review('blocked');
    affectedReview.kind = 'copy';
    assert.ok(!('deletedPaths' in affectedReview.preview));
    affectedReview.preview = { ...affectedReview.preview, coverage: warningReview.preview.coverage,
      linkAssessment: { version: 1, complete: false, warnings: warningReview.preview.linkAssessment!.warnings,
        blockers: [{
          sourcePath: '05_content-engine/atelier-notes/01_margiela-replica-alternative/maison-margiela-replica-alternative.md',
          targetLiteral: 'The First 100 Collection', status: 'missing', reason: 'affected-unresolved-link',
        }],
      },
      issues: [{ code: 'incomplete-index', workspaceId, path: '', detail: 'Affected link unresolved.' }],
    };
    controls.current = () => affectedReview;
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="affected-link" request={{ mode: 'detail', reviewId, workspaceId }} />));
    const blockers = document.querySelector('[data-testid="workspace-operation-link-blockers"]');
    assert.match(blockers?.textContent ?? '', /atelier-notes\/01_margiela-replica-alternative/u);
    assert.match(blockers?.textContent ?? '', /The First 100 Collection/u);
    assert.match(blockers?.textContent ?? '', /Correct its target or create the missing file/u);
    assert.match(document.querySelector('[data-testid="workspace-operation-readiness"]')?.textContent ?? '', /fresh preview/u);
    assert.equal(findButton(translate('accept')), undefined, 'affected missing link remains a blocker');
    assert.ok(findButton(translate('dismiss')));

    controls.current = () => ({ ...review('blocked'), kind: 'copy' });
    controls.decide = async () => review('rejected');
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="blocked" request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.equal(findButton(translate('accept')), undefined, 'blocked review cannot be applied');
    assert.ok(findButton(translate('dismiss')), 'blocked review can be dismissed');
    assert.match(document.body.textContent ?? '', /This action has not been executed/u);
    assert.match(document.body.textContent ?? '', /Close keeps it available in the notification center/u);
    await act(async () => findButton(translate('dismiss'))?.click());
    assert.deepEqual(controls.decisions.at(-1), {
      reviewId, workspaceId, planId: 'plan-sha-123', action: 'reject',
    });
    assert.match(document.body.textContent ?? '', /Rejected/u);
    assert.equal(findButton(translate('dismiss')), undefined, 'dismissed review cannot be decided again');
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

function batchPreview(status: WorkspaceOperationBatchPublic['status'] = 'preview'): WorkspaceOperationBatchPublic {
  const original = review();
  assert.ok(!('deletedPaths' in original.preview));
  const mapping = original.preview.pathMappings[0];
  const edit = original.preview.linkEdits[0];
  return {
    batchId: 'batch-one', planId: 'combined-plan-123', workspaceId,
    reviewIds: [reviewId, 'review-delete'], status, completedActions: 0, totalActions: 4,
    phase: 'preparing', errorCode: null, trashEntryIds: [], createdAt: 1, updatedAt: 1, undoAvailable: false,
    preview: {
      version: 1, workspaceId, planId: 'combined-plan-123', readiness: 'ready',
      actions: [
        { reviewId, kind: 'move', selections: [{ sourcePath: 'Docs', destinationPath: 'Archive/Docs' }] },
        { reviewId: 'review-delete', kind: 'delete', selections: [{ sourcePath: 'Old.md' }] },
      ],
      pathMappings: [
        { ...mapping, sourcePath: 'Docs', destinationPath: 'Archive/Docs', sourceIdentity: 'folder-one', sourceKind: 'directory' },
        { ...mapping, destinationPath: 'Archive/Docs/target.md', sourceKind: 'file' },
        { ...mapping, sourcePath: 'Docs/index.md', destinationPath: 'Archive/Docs/index.md', sourceIdentity: 'file-two', sourceKind: 'file' },
      ],
      deletedPaths: [{ path: 'Old.md', kind: 'file', identity: 'deleted-file' }],
      pathSteps: [
        { reviewId, kind: 'move', sourcePath: 'Docs', destinationPath: 'Archive/Docs' },
        { reviewId: 'review-delete', kind: 'delete', sourcePath: 'Old.md' },
      ],
      linkEdits: [
        { ...edit, sourcePathBefore: 'Reference.md', sourcePathAfter: 'Reference.md',
          previousTargetLiteral: './Docs/target.md', nextTargetLiteral: './Archive/Docs/target.md', changeKind: 'rewrite',
          snippet: { before: '[target](./Docs/target.md)', after: '[target](./Archive/Docs/target.md)' } },
        { ...edit, sourcePathBefore: 'Reference.md', sourcePathAfter: 'Reference.md',
          previousTargetLiteral: 'Old.md', nextTargetLiteral: '', changeKind: 'unlink',
          snippet: { before: '[old](Old.md)', after: 'old' } },
      ],
      expectedPathState: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
      linkAssessment: { version: 1, complete: true, warnings: [], blockers: [] }, issues: [], changedReviews: [],
    },
  };
}

test('selected reviews require a combined preview, show exact scope, and reopen durable progress', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const deletion = { ...review('stale'), reviewId: 'review-delete', kind: 'delete' as const,
    selections: [{ sourcePath: 'Old.md' }] };
  const closed = { ...review('applied'), reviewId: 'closed-review' };
  let currentBatch = batchPreview();
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [],
    list: () => [review(), deletion, closed], current: () => ({ ...review('queued'), batchId: 'batch-one' }),
    decide: async () => review('queued'), batchReads: [], batchPreviews: [], batchAccepts: [],
    previewBatch: () => currentBatch, acceptBatch: () => { currentBatch = { ...currentBatch, status: 'queued' }; return currentBatch; },
    currentBatch: () => currentBatch,
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  let root = createRoot(document.getElementById('root')!);
  const findButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'list', workspaceId }} />));
    const previewButton = document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-preview"]')!;
    assert.equal(previewButton.disabled, true, 'a selection is required');
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-selection"]')?.open, true, 'initial selection is expanded');
    assert.equal(document.querySelector('[data-testid="workspace-operation-review-select-closed-review"]'), null,
      'closed reviews cannot join a fresh action group');
    await act(async () => document.querySelector<HTMLInputElement>('[data-testid="workspace-operation-review-select-all"]')!.click());
    assert.equal(document.querySelector<HTMLInputElement>(`[data-testid="workspace-operation-review-select-${reviewId}"]`)!.checked, true);
    assert.equal(document.querySelector<HTMLInputElement>('[data-testid="workspace-operation-review-select-review-delete"]')!.checked, true,
      'stale proposals can be selected for a freshly rebuilt preview');
    await act(async () => previewButton.click());
    assert.deepEqual(controls.batchPreviews, [['review-delete', reviewId]]);
    assert.deepEqual(controls.batchAccepts, [], 'creating the combined preview never starts execution');
    const selection = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-selection"]')!;
    const batchDetails = document.querySelector('[data-testid="workspace-operation-batch-details"]')!;
    assert.equal(selection.open, false, 'selection folds after the exact preview is ready');
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-paths"]'), null, 'ready batch paths replace the quick checking paths instead of duplicating them');
    assert.ok(batchDetails.compareDocumentPosition(selection) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the concrete plan precedes selection rows');
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-backup-details"]')?.open, false, 'backups stay accessible without delaying the decision');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-preview"]'), null, 'a matching checked plan has one approval action');
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-accept"]'));
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-status"]')?.textContent ?? '', /Actions: 2 · Files: 3 · Folders: 1 · Link changes: 2/u);
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-path-children"]')?.open, false);
    assert.equal(document.querySelectorAll('[data-testid="workspace-operation-batch-links"] .divide-y').length, 1,
      'two edits in the same Markdown source share a single group');
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-links"]')?.textContent ?? '', /Link removed; text kept/u);
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-links"]')?.textContent ?? '', /\[old\]\(Old\.md\)/u);
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-technical-details"]')?.open, false);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-accept"]')!.click());
    assert.deepEqual(controls.batchAccepts, [{ batchId: 'batch-one', workspaceId, planId: 'combined-plan-123' }],
      'only the displayed combined plan is accepted');
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-status"]')?.textContent ?? '', /Queued for processing/u);
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-status"]')?.textContent ?? '', /continues in the background/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null, 'a queued group cannot be accepted twice');
    await act(async () => findButton(translate('close'))?.click());
    assert.equal(controls.closes, 1);
    await act(async () => root.unmount());
    currentBatch = { ...currentBatch, status: 'applied', completedActions: 4, phase: 'complete', undoAvailable: true };
    root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.ok(controls.batchReads!.length >= 2, 'reopening retrieves durable server state');
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-receipt"]')?.textContent ?? '', /Completed — files: 3; folders: 1; link changes: 2/u);
    assert.ok(findButton(translate('undo')));
    assert.deepEqual(controls.decisions, [], 'batch selection does not issue separate single-review approvals');
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test('refresh creates a successor review and blocked combined plans expose pending edits without approval', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const successor = { ...review(), reviewId: 'review-successor', previousReviewId: reviewId };
  const blockedBatch = batchPreview('blocked');
  blockedBatch.preview.readiness = 'blocked';
  blockedBatch.preview.issues = [{ code: 'pending-content-changes', path: 'Docs/index.md', detail: 'A content decision is pending.' }];
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [],
    current: () => ({ ...review('stale'), kind: 'copy' }), decide: async () => review(), refreshCalls: [], refreshed: () => successor,
    batchPreviews: [], previewBatch: () => blockedBatch,
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.ok(document.querySelector('[data-testid="workspace-operation-review-refresh"]'));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-review-refresh"]')!.click());
    assert.deepEqual(controls.refreshCalls, [reviewId]);
    assert.deepEqual(controls.opens, ['review-successor'], 'refresh navigates to the new proposal and leaves the old history intact');
    assert.match(document.querySelector('[data-testid="workspace-operation-review-refreshed"]')?.textContent ?? '', /previous proposal remains in the history/u);
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="list-blocked" request={{ mode: 'list', workspaceId }} />));
    await act(async () => document.querySelector<HTMLInputElement>('[data-testid="workspace-operation-review-select-all"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-preview"]')!.click());
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    assert.match(document.querySelector('[data-testid="workspace-operation-pending-changes"]')?.textContent ?? '', /Pending content changes/u);
    assert.match(document.querySelector('[data-testid="workspace-operation-pending-changes"]')?.textContent ?? '', /Docs\/index\.md/u);
    assert.deepEqual(controls.decisions, []);
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test('back from an automatically refreshed single action opens the list without recreating its batch', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const openedLists: string[] = [];
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [],
    current: () => review(), decide: async () => review(), batchPreviews: [], previewBatch: () => batchPreview(),
  };
  const ui = await compileUi(controls);
  controls.openList = (id: string) => {
    openedLists.push(id);
    root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'list', workspaceId: id }} />);
  };
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.deepEqual(controls.batchPreviews, [[reviewId]], 'opening the single action builds one current preview');
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-details"]'));
    const back = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === translate('back'))!;
    await act(async () => back.click());
    assert.deepEqual(openedLists, [workspaceId]);
    assert.ok(document.querySelector('[data-testid="workspace-operation-review-select-all"]'), 'the selectable list is visible after Back');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-details"]'), null);
    assert.deepEqual(controls.batchPreviews, [[reviewId]], 'Back never recreates the same detail batch');
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test('failed action retries the exact approved durable job without creating or approving another plan', async () => {
  assert.equal(messages.workspaceOperationReview.retryBatch, 'Retry approved action');
  assert.equal(deMessages.workspaceOperationReview.retryBatch, 'Freigegebene Aktion erneut versuchen');
  assert.match(deMessages.workspaceOperationReview.batchFailedHelp, /demselben freigegebenen Plan/u);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  let savedBatch = { ...batchPreview('failed'), errorCode: 'WORKER_PREPARATION_FAILED' };
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [],
    current: () => ({ ...review('failed'), batchId: savedBatch.batchId }),
    decide: async () => review(), currentBatch: () => savedBatch,
    batchReads: [], batchPreviews: [], batchAccepts: [], batchUpdates: [],
    updateBatch: () => { savedBatch = { ...savedBatch, status: 'queued' }; return savedBatch; },
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-status"]')?.textContent ?? '', /same approved plan/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    assert.equal(document.querySelector('[data-testid="workspace-operation-review-refresh"]'), null);
    const retry = document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-resume"]')!;
    assert.equal(retry.textContent, translate('retryBatch'));
    await act(async () => retry.click());
    assert.deepEqual(controls.batchUpdates, [{ batchId: 'batch-one', planId: 'combined-plan-123', workspaceId, action: 'resume' }]);
    assert.deepEqual(controls.batchPreviews, [], 'retry must reuse the existing durable job');
    assert.deepEqual(controls.batchAccepts, [], 'retry must not silently approve another plan');
    assert.deepEqual(controls.decisions, []);
    assert.match(document.querySelector('[data-testid="workspace-operation-batch-status"]')?.textContent ?? '', /Queued for processing/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-resume"]'), null);
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('background checks keep roots visible, survive close and reopen, and require a fresh check after editing', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  let mode: 'waiting' | 'ready' | 'blocked' | 'failed' = 'waiting';
  let finish!: (response: WorkspaceOperationCheckResponse) => void;
  let waitingCheck!: WorkspaceOperationCheckPublic;
  const checked = batchPreview();
  checked.reviewIds = [reviewId];
  checked.preview.linkAssessment.restoredLinks = [{ sourcePath: 'README.md', targetLiteral: './Archive/Docs/target.md', targetPath: 'Archive/Docs/target.md' }];
  checked.preview.linkAssessment.warnings = [{ sourcePath: 'Unrelated.md', targetLiteral: 'Still missing', status: 'missing', reason: 'unaffected-existing-link' }];
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [],
    current: () => review(), decide: async () => review(), batchPreviews: [], batchAccepts: [], checkReads: [], documentOpens: [],
    readCheck: async (check) => {
      if (mode === 'waiting') { waitingCheck = check; return new Promise((resolve) => { finish = resolve; }); }
      if (mode === 'failed') return { check: { ...check, status: 'failed', errorCode: 'CHECK_FAILED' } };
      const batch = structuredClone(checked);
      batch.planId = `fresh-plan-${check.checkId}`;
      batch.preview.planId = batch.planId;
      if (mode === 'blocked') {
        batch.status = 'blocked'; batch.preview.readiness = 'blocked';
        batch.preview.linkAssessment.blockers = [{ workspaceId, sourcePath: 'Docs/index.md', targetLiteral: 'Ambiguous link', status: 'ambiguous', reason: 'affected-unresolved-link' }];
      }
      return { check: { ...check, status: mode, batchId: batch.batchId }, batch };
    },
    acceptBatch: () => ({ ...checked, status: 'queued' }), currentBatch: () => ({ ...checked, status: 'applied' }),
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  let root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-status'), 'queued');
    assert.match(document.querySelector('[data-testid="workspace-operation-check-paths"]')?.textContent ?? '', /Docs\/target\.md → Archive\/target\.md/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null, 'no approval while the scan is outstanding');
    assert.doesNotMatch(document.body.textContent ?? '', /Loading file actions/u, 'the outstanding full scan does not keep the detail loading screen');
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.equal(controls.batchPreviews?.length, 1, 'rerender reuses the same running check');
    await act(async () => root.unmount());
    mode = 'ready';
    finish({ check: { ...waitingCheck, status: 'ready', batchId: checked.batchId }, batch: checked });
    await Promise.resolve();
    root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.equal(controls.batchPreviews?.length, 1, 'closing and reopening does not create another job');
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-check-id'), 'check-1');
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-accept"]'));
    assert.match(document.querySelector('[data-testid="workspace-operation-restored-links"]')?.textContent ?? '', /Link works after move \(1\)/u);
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-technical-details"]')?.open, false);
    await act(async () => controls.changeDocument?.());
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-status'), 'stale');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null, 'editing invalidates the displayed approval');
    mode = 'blocked';
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-check-again"]')!.click());
    assert.equal(controls.batchPreviews?.length, 2, 'explicit check again creates a fresh background check');
    assert.equal(document.querySelectorAll('[data-testid="workspace-operation-link-blockers"]').length, 1);
    assert.match(document.querySelector('[data-testid="workspace-operation-link-blockers"]')?.textContent ?? '', /Ambiguous link/u);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-blocker-open-0"]')!.click());
    assert.deepEqual(controls.documentOpens, [{ path: 'Docs/index.md', workspaceId }]);
    mode = 'failed';
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-check-again"]')!.click());
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-status'), 'failed');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    mode = 'ready';
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-check-again"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-accept"]')!.click());
    assert.deepEqual(controls.batchAccepts, [{ batchId: checked.batchId, workspaceId, planId: 'fresh-plan-check-4' }], 'only the newly checked immutable plan is approved');
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('bulk selection stays interactive while checks run and changes cannot approve another selection', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [], current: () => review(), decide: async () => review(),
    batchPreviews: [], readCheck: async (check) => ({ check: { ...check, status: 'checking' } }),
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'list', workspaceId }} />));
    await act(async () => document.querySelector<HTMLInputElement>('[data-testid="workspace-operation-review-select-all"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-preview"]')!.click());
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-status'), 'checking');
    assert.ok(document.querySelector('[data-testid="workspace-operation-check-paths"]'), 'quick selected roots stay visible while checking');
    const selection = document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-selection"]')!;
    assert.equal(selection.open, false, 'the checking state comes before collapsed selection');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-preview"]'), null, 'an unchanged selection does not create another checking job');
    await act(async () => document.querySelector<HTMLElement>('[data-testid="workspace-operation-selection-summary"]')!.click());
    assert.equal(selection.open, true, 'native selection disclosure remains accessible during checking');
    const selected = document.querySelector<HTMLInputElement>(`[data-testid="workspace-operation-review-select-${reviewId}"]`)!;
    assert.equal(selected.disabled, false);
    await act(async () => selected.click());
    assert.equal(selected.checked, false, 'selection remains responsive while the full scan runs');
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-preview"]'), 'a changed selection can request its own new check');
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-status'), 'stale');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-check-again"]')!.click());
    assert.deepEqual(controls.batchPreviews, [['review-blocked', reviewId].sort(), ['review-blocked']], 'new check is scoped to the newly selected review IDs');
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('session storage rehydrates a scoped running check through GET and never trusts a prior user receipt', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const saved: WorkspaceOperationCheckPublic = { checkId: 'persisted-check', workspaceId, reviewIds: [reviewId], status: 'checking', batchId: null, errorCode: null, createdAt: 1, updatedAt: 1 };
  const storageKey = `canvas:operation-check:${JSON.stringify(['user-one', 'session-one', workspaceId, [reviewId]])}`;
  window.sessionStorage.setItem(storageKey, saved.checkId);
  let respond!: (value: WorkspaceOperationCheckResponse) => void;
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [], current: () => review(), decide: async () => review(),
    savedCheck: saved, batchPreviews: [], checkReads: [], readCheck: () => new Promise((resolve) => { respond = resolve; }),
  };
  let ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  let root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.deepEqual(controls.batchPreviews, [], 'reload uses GET for the saved ID rather than starting another scan');
    assert.deepEqual(controls.checkReads, [saved.checkId]);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null, 'local storage cannot grant approval before server validation');
    const ready = batchPreview();
    ready.reviewIds = [reviewId];
    await act(async () => respond({ check: { ...saved, status: 'ready', batchId: ready.batchId }, batch: ready }));
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]')?.getAttribute('data-check-id'), saved.checkId);
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-accept"]'));
    await act(async () => root.unmount());
    ui.disposeChecks();
    controls.authScope = { userId: 'user-two', sessionId: 'session-two', epoch: 2 };
    controls.batchPreviews = []; controls.checkReads = [];
    controls.readCheck = async (check) => ({ check: { ...check, status: 'checking' } });
    ui = await compileUi(controls);
    root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.deepEqual(controls.batchPreviews, [[reviewId]], 'another user/session cannot reuse the saved receipt');
    assert.ok(!controls.checkReads.includes(saved.checkId));
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks();
    dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

async function withMountedBatchReview(batch: WorkspaceOperationBatchPublic, body: (controls: Parameters<typeof compileUi>[0]) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  let savedBatch = batch;
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [],
    current: () => ({ ...review('needs_recovery'), batchId: batch.batchId }), decide: async () => review(),
    currentBatch: () => savedBatch, batchPreviews: [], batchAccepts: [], batchUpdates: [], documentOpens: [],
    updateBatch: () => { savedBatch = { ...savedBatch, status: 'queued' }; return savedBatch; },
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    await body(controls);
  } finally {
    await act(async () => root.unmount());
    ui.disposeChecks(); dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function partialExecutionBatch(mode: 'apply' | 'undo' = 'apply'): WorkspaceOperationBatchPublic {
  return {
    ...batchPreview('needs_recovery'), completedActions: 3, errorCode: 'LINK_WRITE_STALE',
    execution: { mode, receiptStatus: 'available', finalization: 'pending', steps: mode === 'apply' ? [
      { key: 'path:0', phase: 'path', kind: 'move', path: 'Docs', destinationPath: 'Archive/Docs', reviewId, state: 'applied' },
      { key: 'path:1', phase: 'path', kind: 'delete', path: 'Old.md', reviewId: 'review-delete', state: 'pending' },
      { key: 'link:0', phase: 'link', kind: 'link_update', path: 'Reference.md', openPath: 'Reference.md', state: 'pending' },
      { key: 'link:1', phase: 'link', kind: 'link_update', path: 'Check.md', state: 'needs_check' },
    ] : [
      { key: 'path:1', phase: 'path', kind: 'restore', path: 'Old.md', reviewId: 'review-delete', state: 'applied' },
      { key: 'link:0', phase: 'link', kind: 'link_update', path: 'Reference.md', openPath: 'Reference.md', state: 'pending' },
      { key: 'path:0', phase: 'path', kind: 'move', path: 'Archive/Docs', destinationPath: 'Docs', reviewId, state: 'needs_check' },
    ] },
  };
}

test('partial forward execution shows exact journal results and resumes only the approved job', async () => {
  await withMountedBatchReview(partialExecutionBatch(), async (controls) => {
    const execution = document.querySelector('[data-testid="workspace-operation-execution"]')!;
    assert.match(execution.textContent ?? '', /Recorded progress/u);
    const row = (key: string) => document.querySelector(`[data-testid="workspace-operation-execution-step-${key}"]`)!;
    assert.equal(row('path:0').getAttribute('data-step-state'), 'applied');
    assert.match(row('path:0').textContent ?? '', /Done/u);
    assert.match(row('path:0').textContent ?? '', /Docs.*Archive\/Docs/u);
    assert.equal(row('path:1').getAttribute('data-step-state'), 'pending');
    assert.match(row('path:1').textContent ?? '', /Still pending/u);
    assert.equal(row('link:0').getAttribute('data-step-state'), 'pending', 'a numeric progress count cannot invent a completed link write');
    assert.equal(row('link:1').getAttribute('data-step-state'), 'needs_check');
    assert.match(row('link:1').textContent ?? '', /Check result/u);
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-conflict"]'));
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    assert.equal(document.querySelector('[data-testid="workspace-operation-review-refresh"]'), null);
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="workspace-operation-technical-details"]')?.open, false);
    assert.doesNotMatch(execution.textContent ?? '', /LINK_WRITE_STALE/u, 'technical codes stay outside the decision summary');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-execution-open-link:0"]')!.click());
    assert.deepEqual(controls.documentOpens, [{ path: 'Reference.md', workspaceId }]);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-resume"]')!.click());
    assert.deepEqual(controls.batchUpdates, [{ batchId: 'batch-one', planId: 'combined-plan-123', workspaceId, action: 'resume' }]);
    assert.deepEqual(controls.batchPreviews, []);
    assert.deepEqual(controls.batchAccepts, []);
    assert.deepEqual(controls.decisions, []);
  });
});

test('partial Undo shows restoration receipts without reusing the forward move as a completed result', async () => {
  await withMountedBatchReview(partialExecutionBatch('undo'), async () => {
    const execution = document.querySelector('[data-testid="workspace-operation-execution"]')!;
    assert.match(execution.textContent ?? '', /Recorded undo progress/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-execution-step-path:1"]')?.getAttribute('data-step-state'), 'applied');
    assert.match(document.querySelector('[data-testid="workspace-operation-execution-step-path:1"]')?.textContent ?? '', /Old\.md/u);
    const reversed = document.querySelector('[data-testid="workspace-operation-execution-step-path:0"]')!;
    assert.equal(reversed.getAttribute('data-step-state'), 'needs_check');
    assert.match(reversed.textContent ?? '', /Archive\/Docs.*Docs/u);
    assert.equal(document.querySelector('[data-testid="workspace-operation-execution-step-link:0"]')?.getAttribute('data-step-state'), 'pending');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-receipt"]'), null);
  });
});

test('an unavailable execution journal never turns aggregate progress into Done receipts', async () => {
  const source = partialExecutionBatch();
  const batch = { ...source, completedActions: 4,
    execution: { mode: 'apply' as const, receiptStatus: 'unavailable' as const, finalization: 'pending' as const,
      steps: source.execution!.steps.map((step) => ({ ...step, openPath: undefined, state: 'needs_check' as const })) } };
  await withMountedBatchReview(batch, async () => {
    const execution = document.querySelector('[data-testid="workspace-operation-execution"]')!;
    assert.ok(execution);
    assert.equal(execution.querySelectorAll('[data-step-state="needs_check"]').length, 4);
    assert.doesNotMatch(execution.textContent ?? '', /\bDone\b/u);
    assert.equal(execution.querySelector('[data-testid^="workspace-operation-execution-open-"]'), null, 'unknown locations cannot offer navigation to a guessed path');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-receipt"]'), null);
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-resume"]'));
  });
});

test('recorded applied steps with pending finalization do not claim the file actions completed', async () => {
  const batch = partialExecutionBatch();
  batch.completedActions = batch.totalActions;
  batch.execution!.steps = batch.execution!.steps.map((step) => ({ ...step, state: 'applied' }));
  await withMountedBatchReview(batch, async () => {
    const execution = document.querySelector('[data-testid="workspace-operation-execution"]')!;
    assert.ok(execution);
    assert.equal(execution.querySelectorAll('[data-step-state="applied"]').length, 4);
    assert.match(execution.textContent ?? '', /final|pending/iu);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-receipt"]'), null);
    assert.doesNotMatch(document.querySelector('[data-testid="workspace-operation-batch-status"]')?.textContent ?? '', /File actions completed/u);
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-resume"]'));
  });
});

test('a preflight peer conflict offers a fresh check without automatically resuming or approving changed files', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const original = batchPreview();
  const fresh = { ...batchPreview(), batchId: 'fresh-peer-batch', planId: 'fresh-peer-plan',
    preview: { ...batchPreview().preview, planId: 'fresh-peer-plan' } };
  const stale: WorkspaceOperationBatchPublic = { ...original, status: 'needs_review', errorCode: 'LINK_WRITE_STALE',
    execution: { mode: 'apply', receiptStatus: 'not_started', finalization: 'pending', steps: [] } };
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [], current: () => review(), decide: async () => review(),
    batchPreviews: [], batchAccepts: [], batchUpdates: [],
    previewBatch: () => controls.batchPreviews!.length > 1 ? fresh : original,
    acceptBatch: () => ({ ...original, status: 'queued' }), currentBatch: () => stale,
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ mode: 'detail', reviewId, workspaceId }} />));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-accept"]')!.click());
    assert.ok(document.querySelector('[data-testid="workspace-operation-batch-conflict"]'));
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-resume"]'), null);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    assert.deepEqual(controls.batchPreviews, [[reviewId]], 'conflict never creates a replacement preview by itself');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-review-refresh"]')!.click());
    assert.deepEqual(controls.batchPreviews, [[reviewId], [reviewId]]);
    assert.deepEqual(controls.batchUpdates, []);
    assert.equal(controls.batchAccepts!.length, 1, 'checking current bytes never automatically accepts them');
    assert.equal(document.querySelector('[data-testid="workspace-operation-plan-id"]')?.textContent, fresh.planId);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-accept"]')!.click());
    assert.deepEqual(controls.batchAccepts![1], { batchId: fresh.batchId, planId: fresh.planId, workspaceId });
  } finally {
    await act(async () => root.unmount()); ui.disposeChecks(); dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

for (const failedRead of [false, true]) test(`a rejected acceptance race requires a fresh check when follow-up GET ${failedRead ? 'fails' : 'retains the old ready plan'}`, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const unchangedServerPlan = batchPreview();
  const fresh = { ...batchPreview(), batchId: 'acceptance-race-fresh-batch', planId: 'acceptance-race-fresh-plan',
    preview: { ...batchPreview().preview, planId: 'acceptance-race-fresh-plan' } };
  const controls: Parameters<typeof compileUi>[0] = {
    reads: [], decisions: [], opens: [], undoChecks: [], undoCalls: [], current: () => review(), decide: async () => review(),
    batchPreviews: [], batchAccepts: [], batchUpdates: [], batchReads: [],
    previewBatch: () => controls.batchPreviews!.length > 1 ? fresh : unchangedServerPlan,
    currentBatch: () => { if (failedRead) throw new Error('The follow-up GET is unavailable.'); return unchangedServerPlan; },
    acceptFailure: { message: 'PREVIEW_STALE internal diagnostic', status: 409, code: 'PREVIEW_STALE' },
    acceptBatch: () => ({ ...fresh, status: 'queued' }),
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    const request = { mode: 'detail' as const, reviewId, workspaceId };
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={request} />));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-accept"]')!.click());
    assert.deepEqual(controls.batchReads, [unchangedServerPlan.batchId], 'the actual saved job is still read after the conflict');
    assert.equal(unchangedServerPlan.status, 'preview', 'the test server state was never relabeled to invent a successful refresh');
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null);
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-status"]'), null);
    assert.equal(document.querySelector('[data-testid="workspace-operation-check-again"]'), null);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-resume"]'), null);
    const conflict = document.querySelector('[data-testid="workspace-operation-batch-conflict"]')!;
    assert.ok(conflict);
    assert.match(conflict.textContent ?? '', /has not changed files or links/iu);
    assert.doesNotMatch(document.querySelector('[role="alert"]')?.textContent ?? '', /PREVIEW_STALE/u);
    assert.deepEqual(controls.batchPreviews, [[reviewId]], 'a rejected acceptance never starts a hidden new check');
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel request={{ ...request }} />));
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-accept"]'), null, 'ordinary rerenders cannot forget the conflict');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-review-refresh"]')!.click());
    assert.deepEqual(controls.batchPreviews, [[reviewId], [reviewId]]);
    assert.equal(controls.batchAccepts!.length, 1, 'the new check still needs an explicit approval');
    assert.equal(document.querySelector('[data-testid="workspace-operation-plan-id"]')?.textContent, fresh.planId);
    controls.acceptFailure = undefined;
    controls.currentBatch = () => ({ ...fresh, status: 'applied' });
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-batch-accept"]')!.click());
    assert.deepEqual(controls.batchAccepts![1], { batchId: fresh.batchId, planId: fresh.planId, workspaceId });
    assert.deepEqual(controls.batchUpdates, []);
    assert.equal(document.querySelector('[data-testid="workspace-operation-batch-conflict"]'), null, 'a proven applied result after the fresh approval is not relabeled as a conflict');
  } finally {
    await act(async () => root.unmount()); ui.disposeChecks(); dom.window.close();
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('partial Undo opens a proven current source location instead of its historical link path', async () => {
  const batch = partialExecutionBatch('undo');
  const restoredFolder = batch.execution!.steps.find((step) => step.key === 'path:0')!;
  restoredFolder.state = 'applied';
  const link = batch.execution!.steps.find((step) => step.key === 'link:0')!;
  link.path = 'Archive/Docs/Reference.md';
  link.openPath = 'Docs/Reference.md';
  await withMountedBatchReview(batch, async (controls) => {
    const row = document.querySelector('[data-testid="workspace-operation-execution-step-link:0"]')!;
    assert.match(row.textContent ?? '', /Archive\/Docs\/Reference\.md/u, 'the recorded step retains the originally reviewed path');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="workspace-operation-execution-open-link:0"]')!.click());
    assert.deepEqual(controls.documentOpens, [{ path: 'Docs/Reference.md', workspaceId }], 'navigation uses the proven reverse-move location');
    assert.deepEqual(controls.batchPreviews, []);
    assert.deepEqual(controls.batchAccepts, []);
  });
});
