import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import * as React from 'react';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

import type { FileNode } from '../app/lib/files/types';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type * as CreationUi from '../app/components/file-browser/FolderCreationControl';
import type * as DestinationUi from '../app/components/file-browser/DirectoryDestinationPicker';
import type * as WorkspaceUi from '../app/components/workspaces/WorkspaceDestinationPicker';

const workspace = (id: string, canWrite = true): ClientWorkspaceSummary => ({
  id, name: id, type: 'personal', status: 'active', color: '#475569',
  permissions: { canRead: true, canWrite, canDelete: canWrite, canCreatePublicLinks: false,
    canManageWorkspace: false, canRunAgent: false },
});
const directory = (name: string, children: FileNode[] = []): FileNode => ({ name, path: name, type: 'directory', children });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

class ClientError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

async function compileUi() {
  const controls = {
    activeWorkspaceId: 'active',
    workspaces: [workspace('active'), workspace('foreign'), workspace('readonly', false)],
    createCalls: [] as Array<{ path: string; type: string; workspaceId: string | null | undefined }>,
    refreshCalls: [] as Array<[string, boolean | undefined, string | null | undefined]>,
    treeCalls: [] as Array<[string, string | null | undefined]>,
    directoryErrors: {} as Record<string, string>,
    create: async () => undefined as void,
    refresh: async () => undefined as void,
    loadTree: async (_dir: string, _workspaceId?: string | null) => [directory('Projects')] as FileNode[],
  };
  const hydrateWorkspaces = async () => undefined;
  const state = () => ({ activeWorkspaceId: controls.activeWorkspaceId, workspaces: controls.workspaces, hydrateWorkspaces });
  const useWorkspaceStore = Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()),
    { getState: state });
  const fileState = {
    loadingDirs: new Set<string>(),
    directoryErrors: controls.directoryErrors,
    loadSubdirectory: async () => undefined,
    refreshDirectory: async (dir: string, noCache?: boolean, workspaceId?: string | null) => {
      controls.refreshCalls.push([dir, noCache, workspaceId]);
      await controls.refresh();
    },
  };
  const useFileStore = Object.assign((selector: (value: typeof fileState) => unknown) => selector(fileState),
    { getState: () => fileState });
  const translators = new Map<string, (key: string, values?: Record<string, string>) => string>();
  const useTranslations = (namespace: string) => {
    if (!translators.has(namespace)) translators.set(namespace, (key, values) =>
      values?.name ? `${key}:${values.name}` : values?.path ? `${key}:${values.path}` : key);
    return translators.get(namespace)!;
  };
  const icon = () => null;
  const mocks: Record<string, unknown> = {
    'lucide-react': new Proxy({}, { get: () => icon }),
    'next-intl': { useTranslations },
    'zustand/react/shallow': { useShallow: (selector: unknown) => selector },
    '@/lib/utils': { cn: (...values: Array<string | undefined>) => values.filter(Boolean).join(' ') },
    '@/components/ui/button': { Button: React.forwardRef<HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }>(
      function TestButton({ children, variant: _variant, size: _size, ...props }, ref) {
        return <button {...props} ref={ref}>{children}</button>;
      }) },
    '@/components/ui/input': { Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
      function TestInput(props, ref) { return <input {...props} ref={ref} />; }) },
    '@/app/store/workspace-store': {
      useWorkspaceStore,
      selectActiveWorkspace: (value: ReturnType<typeof state>) =>
        value.workspaces.find((item) => item.id === value.activeWorkspaceId),
    },
    '@/app/store/file-store': { useFileStore },
    '@/app/lib/files/client': {
      WorkspaceFileApiError: ClientError,
      createWorkspacePath: async (createdPath: string, type: string, options: { workspaceId?: string | null }) => {
        controls.createCalls.push({ path: createdPath, type, workspaceId: options.workspaceId });
        await controls.create();
      },
      loadWorkspaceTree: async (dir: string, _depth: number, _noCache: boolean, _fallback: string, workspaceId?: string | null) => {
        controls.treeCalls.push([dir, workspaceId]);
        return controls.loadTree(dir, workspaceId);
      },
    },
    '@/app/components/workspaces/workspace-utils': { getWorkspaceKindLabel: () => 'personal' },
  };
  const compile = async (relativePath: string) => {
    const filename = path.resolve(relativePath);
    const load = createRequire(filename);
    const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const exports: Record<string, unknown> = {};
    new Function('require', 'module', 'exports', source)(
      (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
    return exports;
  };
  mocks['@/app/lib/files/path-utils'] = await compile('app/lib/files/path-utils.ts');
  mocks['@/app/lib/files/directory-picker-tree'] = await compile('app/lib/files/directory-picker-tree.ts');
  const creation = await compile('app/components/file-browser/FolderCreationControl.tsx') as typeof CreationUi;
  mocks['./FolderCreationControl'] = creation;
  const browser = await compile('app/components/file-browser/DirectoryBrowser.tsx');
  mocks['./DirectoryBrowser'] = browser;
  mocks['@/app/components/file-browser/DirectoryBrowser'] = browser;
  const destination = await compile('app/components/file-browser/DirectoryDestinationPicker.tsx') as typeof DestinationUi;
  mocks['@/app/components/file-browser/DirectoryDestinationPicker'] = destination;
  const target = await compile('app/components/workspaces/WorkspaceDestinationPicker.tsx') as typeof WorkspaceUi;
  return { controls, ...creation, ...destination, ...target };
}

async function withMountedUi(run: (fixture: {
  ui: Awaited<ReturnType<typeof compileUi>>;
  render: (element: React.ReactNode) => Promise<void>;
  flush: () => Promise<void>;
  fireEvent: typeof import('@testing-library/react')['fireEvent'];
  button: (name: string) => HTMLButtonElement;
  input: () => HTMLInputElement;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  const globalNames = ['window', 'document', 'Node', 'HTMLElement', 'HTMLInputElement', 'KeyboardEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = globalNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of globalNames) Object.defineProperty(globalThis, name, {
    configurable: true, writable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name],
  });
  const { createRoot } = await import('react-dom/client');
  const { fireEvent } = await import('@testing-library/react');
  const root = createRoot(document.getElementById('root')!);
  const button = (name: string) => {
    const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name);
    assert.ok(value, `button ${name} is visible`);
    return value;
  };
  const input = () => {
    const value = document.querySelector<HTMLInputElement>('input');
    assert.ok(value, 'folder name input is visible');
    return value;
  };
  const flush = async () => {
    for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  };
  try {
    await run({ ui: await compileUi(), button, input, flush, fireEvent,
      render: async (element) => { await act(async () => root.render(element)); } });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalNames.forEach((name, index) => {
      if (prior[index]) Object.defineProperty(globalThis, name, prior[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

test('folder creation validates one name, preserves conflicts, and keeps Enter and Escape inside the outer dialog', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    let submissions = 0;
    let escapedDialog = 0;
    const requests: Array<[string, string]> = [];
    const busy: boolean[] = [];
    let result: () => Promise<string | null> = async () => { throw new ClientError('PATH_EXISTS', 409); };
    const captureEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') escapedDialog += 1; };
    document.addEventListener('keydown', captureEscape, true);
    await render(<form onSubmit={(event) => { event.preventDefault(); submissions += 1; }}
      onKeyDown={(event) => { if (event.key === 'Enter') submissions += 1; }}>
      <ui.FolderCreationControl parentPath="Projects" onCreatingDirectoryChange={(value) => busy.push(value)}
        onCreateDirectory={async (parent, name) => { requests.push([parent, name]); return result(); }} />
      <button type="submit">Save outer dialog</button>
    </form>);
    await act(async () => button('newDestinationFolder').click());
    assert.equal(document.activeElement, input(), 'editing focuses its accessible name input');
    for (const invalid of ['', '.', '..', 'a/b', 'a\\b']) {
      await act(async () => { fireEvent.change(input(), { target: { value: invalid } }); button('createFolder').click(); });
      assert.equal(document.querySelector('[role="alert"]')?.textContent, 'folderInvalidName');
    }
    assert.deepEqual(requests, [], 'invalid names never request a filesystem mutation');
    await act(async () => {
      fireEvent.change(input(), { target: { value: '  Reports  ' } });
      assert.equal(fireEvent.keyDown(input(), { key: 'Enter' }), false, 'Enter prevents form default');
    });
    await flush();
    assert.deepEqual(requests, [['Projects', 'Reports']]);
    assert.equal(submissions, 0, 'folder creation does not submit or trigger the outer dialog');
    assert.equal(input().value, '  Reports  ', 'conflicting name stays available for correction');
    assert.equal(input().getAttribute('aria-invalid'), 'true');
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'folderAlreadyExists');
    assert.deepEqual(busy, [true, false]);

    const pending = deferred<string | null>();
    result = () => pending.promise;
    await act(async () => { fireEvent.change(input(), { target: { value: 'Archive' } }); button('createFolder').click(); });
    assert.equal(input().disabled, true);
    await act(async () => { fireEvent.keyDown(input(), { key: 'Enter' }); fireEvent.keyDown(input(), { key: 'Escape' }); });
    assert.equal(requests.length, 2, 'pending creation rejects duplicate Enter requests');
    assert.equal(escapedDialog, 0, 'Escape is intercepted before document dialog capture');
    assert.ok(document.querySelector('input'), 'Escape cannot discard an in-flight folder creation');
    await act(async () => pending.resolve('Projects/Archive'));
    await flush();
    assert.equal(document.querySelector('input'), null);
    assert.equal(document.activeElement, button('newDestinationFolder'), 'success returns focus to the creation trigger');
    await act(async () => button('newDestinationFolder').click());
    await act(async () => {
      fireEvent.change(input(), { target: { value: 'MustNotBeCreated' } });
      assert.equal(fireEvent.keyDown(button('cancel'), { key: 'Enter' }), true, 'Enter on Cancel retains native button activation');
    });
    assert.equal(requests.length, 2, 'Enter on Cancel never creates a directory');
    assert.equal(submissions, 0, 'button keyboard interaction stays within the folder control');
    await act(async () => button('cancel').click());
    assert.equal(document.querySelector('input'), null, 'native Cancel activation discards the folder draft');
    await act(async () => button('newDestinationFolder').click());
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    assert.equal(document.querySelector('input'), null, 'Escape cancels just the folder draft');
    assert.equal(escapedDialog, 0);
    document.removeEventListener('keydown', captureEscape, true);
  });
});

test('the active workspace picker creates a nested folder, refreshes its parent, expands and selects the confirmed directory', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const selections: string[] = [];
    const tree = [directory('Projects')];
    function Picker() {
      const [selectedPath, setSelectedPath] = React.useState('Projects');
      const [expandedDirs, setExpandedDirs] = React.useState(new Set<string>());
      return <ui.DirectoryDestinationPicker tree={tree} selectedPath={selectedPath} expandedDirs={expandedDirs}
        onSelect={(value) => { selections.push(value); setSelectedPath(value); }}
        onToggleDir={(value) => setExpandedDirs((current) => new Set(current).add(value))} />;
    }
    await render(<Picker />);
    await act(async () => button('newDestinationFolder').click());
    await act(async () => { fireEvent.change(input(), { target: { value: 'Reports' } }); button('createFolder').click(); });
    await flush();
    assert.deepEqual(ui.controls.createCalls, [{ path: 'Projects/Reports', type: 'directory', workspaceId: 'active' }]);
    assert.deepEqual(ui.controls.refreshCalls, [['Projects', true, 'active']]);
    assert.deepEqual(selections, ['Projects/Reports']);
    assert.equal(document.querySelector('[title="Projects/Reports"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('[aria-label="collapseFolder:Projects"]')?.getAttribute('aria-expanded'), 'true');
  });
});

test('a foreign destination uses its explicit workspace and remains usable when its tree refresh fails', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const selected: string[] = [];
    const created: Array<[string, string, string]> = [];
    await render(<ui.DirectoryDestinationPicker workspaceId="foreign" tree={[directory('Projects')]}
      selectedPath="Projects" expandedDirs={new Set(['Projects'])} onToggleDir={() => undefined}
      onSelect={(value) => selected.push(value)} onDirectoryCreated={async (...args) => {
        created.push(args); throw new Error('tree unavailable');
      }} />);
    await act(async () => button('newDestinationFolder').click());
    await act(async () => { fireEvent.change(input(), { target: { value: 'Reports' } }); button('createFolder').click(); });
    await flush();
    assert.deepEqual(ui.controls.createCalls, [{ path: 'Projects/Reports', type: 'directory', workspaceId: 'foreign' }]);
    assert.deepEqual(created, [['Projects/Reports', 'Projects', 'foreign']]);
    assert.deepEqual(ui.controls.refreshCalls, [], 'foreign destination does not refresh the active workspace store');
    assert.deepEqual(selected, ['Projects/Reports'], 'successful creation survives only a refresh failure');
    assert.ok(document.querySelector('[title="Projects/Reports"]'), 'the confirmed folder is visible without a refreshed snapshot');
    assert.equal(document.querySelector('[role="status"]')?.textContent, 'destinationFolderRefreshFailed');
  });
});

test('permission and move destination restrictions prevent folder creation, and workspace changes discard late selection', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const selections: string[] = [];
    const props = { tree: [directory('Projects')], selectedPath: 'Projects', expandedDirs: new Set<string>(),
      onToggleDir: () => undefined, onSelect: (value: string) => selections.push(value) };
    await render(<ui.DirectoryDestinationPicker {...props} workspaceId="readonly" />);
    assert.equal([...document.querySelectorAll('button')].some((item) => item.textContent === 'newDestinationFolder'), false);
    await render(<ui.DirectoryDestinationPicker {...props} workspaceId="active" isDirectoryDisabled={(value) => value === 'Projects'} />);
    assert.equal(button('newDestinationFolder').disabled, true, 'a forbidden move parent cannot gain a destination folder');
    assert.equal(document.querySelector<HTMLButtonElement>('[title="Projects"]')?.disabled, true);

    const pending = deferred<void>();
    ui.controls.create = () => pending.promise;
    await render(<ui.DirectoryDestinationPicker {...props} workspaceId="active" />);
    await act(async () => button('newDestinationFolder').click());
    await act(async () => { fireEvent.change(input(), { target: { value: 'Reports' } }); button('createFolder').click(); });
    await render(<ui.DirectoryDestinationPicker {...props} workspaceId="foreign" />);
    await act(async () => pending.resolve());
    await flush();
    assert.deepEqual(selections, [], 'a response from the old workspace does not select a folder in the new workspace');
    assert.deepEqual(ui.controls.refreshCalls, [], 'a response after scoped picker unmount does not refresh its former parent');
    assert.equal(document.querySelector('[title="Projects/Reports"]'), null);
  });
});

test('the workspace destination picker refreshes and selects a foreign folder while blocking target changes during creation', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const pending = deferred<void>();
    ui.controls.create = () => pending.promise;
    ui.controls.loadTree = async (dir) => dir === '.' ? [directory('Projects')] : [];
    const busy: boolean[] = [];
    const selected: string[] = [];
    function Picker() {
      const [workspaceId, setWorkspaceId] = React.useState<string | null>('foreign');
      const [selectedDir, setSelectedDir] = React.useState('Projects');
      return <ui.WorkspaceDestinationPicker selectedWorkspaceId={workspaceId} selectedDir={selectedDir}
        onWorkspaceChange={setWorkspaceId} onDirChange={(dir) => { selected.push(dir); setSelectedDir(dir); }}
        onCreatingDirectoryChange={(value) => busy.push(value)} />;
    }
    await render(<Picker />);
    await flush();
    assert.deepEqual(ui.controls.treeCalls, [['.', 'foreign']]);
    assert.deepEqual([...document.querySelectorAll('option')].map((item) => item.value), ['active', 'foreign'],
      'the target selector excludes read-only workspaces');
    await act(async () => button('newDestinationFolder').click());
    await act(async () => { fireEvent.change(input(), { target: { value: 'Reports' } }); button('createFolder').click(); });
    assert.equal(document.querySelector<HTMLSelectElement>('select')?.disabled, true);
    assert.equal(document.querySelector<HTMLButtonElement>('[title="Projects"]')?.disabled, true);
    await act(async () => pending.resolve());
    await flush();
    assert.deepEqual(ui.controls.createCalls, [{ path: 'Projects/Reports', type: 'directory', workspaceId: 'foreign' }]);
    assert.deepEqual(ui.controls.treeCalls, [['.', 'foreign'], ['Projects', 'foreign']]);
    assert.deepEqual(ui.controls.refreshCalls, [], 'the foreign workspace maintains its own destination tree');
    assert.deepEqual(selected, ['Projects/Reports']);
    assert.deepEqual(busy, [true, false]);
    assert.equal(document.querySelector('[title="Projects/Reports"]')?.getAttribute('aria-pressed'), 'true',
      'a stale empty snapshot still retains the confirmed folder');
    assert.equal(document.querySelector<HTMLSelectElement>('select')?.disabled, false);
  });
});

test('a late foreign tree refresh cannot select or insert a folder after its destination workspace changes', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const pendingTree = deferred<FileNode[]>();
    ui.controls.loadTree = async (dir) => dir === '.' ? [directory('Projects')] : pendingTree.promise;
    const selections: string[] = [];
    const props = { onWorkspaceChange: () => undefined, onDirChange: (dir: string) => selections.push(dir) };
    await render(<ui.WorkspaceDestinationPicker {...props} selectedWorkspaceId="foreign" selectedDir="Projects" />);
    await flush();
    await act(async () => button('newDestinationFolder').click());
    await act(async () => { fireEvent.change(input(), { target: { value: 'Reports' } }); button('createFolder').click(); });
    assert.deepEqual(ui.controls.treeCalls, [['.', 'foreign'], ['Projects', 'foreign']]);
    await render(<ui.WorkspaceDestinationPicker {...props} selectedWorkspaceId="active" selectedDir="." />);
    await flush();
    await act(async () => pendingTree.resolve([{ name: 'Reports', path: 'Projects/Reports', type: 'directory' }]));
    await flush();
    assert.deepEqual(selections, [], 'the scoped operation does not select its old workspace folder');
    assert.equal(document.querySelector('[title="Projects/Reports"]'), null, 'the old tree snapshot does not enter the new workspace');
    assert.equal(document.querySelector<HTMLSelectElement>('select')?.value, 'active');
    assert.equal(button('newDestinationFolder').disabled, false, 'the current workspace has no stale busy state');
  });
});

test('losing destination write permission during creation prevents subsequent refresh and selection', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const pending = deferred<void>();
    ui.controls.create = () => pending.promise;
    const selected: string[] = [];
    const props = { tree: [directory('Projects')], selectedPath: 'Projects', expandedDirs: new Set<string>(),
      onToggleDir: () => undefined, onSelect: (value: string) => selected.push(value), workspaceId: 'active' };
    await render(<ui.DirectoryDestinationPicker {...props} />);
    await act(async () => button('newDestinationFolder').click());
    await act(async () => { fireEvent.change(input(), { target: { value: 'Reports' } }); button('createFolder').click(); });
    ui.controls.workspaces = [workspace('active', false), workspace('foreign')];
    await render(<ui.DirectoryDestinationPicker {...props} />);
    await act(async () => pending.resolve());
    await flush();
    assert.deepEqual(ui.controls.refreshCalls, []);
    assert.deepEqual(selected, []);
    assert.equal(document.querySelector('[title="Projects/Reports"]'), null);
    assert.equal(document.querySelector('input'), null, 'the permission change closes the folder editor');
  });
});

test('an empty destination supports creation at root followed by a subfolder inside the selected new folder', async () => {
  await withMountedUi(async ({ ui, render, button, input, fireEvent, flush }) => {
    const tree: FileNode[] = [];
    function Picker() {
      const [selectedPath, setSelectedPath] = React.useState('.');
      const [expandedDirs, setExpandedDirs] = React.useState(new Set<string>());
      return <ui.DirectoryDestinationPicker tree={tree} selectedPath={selectedPath} expandedDirs={expandedDirs}
        onSelect={setSelectedPath} onToggleDir={(value) => setExpandedDirs((current) => new Set(current).add(value))} />;
    }
    await render(<Picker />);
    for (const name of ['Notes', '2026']) {
      await act(async () => button('newDestinationFolder').click());
      await act(async () => { fireEvent.change(input(), { target: { value: name } }); button('createFolder').click(); });
      await flush();
    }
    assert.deepEqual(ui.controls.createCalls, [
      { path: 'Notes', type: 'directory', workspaceId: 'active' },
      { path: 'Notes/2026', type: 'directory', workspaceId: 'active' },
    ]);
    assert.deepEqual(ui.controls.refreshCalls, [['.', true, 'active'], ['Notes', true, 'active']]);
    assert.equal(document.querySelector('[title="Notes/2026"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('[aria-label="collapseFolder:Notes"]')?.getAttribute('aria-expanded'), 'true');
  });
});

test('a fixed workspace destination never falls back to an unrelated writable workspace after access changes', async () => {
  await withMountedUi(async ({ ui, render, button, flush }) => {
    const changed: string[] = [];
    const selected: string[] = [];
    const props = { allowWorkspaceChange: false, selectedWorkspaceId: 'foreign', selectedDir: '.',
      onWorkspaceChange: (value: string) => changed.push(value), onDirChange: (value: string) => selected.push(value) };
    await render(<ui.WorkspaceDestinationPicker {...props} />);
    await flush();
    assert.equal(document.querySelector('select'), null, 'fixed destination hides the workspace chooser');
    assert.equal(button('newDestinationFolder').disabled, false);
    assert.deepEqual(ui.controls.treeCalls, [['.', 'foreign']]);
    ui.controls.workspaces = [workspace('active'), workspace('foreign', false)];
    await render(<ui.WorkspaceDestinationPicker {...props} />);
    await flush();
    assert.match(document.body.textContent ?? '', /noWritableWorkspace/u);
    assert.equal([...document.querySelectorAll('button')].some((item) => item.textContent === 'newDestinationFolder'), false);
    assert.deepEqual(changed, [], 'access loss does not change the fixed workspace');
    assert.deepEqual(selected, [], 'access loss does not reset or choose a directory in another workspace');
    assert.deepEqual(ui.controls.treeCalls, [['.', 'foreign']], 'access loss does not load the active workspace tree');
  });
});
