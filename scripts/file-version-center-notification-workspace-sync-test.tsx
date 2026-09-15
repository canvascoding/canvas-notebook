import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import type { NotificationItem } from '../app/components/notifications/notification-summary';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

const initialHref = '/en/notebook?workspaceId=workspace-one&chat=open#kept';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: `https://canvas.test${initialHref}`,
  pretendToBeVisual: true,
});
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'localStorage',
] as const) {
  const value = key === 'window' ? dom.window : dom.window[key];
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const navigationSubscribers = new Set<() => void>();
let navigationRevision = 0;
const originalReplaceState = window.history.replaceState.bind(window.history);
function publishLocation(): void {
  navigationRevision += 1;
  for (const subscriber of navigationSubscribers) subscriber();
}
Object.defineProperty(window.history, 'replaceState', {
  configurable: true,
  value: (data: unknown, unused: string, url?: string | URL | null) => {
    originalReplaceState(data, unused, url);
    publishLocation();
  },
});

function useNavigationRevision(): void {
  useSyncExternalStore(
    (subscriber) => {
      navigationSubscribers.add(subscriber);
      return () => navigationSubscribers.delete(subscriber);
    },
    () => navigationRevision,
    () => navigationRevision,
  );
}

const navigationModule = {
  usePathname: () => {
    useNavigationRevision();
    return window.location.pathname;
  },
  useRouter: () => ({
    replace: (href: string) => window.history.replaceState(window.history.state, '', href),
  }),
  useSearchParams: () => {
    useNavigationRevision();
    return new URLSearchParams(window.location.search);
  },
};

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => (
  request === 'next/navigation'
    ? navigationModule
    : originalLoad(request, parent, isMain)
);

function workspace(id: string): ClientWorkspaceSummary {
  return {
    id,
    type: 'personal',
    name: id,
    color: '#475569',
    status: 'active',
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
  };
}

function notification(workspaceId: string, operationId: string): NotificationItem {
  return {
    id: `file-change:${operationId}`,
    type: 'file.change_review_required',
    title: 'File change needs review',
    detail: null,
    occurredAt: new Date(0).toISOString(),
    unread: true,
    priority: 'normal',
    workspaceId,
    workspaceName: workspaceId,
    fileChangeReason: 'needs_review',
    target: {
      kind: 'file_change',
      workspaceId,
      lineageId: `lineage-${workspaceId}`,
      operationId,
    },
  };
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function main() {
  const { WorkspaceNavigationSync } = await import('../app/components/workspaces/WorkspaceNavigationSync');
  const { openFileChangeReviewNotification } = await import('../app/components/notifications/notification-actions');
  const { closeVersionCenter, useFileVersionCenterStore } = await import('../app/store/file-version-center-store');
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');

  const originalWorkspace = useWorkspaceStore.getState();
  const originalFile = useFileStore.getState();
  const workspaces = ['workspace-one', 'workspace-a', 'workspace-b', 'workspace-failure'].map(workspace);
  const switchTargets: string[] = [];
  const trackedSetActiveWorkspace: typeof originalWorkspace.setActiveWorkspace = async (...args) => {
    switchTargets.push(args[0]);
    return originalWorkspace.setActiveWorkspace(...args);
  };
  const root = createRoot(document.getElementById('root')!);

  async function resetScenario(prepareCurrentFileForTransition: () => Promise<void>) {
    await act(async () => {
      closeVersionCenter({ syncLocation: false });
      window.history.replaceState(window.history.state, '', initialHref);
      useWorkspaceStore.setState({
        activeWorkspaceId: 'workspace-one',
        workspaces,
        initialized: true,
        hydrateWorkspaces: originalWorkspace.hydrateWorkspaces,
        setActiveWorkspace: trackedSetActiveWorkspace,
        error: null,
      });
      useFileStore.setState({
        prepareCurrentFileForTransition,
        resetWorkspaceView: () => {},
      });
      switchTargets.length = 0;
    });
    await settle();
  }

  try {
    await act(async () => root.render(<WorkspaceNavigationSync />));
    await settle();

    let releaseSwitch!: () => void;
    let reportSwitchStarted!: () => void;
    const switchStarted = new Promise<void>((resolve) => { reportSwitchStarted = resolve; });
    await resetScenario(async () => {
      reportSwitchStarted();
      await new Promise<void>((resolve) => { releaseSwitch = resolve; });
    });
    const baselineHref = currentHref();
    let delayedOpen!: Promise<boolean>;
    await act(async () => {
      delayedOpen = openFileChangeReviewNotification(notification('workspace-a', 'operation-a'));
      await switchStarted;
    });
    assert.equal(currentHref(), baselineHref,
      'history stays unchanged while the direct workspace transition is pending');
    assert.equal(useFileVersionCenterStore.getState().request, null,
      'FVRC state stays closed while the direct workspace transition is pending');
    assert.deepEqual(switchTargets, ['workspace-a'],
      'the mounted WorkspaceNavigationSync does not start a competing switch');
    await act(async () => {
      releaseSwitch();
      assert.equal(await delayedOpen, true);
    });
    await settle();
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-a');
    assert.equal(new URL(window.location.href).searchParams.get('workspaceId'), 'workspace-a');
    assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'operation-a');
    assert.deepEqual(switchTargets, ['workspace-a'],
      'the direct notification opener remains the only switch owner after URL publication');

    let releaseFailure!: () => void;
    let reportFailureStarted!: () => void;
    const failureStarted = new Promise<void>((resolve) => { reportFailureStarted = resolve; });
    await resetScenario(async () => {
      reportFailureStarted();
      await new Promise<void>((resolve) => { releaseFailure = resolve; });
      throw new Error('Document transition failed');
    });
    const failureBaselineHref = currentHref();
    let failedOpen!: Promise<boolean>;
    await act(async () => {
      failedOpen = openFileChangeReviewNotification(notification('workspace-failure', 'operation-failure'));
      await failureStarted;
    });
    assert.equal(currentHref(), failureBaselineHref);
    await act(async () => {
      releaseFailure();
      assert.equal(await failedOpen, false);
    });
    await settle();
    assert.equal(currentHref(), failureBaselineHref,
      'a failed direct transition never publishes a transient workspace or FVRC URL');
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-one');
    assert.equal(useFileVersionCenterStore.getState().request, null);
    assert.deepEqual(switchTargets, ['workspace-failure']);

    let releaseFirst!: () => void;
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
    let preparation = 0;
    await resetScenario(async () => {
      preparation += 1;
      if (preparation === 1) {
        reportFirstStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
    });
    let firstOpen!: Promise<boolean>;
    await act(async () => {
      firstOpen = openFileChangeReviewNotification(notification('workspace-a', 'operation-a'));
      await firstStarted;
    });
    await act(async () => {
      assert.equal(await openFileChangeReviewNotification(notification('workspace-b', 'operation-b')), true);
    });
    await act(async () => {
      releaseFirst();
      assert.equal(await firstOpen, true);
    });
    await settle();
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-b');
    assert.equal(new URL(window.location.href).searchParams.get('workspaceId'), 'workspace-b');
    assert.equal(new URL(window.location.href).searchParams.get('fvrcSelectedId'), 'operation-b');
    assert.equal(useFileVersionCenterStore.getState().request?.target.workspaceId, 'workspace-b');
    assert.deepEqual(switchTargets, ['workspace-a', 'workspace-b'],
      'out-of-order A/B completion does not add a navigation-sync switch');

    let releaseSuperseded!: () => void;
    let reportSupersededStarted!: () => void;
    const supersededStarted = new Promise<void>((resolve) => { reportSupersededStarted = resolve; });
    preparation = 0;
    await resetScenario(async () => {
      preparation += 1;
      if (preparation === 1) {
        reportSupersededStarted();
        await new Promise<void>((resolve) => { releaseSuperseded = resolve; });
        return;
      }
      throw new Error('Latest transition failed');
    });
    let supersededOpen!: Promise<boolean>;
    await act(async () => {
      supersededOpen = openFileChangeReviewNotification(notification('workspace-a', 'operation-a'));
      await supersededStarted;
    });
    await act(async () => {
      assert.equal(await openFileChangeReviewNotification(notification('workspace-b', 'operation-b')), false);
    });
    assert.equal(currentHref(), initialHref,
      'a failed latest click leaves the non-transient URL unchanged');
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-one');
    await act(async () => {
      releaseSuperseded();
      assert.equal(await supersededOpen, true);
    });
    await settle();
    assert.equal(currentHref(), initialHref);
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'workspace-one',
      'a stale earlier transition cannot leave workspace and URL inconsistent');
    assert.equal(useFileVersionCenterStore.getState().request, null);
    assert.deepEqual(switchTargets, ['workspace-a', 'workspace-b']);

    console.log('file-version-center-notification-workspace-sync-test: ok');
  } finally {
    await act(async () => root.unmount());
    useWorkspaceStore.setState({
      activeWorkspaceId: originalWorkspace.activeWorkspaceId,
      workspaces: originalWorkspace.workspaces,
      initialized: originalWorkspace.initialized,
      hydrateWorkspaces: originalWorkspace.hydrateWorkspaces,
      setActiveWorkspace: originalWorkspace.setActiveWorkspace,
      error: originalWorkspace.error,
    });
    useFileStore.setState({
      prepareCurrentFileForTransition: originalFile.prepareCurrentFileForTransition,
      resetWorkspaceView: originalFile.resetWorkspaceView,
    });
    closeVersionCenter({ syncLocation: false });
    moduleInternals._load = originalLoad;
    Object.defineProperty(window.history, 'replaceState', { configurable: true, value: originalReplaceState });
    dom.window.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
