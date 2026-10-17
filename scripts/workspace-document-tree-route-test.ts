import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import type { FileNode } from '../app/lib/files/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceDocumentTreeDependencies, WorkspaceDocumentTreeOptions } from '../app/lib/files/workspace-document-tree';
import { buildFileTreeCacheKey } from '../app/lib/utils/file-tree-cache';

type TreeModule = typeof import('../app/lib/files/workspace-document-tree');
type RouteModule = { GET(request: NextRequest): Promise<Response> };

/** Caller contract only: real compiled handlers and error class, mocked read,
 * authentication, annotation and cache boundaries. This does not prove SQL,
 * filesystem, native-catalogue or lifecycle-fence behavior. */
async function compile<T>(file: string, mocks: Record<string, unknown>, errors: unknown[][] = []): Promise<T> {
  const filename = path.resolve(file), load = createRequire(filename), exports = {};
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', 'console', compiled)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
    { ...console, error: (...values: unknown[]) => errors.push(values) },
  );
  return exports as T;
}

async function fixture() {
  const { WorkspaceDocumentTreeError } = await compile<TreeModule>('app/lib/files/workspace-document-tree.ts', {
    'server-only': {},
    '../collaboration/workspace-native-file-read': { withNativeWorkspaceFilesRead: () => { throw new Error('No native/SQL read is allowed in the route fixture.'); } },
    '../collaboration/room-admission-contract': {},
    '../filesystem/workspace-files': {},
    '../workspaces/path-guard': {},
    './internal-staging-path': {},
  });
  const workspace: WorkspaceContext = {
    workspaceId: 'tree-route-workspace', workspaceType: 'personal', rootPath: '/fixture/tree-route',
    status: 'active', organizationId: null, ownerUserId: 'tree-viewer', legacy: false,
    permissions: { canRead: true, canWrite: false, canDelete: false, canCreatePublicLinks: false,
      canManageWorkspace: false, canRunAgent: false },
  };
  const physical: FileNode[] = [{ name: 'folder', path: 'folder', type: 'directory', children: [
    { name: 'asset.pdf', path: 'folder/asset.pdf', type: 'file', size: 11 },
  ] }];
  const cache = new Map<string, FileNode[]>(), errors: unknown[][] = [];
  const state = {
    workspace, physical, nativePath: 'native-one.md', generation: 'one', error: undefined as unknown,
    authResponse: null as Response | null, limitedResponse: null as Response | null,
    authCalls: 0, workspaceOptionCalls: 0, rateCalls: 0, reads: 0, physicalBuilds: 0,
    annotationCalls: 0, enrichmentCalls: 0, cacheReads: 0, cacheWrites: 0,
    requested: [] as Array<{ workspaceId: string; directory: string; depth: number; includeMetadata: boolean | undefined }>,
    annotationPaths: [] as string[][],
  };
  const reader = async (current: WorkspaceContext, directory = '.', depth = 4,
    options: WorkspaceDocumentTreeOptions = {}, dependencies: WorkspaceDocumentTreeDependencies = {}) => {
    state.reads++;
    state.requested.push({ workspaceId: current.workspaceId, directory, depth, includeMetadata: options.includeMetadata });
    assert.deepEqual(current, state.workspace);
    if (state.error !== undefined) throw state.error;
    assert.equal(typeof dependencies.buildPhysicalTree, 'function');
    const listed = await dependencies.buildPhysicalTree!(directory, depth, 0, {
      workspace: current, includeMetadata: options.includeMetadata, includeSymlinks: false, strictMetadata: true,
    });
    // Models the reader's fresh namespace result; its own deep-copy/fence
    // implementation is verified separately by workspace-document-tree-test.
    return [...structuredClone(listed), { name: state.nativePath, path: state.nativePath, type: 'file' as const }];
  };
  const route = await compile<RouteModule>('app/api/files/tree/route.ts', {
    '@/app/lib/filesystem/workspace-files': {
      buildFileTree: async (directory: string, depth: number, currentDepth: number,
        options: Parameters<NonNullable<WorkspaceDocumentTreeDependencies['buildPhysicalTree']>>[3]) => {
        state.physicalBuilds++;
        assert.equal(directory, state.requested.at(-1)!.directory);
        assert.equal(depth, state.requested.at(-1)!.depth); assert.equal(currentDepth, 0);
        assert.deepEqual(options?.workspace, state.workspace);
        assert.equal(options?.includeMetadata, state.requested.at(-1)!.includeMetadata);
        assert.equal(options?.includeSymlinks, false); assert.equal(options?.strictMetadata, true);
        return structuredClone(state.physical);
      },
    },
    '@/app/lib/files/workspace-document-tree': { readWorkspaceDocumentTree: reader, WorkspaceDocumentTreeError },
    '@/app/lib/utils/file-tree-cache': { buildFileTreeCacheKey, fileTreeCache: {
      get: (key: string) => { state.cacheReads++; return cache.get(key); },
      set: (key: string, nodes: FileNode[]) => { state.cacheWrites++; cache.set(key, nodes); },
    } },
    '@/app/lib/utils/rate-limit': { rateLimit: (_request: NextRequest, options: unknown) => {
      state.rateCalls++;
      assert.deepEqual(options, { limit: 60, windowMs: 60_000, keyPrefix: 'files-tree' });
      return state.limitedResponse ? { ok: false, response: state.limitedResponse } : { ok: true };
    } },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async (_request: NextRequest, options: unknown) => {
        state.authCalls++; assert.deepEqual(options, { permissions: 'canRead' });
        return state.authResponse ? { response: state.authResponse }
          : { response: null, workspace: state.workspace, session: { user: { id: 'tree-viewer' } } };
      },
      workspaceFileOptions: (current: WorkspaceContext) => {
        state.workspaceOptionCalls++; assert.deepEqual(current, state.workspace); return { workspace: current };
      },
    },
    '@/app/lib/public-sharing/public-file-shares': { getPublicShareAnnotations: async (paths: string[], userId: unknown, current: WorkspaceContext) => {
      state.annotationCalls++; state.annotationPaths.push([...paths]);
      assert.equal(userId, null); assert.deepEqual(current, state.workspace);
      return new Map(paths.map(filePath => [filePath, { id: `${state.generation}:${filePath}`, status: 'active',
        publicUrl: '/shared/fixture', expiresAt: null, accessCount: 0 }]));
    } },
    '@/app/lib/files/workspace-file-metadata': { enrichWorkspaceFileNodes: async (input: {
      nodes: FileNode[]; workspace: WorkspaceContext; userId: string;
    }) => {
      state.enrichmentCalls++; assert.deepEqual(input.workspace, state.workspace); assert.equal(input.userId, 'tree-viewer');
      const enrich = (node: FileNode) => {
        node.title = `${state.generation}:${node.path}`;
        for (const child of node.children ?? []) enrich(child);
      };
      for (const node of input.nodes) enrich(node);
      return input.nodes;
    } },
  }, errors);
  return { route, state, cache, errors, WorkspaceDocumentTreeError,
    request: (query = '') => route.GET(new NextRequest(`http://tree.example/api/files/tree${query}`)) };
}

test('only the actual directory-not-found error becomes an empty successful tree', async () => {
  const f = await fixture();
  f.state.error = new f.WorkspaceDocumentTreeError('TREE_DIRECTORY_NOT_FOUND', 'Selected directory is absent.', 404);
  const response = await f.request('?path=absent');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true, data: [] });
  assert.equal(f.state.reads, 1); assert.equal(f.state.physicalBuilds, 0);
  assert.equal(f.state.annotationCalls, 0); assert.equal(f.state.enrichmentCalls, 0); assert.equal(f.errors.length, 0);
});

for (const [name, code] of [
  ['lost workspace root', 'TREE_SOURCE_CHANGED'],
  ['physical stat source changed', 'TREE_SOURCE_CHANGED'],
  ['known native file requested as a directory', 'TREE_NAME_CONFLICT'],
] as const) {
  test(`${name} remains a conflict instead of an empty successful tree`, async () => {
    const f = await fixture();
    f.state.error = new f.WorkspaceDocumentTreeError(code, 'The workspace namespace changed.');
    const response = await f.request('?path=selected');
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { success: false, error: 'The workspace namespace changed.', code });
    assert.equal(f.state.reads, 1); assert.equal(f.state.annotationCalls, 0); assert.equal(f.errors.length, 1);
  });
}

for (const [name, error, status, code] of [
  ['raw ENOENT', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL: root disappeared'), { code: 'ENOENT' }), 500, undefined],
  ['forged directory-not-found code', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL'), { code: 'TREE_DIRECTORY_NOT_FOUND', status: 404 }), 500, undefined],
  ['invalid input', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL'), { status: 400, code: 'PRIVATE_CODE' }), 400, undefined],
  ['read permission revoked', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL'), { status: 403, code: 'PRIVATE_CODE' }), 403, undefined],
  ['catalogue conflict', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL'), { status: 409, code: 'PRIVATE_CODE' }), 409, 'TREE_SOURCE_CHANGED'],
  ['catalogue size limit', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL'), { status: 413, code: 'PRIVATE_CODE' }), 413, 'NATIVE_CATALOGUE_TOO_LARGE'],
  ['unknown exception', new Error('PRIVATE_FIXTURE_DETAIL'), 500, undefined],
  ['unrecognized status', Object.assign(new Error('PRIVATE_FIXTURE_DETAIL'), { status: 451 }), 500, undefined],
] as const) {
  test(`${name} preserves only the safe status and public error contract`, async () => {
    const f = await fixture(); f.state.error = error;
    const response = await f.request(); const body = await response.json();
    assert.equal(response.status, status);
    assert.deepEqual(body, { success: false, error: 'Failed to load file tree', ...(code ? { code } : {}) });
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_FIXTURE_DETAIL|PRIVATE_CODE/u);
    assert.equal(f.state.annotationCalls, 0); assert.equal(f.state.enrichmentCalls, 0);
  });
}

test('the actual invalid-path class retains its explicit public 400 code', async () => {
  const f = await fixture();
  f.state.error = new f.WorkspaceDocumentTreeError('TREE_INVALID_PATH', 'Invalid workspace tree path.', 400);
  const response = await f.request('?path=bad');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { success: false, error: 'Invalid workspace tree path.', code: 'TREE_INVALID_PATH' });
});

test('authentication denial returns unchanged before rate limiting, reader or cache access', async () => {
  const f = await fixture(); f.state.authResponse = NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  assert.equal(await f.request(), f.state.authResponse);
  assert.equal(f.state.authCalls, 1); assert.equal(f.state.workspaceOptionCalls, 0); assert.equal(f.state.rateCalls, 0);
  assert.equal(f.state.reads, 0); assert.equal(f.state.physicalBuilds, 0); assert.equal(f.cache.size, 0);
  assert.equal(f.state.annotationCalls, 0); assert.equal(f.state.enrichmentCalls, 0);
  assert.equal(f.state.cacheReads, 0); assert.equal(f.state.cacheWrites, 0);
});

test('rate limiting returns unchanged before reader, physical cache and annotations', async () => {
  const f = await fixture();
  f.state.limitedResponse = NextResponse.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  const response = await f.request(); assert.equal(response, f.state.limitedResponse);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(f.state.authCalls, 1); assert.equal(f.state.rateCalls, 1); assert.equal(f.state.reads, 0);
  assert.equal(f.state.physicalBuilds, 0); assert.equal(f.cache.size, 0); assert.equal(f.state.annotationCalls, 0);
  assert.equal(f.state.cacheReads, 0); assert.equal(f.state.cacheWrites, 0);
});

test('invalid tree depths are rejected before authority reads or physical builds', async () => {
  const f = await fixture();
  for (const value of ['-1', '7', 'abc', '1.5', 'Infinity', '9007199254740993', '0x2']) {
    const response = await f.request(`?depth=${encodeURIComponent(value)}`);
    assert.equal(response.status, 400); assert.equal((await response.json()).success, false);
  }
  assert.equal(f.state.reads, 0); assert.equal(f.state.physicalBuilds, 0); assert.equal(f.cache.size, 0);
});

test('a physical cache hit still reads fresh native namespace and attaches fresh annotations per request', async () => {
  const f = await fixture(), before = structuredClone(f.state.physical);
  const first = await f.request('?depth=1');
  assert.equal(first.status, 200); assert.equal(first.headers.get('Cache-Control'), 'no-store, max-age=0, must-revalidate');
  const firstBody = await first.json();
  assert.deepEqual(firstBody.data.map((node: FileNode) => node.path), ['folder', 'native-one.md']);
  assert.equal(firstBody.data[0].children[0].publicShare.id, 'one:folder/asset.pdf');
  assert.equal(firstBody.data[1].title, 'one:native-one.md');
  const key = buildFileTreeCacheKey('.', 1, f.state.workspace.workspaceId, true);
  assert.deepEqual(f.cache.get(key), before);
  f.state.nativePath = 'native-two.md'; f.state.generation = 'two';
  const second = await f.request('?depth=1'); const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.deepEqual(secondBody.data.map((node: FileNode) => node.path), ['folder', 'native-two.md']);
  assert.equal(secondBody.data[0].children[0].publicShare.id, 'two:folder/asset.pdf');
  assert.equal(secondBody.data[0].children[0].title, 'two:folder/asset.pdf');
  assert.equal(secondBody.data[1].title, 'two:native-two.md');
  assert.equal(f.state.reads, 2, 'a cache hit cannot bypass the native authority reader');
  assert.equal(f.state.physicalBuilds, 1, 'only the physical tree is cached');
  assert.equal(f.state.cacheReads, 2); assert.equal(f.state.cacheWrites, 1);
  assert.equal(f.state.annotationCalls, 2); assert.equal(f.state.enrichmentCalls, 2);
  assert.deepEqual(f.state.annotationPaths, [['folder/asset.pdf', 'native-one.md'], ['folder/asset.pdf', 'native-two.md']]);
  assert.deepEqual(f.cache.get(key), before, 'cache holds neither native union nor nested share/title annotations');
  assert.deepEqual(f.state.physical, before);
});

test('noCache rebuilds physical nodes while stats, depth and workspace retain independent cache keys', async () => {
  const f = await fixture();
  assert.equal((await f.request('?depth=0')).status, 200);
  assert.equal((await f.request('?depth=0')).status, 200);
  assert.equal(f.state.reads, 2); assert.equal(f.state.physicalBuilds, 1);
  f.state.physical = [{ name: 'updated.pdf', path: 'updated.pdf', type: 'file', size: 29 }];
  const rebuilt = await f.request('?depth=0&noCache=1');
  assert.equal(rebuilt.status, 200);
  assert.deepEqual((await rebuilt.json()).data.map((node: FileNode) => node.path), ['updated.pdf', 'native-one.md']);
  assert.equal(f.state.physicalBuilds, 2);
  assert.equal(f.state.cacheReads, 2, 'noCache bypasses the physical cache lookup');
  assert.equal(f.state.cacheWrites, 2);
  assert.equal((await f.request('?depth=0&stats=0')).status, 200);
  assert.equal(f.state.physicalBuilds, 3); assert.equal(f.state.requested.at(-1)!.includeMetadata, false);
  assert.equal((await f.request('?depth=1')).status, 200); assert.equal(f.state.physicalBuilds, 4);
  const originalWorkspaceId = f.state.workspace.workspaceId;
  f.state.workspace = { ...f.state.workspace, workspaceId: 'another-tree-workspace' };
  f.state.physical = [{ name: 'other.pdf', path: 'other.pdf', type: 'file' }];
  const other = await f.request('?depth=0'); assert.equal(other.status, 200);
  assert.equal(f.state.physicalBuilds, 5); assert.equal(f.state.reads, 6);
  assert.deepEqual((await other.json()).data.map((node: FileNode) => node.path), ['other.pdf', 'native-one.md']);
  assert.deepEqual(f.cache.get(buildFileTreeCacheKey('.', 0, originalWorkspaceId, true)), [
    { name: 'updated.pdf', path: 'updated.pdf', type: 'file', size: 29 },
  ]);
  assert.deepEqual(f.cache.get(buildFileTreeCacheKey('.', 0, f.state.workspace.workspaceId, true)), f.state.physical);
});
