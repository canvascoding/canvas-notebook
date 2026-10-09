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
import type * as Ui from '../app/components/file-browser/FileActionsDropdown';
import type { WorkspaceFileOperationDryRun, WorkspaceRenameResult } from '../app/lib/files/client';
import { WorkspacePathOperationClientError } from '../app/lib/files/workspace-path-operation-client';
import type { WorkspacePathOperationPublic } from '../app/lib/files/workspace-path-operation-public';

const workspaceId = 'workspace-one';
const file = { name: 'report.txt', path: 'Docs/report.txt', type: 'file' as const };

function preview(kind: 'rename' | 'copy', readiness: 'ready' | 'blocked'): WorkspaceFileOperationDryRun {
  return {
    dryRun: true,
    requiresRevalidation: true,
    plan: {
      contractVersion: 1,
      planId: `${kind}-preview`,
      kind,
      status: 'planned',
      readiness,
      pathMappings: [{
        sourceWorkspaceId: workspaceId,
        sourcePath: file.path,
        destinationWorkspaceId: workspaceId,
        destinationPath: kind === 'rename' ? 'Docs/renamed.txt' : 'Archive/report.txt',
        sourceIdentity: 'file-one',
      }],
      linkEdits: [{
        sourceWorkspaceId: workspaceId,
        destinationWorkspaceId: workspaceId,
        sourcePathBefore: 'Docs/index.md',
        sourcePathAfter: 'Docs/index.md',
        expectedContentHash: 'old-hash',
        targetRange: { startUtf16: 4, endUtf16: 14, startUtf8Byte: 4, endUtf8Byte: 14 },
        previousTargetLiteral: 'report.txt',
        nextTargetLiteral: kind === 'rename' ? 'renamed.txt' : '../Archive/report.txt',
      }],
      coverage: {
        complete: false,
        omittedSources: [{ path: 'Docs/large.md', reason: 'source-too-large' }],
        unresolvedLinks: [{ sourcePath: 'Docs/index.md', targetLiteral: 'unknown.md', status: 'missing' }],
      },
      expectedPathState: [],
      collisions: [],
      recoveryReady: false,
      issues: [{
        code: 'incomplete-index',
        workspaceId,
        path: 'Docs/large.md',
        detail: 'Some Markdown links could not be checked.',
      }],
    },
  };
}

function translate(key: string, values?: Record<string, string | number>, namespace = 'notebook'): string {
  const message = key.split('.').reduce<unknown>((value, part) => value && typeof value === 'object'
    ? (value as Record<string, unknown>)[part] : null, (messages as Record<string, unknown>)[namespace]);
  const template = typeof message === 'string' ? message : key;
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? `{${name}}`));
}

async function compileUi(controls: {
  renameCalls: Array<[string, string, string | null]>;
  copyCalls: Array<Record<string, unknown>>;
  renamePreview: () => Promise<WorkspaceFileOperationDryRun>;
  copyPreview: () => Promise<WorkspaceFileOperationDryRun>;
  errors: string[];
  mutations: string[];
  renameApplyCalls: unknown[][];
  copyApplyCalls: Array<Record<string, unknown>>;
  renameApply?: () => Promise<WorkspaceRenameResult>;
  openedFiles?: Array<{ path: string; workspaceId?: string | null }>;
  activeWorkspaceId?: string;
}) {
  const filename = path.resolve('app/components/file-browser/FileActionsDropdown.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {} as typeof Ui;
  const workspace = { id: workspaceId, permissions: { canWrite: true } };
  const workspaceState = () => ({ activeWorkspaceId: controls.activeWorkspaceId ?? workspaceId,
    activeWorkspace: { ...workspace, id: controls.activeWorkspaceId ?? workspaceId } });
  const fileState = {
    renamePath: async (...args: unknown[]) => {
      controls.renameApplyCalls.push(args);
      controls.mutations.push('rename');
      return controls.renameApply ? controls.renameApply() : { linkStatus: 'complete' };
    },
    revealAndLoadFile: async (path: string, options?: { workspaceId?: string | null }) => {
      controls.openedFiles?.push({ path, workspaceId: options?.workspaceId });
      return { status: 'opened' as const, path };
    },
    downloadFile: async () => undefined,
    fileTree: [],
    multiSelectPaths: new Set<string>(),
    clearMultiSelect: () => undefined,
    copyPaths: () => undefined,
    pastePaths: async () => undefined,
    duplicatePath: async () => undefined,
    clipboardPaths: new Set<string>(),
    clipboardMode: null,
    setBulkMoveOpen: () => undefined,
    refreshDirectory: async () => undefined,
  };
  const useFileStore = Object.assign((selector: (state: typeof fileState) => unknown) => selector(fileState),
    { getState: () => fileState });
  const useWorkspaceStore = Object.assign(
    (selector: (state: ReturnType<typeof workspaceState>) => unknown) => selector(workspaceState()),
    { getState: workspaceState },
  );
  const icon = () => null;
  const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const dialogContent = ({ children }: React.PropsWithChildren) => <div role="dialog">{children}</div>;
  const menuItem = ({ children, onSelect, disabled }: React.PropsWithChildren<{
    onSelect?: () => void; disabled?: boolean;
  }>) => <button type="button" role="menuitem" onClick={onSelect} disabled={disabled}>{children}</button>;
  const mocks: Record<string, unknown> = {
    'lucide-react': new Proxy({}, { get: () => icon }),
    'next-intl': { useTranslations: (namespace = 'notebook') => (key: string, values?: Record<string, string | number>) =>
      translate(key, values, namespace), useLocale: () => 'en' },
    'sonner': { toast: { error: (message: string) => controls.errors.push(message), warning: () => undefined, success: () => undefined } },
    '@/components/ui/dialog': {
      Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) => open ? <>{children}</> : null,
      DialogContent: dialogContent,
      DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
      DialogFooter: passthrough,
      DialogHeader: passthrough,
      DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
    },
    '@/components/ui/dropdown-menu': {
      DropdownMenu: passthrough,
      DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
      DropdownMenuItem: menuItem,
      DropdownMenuLabel: passthrough,
      DropdownMenuSeparator: () => null,
      DropdownMenuTrigger: passthrough,
    },
    '@/components/ui/button': {
      Button: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
        <button type="button" {...props}>{children}</button>
      ),
    },
    '@/components/ui/input': {
      Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    },
    '@/app/lib/marp/detect': { hasMarpFileName: () => false },
    '@/app/store/file-store': { useFileStore },
    '@/app/lib/files/client': {
      previewWorkspaceRename: (oldPath: string, newPath: string, id: string | null) => {
        controls.renameCalls.push([oldPath, newPath, id]);
        return controls.renamePreview();
      },
      previewWorkspaceCopy: (params: Record<string, unknown>) => {
        controls.copyCalls.push(params);
        return controls.copyPreview();
      },
      copyWorkspacePaths: async (params: Record<string, unknown>) => {
        controls.copyApplyCalls.push(params);
        controls.mutations.push('copy');
        return { copied: [], failed: [], skipped: [], linkStatus: 'complete' };
      },
      workspaceHeaders: () => ({}),
    },
    '@/app/lib/files/path-utils': {
      getParentDirectory: (filePath: string) => filePath.split('/').slice(0, -1).join('/') || '.',
      joinWorkspacePath: (dir: string, name: string) => dir === '.' ? name : `${dir}/${name}`,
    },
    '@/app/lib/files/workspace-image-share': { isWorkspaceImageFileName: () => false, shareWorkspaceImageFile: async () => 'cancelled' },
    '@/app/lib/files/workspace-path-operation-client': load('../../lib/files/workspace-path-operation-client'),
    '@/app/lib/files/workspace-path-operation-public': load('../../lib/files/workspace-path-operation-public'),
    '@/app/lib/files/workspace-path-operation-issue-messages': load('../../lib/files/workspace-path-operation-issue-messages'),
    '@/app/lib/files/operation-flows': {
      compactWorkspaceSelection: (paths: Iterable<string>) => [...paths],
      isMoveIntoSelf: () => false,
      isProtectedDirectoryNode: () => false,
      resolveMoveDestination: (dir: string, name: string) => dir === '.' ? name : `${dir}/${name}`,
      splitProtectedWorkspacePaths: () => ({ hasProtected: false }),
      summarizeWorkspaceBatchResult: () => ({}),
    },
    './CreateItemDialog': { CreateItemDialog: () => null },
    './DeleteConfirmDialog': { DeleteConfirmDialog: () => null },
    './DirectoryBrowser': { DirectoryBrowser: ({ onSelect }: { onSelect: (dir: string) => void }) =>
      <button type="button" onClick={() => onSelect('Archive')}>Choose Archive folder</button> },
    './PublicShareDialog': { PublicShareDialog: () => null },
    './MarpExportDialog': { MarpExportDialog: () => null },
    './useCreateItemDialog': { useCreateItemDialog: () => ({ createDialogProps: {}, openCreateDialog: () => undefined }) },
    '@/app/components/workspaces/WorkspaceDestinationPicker': {
      WorkspaceDestinationPicker: ({ onDirChange }: { onDirChange: (dir: string) => void }) => (
        <button type="button" onClick={() => onDirChange('Archive')}>Choose Archive</button>
      ),
    },
    '@/app/store/workspace-store': { selectActiveWorkspace: (state: ReturnType<typeof workspaceState>) => state.activeWorkspace, useWorkspaceStore },
    'zustand/react/shallow': { useShallow: (selector: unknown) => selector },
    './useTrashUndo': { useTrashUndo: () => async () => undefined },
    './FileInfoDialog': { FileInfoDialog: () => null },
    './FileVersionMenuItem': { FileVersionMenuItem: () => null },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports },
    exports,
  );
  return exports;
}

test('mounted file actions show rename and copy plans, warnings, and clear a stale preview', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  const renameCalls: Array<[string, string, string | null]> = [];
  const copyCalls: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const mutations: string[] = [];
  const renameApplyCalls: unknown[][] = [];
  const copyApplyCalls: Array<Record<string, unknown>> = [];
  let resolveRename: () => Promise<WorkspaceFileOperationDryRun> = async () => preview('rename', 'blocked');
  let resolveCopy: () => Promise<WorkspaceFileOperationDryRun> = async () => preview('copy', 'ready');
  const ui = await compileUi({
    renameCalls, copyCalls, errors, mutations, renameApplyCalls, copyApplyCalls,
    renamePreview: () => resolveRename(),
    copyPreview: () => resolveCopy(),
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const { fireEvent } = await import('@testing-library/react');
  const menuButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === name);
  const dialogButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent?.trim() === name);
  const status = () => document.querySelector<HTMLElement>('[role="status"]');

  try {
    await act(async () => root.render(
      <ui.FileActionsDropdown node={file} open showCreateActions={false}>
        <button type="button">File actions</button>
      </ui.FileActionsDropdown>,
    ));

    await act(async () => menuButton(translate('rename'))?.click());
    assert.equal((document.querySelector('#newName') as HTMLInputElement).value, file.name);
    await act(async () => fireEvent.change(document.querySelector('#newName')!, { target: { value: 'renamed.txt' } }));
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    assert.deepEqual(renameCalls, [[file.path, 'Docs/renamed.txt', workspaceId]]);
    assert.match(status()?.textContent ?? '', /Preview readiness: blocked/u);
    assert.match(status()?.textContent ?? '', /Planned: 1 path\(s\), 1 link edit\(s\)/u);
    assert.match(status()?.textContent ?? '', /Workspace link scan: incomplete\. Omitted files: 1; unresolved links: 1/u);
    assert.match(status()?.textContent ?? '', /Docs\/report\.txt → Docs\/renamed\.txt/u);
    assert.match(status()?.textContent ?? '', /Docs\/index\.md: report\.txt → renamed\.txt/u);
    assert.match(status()?.textContent ?? '', /Docs\/large\.md: Not all Markdown files or links could be checked/u);
    assert.match(status()?.textContent ?? '', /checked again under a workspace lock/u);

    const affectedPreview = preview('rename', 'blocked');
    affectedPreview.plan.linkAssessment = { version: 1, complete: false, warnings: [], blockers: [
      { sourcePath: 'Docs/index.md', targetLiteral: 'unknown.md', status: 'missing', reason: 'affected-unresolved-link' },
    ] };
    resolveRename = async () => affectedPreview;
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    const blockers = document.querySelector('[data-testid="file-operation-link-blockers"]');
    assert.match(blockers?.textContent ?? '', /Docs\/index\.md → unknown\.md/u);
    assert.match(blockers?.textContent ?? '', /Correct its target or create the missing file/u);
    assert.equal(document.querySelector<HTMLDetailsElement>('[data-testid="file-operation-link-coverage"]')?.open, false);

    await act(async () => fireEvent.change(document.querySelector('#newName')!, { target: { value: 'again.txt' } }));
    assert.equal(status(), null, 'editing the name clears the old plan and warning');
    assert.deepEqual(mutations, [], 'preview does not apply the rename');

    resolveRename = async () => { throw new Error('Rename preview unavailable'); };
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Rename preview unavailable');
    await act(async () => dialogButton(translate('cancel'))?.click());

    await act(async () => menuButton(translate('copyToWorkspace'))?.click());
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    assert.deepEqual(copyCalls, [{
      sources: [file.path], destDir: '.', renameOnCollision: true,
      sourceWorkspaceId: workspaceId, targetWorkspaceId: workspaceId,
    }]);
    assert.match(status()?.textContent ?? '', /Preview readiness: ready/u);
    assert.match(status()?.textContent ?? '', /Docs\/report\.txt → Archive\/report\.txt/u);
    assert.match(status()?.textContent ?? '', /Docs\/index\.md: report\.txt → \.\.\/Archive\/report\.txt/u);
    assert.match(status()?.textContent ?? '', /Workspace link scan: incomplete\. Omitted files: 1; unresolved links: 1/u);
    assert.match(status()?.textContent ?? '', /Docs\/large\.md: Not all Markdown files or links could be checked/u);
    assert.match(status()?.textContent ?? '', /checked again under a workspace lock/u);

    await act(async () => dialogButton('Choose Archive')?.click());
    assert.equal(status(), null, 'changing the destination clears the old copy plan and warning');
    resolveCopy = async () => { throw new Error('Copy preview unavailable'); };
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    assert.equal(copyCalls.at(-1)?.destDir, 'Archive');
    assert.deepEqual(errors, ['Copy preview unavailable']);
    assert.deepEqual(mutations, [], 'preview does not apply the copy');

    const warningOnlyPreview = preview('copy', 'ready');
    warningOnlyPreview.plan.issues = [];
    warningOnlyPreview.plan.coverage = { complete: false, omittedSources: [], unresolvedLinks: [
      { sourcePath: 'Archive/old.md', targetLiteral: 'missing.md', status: 'missing' },
    ] };
    warningOnlyPreview.plan.linkAssessment = { version: 1, complete: true, blockers: [], warnings: [
      { sourcePath: 'Archive/old.md', targetLiteral: 'missing.md', status: 'missing', reason: 'unaffected-existing-link' },
    ] };
    resolveCopy = async () => warningOnlyPreview;
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    const warnings = document.querySelector<HTMLDetailsElement>('[data-testid="file-operation-link-warnings"]');
    assert.equal(warnings?.open, false, 'unrelated links start collapsed');
    assert.match(warnings?.textContent ?? '', /Archive\/old\.md → missing\.md/u);
    assert.match(status()?.textContent ?? '', /Preview readiness: ready/u);
    assert.equal(document.querySelector('[data-testid="file-operation-link-blockers"]'), null);
    await act(async () => dialogButton(translate('copyToWorkspaceConfirm'))?.click());
    assert.equal(copyApplyCalls[0]?.planId, 'copy-preview');
    resolveRename = async () => preview('rename', 'ready');
    await act(async () => menuButton(translate('rename'))?.click());
    await act(async () => fireEvent.change(document.querySelector('#newName')!, { target: { value: 'renamed.txt' } }));
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    await act(async () => dialogButton(translate('rename'))?.click());
    assert.equal(renameApplyCalls[0]?.at(-1), 'rename-preview');
    assert.deepEqual(mutations, ['copy', 'rename']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalNames.forEach((name, index) => {
      const descriptor = prior[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test('mounted move errors retain issue paths, recheck without applying, and open the affected workspace file', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const operation: WorkspacePathOperationPublic = {
    batchId: 'move-ui-batch-1234567890', planId: 'a'.repeat(64), workspaceId,
    kind: 'move', status: 'blocked', errorCode: 'PREVIEW_BLOCKED', phase: 'preparing',
    completedActions: 0, totalActions: 2,
    selections: [{ sourcePath: file.path, destinationPath: 'Archive/report.txt' }],
    issues: [{ code: 'unevaluated-link', path: 'Other/local-links.md' }],
  };
  let resolveApply = async (): Promise<WorkspaceRenameResult> => {
    throw new WorkspacePathOperationClientError(operation, 'Immediate action could not finish safely');
  };
  let resolvePreview = async () => {
    const ready = preview('rename', 'ready');
    ready.plan.planId = 'b'.repeat(64);
    ready.plan.issues = [];
    ready.plan.linkAssessment = { version: 1, complete: true, blockers: [], warnings: [] };
    ready.plan.coverage = { complete: true, omittedSources: [], unresolvedLinks: [] };
    return ready;
  };
  const controls = {
    renameCalls: [] as Array<[string, string, string | null]>, copyCalls: [] as Array<Record<string, unknown>>,
    errors: [] as string[], mutations: [] as string[], renameApplyCalls: [] as unknown[][],
    copyApplyCalls: [] as Array<Record<string, unknown>>, openedFiles: [] as Array<{ path: string; workspaceId?: string | null }>,
    activeWorkspaceId: workspaceId,
    renamePreview: () => resolvePreview(), copyPreview: async () => preview('copy', 'ready'),
    renameApply: () => resolveApply(),
  };
  const ui = await compileUi(controls);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const { fireEvent } = await import('@testing-library/react');
  const render = () => root.render(<ui.FileActionsDropdown node={file} open showCreateActions={false}>
    <button type="button">File actions</button>
  </ui.FileActionsDropdown>);
  const button = (name: string, selector = '[role="dialog"] button') => {
    const found = [...document.querySelectorAll<HTMLButtonElement>(selector)]
      .find((item) => item.textContent?.trim() === name);
    assert.ok(found, `Missing mounted action: ${name}`);
    return found;
  };
  const issues = () => document.querySelector('[data-testid="workspace-move-operation-issues"]');
  const movePreview = () => document.querySelector('[data-testid="workspace-move-preview"]');
  const openMove = async () => {
    await act(async () => button(translate('move'), '[role="menuitem"]').click());
    await act(async () => fireEvent.change(document.querySelector('#moveTarget')!, { target: { value: 'Archive' } }));
  };

  try {
    await act(async () => render());
    await openMove();
    await act(async () => button(translate('move')).click());
    assert.ok(issues());
    assert.match(issues()?.textContent ?? '', /Other\/local-links\.md/u);
    assert.ok(issues()?.textContent?.includes(messages.workspacePathOperationStatus.issue.unsupportedLink),
      'immediate conflict uses the same localized guidance as the durable status dialog');
    assert.equal(controls.renameApplyCalls.length, 1);
    assert.equal(controls.renameApplyCalls[0]?.[4], workspaceId, 'Move captures its explicit workspace');

    await act(async () => button('Check again').click());
    assert.deepEqual(controls.renameCalls, [[file.path, 'Archive/report.txt', workspaceId]]);
    assert.equal(controls.renameApplyCalls.length, 1, 'rechecking only reads a dry-run preview');
    assert.match(movePreview()?.textContent ?? '', /ready/iu);
    assert.ok(!document.body.textContent?.includes('workspacePathOperationStatus.'), 'issue and action copy is translated');
    resolveApply = async () => ({ linkStatus: 'complete' });
    await act(async () => button(translate('move')).click());
    assert.equal(controls.renameApplyCalls.at(-1)?.[5], 'b'.repeat(64), 'explicit Move uses the freshly checked plan');
    assert.equal(document.querySelector('[role="dialog"]'), null);

    resolveApply = async () => {
      await Promise.resolve();
      throw new WorkspacePathOperationClientError(operation, 'Polled action could not finish safely');
    };
    await openMove();
    await act(async () => button(translate('move')).click());
    assert.match(issues()?.textContent ?? '', /Other\/local-links\.md/u);
    assert.ok(issues()?.textContent?.includes(messages.workspacePathOperationStatus.issue.unsupportedLink),
      'later durable failure shows the same issue path and corrective guidance');
    await act(async () => button('Open affected file').click());
    assert.deepEqual(controls.openedFiles, [{ path: 'Other/local-links.md', workspaceId }]);
    assert.equal(document.querySelector('[role="dialog"]'), null, 'successful file opening frees the editor from the modal');

    await openMove();
    await act(async () => button(translate('move')).click());
    assert.ok(issues());
    await act(async () => button('Choose Archive folder').click());
    assert.equal(issues(), null, 'choosing a destination invalidates old blocker details');
    assert.equal(movePreview(), null);
    await act(async () => button(translate('move')).click());
    assert.ok(issues());
    await act(async () => fireEvent.change(document.querySelector('#moveName')!, { target: { value: 'renamed.txt' } }));
    assert.equal(issues(), null, 'changing the name invalidates old blocker details');
    await act(async () => button('Check again').click());
    assert.ok(movePreview());
    await act(async () => fireEvent.change(document.querySelector('#moveTarget')!, { target: { value: 'Other' } }));
    assert.equal(movePreview(), null, 'changing the target invalidates the previously checked plan');

    resolveApply = async () => {
      throw new WorkspacePathOperationClientError({ ...operation, status: 'queued', errorCode: null, issues: [] },
        'The file action is still running.');
    };
    await act(async () => button(translate('move')).click());
    assert.equal(button(translate('move')).disabled, true, 'a durable pending action cannot be submitted again');
    assert.equal(button('Check again').disabled, true, 'a pending action cannot obtain a competing plan');
    assert.equal(document.querySelector<HTMLInputElement>('#moveName')?.disabled, true,
      'changing the name cannot clear the pending operation guard');
    assert.equal(document.querySelector<HTMLInputElement>('#moveTarget')?.disabled, true,
      'changing the destination cannot clear the pending operation guard');
    const pendingPicker = button('Choose Archive folder').parentElement;
    assert.equal(pendingPicker?.hasAttribute('inert'), true, 'pending work also disables keyboard interaction with the directory picker');
    assert.equal(pendingPicker?.classList.contains('pointer-events-none'), true,
      'the directory picker cannot reset pending work through pointer interaction');
    const pendingApplyCount = controls.renameApplyCalls.length;
    const pendingPreviewCount = controls.renameCalls.length;
    await act(async () => { button(translate('move')).click(); button('Check again').click(); });
    assert.equal(controls.renameApplyCalls.length, pendingApplyCount);
    assert.equal(controls.renameCalls.length, pendingPreviewCount);
    await act(async () => button(translate('cancel')).click());
    await openMove();

    let rejectLate!: (error: Error) => void;
    resolveApply = () => new Promise((_resolve, reject) => { rejectLate = reject; });
    await act(async () => button(translate('move')).click());
    controls.activeWorkspaceId = 'workspace-two';
    await act(async () => render());
    await act(async () => rejectLate(new WorkspacePathOperationClientError(operation, 'Old workspace conflict')));
    assert.equal(issues(), null, 'a late failure from another workspace is never displayed');
    assert.ok(!document.body.textContent?.includes('Old workspace conflict'));
    assert.equal(controls.openedFiles.length, 1, 'the late error never navigates into a different workspace');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalNames.forEach((name, index) => {
      const descriptor = prior[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
