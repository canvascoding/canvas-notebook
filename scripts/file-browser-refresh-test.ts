import assert from 'node:assert/strict';
import { useFileStore, type FileNode } from '../app/store/file-store';

const originalFetch = globalThis.fetch;

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function main() {
  const calls: string[] = [];
  const responses: Record<string, FileNode[]> = {
    '.': [
      { name: 'docs', path: 'docs', type: 'directory' },
      { name: 'src', path: 'src', type: 'directory' },
    ],
    docs: [
      { name: 'fresh.md', path: 'docs/fresh.md', type: 'file' },
    ],
    src: [
      { name: 'app', path: 'src/app', type: 'directory' },
    ],
    'src/app': [
      { name: 'page.tsx', path: 'src/app/page.tsx', type: 'file' },
    ],
    empty: [],
  };
  let delayDocsFetch = true;
  const docsFetchControl: { release?: () => void } = {};
  const docsFetchStarted = new Promise<void>((resolve) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.searchParams.get('path') || '.';
      calls.push(path);
      if (delayDocsFetch && path === 'docs') {
        resolve();
        await new Promise<void>((release) => {
          docsFetchControl.release = release;
        });
      }
      return Response.json({ success: true, data: responses[path] ?? [] });
    }) as typeof fetch;
  });

  try {
    useFileStore.setState({
      fileTree: [
        { name: 'docs', path: 'docs', type: 'directory' },
      ],
      loadingDirs: new Set<string>(),
      expandedDirs: new Set<string>(),
    });

    useFileStore.getState().toggleDirectory('docs');
    assert.equal(useFileStore.getState().expandedDirs.has('docs'), true, 'opening a folder should expand immediately');
    assert.equal(useFileStore.getState().loadingDirs.has('docs'), true, 'opening an unloaded folder should show a loading state');
    await docsFetchStarted;

    useFileStore.getState().toggleDirectory('docs');
    assert.equal(useFileStore.getState().expandedDirs.has('docs'), false, 'closing a loading folder should collapse immediately');
    const releaseDocsFetch = docsFetchControl.release;
    if (typeof releaseDocsFetch !== 'function') {
      assert.fail('docs fetch release should be available after fetch starts');
    }
    releaseDocsFetch();
    await waitFor(() => !useFileStore.getState().loadingDirs.has('docs'), 'docs fetch should finish');
    assert.equal(useFileStore.getState().expandedDirs.has('docs'), false, 'finished loads should not reopen a folder the user closed');

    useFileStore.setState({
      fileTree: [
        { name: 'empty', path: 'empty', type: 'directory', children: [] },
      ],
      loadingDirs: new Set<string>(),
      expandedDirs: new Set<string>(),
    });
    calls.length = 0;
    useFileStore.getState().toggleDirectory('empty');
    assert.equal(useFileStore.getState().expandedDirs.has('empty'), true, 'loaded empty folders should still expand');
    assert.deepEqual(calls, [], 'loaded empty folders should not fetch again');

    delayDocsFetch = false;
    calls.length = 0;

    useFileStore.setState({
      fileTree: [
        {
          name: 'docs',
          path: 'docs',
          type: 'directory',
          children: [{ name: 'stale.md', path: 'docs/stale.md', type: 'file' }],
        },
        {
          name: 'src',
          path: 'src',
          type: 'directory',
          children: [{ name: 'app', path: 'src/app', type: 'directory', children: [] }],
        },
      ],
      browserMode: 'tree',
      currentDirectory: 'docs',
      expandedDirs: new Set(['src', 'src/app']),
    });

    await useFileStore.getState().refreshVisibleTree();

    assert.deepEqual(calls, ['.', 'docs', 'src', 'src/app']);

    const state = useFileStore.getState();
    const docs = state.fileTree.find((node) => node.path === 'docs');
    const src = state.fileTree.find((node) => node.path === 'src');
    const app = src?.children?.find((node) => node.path === 'src/app');

    assert.equal(docs?.children?.[0]?.path, 'docs/fresh.md');
    assert.equal(app?.children?.[0]?.path, 'src/app/page.tsx');

    const firstVisibleNode: FileNode = { name: 'a.md', path: 'visible/a.md', type: 'file' };
    const middleVisibleNode: FileNode = { name: 'c.md', path: 'visible/c.md', type: 'file' };
    const lastVisibleNode: FileNode = { name: 'b.md', path: 'visible/b.md', type: 'file' };
    useFileStore.setState({
      fileTree: [firstVisibleNode, lastVisibleNode, middleVisibleNode],
      selectedNode: null,
      isMultiSelectMode: false,
      multiSelectPaths: new Set<string>(),
      lastSelectedPath: null,
    });

    useFileStore.getState().selectNode(firstVisibleNode, false, false, [
      firstVisibleNode.path,
      middleVisibleNode.path,
      lastVisibleNode.path,
    ]);
    useFileStore.getState().selectNode(lastVisibleNode, false, true, [
      firstVisibleNode.path,
      middleVisibleNode.path,
      lastVisibleNode.path,
    ]);

    assert.deepEqual(
      Array.from(useFileStore.getState().multiSelectPaths),
      [firstVisibleNode.path, middleVisibleNode.path, lastVisibleNode.path],
      'shift range selection should follow the visible view order when provided',
    );

    globalThis.fetch = (async () => new Response('<!DOCTYPE html><html><body>busy</body></html>', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch;

    await useFileStore.getState().loadFile('docs/busy-preview.png', true);

    const errorMessage = useFileStore.getState().fileError;
    assert.ok(errorMessage, 'HTML error responses should set a file error');
    assert.match(errorMessage, /server returned HTML instead of JSON/);
    assert.doesNotMatch(errorMessage, /Unexpected token/);
    assert.equal(useFileStore.getState().isLoadingFile, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('file-browser-refresh-test: ok');
}

void main();
