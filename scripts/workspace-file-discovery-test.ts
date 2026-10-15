import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import * as catalogue from '../app/lib/filesystem/file-reference-cache';
import * as queries from '../app/lib/filesystem/workspace-reference-query';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-discovery-'));
  const workspace: WorkspaceContext = { workspaceId: root, workspaceType: 'personal', rootPath: root,
    organizationId: null, ownerUserId: null, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: false } };
  const options = { workspace };
  const deep = Array.from({ length: 18 }, (_, index) => `level-${index}`).join('/');
  try {
    await fs.mkdir(path.join(root, deep, 'empty'), { recursive: true });
    await Promise.all(Array.from({ length: 550 }, (_, index) => fs.writeFile(path.join(root, `other-${index}.txt`), 'text')));
    await fs.writeFile(path.join(root, deep, 'Terra sneaker.png'), 'image');
    await fs.writeFile(path.join(root, deep, 'Terra texture.tiff'), 'image');
    const entries = await catalogue.getCachedWorkspaceReferenceEntries(true, options);
    assert.ok(entries.some((entry) => entry.path === `${deep}/empty` && entry.type === 'directory'));
    const files = await catalogue.getCachedFileReferenceEntries(false, options);
    assert.equal(files.length, 552);
    assert.ok(files.every((entry) => entry.type === 'file'), 'Existing file-only catalogue consumers must not receive folders.');
    const query = queries.parseWorkspaceReferenceQuery(new URLSearchParams({ extensions: 'png,tiff', limit: '1' }));
    const first = queries.selectWorkspaceReferencePage(entries, query, workspace.workspaceId);
    assert.equal(first.total, 2, 'Filter media before slicing a catalogue containing over 500 other files.');
    assert.equal(first.files.length, 1);
    assert.ok(first.files[0].path.startsWith(deep));
    assert.ok(first.nextCursor);
    const second = queries.selectWorkspaceReferencePage(entries, { ...query, cursor: first.nextCursor }, workspace.workspaceId);
    assert.equal(second.files.length, 1);
    assert.notEqual(second.files[0].path, first.files[0].path);
    assert.equal(second.nextCursor, null);
    assert.throws(() => queries.selectWorkspaceReferencePage(entries, { ...query, cursor: first.nextCursor }, 'other-workspace'),
      (error) => error instanceof queries.WorkspaceReferenceQueryError && error.status === 409);
    assert.throws(() => queries.selectWorkspaceReferencePage(entries, { ...query, query: 'different', cursor: first.nextCursor }, workspace.workspaceId));
    assert.throws(() => queries.parseWorkspaceReferenceQuery(new URLSearchParams({ extensions: '../png' })));
    assert.throws(() => queries.selectWorkspaceReferencePage(entries, { ...query, cursor: 'bnVsbA' }, workspace.workspaceId));
    const emptyFolder = queries.selectWorkspaceReferencePage(entries,
      queries.parseWorkspaceReferenceQuery(new URLSearchParams({ type: 'directory', q: 'empty' })), workspace.workspaceId);
    assert.deepEqual(emptyFolder.files.map((entry) => entry.path), [`${deep}/empty`]);
    let all: string[] = [];
    let cursor: string | null = null;
    do {
      const page = queries.selectWorkspaceReferencePage(entries, { ...query, extensions: [], limit: 100, cursor }, workspace.workspaceId);
      all = all.concat(page.files.map((file) => file.path));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(all.length, 552);
    assert.equal(new Set(all).size, all.length);

    const native = createRequire(path.resolve('app/api/files/list/route.ts'));
    let denied = false;
    const mocks: Record<string, unknown> = {
      '@/app/lib/filesystem/file-reference-cache': catalogue,
      '@/app/lib/filesystem/workspace-reference-query': queries,
      '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
      '@/app/lib/public-sharing/public-file-shares': { getPublicShareAnnotations: async () => new Map() },
      '@/app/lib/workspaces/request': { workspaceFileOptions: () => options,
        requireRequestWorkspace: async () => denied ? { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
          : { workspace, response: null } },
    };
    const source = ts.transpileModule(await fs.readFile('app/api/files/list/route.ts', 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const exported: { GET?: (request: NextRequest) => Promise<Response> } = {};
    new Function('require', 'module', 'exports', source)((name: string) => mocks[name] ?? native(name), { exports: exported }, exported);
    const response = await exported.GET!(new NextRequest('http://fixture/api/files/list?extensions=png,tiff&limit=1'));
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.total, 2);
    assert.equal(page.files.length, 1);
    assert.ok(page.nextCursor);
    denied = true;
    assert.equal((await exported.GET!(new NextRequest('http://fixture/api/files/list?type=all'))).status, 403);
    denied = false;
    assert.equal((await exported.GET!(new NextRequest('http://fixture/api/files/list?type=invalid'))).status, 400);

    catalogue.invalidateFileReferenceCache(options);
    const readdir = fs.readdir;
    const faultRoot = await fs.realpath(root);
    const scanError = Object.assign(new Error('Unreadable deep folder'), { code: 'EACCES' });
    const failure = mock.method(fs, 'readdir', (directory: unknown, ...args: unknown[]) => {
      if (String(directory) === path.join(faultRoot, deep)) throw scanError;
      return Reflect.apply(readdir, fs, [directory, ...args]);
    });
    try {
      await assert.rejects(catalogue.getCachedWorkspaceReferenceEntries(true, options), (error) => error === scanError);
      await assert.rejects(catalogue.getCachedFileReferenceEntries(true, options), (error) => error === scanError);
    } finally { failure.mock.restore(); }
    console.log('workspace-file-discovery-test: 18 levels, empty directories, 552 files, media filtering, pagination, workspace binding and scan failures passed');
  } finally {
    catalogue.invalidateFileReferenceCache(options);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
