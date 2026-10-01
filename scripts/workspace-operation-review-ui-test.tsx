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
  refreshCalls?: string[];
  refreshed?: () => WorkspaceOperationReviewPublic;
  closes?: number;
  openList?: (workspaceId: string) => void;
}) {
  const filename = path.resolve('app/components/file-version-center/WorkspaceOperationReviewPanel.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {} as typeof Ui;
  const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const button = ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string; size?: string;
  }) => <button type="button" {...props}>{children}</button>;
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
      WorkspaceOperationReviewClientError: class extends Error {
        constructor(message: string, readonly status: number, readonly code: string | null) { super(message); }
      },
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
      acceptWorkspaceOperationBatch: async (input: { batchId: string; planId: string; workspaceId: string }) => {
        controls.batchAccepts?.push(input);
        return controls.acceptBatch?.();
      },
      readWorkspaceOperationBatch: async (id: string) => {
        controls.batchReads?.push(id);
        return controls.currentBatch?.();
      },
      updateWorkspaceOperationBatch: async () => controls.currentBatch?.(),
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
    '@/app/store/file-store': { useFileStore: { getState: () => ({ refreshVisibleTree: async () => undefined }) } },
    '@/app/store/workspace-operation-review-store': {
      closeWorkspaceOperationReview: () => { controls.closes = (controls.closes ?? 0) + 1; },
      openWorkspaceOperationReview: (id: string) => controls.opens.push(id),
      openWorkspaceOperationReviewList: (workspaceId: string) => controls.openList?.(workspaceId),
    },
  };
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
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports }, exports,
  );
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
    assert.equal(document.querySelector('[data-testid="workspace-operation-review-select-closed-review"]'), null,
      'closed reviews cannot join a fresh action group');
    await act(async () => document.querySelector<HTMLInputElement>('[data-testid="workspace-operation-review-select-all"]')!.click());
    assert.equal(document.querySelector<HTMLInputElement>(`[data-testid="workspace-operation-review-select-${reviewId}"]`)!.checked, true);
    assert.equal(document.querySelector<HTMLInputElement>('[data-testid="workspace-operation-review-select-review-delete"]')!.checked, true,
      'stale proposals can be selected for a freshly rebuilt preview');
    await act(async () => previewButton.click());
    assert.deepEqual(controls.batchPreviews, [[reviewId, 'review-delete']]);
    assert.deepEqual(controls.batchAccepts, [], 'creating the combined preview never starts execution');
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
    current: () => review('stale'), decide: async () => review(), refreshCalls: [], refreshed: () => successor,
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
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
