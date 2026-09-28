import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

import en from '../messages/en.json';
import de from '../messages/de.json';
import type * as Ui from '../app/components/file-version-center/WorkspaceOperationBackupPanel';

test('backup recovery UI restores only to the explicit free-path suggestion and reports the result', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globals = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  const restoreCalls: Array<{ workspaceId: string; backupId: string; targetPath: string }> = [];
  const undoCalls: string[] = [];
  let refreshes = 0;
  const filename = path.resolve('app/components/file-version-center/WorkspaceOperationBackupPanel.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {} as typeof Ui;
  const translate = (key: string, values?: Record<string, string>) => {
    const value = (en.workspaceOperationRecovery as Record<string, string>)[key] ?? key;
    return values ? value.replace('{path}', values.path ?? '') : value;
  };
  const mocks: Record<string, unknown> = {
    'lucide-react': new Proxy({}, { get: () => () => null }),
    'next-intl': { useTranslations: () => translate },
    '@/components/ui/button': { Button: ({ children, variant: _variant, size: _size, ...props }:
      React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
      <button type="button" {...props}>{children}</button> },
    '@/components/ui/input': { Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> },
    '@/app/lib/files/workspace-operation-backup-client': {
      listWorkspaceOperationBackups: async () => ({ backups: [{ status: 'manifest_valid', backupId: 'backup-one',
        operationId: 'operation-one', originalPath: 'Docs/Plan.md', itemType: 'file', capturedAt: 1,
        retention: 'until_manual_cleanup', sizeBytes: 20, fileCount: 1, directoryCount: 0, contentSha256: 'hash' }],
      nextCursor: null }),
      restoreWorkspaceOperationBackupFromClient: async (input: { workspaceId: string; backupId: string; targetPath: string }) => {
        restoreCalls.push(input);
        return { restoredPath: input.targetPath, contentSha256: 'hash', sizeBytes: 20 };
      },
    },
    '@/app/lib/files/workspace-operation-undo-client': {
      readWorkspaceOperationUndoAvailability: async () => undoCalls.length
        ? { available: false, reason: 'Operation already undone.', reasonCode: 'ALREADY_UNDONE', undoOperationId: 'undo-one' }
        : { available: true, reason: null, reasonCode: null, undoOperationId: 'undo-one' },
      undoWorkspaceOperation: async (operationId: string) => {
        undoCalls.push(operationId);
        return { originalOperationId: operationId, undoOperationId: 'undo-one', kind: 'move',
          status: 'applied', restoredPaths: ['Docs/Plan.md'], linkStatus: 'complete' };
      },
    },
    '@/app/store/file-store': { useFileStore: { getState: () => ({ refreshVisibleTree: async () => { refreshes += 1; } }) } },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports }, exports,
  );
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    assert.equal(de.workspaceOperationRecovery.restore, 'Wiederherstellen');
    await act(async () => root.render(<exports.WorkspaceOperationBackupPanel workspaceId="workspace-one" />));
    assert.match(document.body.textContent ?? '', /Docs\/Plan\.md/u);
    const backup = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Docs/Plan.md'));
    await act(async () => backup?.click());
    const input = document.querySelector<HTMLInputElement>('#workspace-operation-backup-target');
    assert.equal(input?.value, 'Docs/Plan-restored.md');
    const restore = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Restore');
    await act(async () => restore?.click());
    assert.deepEqual(restoreCalls, [{ workspaceId: 'workspace-one', backupId: 'backup-one',
      targetPath: 'Docs/Plan-restored.md' }]);
    assert.equal(refreshes, 1);
    assert.match(document.body.textContent ?? '', /Restored: Docs\/Plan-restored\.md/u);
    const undo = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Undo file action');
    assert.ok(undo);
    await act(async () => undo.click());
    assert.deepEqual(undoCalls, ['operation-one']);
    assert.equal(refreshes, 2);
    assert.match(document.body.textContent ?? '', /file action was undone/u);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
