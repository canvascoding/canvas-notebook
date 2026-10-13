import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { materializeWorkspaceDownloadArchive } from '../app/lib/files/workspace-download-archive';
import { withNativeWorkspaceFilesRead, type NativeWorkspaceFilesReadScope } from '../app/lib/collaboration/workspace-native-file-read';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { SqlConnection } from '../app/lib/db';
import { nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

const unzipper = createRequire(import.meta.url)('unzipper') as {
  Open: { file(p: string): Promise<{ files: { path: string; type: string; buffer(): Promise<Buffer> }[] }> };
};
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-zip-fixture-'));
  const workspace: WorkspaceContext = { workspaceId: 'native-zip-test', organizationId: null, workspaceType: 'personal',
    rootPath: root, legacy: false, status: 'active', permissions: { canRead: true, canWrite: false, canDelete: false,
      canManageWorkspace: false, canCreatePublicLinks: false, canRunAgent: false } };
  const states = new Map<string, PersistedCollaborationState>(), catalogue: WorkspaceDocumentCatalogueEntry[] = [];
  const controls = { active: false, checkouts: 0, changedCatalogue: false, catalogueReads: 0, ancestorConflict: false };
  const commands: string[] = [], loaded: string[] = [];
  const connection: SqlConnection = {
    run: async sql => { commands.push(sql); if (sql.startsWith('BEGIN')) controls.active = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') controls.active = false;
      assert(!/^\s*(INSERT|UPDATE|DELETE)/u.test(sql)); },
    get: async sql => { assert(controls.active); if (sql.includes('FROM collaboration_documents')) return controls.ancestorConflict ? { path: 'parent.md' } : undefined;
      assert(sql.includes('pg_advisory_xact_lock_shared')); return undefined; },
    all: async () => [], close: async () => { assert(!controls.active); commands.push('CLOSE'); },
  };
  const dependencies = { openConnection: async () => { controls.checkouts++; return connection; },
    readCatalogue: async (_db: SqlConnection, _ws: WorkspaceContext, options: { paths?: readonly string[] } = {}) => {
      assert(controls.active); controls.catalogueReads++;
      const paths = options.paths ?? ['.'];
      const rows = catalogue.filter(d => paths.some(p => p === '.' || d.path === p || d.path.startsWith(`${p}/`)));
      return rows.map(d => ({ ...d, state_version: controls.changedCatalogue && controls.catalogueReads > 1 ? d.state_version + 1 : d.state_version }));
    }, loadState: async (_db: Pick<SqlConnection, 'get'>, id: string) => { assert(controls.active); loaded.push(id); return states.get(id) ?? null; } };
  const add = (filePath: string, content: string, representation: PersistedCollaborationState['representation'] = 'plain_text', authority: WorkspaceDocumentCatalogueEntry['authority'] = 'initialized') => {
    const id = `native-zip-${catalogue.length}`, doc = representation === 'plain_text' ? createPlainTextYDoc(content)
      : nativeTableWidthFixture('tiptap_blocks', content);
    try {
      states.set(id, { documentId: id, workspaceId: workspace.workspaceId, organizationId: null, path: filePath,
        representation, lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
        documentSequence: 0, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
        newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active' });
    } finally { doc.destroy(); }
    catalogue.push({ id, lineage_id: 'lineage', path: filePath, workspace_id: workspace.workspaceId, organization_id: null,
      status: 'active', state_version: 0, yjs_state_lifecycle: authority === 'pristine' ? 'never_initialized' : 'initialized',
      has_persisted_state: authority === 'initialized', has_state_history: false, lifecycle_generation: 1,
      authority, state_status: 'active', state_path: filePath, state_workspace_id: workspace.workspaceId, state_organization_id: null });
    return states.get(id)!;
  };
  const cleanup = async () => { assert(!controls.active); await fs.rm(root, { recursive: true, force: true }); };
  return { workspace, root, add, states, catalogue, controls, commands, dependencies, loaded, cleanup };
}
async function contents(archivePath: string) {
  const zip = await unzipper.Open.file(archivePath), result = new Map<string, Buffer | null>();
  for (const entry of zip.files) result.set(entry.path, entry.type === 'Directory' ? null : await entry.buffer());
  return result;
}
async function tempArchives() { return new Set((await fs.readdir(os.tmpdir())).filter(n => n.startsWith('canvas-download-'))); }

test('ZIP combines native-only virtual folders, fresh native bytes, exact BOM/CRLF, binary bytes and empty directories', async () => {
  const f = await fixture(); let artifact: Awaited<ReturnType<typeof materializeWorkspaceDownloadArchive>> | undefined;
  try {
    f.add('virtual/deep/native.bin', 'Fresh\nEmoji 😀\n'); f.add('stale.md', 'Current');
    await fs.writeFile(path.join(f.root, 'stale.md'), 'Stale projection');
    await fs.writeFile(path.join(f.root, 'asset.bin'), Buffer.from([0xff, 0, 0x42]));
    await fs.mkdir(path.join(f.root, 'empty'));
    artifact = await materializeWorkspaceDownloadArchive(f.workspace, ['.'], f.dependencies);
    const zip = await contents(artifact.archivePath);
    assert.equal(zip.get('workspace/virtual/deep/native.bin')?.toString(), '\uFEFFFresh\r\nEmoji 😀\r\n');
    assert.equal(zip.get('workspace/stale.md')?.toString(), '\uFEFFCurrent');
    assert.deepEqual(zip.get('workspace/asset.bin'), Buffer.from([0xff, 0, 0x42]));
    for (const p of ['workspace/', 'workspace/virtual/', 'workspace/virtual/deep/', 'workspace/empty/']) assert.equal(zip.get(p), null);
    assert.equal(f.controls.checkouts, 1); assert.equal(f.loaded.length, 2);
    assert.deepEqual(f.commands.slice(-2), ['COMMIT', 'CLOSE']);
    assert.equal((await fs.stat(artifact.archivePath)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(artifact).includes('yjsState'), false);
  } finally { if (artifact) await fs.rm(artifact.tempDirectory, { recursive: true, force: true }); await f.cleanup(); }
});

test('absent physical selected folder and disjoint native/binary selections preserve their requested ZIP names', async () => {
  const f = await fixture();
  try {
    f.add('virtual/nested/a.md', 'A'); f.add('other/b.md', 'B');
    await fs.writeFile(path.join(f.root, 'asset.bin'), Buffer.from([1, 2, 3]));
    for (const paths of [['virtual'], ['virtual/nested/a.md', 'asset.bin']]) {
      const artifact = await materializeWorkspaceDownloadArchive(f.workspace, paths, f.dependencies);
      try {
        const zip = await contents(artifact.archivePath);
        assert.equal(zip.get('virtual/nested/a.md')?.toString(), '\uFEFFA');
        assert.equal(zip.has('other/b.md'), false);
        if (paths.length === 2) assert.deepEqual(zip.get('asset.bin'), Buffer.from([1, 2, 3]));
        else assert.equal(zip.get('virtual/'), null);
      } finally { await fs.rm(artifact.tempDirectory, { recursive: true, force: true }); }
    }
  } finally { await f.cleanup(); }
});

test('lost state and invalid native identity/schema reject the whole ZIP without projection fallback', async () => {
  for (const kind of ['missing', 'foreign', 'schema'] as const) {
    const f = await fixture(), before = await tempArchives();
    try {
      const state = f.add('note.md', 'Protected', 'plain_text', kind === 'missing' ? 'missing-state' : 'initialized');
      await fs.writeFile(path.join(f.root, 'note.md'), 'Stale must never export');
      if (kind === 'foreign') state.workspaceId = 'foreign';
      if (kind === 'schema') state.schemaVersion = 999;
      await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['.'], f.dependencies));
      assert.deepEqual(await tempArchives(), before); assert(f.commands.includes('ROLLBACK'));
    } finally { await f.cleanup(); }
  }
});

test('schema-valid non-exportable rich structure stays explicit and removes its partial archive', async () => {
  const f = await fixture(), before = await tempArchives();
  try {
    f.add('rich.md', 'Native column width', 'tiptap_blocks');
    await fs.writeFile(path.join(f.root, 'rich.md'), 'Stale table');
    await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['.'], f.dependencies), /roundtrip_unstable/u);
    assert.deepEqual(await tempArchives(), before);
  } finally { await f.cleanup(); }
});

test('physical replacement, byte change and parent alias after planning fail before ZIP publication', async () => {
  for (const kind of ['bytes', 'inode', 'parent'] as const) {
    const f = await fixture(), before = await tempArchives();
    try {
      await fs.mkdir(path.join(f.root, 'folder')); await fs.writeFile(path.join(f.root, 'folder', 'file.bin'), 'Original');
      await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['folder'], { ...f.dependencies, beforeMaterialize: async () => {
        assert(f.controls.active);
        if (kind === 'bytes') await fs.writeFile(path.join(f.root, 'folder', 'file.bin'), 'Changed');
        if (kind === 'inode') { await fs.rename(path.join(f.root, 'folder', 'file.bin'), path.join(f.root, 'folder', 'old.bin'));
          await fs.writeFile(path.join(f.root, 'folder', 'file.bin'), 'Original'); }
        if (kind === 'parent') { await fs.rename(path.join(f.root, 'folder'), path.join(f.root, 'moved'));
          await fs.symlink('moved', path.join(f.root, 'folder')); }
      } }));
      assert.deepEqual(await tempArchives(), before);
    } finally { await f.cleanup(); }
  }
});

test('namespace drift after actual ZIP materialization rolls back and removes the owned artifact', async () => {
  const f = await fixture(), before = await tempArchives();
  try {
    f.add('native.md', 'Native'); f.controls.changedCatalogue = true;
    await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['.'], f.dependencies), { code: 'ARCHIVE_SOURCE_CHANGED' });
    assert(f.loaded.length > 0); assert.deepEqual(await tempArchives(), before);
    assert(f.commands.includes('ROLLBACK')); assert(!f.commands.includes('COMMIT'));
  } finally { await f.cleanup(); }
});

test('symlinks and hardlinks are rejected, including stale native projection aliases', async () => {
  for (const kind of ['symbolic', 'hard', 'native-symbolic'] as const) {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.root, 'source.bin'), 'Source');
      if (kind === 'native-symbolic') f.add('alias.md', 'Native');
      if (kind === 'hard') await fs.link(path.join(f.root, 'source.bin'), path.join(f.root, 'alias.bin'));
      else await fs.symlink('source.bin', path.join(f.root, kind === 'native-symbolic' ? 'alias.md' : 'alias.bin'));
      await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['.'], f.dependencies));
    } finally { await f.cleanup(); }
  }
});

test('native file/directory, pristine-directory, case/NFC and ancestor conflicts cannot create ambiguous ZIPs', async () => {
  for (const kind of ['file-directory', 'pristine-directory', 'case', 'nfc', 'ancestor'] as const) {
    const f = await fixture();
    try {
      if (kind === 'file-directory') { f.add('folder', 'Native file'); await fs.mkdir(path.join(f.root, 'folder')); }
      if (kind === 'pristine-directory') { f.add('folder', '', 'plain_text', 'pristine'); await fs.mkdir(path.join(f.root, 'folder')); }
      if (kind === 'case') { f.add('Foo.md', 'A'); f.add('foo.md', 'B'); }
      if (kind === 'nfc') { f.add('é.md', 'A'); f.add('e\u0301.md', 'B'); }
      if (kind === 'ancestor') { f.add('parent.md/child.md', 'A'); f.controls.ancestorConflict = true; }
      await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['.'], f.dependencies));
    } finally { await f.cleanup(); }
  }
});

test('entry, depth, individual native bytes and total mixed byte budgets reject before unsafe publication', async () => {
  for (const kind of ['entries', 'depth', 'native-bytes', 'total'] as const) {
    const f = await fixture(), before = await tempArchives();
    try {
      if (kind === 'entries') { f.add('a.md', 'A'); f.add('b.md', 'B'); }
      if (kind === 'depth') f.add('deep/nested/note.md', 'A');
      if (kind === 'native-bytes') f.add('native.md', 'Large text');
      if (kind === 'total') { f.add('native.md', '1234'); await fs.writeFile(path.join(f.root, 'asset.bin'), '1234'); }
      const limits = kind === 'entries' ? { maxEntries: 1 } : kind === 'depth' ? { maxDepth: 1 }
        : kind === 'native-bytes' ? { maxNativeBytes: 4 } : { maxBytes: 10 };
      await assert.rejects(materializeWorkspaceDownloadArchive(f.workspace, ['.'], { ...f.dependencies, limits }), { status: 413 });
      assert.deepEqual(await tempArchives(), before);
    } finally { await f.cleanup(); }
  }
});

test('permission, out-of-scope and expired readers do not inspect native or physical content', async () => {
  const f = await fixture();
  try {
    f.add('native.md', 'Private');
    await assert.rejects(materializeWorkspaceDownloadArchive({ ...f.workspace,
      permissions: { ...f.workspace.permissions, canRead: false } }, ['.'], f.dependencies), { status: 403 });
    assert.equal(f.controls.checkouts, 0);
    let saved: NativeWorkspaceFilesReadScope | undefined;
    await withNativeWorkspaceFilesRead({ workspace: f.workspace, paths: ['native.md'], maxEntries: 10 }, async scope => {
      saved = scope;
      await assert.rejects(scope.readFile('outside.md', 100), { status: 409 });
      assert.equal(f.loaded.length, 0);
      assert(Object.isFrozen(scope.documents));
    }, f.dependencies);
    await assert.rejects(saved!.readFile('native.md', 100), { status: 409 });
    assert.equal(f.loaded.length, 0);
  } finally { await f.cleanup(); }
});

test('an admitted failed detached read remains fatal after its rejection settled and was ignored by the consumer', async () => {
  const f = await fixture();
  try {
    f.add('missing.md', 'Protected', 'plain_text', 'missing-state');
    let captured: NativeWorkspaceFilesReadScope | undefined;
    await assert.rejects(withNativeWorkspaceFilesRead({ workspace: f.workspace, paths: ['.'], maxEntries: 10 }, async scope => {
      captured = scope;
      void scope.readFile('missing.md', 100).catch(() => undefined);
      await new Promise(resolve => setImmediate(resolve));
      return 'must not commit';
    }, f.dependencies), { status: 409 });
    assert(f.commands.includes('ROLLBACK')); assert(!f.commands.includes('COMMIT'));
    await assert.rejects(captured!.readFile('missing.md', 100), { status: 409 });
  } finally { await f.cleanup(); }
});

test('native UTF-8/BOM/CRLF limits are exact and oversized export Buffer allocation is avoided', async () => {
  const f = await fixture();
  try {
    const content = 'Ä 😀\nSecond\n', expected = Buffer.from(`\uFEFF${content.replace(/\n/gu, '\r\n')}`);
    f.add('exact.md', content);
    await withNativeWorkspaceFilesRead({ workspace: f.workspace, paths: ['exact.md'], maxEntries: 10 }, async scope => {
      assert.deepEqual((await scope.readFile('exact.md', expected.length))?.content, expected);
    }, f.dependencies);
    await assert.rejects(withNativeWorkspaceFilesRead({ workspace: f.workspace, paths: ['exact.md'], maxEntries: 10 },
      async scope => scope.readFile('exact.md', expected.length - 1), f.dependencies), { status: 413 });
    f.add('large.md', 'x'.repeat(1024 * 1024));
    const original = Buffer.from; let largeStringBuffers = 0;
    Buffer.from = ((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].length >= 1024 * 1024) largeStringBuffers++;
      return Reflect.apply(original, Buffer, args);
    }) as typeof Buffer.from;
    try {
      await assert.rejects(withNativeWorkspaceFilesRead({ workspace: f.workspace, paths: ['large.md'], maxEntries: 10 },
        async scope => scope.readFile('large.md', 4), f.dependencies), { status: 413 });
      assert.equal(largeStringBuffers, 0);
    } finally { Buffer.from = original; }
  } finally { await f.cleanup(); }
});

test('a zero-byte native export still fits when physical files exactly fill the total ZIP budget', async () => {
  const f = await fixture(); let artifact: Awaited<ReturnType<typeof materializeWorkspaceDownloadArchive>> | undefined;
  try {
    f.add('empty.md', '').hasBom = false;
    await fs.writeFile(path.join(f.root, 'asset.bin'), '1234');
    artifact = await materializeWorkspaceDownloadArchive(f.workspace, ['.'], { ...f.dependencies, limits: { maxBytes: 4 } });
    const zip = await contents(artifact.archivePath);
    assert.equal(zip.get('workspace/empty.md')?.length, 0);
    assert.equal(zip.get('workspace/asset.bin')?.toString(), '1234');
  } finally { if (artifact) await fs.rm(artifact.tempDirectory, { recursive: true, force: true }); await f.cleanup(); }
});
