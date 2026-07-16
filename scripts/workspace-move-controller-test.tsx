import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NextIntlClientProvider } from 'next-intl';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import {
  useWorkspaceMove,
  type WorkspaceMoveController,
  type WorkspaceMoveResult,
} from '../app/components/file-browser/useWorkspaceMove';
import { useFileStore } from '../app/store/file-store';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const messages = {
  notebook: {
    directoryConflictError: 'directory conflict',
    moveError: 'move error',
    moveIntoSelf: 'move into self',
    moveMultiplePartialSuccess: 'partial move',
    moveMultipleSuccess: 'move complete',
    protectedFolderMove: 'protected folder',
    sourceNotFoundError: 'source missing',
  },
};

let latestController: WorkspaceMoveController | null = null;

function HookHarness() {
  const controller = useWorkspaceMove();
  useEffect(() => {
    latestController = controller;
  }, [controller]);
  return null;
}

function currentController(): WorkspaceMoveController {
  assert.ok(latestController, 'move controller should be rendered');
  return latestController;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function main() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="de" timeZone="Europe/Berlin" messages={messages}>
        <HookHarness />
      </NextIntlClientProvider>,
    );
  });

  const firstMoveGate = deferred();
  const renameCalls: Array<{ oldPath: string; newPath: string }> = [];
  useFileStore.setState({
    multiSelectPaths: new Set(['files/00_dashboard']),
    isMultiSelectMode: true,
    renamePath: async (oldPath, newPath) => {
      renameCalls.push({ oldPath, newPath });
      await firstMoveGate.promise;
    },
    refreshVisibleTree: async () => {},
  });

  let firstMove!: Promise<WorkspaceMoveResult>;
  let duplicateMoveResult!: WorkspaceMoveResult;
  await act(async () => {
    const controller = currentController();
    firstMove = controller.startMove(['files/00_dashboard'], '.');
    duplicateMoveResult = await controller.startMove(['files/00_dashboard'], '.');
  });
  assert.equal(duplicateMoveResult, 'failed', 'a second move start must be rejected synchronously');
  assert.equal(renameCalls.length, 1, 'duplicate starts must not issue a second rename request');

  let firstMoveResult!: WorkspaceMoveResult;
  await act(async () => {
    firstMoveGate.resolve();
    firstMoveResult = await firstMove;
  });
  assert.equal(firstMoveResult, 'completed');
  assert.equal(currentController().isMoving, false);

  const conflictError = Object.assign(new Error('destination exists'), {
    code: 'FILE_EXISTS',
    type: 'file',
    sourcePath: 'files/report.md',
    destPath: 'report.md',
  });
  useFileStore.setState({
    multiSelectPaths: new Set(['files/report.md']),
    isMultiSelectMode: true,
    renamePath: async () => {
      throw conflictError;
    },
  });

  let conflictResult!: WorkspaceMoveResult;
  await act(async () => {
    conflictResult = await currentController().startMove(['files/report.md'], '.');
  });
  assert.equal(conflictResult, 'conflict');

  const conflictMoveGate = deferred();
  useFileStore.setState({
    renamePath: async (oldPath, newPath) => {
      renameCalls.push({ oldPath, newPath });
      await conflictMoveGate.promise;
    },
  });
  const conflictController = currentController();
  let conflictResolution!: Promise<WorkspaceMoveResult>;
  let duplicateResolutionResult!: WorkspaceMoveResult;
  await act(async () => {
    conflictResolution = conflictController.resolveConflict('overwrite-selection');
    duplicateResolutionResult = await conflictController.resolveConflict('overwrite-selection');
  });
  assert.equal(duplicateResolutionResult, 'failed', 'a conflict action must only be applied once');
  assert.equal(renameCalls.length, 2, 'duplicate conflict actions must not issue a second overwrite request');

  let conflictResolutionResult!: WorkspaceMoveResult;
  await act(async () => {
    conflictMoveGate.resolve();
    conflictResolutionResult = await conflictResolution;
  });
  assert.equal(conflictResolutionResult, 'completed');
  assert.equal(currentController().isMoving, false);

  await act(async () => {
    root.unmount();
  });
  container.remove();

  console.log('workspace move controller test passed');
}

void main();
