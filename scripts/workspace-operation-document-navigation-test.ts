import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { notifyWorkspaceFileOpened, WORKSPACE_FILE_OPENED_EVENT, type WorkspaceFileOpenedDetail } from '../app/lib/files/workspace-file-events';
import type * as Navigation from '../app/components/file-version-center/workspaceOperationDocumentNavigation';

test('blocker document uses guarded workspace hydration and the existing editor reveal path', async (context) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const priorEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true });
  context.after(() => {
    dom.window.close();
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (priorEvent) Object.defineProperty(globalThis, 'CustomEvent', priorEvent); else Reflect.deleteProperty(globalThis, 'CustomEvent');
  });
  const filename = path.resolve('app/components/file-version-center/workspaceOperationDocumentNavigation.ts');
  const native = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  let scope: { userId: string; sessionId: string; epoch: number } | null = { userId: 'user-one', sessionId: 'session-one', epoch: 1 };
  let workspaceId = 'different-workspace';
  let closeCount = 0;
  let released = 0;
  let hydrated = 0;
  let invalidateDuringOpen = false;
  let openResult: { status: 'opened' | 'failed'; path: string; error?: string } = { status: 'opened', path: 'Docs/index.md' };
  const opens: Array<{ path: string; workspaceId: string; isCurrent: () => boolean }> = [];
  const switches: Array<[string, string]> = [];
  const revealed: WorkspaceFileOpenedDetail[] = [];
  let mainView = 'chat';
  window.addEventListener(WORKSPACE_FILE_OPENED_EVENT, (event) => {
    const detail = (event as CustomEvent<WorkspaceFileOpenedDetail>).detail;
    if (detail.workspaceId !== workspaceId) return;
    revealed.push(detail);
    mainView = 'document';
  });
  const mocks: Record<string, unknown> = {
    '@/app/lib/files/workspace-file-events': { notifyWorkspaceFileOpened },
    '@/app/lib/collaboration/opened-document-registry': { openedDocumentAuthScope: () => scope },
    '@/app/lib/workspaces/navigation-sync': { beginExternalWorkspaceNavigation: () => () => { released++; } },
    '@/app/store/workspace-store': { useWorkspaceStore: { getState: () => ({
      activeWorkspaceId: workspaceId, hydrateWorkspaces: async () => { hydrated++; },
      setActiveWorkspace: async (id: string, source: string) => { switches.push([id, source]); workspaceId = id; },
    }) } },
    '@/app/store/file-store': { useFileStore: { getState: () => ({
      revealAndLoadFile: async (filePath: string, options: { workspaceId: string; isCurrent: () => boolean }) => {
        assert.equal(options.isCurrent(), true);
        opens.push({ path: filePath, ...options });
        if (invalidateDuringOpen) scope = { userId: 'another-user', sessionId: 'another-session', epoch: 2 };
        return openResult;
      },
    }) } },
    '@/app/store/workspace-operation-review-store': { closeWorkspaceOperationReview: () => { closeCount++; } },
  };
  const loaded = { exports: {} as typeof Navigation };
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : native(name), loaded, loaded.exports);
  await loaded.exports.openWorkspaceOperationSourceDocument('Docs/index.md', 'workspace-one');
  assert.equal(hydrated, 1);
  assert.deepEqual(switches, [['workspace-one', 'system']]);
  assert.deepEqual(opens.map(({ path, workspaceId }) => ({ path, workspaceId })), [{ path: 'Docs/index.md', workspaceId: 'workspace-one' }]);
  assert.equal(closeCount, 1, 'review closes after the document was actually opened');
  assert.deepEqual(revealed, [{ path: 'Docs/index.md', source: 'file-browser', workspaceId: 'workspace-one' }],
    'opening a blocker emits the canonical file-browser event that switches the notebook from chat to its editor');
  assert.equal(mainView, 'document', 'the existing notebook event contract reveals the loaded document');
  assert.equal(released, 1);
  openResult = { status: 'failed', path: 'Docs/index.md', error: 'Source document missing' };
  await assert.rejects(loaded.exports.openWorkspaceOperationSourceDocument('Docs/index.md', 'workspace-one'), /Source document missing/);
  assert.equal(closeCount, 1, 'failed navigation keeps the actionable review open');
  assert.equal(revealed.length, 1, 'failed loads cannot switch the notebook view');
  assert.equal(released, 2);
  openResult = { status: 'opened', path: 'Docs/index.md' };
  invalidateDuringOpen = true;
  await loaded.exports.openWorkspaceOperationSourceDocument('Docs/index.md', 'workspace-one');
  assert.equal(opens.at(-1)?.isCurrent(), false, 'the editor opening guard detects an auth change during its request');
  assert.equal(closeCount, 1, 'a superseded open cannot close a newly owned review');
  assert.equal(revealed.length, 1, 'auth-superseded loads cannot switch the notebook view');
  assert.equal(released, 3);
  scope = null;
  await assert.rejects(loaded.exports.openWorkspaceOperationSourceDocument('Docs/index.md', 'workspace-one'), /session unavailable/);
  assert.equal(opens.length, 3, 'signed-out navigation cannot request a document');
});
