import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import type { FileNode } from '../app/lib/files/types';

async function main() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test' });
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'HTMLInputElement', 'Event'] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  let releaseOld!: (value: FileNode[]) => void;
  const oldRoot = new Promise<FileNode[]>((resolve) => { releaseOld = resolve; });
  const treeRequests: Array<{ directory: string; depth: number; workspaceId: string }> = [];
  const searchRequests: Array<{ query: string; workspaceId: string; cursor: string | null; extensions: string[] }> = [];
  const mocks: Record<string, unknown> = {
    '@/app/lib/files/client': {
      WorkspaceFileApiError: class extends Error {},
      loadWorkspaceTree: async (directory: string, depth: number, _noCache: boolean, _message: string, workspaceId: string) => {
        treeRequests.push({ directory, depth, workspaceId });
        if (workspaceId === 'old') return oldRoot;
        const prefix = directory === '.' ? '' : `${directory}/`;
        return [{ name: 'next', path: `${prefix}next`, type: 'directory' }];
      },
      searchWorkspaceFileReferences: async (options: typeof searchRequests[number]) => {
        searchRequests.push(options);
        const name = options.cursor ? 'later.png' : `${options.query}.png`;
        return { files: [{ path: `deep/${name}`, name, type: 'file', isImage: true }],
          total: 2, nextCursor: options.cursor ? null : 'page-two' };
      },
    },
  };
  const compile = async (relativePath: string) => {
    const file = path.resolve(relativePath);
    const native = createRequire(file);
    const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const exported: Record<string, unknown> = {};
    new Function('require', 'module', 'exports', source)((name: string) => mocks[name] ?? native(name), { exports: exported }, exported);
    return exported;
  };
  const { useWorkspaceDirectoryTree } = await compile('app/components/file-browser/useWorkspaceDirectoryTree.ts') as
    typeof import('../app/components/file-browser/useWorkspaceDirectoryTree');
  const { useWorkspaceFileSearch } = await compile('app/components/file-browser/useWorkspaceFileSearch.ts') as
    typeof import('../app/components/file-browser/useWorkspaceFileSearch');
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  function Probe() {
    const [workspaceId, setWorkspaceId] = useState('old');
    const [query, setQuery] = useState('');
    const directory = useWorkspaceDirectoryTree(workspaceId, true);
    const search = useWorkspaceFileSearch({ workspaceId, query, enabled: Boolean(query), extensions: ['png'], limit: 1 });
    const nodes = (items: FileNode[]): React.ReactNode => items.map((node) => <div key={node.path}>
      <button onClick={() => void directory.loadDirectory(node.path)}>{node.path}</button>
      {node.children ? nodes(node.children) : null}
    </div>);
    return <><button onClick={() => setWorkspaceId('current')}>Switch workspace</button>
      <input aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
      <output data-testid="workspace">{workspaceId}</output>
      <output data-testid="tree">{JSON.stringify(directory.tree)}</output>
      {nodes(directory.tree)}
      <output data-testid="results">{search.results.map((file) => file.path).join(',')}</output>
      <output data-testid="count">{search.results.length}/{search.total}</output>
      <button onClick={search.loadMore} disabled={!search.hasMore || search.isLoadingMore}>Load more</button>
    </>;
  }
  try {
    const ui = render(<Probe />);
    await waitFor(() => assert.ok(treeRequests.some((request) => request.workspaceId === 'old')));
    await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Switch workspace' })));
    await waitFor(() => assert.match(ui.getByTestId('tree').textContent || '', /next/));
    await act(async () => releaseOld([{ name: 'stale', path: 'stale', type: 'directory' }]));
    assert.doesNotMatch(ui.getByTestId('tree').textContent || '', /stale/);
    let directory = 'next';
    for (let level = 0; level < 18; level += 1) {
      await act(async () => fireEvent.click(ui.getByRole('button', { name: directory, exact: true })));
      directory += '/next';
      await waitFor(() => assert.ok(ui.queryByRole('button', { name: directory, exact: true })));
    }
    assert.ok(treeRequests.every((request) => request.depth === 0));
    await act(async () => fireEvent.change(ui.getByLabelText('Search'), { target: { value: 'Terra' } }));
    await waitFor(() => assert.equal(ui.getByTestId('count').textContent, '1/2'));
    assert.deepEqual(searchRequests[0].extensions, ['png']);
    assert.equal(searchRequests[0].workspaceId, 'current');
    await act(async () => fireEvent.click(ui.getByRole('button', { name: 'Load more' })));
    await waitFor(() => assert.equal(ui.getByTestId('count').textContent, '2/2'));
    assert.equal(searchRequests[1].cursor, 'page-two');
    assert.match(ui.getByTestId('results').textContent || '', /later.png/);
    await act(async () => fireEvent.change(ui.getByLabelText('Search'), { target: { value: 'new-query' } }));
    assert.doesNotMatch(ui.getByTestId('results').textContent || '', /Terra|later/);
    await waitFor(() => assert.match(ui.getByTestId('results').textContent || '', /new-query.png/));
    console.log('workspace-file-discovery-ui-test: shallow navigation through 18 levels, late workspace response, scoped media search, pagination and query reset passed');
  } finally {
    cleanup();
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
