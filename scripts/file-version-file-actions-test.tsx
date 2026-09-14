import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

import type * as Ui from '../app/components/file-browser/FileVersionMenuItem';

type ResolveCall = { request: Record<string, unknown>; signal?: AbortSignal };
type Timeline = {
  document: { workspaceId: string; lineageId: string };
  capabilities: {
    contractVersion: 1;
    history: boolean;
    compare: boolean;
    restore: boolean;
    agentReviewPolicy: boolean;
    preview: 'markdown' | 'text' | 'metadata';
    reason?: 'unsupported_type' | 'read_only';
  };
};

class ClientError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function timeline(
  lineageId: string,
  capabilities: Partial<Timeline['capabilities']> = {},
  workspaceId = 'workspace-one',
): Timeline {
  return {
    document: { workspaceId, lineageId },
    capabilities: {
      contractVersion: 1,
      history: true,
      compare: true,
      restore: true,
      agentReviewPolicy: true,
      preview: 'markdown',
      ...capabilities,
    },
  };
}

async function compileUi(input: {
  calls: ResolveCall[];
  opened: unknown[];
  resolve: (call: ResolveCall) => Promise<Timeline>;
}) {
  const filename = path.resolve('app/components/file-browser/FileVersionMenuItem.tsx');
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
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => (key: string) => key },
    'lucide-react': {
      FileClock: () => <span data-icon="history" />,
      Loader2: () => <span data-icon="loading" />,
    },
    '@/app/lib/file-version-center/client': {
      FileVersionCenterClientError: ClientError,
      resolveFileVersionCenter: (request: Record<string, unknown>, signal?: AbortSignal) => {
        const call = { request, signal };
        input.calls.push(call);
        return input.resolve(call);
      },
    },
    '@/app/lib/file-version-center/contracts/v1': {
      FILE_VERSION_CENTER_CONTRACT_VERSION: 1,
      FILE_VERSION_CENTER_ERROR_CODES: { notFound: 'FVRC_NOT_FOUND' },
    },
    '@/app/store/file-version-center-store': {
      openVersionCenter: (request: unknown) => { input.opened.push(request); },
    },
    '@/components/ui/dropdown-menu': {
      DropdownMenuItem: ({ children, onSelect, ...props }: React.PropsWithChildren<{
        onSelect?: () => void;
      }> & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props} onClick={onSelect}>{children}</button>
      ),
    },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports },
    exports,
  );
  return exports;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  }
}

test('file version menu target prefers a durable lineage and safely falls back to workspace path', async () => {
  const ui = await compileUi({ calls: [], opened: [], resolve: async () => timeline('unused') });
  assert.deepEqual(ui.fileVersionMenuTarget({
    workspaceId: 'workspace-one', path: 'Notes/renamed.md', lineageId: 'lineage-one',
  }), { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' });
  assert.deepEqual(ui.fileVersionMenuTarget({
    workspaceId: 'workspace-one', path: 'Notes/new.md',
  }), { kind: 'path', workspaceId: 'workspace-one', pathHint: 'Notes/new.md' });
});

test('the shared item follows server capabilities and opens only the resolved lineage', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'DOMException', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'DOMException', { configurable: true, value: dom.window.DOMException });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  const calls: ResolveCall[] = [];
  const opened: unknown[] = [];
  let releaseInitial!: (value: Timeline) => void;
  const initialTimeline = new Promise<Timeline>((resolve) => { releaseInitial = resolve; });
  let resolveTimeline: (call: ResolveCall) => Promise<Timeline> = async () => initialTimeline;
  const ui = await compileUi({ calls, opened, resolve: (call) => resolveTimeline(call) });
  const root = createRoot(document.getElementById('root')!);

  try {
    await act(async () => root.render(
      <ui.FileVersionMenuItem workspaceId="workspace-one" path="Notes/current.md" source="file_browser" />,
    ));
    assert.equal(document.querySelector('button')?.dataset.fileVersionCapability, 'loading');
    releaseInitial(timeline('lineage-one'));
    await settle();
    const enabled = document.querySelector<HTMLButtonElement>('button');
    assert.equal(enabled?.disabled, false);
    assert.equal(enabled?.dataset.fileVersionCapability, 'full');
    assert.deepEqual(calls.at(-1)?.request.target, {
      kind: 'path', workspaceId: 'workspace-one', pathHint: 'Notes/current.md',
    });
    await act(async () => enabled?.click());
    assert.deepEqual(opened.at(-1), {
      contractVersion: 1,
      target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
      initialView: 'history',
      source: 'file_browser',
    });

    resolveTimeline = async () => timeline('lineage-viewer', { restore: false, reason: 'read_only' });
    await act(async () => root.render(
      <ui.FileVersionMenuItem
        workspaceId="workspace-one"
        path="Notes/moved.txt"
        lineageId="lineage-viewer"
        source="editor"
      />,
    ));
    await settle();
    const readOnly = document.querySelector<HTMLButtonElement>('button');
    assert.equal(readOnly?.disabled, false);
    assert.equal(readOnly?.dataset.fileVersionCapability, 'read-only');
    assert.equal(readOnly?.getAttribute('aria-label'), 'fileVersionChangesReadOnly');
    assert.deepEqual(calls.at(-1)?.request.target, {
      kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-viewer',
    });

    resolveTimeline = async () => timeline('lineage-unsupported', {
      history: false, compare: false, restore: false, agentReviewPolicy: false, reason: 'unsupported_type',
    });
    await act(async () => root.render(
      <ui.FileVersionMenuItem workspaceId="workspace-one" path="Notes/report.pdf" source="file_browser" />,
    ));
    await settle();
    assert.equal(document.querySelector('button'), null, 'server capability hides unsupported files');

    resolveTimeline = async () => { throw new ClientError('FVRC_NOT_FOUND'); };
    await act(async () => root.render(
      <ui.FileVersionMenuItem workspaceId="workspace-one" path="Notes/deleted.md" source="file_browser" />,
    ));
    await settle();
    const missing = document.querySelector<HTMLButtonElement>('button');
    assert.equal(missing?.disabled, true);
    assert.equal(missing?.dataset.fileVersionCapability, 'missing');
    assert.equal(missing?.getAttribute('aria-label'), 'fileVersionChangesMissing');

    let releasePreviousWorkspace!: (value: Timeline) => void;
    const previousWorkspace = new Promise<Timeline>((resolve) => { releasePreviousWorkspace = resolve; });
    resolveTimeline = (call) => {
      const target = call.request.target as { workspaceId: string };
      return target.workspaceId === 'workspace-old'
        ? previousWorkspace
        : Promise.resolve(timeline('lineage-new-workspace', {}, 'workspace-new'));
    };
    await act(async () => root.render(
      <ui.FileVersionMenuItem workspaceId="workspace-old" path="Notes/switch.md" source="file_browser" />,
    ));
    await act(async () => root.render(
      <ui.FileVersionMenuItem workspaceId="workspace-new" path="Notes/switch.md" source="file_browser" />,
    ));
    await settle();
    releasePreviousWorkspace(timeline('lineage-old-workspace', {}, 'workspace-old'));
    await settle();
    const switched = document.querySelector<HTMLButtonElement>('button');
    assert.equal(switched?.dataset.fileVersionCapability, 'full');
    await act(async () => switched?.click());
    assert.deepEqual(opened.at(-1), {
      contractVersion: 1,
      target: { kind: 'lineage', workspaceId: 'workspace-new', lineageId: 'lineage-new-workspace' },
      initialView: 'history',
      source: 'file_browser',
    }, 'a late response from the previous workspace cannot replace the active target');
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

test('file context menu and editor overflow both reuse the one FileActionsDropdown entry', async () => {
  const files = {
    actions: await fs.readFile('app/components/file-browser/FileActionsDropdown.tsx', 'utf8'),
    context: await fs.readFile('app/components/file-browser/FileContextMenu.tsx', 'utf8'),
    editor: await fs.readFile('app/components/editor/FileEditor.tsx', 'utf8'),
  };
  assert.equal((files.actions.match(/<FileVersionMenuItem\b/gu) ?? []).length, 1);
  assert.equal((files.context.match(/<FileActionsDropdown\b/gu) ?? []).length, 1);
  assert.equal((files.editor.match(/<FileActionsDropdown\b/gu) ?? []).length, 1);
  assert.match(files.editor, /versionCenterSource="editor"/u);
  assert.match(files.editor, /versionLineageId=\{/u);
  assert.doesNotMatch(files.context, /FileVersionMenuItem/u);
  assert.doesNotMatch(files.editor, /FileVersionMenuItem/u);
});
