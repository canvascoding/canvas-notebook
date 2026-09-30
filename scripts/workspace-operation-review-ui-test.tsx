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

function translate(key: string): string {
  const value = (messages.workspaceOperationReview as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : key;
}

async function compileUi(controls: {
  reads: string[];
  decisions: Array<{ reviewId: string; planId: string; action: string }>;
  opens: string[];
  undoChecks: string[];
  undoCalls: string[];
  current: () => WorkspaceOperationReviewPublic;
  decide: (action: 'accept' | 'reject') => Promise<WorkspaceOperationReviewPublic>;
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
      listWorkspaceOperationReviews: async () => [review(), { ...review('blocked'), reviewId: 'review-blocked' }],
      readWorkspaceOperationReview: async (id: string) => { controls.reads.push(id); return controls.current(); },
      decideWorkspaceOperationReview: async (input: { reviewId: string; planId: string; action: 'accept' | 'reject' }) => {
        controls.decisions.push(input);
        return controls.decide(input.action);
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
      closeWorkspaceOperationReview: () => undefined,
      openWorkspaceOperationReview: (id: string) => controls.opens.push(id),
      openWorkspaceOperationReviewList: () => undefined,
    },
  };
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
    opens: [] as string[], undoChecks: [] as string[], undoCalls: [] as string[], current: () => review(),
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
    assert.equal(document.querySelectorAll('button .font-mono').length, 2);
    await act(async () => document.querySelector<HTMLButtonElement>('button .font-mono')?.closest('button')?.click());
    assert.deepEqual(controls.opens, [reviewId]);

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

    controls.current = () => review('stale');
    await act(async () => root.render(<ui.WorkspaceOperationReviewPanel key="stale" request={{ mode: 'detail', reviewId, workspaceId }} />));
    assert.match(document.body.textContent ?? '', /The plan is stale/u);
    assert.equal(findButton(translate('accept')), undefined);
    assert.equal(controls.decisions.length, 1);

    const warningReview = review();
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

    controls.current = () => review('blocked');
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
