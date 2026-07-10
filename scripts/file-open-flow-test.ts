import assert from 'node:assert/strict';
import { useEditorStore } from '../app/store/editor-store';
import { useFileStore, type FileNode } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

const originalFetch = globalThis.fetch;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function treeResponse(data: FileNode[]) {
  return Response.json({ success: true, data });
}

async function testConcurrentDirectoryLoadsShareTheSamePromise() {
  const gate = deferred();
  let fetchCount = 0;
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });

  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  useFileStore.setState({
    fileTree: [{ name: 'docs', path: 'docs', type: 'directory' }],
    fileTreeWorkspaceId: 'workspace-a',
    loadingDirs: new Set<string>(),
    expandedDirs: new Set<string>(),
    directoryErrors: {},
    treeError: null,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/files/tree' && url.searchParams.get('path') === 'docs') {
      fetchCount += 1;
      fetchStarted();
      await gate.promise;
      return treeResponse([{ name: 'readme.md', path: 'docs/readme.md', type: 'file' }]);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const first = useFileStore.getState().loadSubdirectory('docs', false, true, 'workspace-a');
  await started;

  let secondResolved = false;
  const second = useFileStore.getState().loadSubdirectory('docs', false, true, 'workspace-a')
    .then(() => { secondResolved = true; });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondResolved, false, 'a deduplicated caller must await the in-flight directory request');

  gate.release();
  await Promise.all([first, second]);
  assert.equal(fetchCount, 1, 'concurrent loads for the same workspace directory should fetch once');
}

async function testLatestOpenRequestWins() {
  const slowReadGate = deferred();
  let slowReadStarted!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    slowReadStarted = resolve;
  });

  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  useEditorStore.getState().clear();
  useFileStore.setState({
    fileTree: [
      {
        name: 'slow',
        path: 'slow',
        type: 'directory',
        children: [{ name: 'a.md', path: 'slow/a.md', type: 'file' }],
      },
      {
        name: 'fast',
        path: 'fast',
        type: 'directory',
        children: [{ name: 'b.md', path: 'fast/b.md', type: 'file' }],
      },
    ],
    fileTreeWorkspaceId: 'workspace-a',
    currentFile: null,
    selectedNode: null,
    loadingDirs: new Set<string>(),
    expandedDirs: new Set<string>(),
    directoryErrors: {},
    treeError: null,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== '/api/files/read') {
      throw new Error(`Unexpected request: ${url}`);
    }

    const path = url.searchParams.get('path');
    if (path === 'slow/a.md') {
      slowReadStarted();
      await slowReadGate.promise;
    }

    return Response.json({
      success: true,
      data: {
        path,
        content: path === 'slow/a.md' ? '# Slow' : '# Fast',
        stats: { size: 8, modified: 1, permissions: '100644' },
      },
    });
  }) as typeof fetch;

  const slowOpen = useFileStore.getState().revealAndLoadFile('slow/a.md', { workspaceId: 'workspace-a' });
  await slowStarted;
  const fastResult = await useFileStore.getState().revealAndLoadFile('fast/b.md', { workspaceId: 'workspace-a' });
  slowReadGate.release();
  const slowResult = await slowOpen;

  assert.equal(fastResult.status, 'opened');
  assert.equal(slowResult.status, 'superseded');
  assert.equal(useFileStore.getState().currentFile?.path, 'fast/b.md');
}

async function testWorkspaceSwitchRejectsOldTreeResponse() {
  const workspaceAGate = deferred();
  let workspaceAStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    workspaceAStarted = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const workspaceId = new Headers(init?.headers).get('X-Canvas-Workspace-Id');
    if (workspaceId === 'workspace-a') {
      workspaceAStarted();
      await workspaceAGate.promise;
      return treeResponse([{ name: 'a.md', path: 'a.md', type: 'file' }]);
    }
    if (workspaceId === 'workspace-b') {
      return treeResponse([{ name: 'b.md', path: 'b.md', type: 'file' }]);
    }
    throw new Error(`Unexpected workspace request: ${url}`);
  }) as typeof fetch;

  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  useFileStore.getState().resetWorkspaceView('workspace-a');
  const workspaceALoad = useFileStore.getState().loadFileTree('.', 0, false, 'workspace-a');
  await started;

  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-b' });
  useFileStore.getState().resetWorkspaceView('workspace-b');
  await useFileStore.getState().loadFileTree('.', 0, false, 'workspace-b');
  workspaceAGate.release();
  await workspaceALoad;

  const state = useFileStore.getState();
  assert.equal(state.fileTreeWorkspaceId, 'workspace-b');
  assert.deepEqual(state.fileTree.map((node) => node.path), ['b.md']);
}

async function testDirectoryErrorsStayLocal() {
  const originalConsoleError = console.error;
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  useFileStore.setState({
    fileTree: [{ name: 'broken', path: 'broken', type: 'directory' }],
    fileTreeWorkspaceId: 'workspace-a',
    loadingDirs: new Set<string>(),
    directoryErrors: {},
    treeError: null,
  });

  globalThis.fetch = (async () => Response.json(
    { success: false, error: 'Directory unavailable' },
    { status: 503 },
  )) as typeof fetch;

  console.error = () => {};
  try {
    await useFileStore.getState().loadSubdirectory('broken', true, true, 'workspace-a');
    const state = useFileStore.getState();
    assert.equal(state.treeError, null);
    assert.match(state.directoryErrors.broken ?? '', /Directory unavailable/);
    assert.equal(state.fileTree[0]?.path, 'broken');
  } finally {
    console.error = originalConsoleError;
  }
}

async function testDirtyEditorIsSavedBeforeOpeningAnotherFile() {
  const requestOrder: string[] = [];

  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  useFileStore.setState({
    fileTree: [{ name: 'new.md', path: 'new.md', type: 'file' }],
    fileTreeWorkspaceId: 'workspace-a',
    currentFile: {
      path: 'old.md',
      content: 'old',
      stats: { size: 3, modified: 1, permissions: '100644' },
    },
    fileRevisions: {},
    mobileFileOpenedCount: 0,
  });
  useEditorStore.setState({
    activePath: 'old.md',
    draft: 'unsaved change',
    baseContent: 'old',
    isDirty: true,
    isSaving: false,
    saveError: null,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/files/write') {
      requestOrder.push('write');
      return Response.json({
        success: true,
        data: {
          path: 'old.md',
          stats: { size: 14, modified: 2, permissions: '100644', sha256: 'saved' },
        },
      });
    }
    if (url.pathname === '/api/files/read') {
      requestOrder.push('read');
      return Response.json({
        success: true,
        data: {
          path: 'new.md',
          content: '# New',
          stats: { size: 5, modified: 2, permissions: '100644' },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const result = await useFileStore.getState().revealAndLoadFile('new.md', { workspaceId: 'workspace-a' });
  assert.equal(result.status, 'opened');
  assert.deepEqual(requestOrder, ['write', 'read']);
  assert.equal(useFileStore.getState().currentFile?.path, 'new.md');
  assert.equal(useEditorStore.getState().isDirty, false);
}

async function testFailedOpenDoesNotTriggerMobileTransition() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  useEditorStore.getState().clear();
  useFileStore.setState({
    fileTree: [{ name: 'missing.md', path: 'missing.md', type: 'file' }],
    fileTreeWorkspaceId: 'workspace-a',
    currentFile: null,
    mobileFileOpenedCount: 7,
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/files/read') {
      return Response.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  const result = await useFileStore.getState().revealAndLoadFile('missing.md', { workspaceId: 'workspace-a' });
  assert.equal(result.status, 'missing');
  assert.equal(useFileStore.getState().mobileFileOpenedCount, 7);
  assert.match(useFileStore.getState().fileError ?? '', /not found/i);
}

function testExplorerPreferencesAreScopedByWorkspace() {
  const originalWindow = globalThis.window;
  const values = new Map<string, string>([
    ['canvas.fileExplorerState:workspace-a', JSON.stringify({
      currentDirectory: 'docs/a',
      expandedDirs: ['docs', 'docs/a'],
    })],
    ['canvas.fileExplorerState:workspace-b', JSON.stringify({
      currentDirectory: 'src/b',
      expandedDirs: ['src', 'src/b'],
    })],
  ]);
  const fakeWindow = {
    innerWidth: 1280,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  try {
    useFileStore.getState().resetWorkspaceView('workspace-a');
    useFileStore.getState().hydrateClientPreferences('workspace-a', true);
    assert.equal(useFileStore.getState().currentDirectory, 'docs/a');
    assert.deepEqual(Array.from(useFileStore.getState().expandedDirs), ['docs', 'docs/a']);

    useFileStore.getState().resetWorkspaceView('workspace-b');
    useFileStore.getState().hydrateClientPreferences('workspace-b', true);
    assert.equal(useFileStore.getState().currentDirectory, 'src/b');
    assert.deepEqual(Array.from(useFileStore.getState().expandedDirs), ['src', 'src/b']);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  }
}

async function main() {
  try {
    await testConcurrentDirectoryLoadsShareTheSamePromise();
    await testLatestOpenRequestWins();
    await testWorkspaceSwitchRejectsOldTreeResponse();
    await testDirectoryErrorsStayLocal();
    await testDirtyEditorIsSavedBeforeOpeningAnotherFile();
    await testFailedOpenDoesNotTriggerMobileTransition();
    testExplorerPreferencesAreScopedByWorkspace();
  } finally {
    globalThis.fetch = originalFetch;
    useEditorStore.getState().clear();
  }

  console.log('file-open-flow-test: ok');
}

void main();
