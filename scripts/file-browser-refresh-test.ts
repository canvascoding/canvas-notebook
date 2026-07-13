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
  const callDetails: Array<{ path: string; depth: string | null; stats: string | null }> = [];
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
      callDetails.push({
        path,
        depth: url.searchParams.get('depth'),
        stats: url.searchParams.get('stats'),
      });
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
    assert.equal(callDetails.find((call) => call.path === 'docs')?.depth, '0', 'folder expand should load direct children only');
    assert.equal(callDetails.find((call) => call.path === 'docs')?.stats, '0', 'folder expand should use tree fast path');

    useFileStore.setState({
      fileTree: [
        { name: 'empty', path: 'empty', type: 'directory', children: [] },
      ],
      loadingDirs: new Set<string>(),
      expandedDirs: new Set<string>(),
    });
    calls.length = 0;
    callDetails.length = 0;
    useFileStore.getState().toggleDirectory('empty');
    assert.equal(useFileStore.getState().expandedDirs.has('empty'), true, 'loaded empty folders should still expand');
    assert.deepEqual(calls, [], 'loaded empty folders should not fetch again');

    delayDocsFetch = false;
    calls.length = 0;
    callDetails.length = 0;

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
    assert.deepEqual(
      callDetails.map((call) => [call.path, call.depth, call.stats]),
      [
        ['.', '0', '0'],
        ['docs', '0', '0'],
        ['src', '0', '0'],
        ['src/app', '0', '0'],
      ],
      'visible refresh should load only direct children via the fast tree path',
    );

    const state = useFileStore.getState();
    const docs = state.fileTree.find((node) => node.path === 'docs');
    const src = state.fileTree.find((node) => node.path === 'src');
    const app = src?.children?.find((node) => node.path === 'src/app');

    assert.equal(docs?.children?.[0]?.path, 'docs/fresh.md');
    assert.equal(app?.children?.[0]?.path, 'src/app/page.tsx');

    calls.length = 0;
    callDetails.length = 0;
    useFileStore.setState({
      fileTree: [{
        name: 'docs',
        path: 'docs',
        type: 'directory',
        children: [{ name: 'stale-after-refresh.md', path: 'docs/stale-after-refresh.md', type: 'file' }],
      }],
      browserMode: 'tree',
      currentDirectory: '.',
      expandedDirs: new Set<string>(),
      loadingDirs: new Set<string>(),
    });

    await useFileStore.getState().refreshVisibleTree();
    const collapsedDocs = useFileStore.getState().fileTree.find((node) => node.path === 'docs');
    assert.equal(collapsedDocs?.children, undefined, 'manual refresh must mark collapsed directory children stale');

    useFileStore.getState().toggleDirectory('docs');
    await waitFor(() => !useFileStore.getState().loadingDirs.has('docs'), 'opening a stale directory should refresh it');
    assert.deepEqual(calls, ['.', 'docs'], 'opening a stale directory must fetch fresh children after refresh');
    assert.equal(useFileStore.getState().fileTree.find((node) => node.path === 'docs')?.children?.[0]?.path, 'docs/fresh.md');

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

    const expandedFolder: FileNode = {
      name: '00_dashboard',
      path: 'files/00_dashboard',
      type: 'directory',
      children: [
        { name: 'daily.html', path: 'files/00_dashboard/daily.html', type: 'file' },
        { name: 'daily.md', path: 'files/00_dashboard/daily.md', type: 'file' },
      ],
    };
    const siblingFolder: FileNode = {
      name: '01_brand',
      path: 'files/01_brand',
      type: 'directory',
    };
    const siblingFile: FileNode = {
      name: '00_readme-first.md',
      path: 'files/00_readme-first.md',
      type: 'file',
    };
    const siblingOrder = [expandedFolder.path, siblingFolder.path, siblingFile.path];
    useFileStore.setState({
      fileTree: [expandedFolder, siblingFolder, siblingFile],
      selectedNode: null,
      isMultiSelectMode: false,
      multiSelectPaths: new Set<string>(),
      lastSelectedPath: null,
    });

    useFileStore.getState().selectNode(expandedFolder, false, false, siblingOrder, true);
    useFileStore.getState().selectNode(siblingFile, false, true, siblingOrder, true);
    assert.deepEqual(
      Array.from(useFileStore.getState().multiSelectPaths),
      siblingOrder,
      'tree shift selection should stay on the anchor directory level',
    );
    assert.equal(
      useFileStore.getState().multiSelectPaths.has('files/00_dashboard/daily.html'),
      false,
      'tree shift selection must not include expanded descendants',
    );

    useFileStore.setState({
      selectedNode: null,
      isMultiSelectMode: false,
      multiSelectPaths: new Set<string>(),
      lastSelectedPath: expandedFolder.path,
    });
    const childTarget = expandedFolder.children?.[1];
    assert.ok(childTarget);
    useFileStore.getState().selectNode(
      childTarget,
      false,
      true,
      expandedFolder.children?.map((node) => node.path),
      true,
    );
    assert.deepEqual(
      Array.from(useFileStore.getState().multiSelectPaths),
      [expandedFolder.path, childTarget.path],
      'cross-level shift selection should add only the explicit target',
    );

    const selectedDirectory: FileNode = { name: 'docs', path: 'docs', type: 'directory' };
    useFileStore.setState({ currentDirectory: '.', selectedNode: null, isMultiSelectMode: false });
    useFileStore.getState().selectNode(selectedDirectory, false, false, undefined, true);
    assert.equal(useFileStore.getState().selectedNode?.path, 'docs');
    assert.equal(
      useFileStore.getState().currentDirectory,
      '.',
      'desktop selection should not navigate into a directory before it is opened',
    );

    calls.length = 0;
    callDetails.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/files/copy') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { sources?: string[] };
        assert.deepEqual(
          body.sources,
          ['docs'],
          'paste should compact nested clipboard paths before copy',
        );
        return Response.json({
          success: true,
          copied: ['dest/docs'],
          failed: [{ path: 'missing.txt', error: 'Missing file' }],
          skipped: [],
        });
      }

      const path = url.searchParams.get('path') || '.';
      (calls as string[]).push(path);
      callDetails.push({
        path,
        depth: url.searchParams.get('depth'),
        stats: url.searchParams.get('stats'),
      });
      return Response.json({ success: true, data: responses[path] ?? [] });
    }) as typeof fetch;

    useFileStore.setState({
      clipboardMode: 'copy',
      clipboardPaths: new Set(['docs', 'docs/fresh.md']),
    });

    const pasteResult = await useFileStore.getState().pastePaths('dest');
    assert.equal(pasteResult?.copied.length, 1);
    assert.equal(pasteResult?.failed.length, 1);
    assert.deepEqual(calls, ['dest'], 'paste should refresh the destination after copied items');

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
