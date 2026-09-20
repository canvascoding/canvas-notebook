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

import type * as Ui from '../app/components/editor/FileReviewPolicyControl';

type Policy = {
  contractVersion: 1;
  requestedMode: 'review_required' | 'safe_direct';
  effectiveMode: 'review_required' | 'safe_direct';
  revision: number;
  locked: boolean;
  reason: 'user_preference' | 'default_review_required' | 'default_safe_direct' | 'explicit_review' | 'hard_safety'
    | 'workspace_policy' | 'persistence_unavailable';
};

const policy = (
  mode: Policy['effectiveMode'],
  revision = 1,
  overrides: Partial<Policy> = {},
): Policy => ({
  contractVersion: 1,
  requestedMode: mode,
  effectiveMode: mode,
  revision,
  locked: false,
  reason: 'user_preference',
  ...overrides,
});

const timeline = (value: Policy | null, capable = true) => ({
  document: { workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  capabilities: { agentReviewPolicy: capable },
  policy: value,
});

async function compileUi(controls: {
  resolve: () => Promise<ReturnType<typeof timeline>>;
  update: (request: Record<string, unknown>) => Promise<Policy>;
  updates: Record<string, unknown>[];
}) {
  const filename = path.resolve('app/components/editor/FileReviewPolicyControl.tsx');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  class ClientError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  const exports = {} as typeof Ui;
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => (key: string) => key },
    '@/app/lib/file-version-center/client': {
      FileVersionCenterClientError: ClientError,
      resolveFileVersionCenterWhenReady: () => controls.resolve(),
      updateFileReviewPolicy: (request: Record<string, unknown>) => {
        controls.updates.push(request);
        return controls.update(request);
      },
    },
    '@/app/lib/file-version-center/contracts/v1': {
      FILE_VERSION_CENTER_CONTRACT_VERSION: 1,
      FILE_VERSION_CENTER_ERROR_CODES: { policyConflict: 'FVRC_POLICY_CONFLICT' },
    },
    '@/components/ui/button': {
      Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props}>{children}</button>
      ),
    },
    '@/components/ui/switch': {
      Switch: ({ checked, onCheckedChange, ...props }: {
        checked: boolean;
        onCheckedChange: (checked: boolean) => void;
      } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button
          {...props}
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onCheckedChange(!checked)}
        />
      ),
    },
    '@/components/ui/tooltip': {
      Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
      TooltipTrigger: ({ children }: React.PropsWithChildren<{ asChild?: boolean }>) => <>{children}</>,
      TooltipContent: ({ children }: React.PropsWithChildren<{ side?: string }>) => <span>{children}</span>,
    },
    './FileVersionHistoryButton': {
      isEditorFileVersionSupported: (pathHint: string) => /\.(?:md|markdown|txt)$/iu.test(pathHint),
      editorFileVersionTarget: (input: { workspaceId: string; path: string; documentId?: string | null }) => input.documentId
        ? { kind: 'document', workspaceId: input.workspaceId, documentId: input.documentId }
        : { kind: 'path', workspaceId: input.workspaceId, pathHint: input.path },
    },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports }, exports,
  );
  return { ui: exports, ClientError };
}

test('the pure control states remain fail-closed for loading, errors and forced policy', async () => {
  const { ui } = await compileUi({ resolve: async () => timeline(policy('review_required')),
    update: async () => policy('review_required'), updates: [] });
  assert.deepEqual(ui.fileReviewPolicyControlState({ state: 'loading', busy: false }), {
    checked: true, disabled: true, visualState: 'loading',
  });
  assert.deepEqual(ui.fileReviewPolicyControlState({ state: 'error', busy: false }), {
    checked: true, disabled: true, visualState: 'error',
  });
  assert.deepEqual(ui.fileReviewPolicyControlState({
    state: 'ready', available: true, policy: policy('safe_direct', 0, {
      requestedMode: 'safe_direct', reason: 'default_safe_direct',
    }), busy: false,
  }), { checked: false, disabled: false, visualState: 'safe_direct' });
  assert.deepEqual(ui.fileReviewPolicyControlState({
    state: 'ready', available: true, policy: policy('safe_direct', 2, {
      effectiveMode: 'review_required', locked: true, reason: 'hard_safety',
    }), busy: false,
  }), { checked: true, disabled: true, visualState: 'forced' });
});

test('the mobile editor switch uses CAS, reloads conflicts and exposes accessible fail-closed states', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  const updates: Record<string, unknown>[] = [];
  let resolvePolicy = async () => timeline(policy('review_required', 4));
  let updatePolicy = async () => policy('safe_direct', 5);
  const compiled = await compileUi({
    resolve: () => resolvePolicy(),
    update: (request) => updatePolicy().then((value) => {
      assert.ok(request);
      return value;
    }),
    updates,
  });
  const root = createRoot(document.getElementById('root')!);
  const flush = async () => {
    for (let index = 0; index < 5; index += 1) {
      await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    }
  };

  try {
    let releaseLoading!: (value: ReturnType<typeof timeline>) => void;
    resolvePolicy = () => new Promise((resolve) => { releaseLoading = resolve; });
    await act(async () => root.render(
      <compiled.ui.FileReviewPolicyControl workspaceId="workspace-one" path="notes.md" documentId="document-one" />,
    ));
    await flush();
    const loadingSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.equal(loadingSwitch?.disabled, true);
    assert.equal(loadingSwitch?.getAttribute('aria-checked'), 'true');
    assert.equal(document.querySelector('[data-file-review-policy]')?.getAttribute('data-file-review-policy'), 'loading');
    releaseLoading(timeline(policy('review_required', 4)));
    await flush();

    const reviewSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.equal(reviewSwitch?.disabled, false);
    assert.equal(reviewSwitch?.getAttribute('aria-label'), 'fileReviewPolicyRequired');
    assert.match(reviewSwitch?.className ?? '', /after:-inset-y-2/u, 'mobile hit area is enlarged without changing header layout');
    await act(async () => reviewSwitch?.click());
    await flush();
    assert.deepEqual(updates[0], {
      contractVersion: 1,
      target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
      requestedMode: 'safe_direct',
      expectedRevision: 4,
    });
    assert.equal(document.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'false');

    resolvePolicy = async () => timeline(policy('safe_direct', 8));
    updatePolicy = async () => { throw new compiled.ClientError('FVRC_POLICY_CONFLICT'); };
    await act(async () => root.render(
      <compiled.ui.FileReviewPolicyControl workspaceId="workspace-one" path="conflict.md" documentId="document-conflict" />,
    ));
    await flush();
    const conflictSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.equal(conflictSwitch?.getAttribute('aria-checked'), 'false');
    resolvePolicy = async () => timeline(policy('review_required', 9));
    await act(async () => conflictSwitch?.click());
    await flush();
    assert.equal(document.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true');
    assert.match(document.body.textContent ?? '', /fileReviewPolicyConflict/u);

    resolvePolicy = async () => { throw new Error('offline'); };
    await act(async () => root.render(
      <compiled.ui.FileReviewPolicyControl workspaceId="workspace-one" path="offline.md" />,
    ));
    await flush();
    const errorSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.equal(errorSwitch?.disabled, true);
    assert.equal(errorSwitch?.getAttribute('aria-checked'), 'true');
    assert.equal(document.querySelector('[data-file-review-policy]')?.getAttribute('data-file-review-policy'), 'error');
    assert.ok(document.querySelector<HTMLButtonElement>('[aria-label="fileReviewPolicyRetry"]'));

    const updatesBeforeUnsupported = updates.length;
    await act(async () => root.render(
      <compiled.ui.FileReviewPolicyControl workspaceId="workspace-one" path="source.ts" />,
    ));
    assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(updates.length, updatesBeforeUnsupported);
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
