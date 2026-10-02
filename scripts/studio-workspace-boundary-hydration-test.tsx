import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, useEffect, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { create } from 'zustand';

async function main() {
  const internals = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = internals._load;
  let workspaceId: string | null = null;
  let requestedWorkspaceId: string | null = null;
  let generationResetCount = 0;
  const cacheResets: Array<string | null> = [];
  const cache = create<{
    workspaceId: string | null;
    resetForWorkspace: (id: string | null) => void;
  }>((set, get) => ({
    workspaceId: null,
    resetForWorkspace: id => {
      cacheResets.push(id);
      if (get().workspaceId !== id) set({ workspaceId: id });
    },
  }));
  internals._load = (name, ...args) => {
    if (name === 'next/navigation') {
      return { useSearchParams: () => new URLSearchParams(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}) };
    }
    if (name === '@/app/store/workspace-store' || name.endsWith('/app/store/workspace-store')) {
      return { useWorkspaceStore: (selector: (state: { activeWorkspaceId: string | null }) => unknown) => selector({ activeWorkspaceId: workspaceId }) };
    }
    if (name === '@/app/store/studio-generations-cache-store' || name.endsWith('/app/store/studio-generations-cache-store')) {
      return { useStudioGenerationsCacheStore: cache };
    }
    if (name === '@/app/store/studio-generation-store' || name.endsWith('/app/store/studio-generation-store')) {
      return { useStudioGenerationStore: { getState: () => ({ resetWorkspaceContext: () => { generationResetCount += 1; } }) } };
    }
    return originalLoad(name, ...args);
  };
  let dom: JSDOM | null = null;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  try {
    const { StudioWorkspaceBoundary } = await import('../app/apps/studio/components/StudioWorkspaceBoundary');
    const mounts: string[] = [];
    const unmounts: string[] = [];
    function WorkspaceEditor() {
      const mountedWorkspaceId = workspaceId!;
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts.push(mountedWorkspaceId);
        return () => { unmounts.push(mountedWorkspaceId); };
      }, [mountedWorkspaceId]);
      return <button onClick={() => setCount(value => value + 1)}>{mountedWorkspaceId}:{count}</button>;
    }
    const tree = () => <StudioWorkspaceBoundary><WorkspaceEditor /></StudioWorkspaceBoundary>;

    // Node SSR sees no cached workspace. The browser module starts with a
    // localStorage workspace while its Studio cache still starts at null.
    const serverHtml = renderToString(tree());
    assert.equal(serverHtml, '', 'Server output waits for hydration even when both server stores are null');
    assert.deepEqual(mounts, []);
    assert.deepEqual(cacheResets, []);
    workspaceId = 'cached-workspace';
    dom = new JSDOM(`<div id="root">${serverHtml}</div>`, { url: 'https://notebook.example.test/studio' });
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event'] as const) {
      originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
    }
    originalGlobals.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
    const { hydrateRoot } = await import('react-dom/client');
    const container = dom.window.document.getElementById('root')!;
    const hydrationErrors: string[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError: error => hydrationErrors.push(String(error)) });
    });
    try {
      assert.equal(hydrationErrors.length, 0, 'Cached browser workspace hydrates without mismatched server HTML');
      assert.equal(container.textContent, 'cached-workspace:0');
      assert.equal(cache.getState().workspaceId, 'cached-workspace');
      assert.deepEqual(cacheResets, ['cached-workspace']);
      assert.equal(generationResetCount, 1);
      assert.deepEqual(mounts, ['cached-workspace']);
      await act(async () => container.querySelector('button')!.click());
      await act(async () => root!.render(tree()));
      assert.equal(container.textContent, 'cached-workspace:1', 'Same workspace preserves editor state');
      assert.equal(generationResetCount, 1, 'An ordinary rerender does not reset generation context');

      workspaceId = 'next-workspace';
      await act(async () => root!.render(tree()));
      assert.equal(container.textContent, 'next-workspace:0', 'Workspace change remounts editor without carrying old state');
      assert.equal(cache.getState().workspaceId, 'next-workspace');
      assert.deepEqual(cacheResets, ['cached-workspace', 'next-workspace']);
      assert.equal(generationResetCount, 2);
      assert.deepEqual(unmounts, ['cached-workspace']);

      requestedWorkspaceId = 'requested-workspace';
      await act(async () => root!.render(tree()));
      assert.equal(container.textContent, '', 'Deep link cannot show the currently active wrong workspace');
      workspaceId = 'requested-workspace';
      await act(async () => root!.render(tree()));
      assert.equal(container.textContent, 'requested-workspace:0', 'Target workspace appears only after cache reset');
      assert.equal(cache.getState().workspaceId, 'requested-workspace');
      assert.equal(generationResetCount, 3);
      assert.equal(hydrationErrors.length, 0);
    } finally {
      await act(async () => root!.unmount());
    }

    // Repeat SSR/hydration with a requested target different from the cached
    // browser workspace, so hydration cannot momentarily mount the wrong UI.
    workspaceId = null;
    const requestedServerHtml = renderToString(tree());
    assert.equal(requestedServerHtml, '');
    container.innerHTML = requestedServerHtml;
    workspaceId = 'other-cached-workspace';
    const mountCount = mounts.length;
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError: error => hydrationErrors.push(String(error)) });
    });
    try {
      assert.equal(container.textContent, '');
      assert.equal(mounts.length, mountCount, 'Mismatched target never mounts workspace children');
      assert.equal(hydrationErrors.length, 0);
    } finally {
      await act(async () => root!.unmount());
    }
    console.log('studio-workspace-boundary-hydration-test: ok (SSR, cached workspace, requested target, resets, remounts)');
  } finally {
    internals._load = originalLoad;
    dom?.window.close();
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
