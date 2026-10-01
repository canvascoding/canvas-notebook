import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type * as Navigation from '../app/components/file-version-center/useWorkspaceOperationReviewNavigation';

test('review deep link is consumed in router state before hydration and never reopens an old proposal over its successor', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://canvas.test/en/notebook?workspaceId=workspace-one&workspaceOperationReview=original-review&file=start.md',
  });
  const globalNames = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const nativeReplace = window.history.replaceState.bind(window.history);
  nativeReplace({ __NA: true, tree: 'preserved-router-tree' }, '', window.location.href);
  let routerHref = window.location.href;
  // Installed Next.js only syncs the canonical URL for external history calls;
  // passing its existing __NA state would bypass that synchronization.
  window.history.replaceState = (data: Record<string, unknown> | null, unused, url) => {
    if (!data?.__NA) routerHref = new URL(String(url), window.location.href).href;
    nativeReplace({ ...data, __NA: true, tree: 'preserved-router-tree' }, unused, url);
  };
  const filename = path.resolve('app/components/file-version-center/useWorkspaceOperationReviewNavigation.ts');
  const native = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {} as typeof Navigation;
  const opens: Array<{ reviewId: string; workspaceId: string }> = [];
  let finishHydration!: (result: boolean) => void;
  let opening = new Promise<boolean>((resolve) => { finishHydration = resolve; });
  const errors: string[] = [];
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: () => (key: string) => key },
    'sonner': { toast: { error: (message: string) => errors.push(message) } },
    '@/app/components/notifications/notification-actions': {
      openWorkspaceOperationNotificationTarget: (target: { reviewId: string; workspaceId: string }) => { opens.push(target); return opening; },
    },
  };
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : native(name), { exports }, exports,
  );
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const stableScope: Parameters<typeof exports.useWorkspaceOperationReviewNavigation>[0] = { userId: 'user', sessionId: 'session-one', epoch: 1 };
  const changedScope: Parameters<typeof exports.useWorkspaceOperationReviewNavigation>[0] = { userId: 'user', sessionId: 'session-two', epoch: 2 };
  function Harness({ scope }: { scope: typeof stableScope }) {
    exports.useWorkspaceOperationReviewNavigation(scope);
    return null;
  }
  try {
    await act(async () => root.render(<Harness scope={stableScope} />));
    assert.deepEqual(opens, [{ reviewId: 'original-review', workspaceId: 'workspace-one' }]);
    assert.equal(new URL(window.location.href).searchParams.has('workspaceOperationReview'), false,
      'the old review is consumed before workspace hydration can trigger another effect');
    assert.equal(new URL(routerHref).searchParams.has('workspaceOperationReview'), false,
      'the canonical router URL also consumes the old review');
    assert.equal(window.history.state.tree, 'preserved-router-tree');
    const unrelated = new URL(window.location.href);
    unrelated.searchParams.set('file', 'latest.md');
    window.history.replaceState(null, '', unrelated.href);
    await act(async () => root.render(<Harness scope={changedScope} />));
    assert.equal(opens.length, 1, 'an auth/effect rerun during hydration cannot open the old target again');
    await act(async () => finishHydration(true));
    assert.equal(new URL(window.location.href).searchParams.get('file'), 'latest.md', 'unrelated navigation survives hydration');
    // Simulate a stale query reintroduced by an independent navigation, then
    // a component/effect rerun after the successor has completed.
    const stale = new URL(window.location.href);
    stale.searchParams.set('workspaceOperationReview', 'original-review');
    window.history.replaceState(null, '', stale.href);
    await act(async () => root.render(<Harness scope={stableScope} />));
    assert.equal(opens.length, 1, 'the original proposal cannot replace the successor receipt');
    assert.equal(new URL(routerHref).searchParams.has('workspaceOperationReview'), false);
    const next = new URL(window.location.href);
    next.searchParams.set('workspaceOperationReview', 'successor-review');
    window.history.replaceState(null, '', next.href);
    opening = Promise.resolve(true);
    await act(async () => window.dispatchEvent(new dom.window.PopStateEvent('popstate', { state: window.history.state })));
    assert.equal(opens.at(-1)?.reviewId, 'successor-review', 'a deliberate history navigation can open a new review');
    assert.deepEqual(errors, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
