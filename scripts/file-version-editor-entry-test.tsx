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

import type * as Ui from '../app/components/editor/FileVersionHistoryButton';

type ResolveCall = {
  request: Record<string, unknown>;
  signal?: AbortSignal;
};

type Timeline = {
  document: { workspaceId: string; lineageId: string };
  capabilities: {
    contractVersion: 1;
    history: boolean;
    compare: boolean;
    restore: boolean;
    agentReviewPolicy: boolean;
    preview: 'markdown' | 'text' | 'metadata';
  };
};

function timeline(lineageId: string, capabilities: Partial<Timeline['capabilities']> = {}): Timeline {
  return {
    document: { workspaceId: 'workspace-one', lineageId },
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
  const filename = path.resolve('app/components/editor/FileVersionHistoryButton.tsx');
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
    '@/app/lib/file-version-center/client': {
      resolveFileVersionCenterWhenReady: (request: Record<string, unknown>, signal?: AbortSignal) => {
        const call = { request, signal };
        input.calls.push(call);
        return input.resolve(call);
      },
    },
    '@/app/lib/file-version-center/contracts/v1': { FILE_VERSION_CENTER_CONTRACT_VERSION: 1 },
    '@/app/lib/file-version-center/policy-v1': {
      classifyFileVersionFileV1: (pathHint: string) => {
        const extension = pathHint.split('.').at(-1)?.toLowerCase();
        if (extension === 'md' || extension === 'markdown') return 'markdown';
        if (extension === 'txt') return 'text';
        if (extension === 'ts' || extension === 'mdx') return 'code';
        return 'binary';
      },
    },
    '@/app/store/file-version-center-store': {
      openVersionCenter: (request: unknown) => { input.opened.push(request); },
    },
    '@/components/ui/button': {
      Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props}>{children}</button>
      ),
    },
    '@/components/ui/tooltip': {
      Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
      TooltipTrigger: ({ children }: React.PropsWithChildren<{ asChild?: boolean }>) => <>{children}</>,
      TooltipContent: ({ children }: React.PropsWithChildren<{ side?: string }>) => <span>{children}</span>,
    },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports },
    exports,
  );
  return exports;
}

test('the editor entry supports only the agreed Markdown and text capability boundary', async () => {
  const ui = await compileUi({ calls: [], opened: [], resolve: async () => timeline('unused') });
  for (const pathHint of ['notes.md', 'NOTES.MARKDOWN', 'notes.txt']) {
    assert.equal(ui.isEditorFileVersionSupported(pathHint), true, pathHint);
  }
  for (const pathHint of ['notes.mdx', 'index.ts', 'README', 'brief.docx']) {
    assert.equal(ui.isEditorFileVersionSupported(pathHint), false, pathHint);
  }
  assert.deepEqual(ui.editorFileVersionTarget({
    workspaceId: 'workspace-one', path: 'notes.md', documentId: 'document-one',
  }), { kind: 'document', workspaceId: 'workspace-one', documentId: 'document-one' });
  assert.deepEqual(ui.editorFileVersionTarget({ workspaceId: 'workspace-one', path: 'notes.txt' }), {
    kind: 'path', workspaceId: 'workspace-one', pathHint: 'notes.txt',
  });
});

test('the responsive editor control fails closed and opens only its latest authorized lineage', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  const calls: ResolveCall[] = [];
  const opened: unknown[] = [];
  let resolveTimeline: (call: ResolveCall) => Promise<Timeline> = async () => timeline('lineage-one');
  const ui = await compileUi({ calls, opened, resolve: (call) => resolveTimeline(call) });
  const root = createRoot(document.getElementById('root')!);
  const flush = async () => {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    }
  };

  try {
    let releaseOld!: (value: Timeline) => void;
    const oldTimeline = new Promise<Timeline>((resolve) => { releaseOld = resolve; });
    resolveTimeline = (call) => {
      const target = call.request.target as { pathHint?: string };
      return target.pathHint === 'old.md' ? oldTimeline : Promise.resolve(timeline('lineage-new'));
    };
    await act(async () => root.render(
      <ui.FileVersionHistoryButton workspaceId="workspace-one" path="old.md" />,
    ));
    const loadingButton = document.querySelector<HTMLButtonElement>('button');
    assert.ok(loadingButton?.disabled);
    assert.equal(loadingButton?.dataset.fileVersionCapability, 'loading');
    assert.equal(loadingButton?.getAttribute('aria-busy'), 'true');

    await act(async () => root.render(
      <ui.FileVersionHistoryButton workspaceId="workspace-one" path="new.md" />,
    ));
    await flush();
    const currentButton = document.querySelector<HTMLButtonElement>('button');
    assert.equal(currentButton?.disabled, false);
    assert.equal(currentButton?.dataset.fileVersionCapability, 'full');
    releaseOld(timeline('lineage-old'));
    await flush();
    await act(async () => currentButton?.click());
    assert.deepEqual(opened.at(-1), {
      contractVersion: 1,
      target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-new' },
      initialView: 'history',
      source: 'editor',
    });

    resolveTimeline = async () => timeline('lineage-viewer', { restore: false });
    await act(async () => root.render(
      <ui.FileVersionHistoryButton workspaceId="workspace-one" path="viewer.txt" />,
    ));
    await flush();
    const readOnlyButton = document.querySelector<HTMLButtonElement>('button');
    assert.equal(readOnlyButton?.disabled, false);
    assert.equal(readOnlyButton?.dataset.fileVersionCapability, 'read-only');
    assert.equal(readOnlyButton?.getAttribute('aria-label'), 'fileVersionHistoryReadOnly');

    resolveTimeline = async () => timeline('lineage-disabled', { history: false });
    await act(async () => root.render(
      <ui.FileVersionHistoryButton workspaceId="workspace-one" path="disabled.md" />,
    ));
    await flush();
    const unavailableButton = document.querySelector<HTMLButtonElement>('button');
    assert.ok(unavailableButton?.disabled);
    assert.equal(unavailableButton?.dataset.fileVersionCapability, 'unavailable');

    resolveTimeline = async () => { throw new Error('offline'); };
    await act(async () => root.render(
      <ui.FileVersionHistoryButton workspaceId="workspace-one" path="error.md" />,
    ));
    await flush();
    const errorButton = document.querySelector<HTMLButtonElement>('button');
    assert.ok(errorButton?.disabled);
    assert.equal(errorButton?.dataset.fileVersionCapability, 'error');

    const callsBeforeUnsupported = calls.length;
    await act(async () => root.render(
      <ui.FileVersionHistoryButton workspaceId="workspace-one" path="source.ts" />,
    ));
    assert.equal(document.querySelector('button'), null);
    assert.equal(calls.length, callsBeforeUnsupported, 'unsupported files do not probe hidden version data');
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
