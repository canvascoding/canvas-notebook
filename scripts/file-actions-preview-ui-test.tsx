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
import type { WorkspaceFileOperationDryRun } from '../app/lib/files/client';

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

function translate(key: string, values?: Record<string, string | number>): string {
  const message = (messages.notebook as Record<string, unknown>)[key];
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
  const workspaceState = { activeWorkspaceId: workspaceId, activeWorkspace: workspace };
  const fileState = {
    renamePath: async (...args: unknown[]) => {
      controls.renameApplyCalls.push(args);
      controls.mutations.push('rename');
      return { linkStatus: 'complete' };
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
  const useFileStore = (selector: (state: typeof fileState) => unknown) => selector(fileState);
  const useWorkspaceStore = Object.assign(
    (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
    { getState: () => workspaceState },
  );
  const icon = () => null;
  const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const dialogContent = ({ children }: React.PropsWithChildren) => <div role="dialog">{children}</div>;
  const menuItem = ({ children, onSelect, disabled }: React.PropsWithChildren<{
    onSelect?: () => void; disabled?: boolean;
  }>) => <button type="button" role="menuitem" onClick={onSelect} disabled={disabled}>{children}</button>;
  const mocks: Record<string, unknown> = {
    'lucide-react': new Proxy({}, { get: () => icon }),
    'next-intl': { useTranslations: () => translate, useLocale: () => 'en' },
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
    '@/app/lib/files/operation-flows': {
      compactWorkspaceSelection: (paths: Iterable<string>) => [...paths],
      isMoveIntoSelf: () => false,
      isProtectedDirectoryNode: () => false,
      resolveMoveDestination: () => '',
      splitProtectedWorkspacePaths: () => ({ hasProtected: false }),
      summarizeWorkspaceBatchResult: () => ({}),
    },
    './CreateItemDialog': { CreateItemDialog: () => null },
    './DeleteConfirmDialog': { DeleteConfirmDialog: () => null },
    './DirectoryBrowser': { DirectoryBrowser: () => null },
    './PublicShareDialog': { PublicShareDialog: () => null },
    './MarpExportDialog': { MarpExportDialog: () => null },
    './useCreateItemDialog': { useCreateItemDialog: () => ({ createDialogProps: {}, openCreateDialog: () => undefined }) },
    '@/app/components/workspaces/WorkspaceDestinationPicker': {
      WorkspaceDestinationPicker: ({ onDirChange }: { onDirChange: (dir: string) => void }) => (
        <button type="button" onClick={() => onDirChange('Archive')}>Choose Archive</button>
      ),
    },
    '@/app/store/workspace-store': { selectActiveWorkspace: (state: typeof workspaceState) => state.activeWorkspace, useWorkspaceStore },
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
    assert.match(status()?.textContent ?? '', /Not fully checked: 1 Markdown file\(s\), 1 link\(s\)/u);
    assert.match(status()?.textContent ?? '', /Docs\/report\.txt → Docs\/renamed\.txt/u);
    assert.match(status()?.textContent ?? '', /Docs\/index\.md: report\.txt → renamed\.txt/u);
    assert.match(status()?.textContent ?? '', /Docs\/large\.md: Not all Markdown files or links could be checked/u);
    assert.match(status()?.textContent ?? '', /checked again under a workspace lock/u);

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
    assert.match(status()?.textContent ?? '', /Not fully checked: 1 Markdown file\(s\), 1 link\(s\)/u);
    assert.match(status()?.textContent ?? '', /Docs\/large\.md: Not all Markdown files or links could be checked/u);
    assert.match(status()?.textContent ?? '', /checked again under a workspace lock/u);

    await act(async () => dialogButton('Choose Archive')?.click());
    assert.equal(status(), null, 'changing the destination clears the old copy plan and warning');
    resolveCopy = async () => { throw new Error('Copy preview unavailable'); };
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
    assert.equal(copyCalls.at(-1)?.destDir, 'Archive');
    assert.deepEqual(errors, ['Copy preview unavailable']);
    assert.deepEqual(mutations, [], 'preview does not apply the copy');

    resolveCopy = async () => preview('copy', 'ready');
    await act(async () => dialogButton(translate('fileOperationPreview'))?.click());
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
