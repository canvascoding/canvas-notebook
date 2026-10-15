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
  const searchRequests: Array<{ query: string; workspaceId: string; cursor: string | null; extensions: string[]; entryType?: string }> = [];
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
        if (options.entryType === 'directory') return { files: [{ path: `deep/${options.query}`, name: options.query, type: 'directory' }], total: 1, nextCursor: null };
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
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
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
    cleanup();
    const block = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
    const collapseContext = React.createContext({ open: false, onOpenChange: (_open: boolean) => {} });
    mocks['next-intl'] = { useTranslations: () => (key: string) => key };
    mocks['lucide-react'] = new Proxy({}, { get: () => () => null });
    mocks['@/lib/utils'] = { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') };
    mocks['@/components/ui/dialog'] = { Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div role="dialog">{children}</div> : null,
      DialogContent: block, DialogDescription: block, DialogFooter: block, DialogHeader: block, DialogTitle: block };
    mocks['@/components/ui/button'] = { Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button> };
    mocks['@/components/ui/input'] = { Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> };
    mocks['@/components/ui/collapsible'] = {
      Collapsible: ({ children, open, onOpenChange }: { children: React.ReactNode; open: boolean; onOpenChange: (value: boolean) => void }) =>
        <collapseContext.Provider value={{ open, onOpenChange }}>{children}</collapseContext.Provider>,
      CollapsibleTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
        const state = React.useContext(collapseContext);
        return <button {...props} onClick={() => state.onOpenChange(!state.open)}>{children}</button>;
      },
      CollapsibleContent: block,
    };
    mocks['@/app/components/file-browser/useWorkspaceDirectoryTree'] = { useWorkspaceDirectoryTree };
    mocks['@/app/components/file-browser/useWorkspaceFileSearch'] = { useWorkspaceFileSearch };
    mocks['@/app/components/file-browser/WorkspaceSearchPagination'] = { WorkspaceSearchPagination: () => null };
    const { WorkspaceDirectoryPickerDialog } = await compile('app/apps/automations/components/WorkspaceDirectoryPickerDialog.tsx') as
      typeof import('../app/apps/automations/components/WorkspaceDirectoryPickerDialog');
    let selectedPath = '';
    let closed = false;
    const automation = render(<WorkspaceDirectoryPickerDialog open workspaceId="current"
      onOpenChange={(open) => { closed = !open; }} onSelect={(selected) => { selectedPath = selected; }} />);
    await act(async () => fireEvent.change(automation.getByPlaceholderText('searchPlaceholder'), { target: { value: 'empty' } }));
    await waitFor(() => assert.ok(automation.queryByTestId('automation-directory-option-deep-empty')));
    await act(async () => fireEvent.click(automation.getByTestId('automation-directory-option-deep-empty')));
    await act(async () => fireEvent.click(automation.getByTestId('automation-directory-picker-confirm')));
    assert.equal(selectedPath, 'deep/empty');
    assert.equal(closed, true);
    console.log('automation directory picker: global directory search and empty-folder selection passed');
    cleanup();
    mocks['@/app/store/workspace-store'] = { useWorkspaceStore: (selector: (state: { activeWorkspaceId: string }) => unknown) => selector({ activeWorkspaceId: 'current' }) };
    mocks['@/app/components/shared/ImageThumbnailIcon'] = { ImageThumbnailIcon: () => null };
    mocks['@/components/ui/badge'] = { Badge: block };
    mocks['@/components/ui/switch'] = { Switch: () => null };
    mocks['@/components/ui/tabs'] = { Tabs: block, TabsList: block, TabsTrigger: block,
      TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => value === 'workspace' ? <div>{children}</div> : null };
    mocks['./useEmailAttachmentPreview'] = { useEmailAttachmentPreview: () => ({ dialog: null, canOpen: true, openLabel: (name: string) => name, openAttachment: () => {} }) };
    mocks['@/app/components/file-browser/WorkspaceSearchPagination'] = { WorkspaceSearchPagination: ({ hasMore, onLoadMore }: { hasMore: boolean; onLoadMore: () => void }) =>
      hasMore ? <button onClick={onLoadMore}>Next page</button> : null };
    const { EmailAttachmentPanel } = await compile('app/apps/email/components/EmailAttachmentPanel.tsx') as
      typeof import('../app/apps/email/components/EmailAttachmentPanel');
    const labels = new Proxy({}, { get: (_target, key) => String(key) }) as React.ComponentProps<typeof EmailAttachmentPanel>['labels'];
    let selectedAttachments: Array<{ path?: string }> = [];
    const email = render(<EmailAttachmentPanel workspaceId="current" attachments={[]} labels={labels}
      onChange={(attachments) => { selectedAttachments = attachments; }} />);
    await act(async () => fireEvent.click(email.getByRole('button', { name: 'attachmentsAdd', exact: true })));
    await act(async () => fireEvent.change(email.getByPlaceholderText('attachmentsSearchPlaceholder'), { target: { value: 'needle' } }));
    await waitFor(() => assert.ok(email.queryByRole('button', { name: /needle/ })));
    await act(async () => fireEvent.click(email.getByRole('button', { name: 'Next page', exact: true })));
    await waitFor(() => assert.ok(email.queryByRole('button', { name: /later/ })));
    await act(async () => fireEvent.click(email.getByRole('button', { name: /later/ })));
    await act(async () => fireEvent.click(email.getByRole('button', { name: 'attachmentsConfirm', exact: true })));
    assert.deepEqual(selectedAttachments.map((attachment) => attachment.path), ['deep/later.png']);
    console.log('email attachment panel: search pagination and selecting a file from a later page passed');
  } finally {
    cleanup();
    dom.window.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
