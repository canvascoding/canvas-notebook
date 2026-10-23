import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { WorkspaceSceneCatalogueEntry } from '../app/lib/collaboration/workspace-scene-catalogue';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { SqlConnection } from '../app/lib/db';
import { buildFileTree } from '../app/lib/filesystem/workspace-files';
import { mergeWorkspaceDocumentTree, readWorkspaceDocumentTree, type WorkspaceDocumentTreeDependencies } from '../app/lib/files/workspace-document-tree';
import type { FileNode } from '../app/lib/files/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type Row = WorkspaceDocumentCatalogueEntry;
function workspace(rootPath = '/fixture/workspace'): WorkspaceContext {
  return { workspaceId: 'native-tree-test', organizationId: null, workspaceType: 'personal', rootPath, legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: false, canDelete: false, canManageWorkspace: false, canRunAgent: false, canCreatePublicLinks: false } };
}
function row(filePath: string, authority: Row['authority'] = 'initialized', id = `document:${filePath}`): Row {
  const initialized = authority === 'initialized';
  return { id, lineage_id: `lineage:${id}`, path: filePath, workspace_id: 'native-tree-test', organization_id: null,
    status: 'active', state_version: authority === 'pristine' ? 0 : 3,
    yjs_state_lifecycle: authority === 'pristine' ? 'never_initialized' : 'initialized', has_persisted_state: initialized,
    has_state_history: authority !== 'pristine', lifecycle_generation: initialized ? 1 : null, authority,
    state_status: initialized ? 'active' : null, state_path: initialized ? filePath : null,
    state_workspace_id: initialized ? 'native-tree-test' : null, state_organization_id: null };
}
function sceneRow(filePath: string, authority: WorkspaceSceneCatalogueEntry['authority'] = 'initialized'): WorkspaceSceneCatalogueEntry {
  const id = `scene:${filePath}`, lineage = `lineage:${id}`, initialized = authority === 'initialized';
  return { id, lineage_id: lineage, path: filePath, workspace_id: 'native-tree-test', workspace_type: 'personal',
    organization_id: null, customer_id: null, project_id: null, provider: 'excalidraw', status: 'active', state_version: 0,
    has_persisted_state: initialized, authority, state_document_id: initialized ? id : null,
    state_workspace_id: initialized ? 'native-tree-test' : null, state_organization_id: null,
    state_path: initialized ? filePath : null, state_status: initialized ? 'active' : null,
    lifecycle_generation: initialized ? 1 : null, scene_schema_version: initialized ? 1 : null,
    excalidraw_version: initialized ? '0.18.1' : null, scene_sequence: initialized ? 2 : null,
    checkpoint_sequence: initialized ? 1 : null, canonical_hash: initialized ? 'a'.repeat(64) : null,
    elements_bytes: initialized ? 2 : null, shared_app_state_bytes: initialized ? 2 : null, assets_bytes: initialized ? 2 : null,
    lineage_row_id: lineage, lineage_workspace_id: 'native-tree-test', lineage_workspace_type: 'personal', lineage_organization_id: null,
    lineage_customer_id: null, lineage_project_id: null, lineage_path: filePath, lineage_status: 'active',
    lineage_archived_at: null, lineage_trash_entry_id: null };
}
const file = (filePath: string, stats = false): FileNode => ({ path: filePath, name: path.posix.basename(filePath), type: 'file',
  ...(stats ? { size: 19, modified: 100, created: 90, permissions: '100600' } : {}) });
const directory = (filePath: string, children?: FileNode[]): FileNode => ({ path: filePath, name: path.posix.basename(filePath), type: 'directory',
  ...(children ? { children } : {}) });

test('namespace union includes initialized/missing-state files and implied parents, while pristine alone proves no path', () => {
  const input = [directory('empty', []), file('asset.pdf', true), file('pristine.md', true)];
  const catalogue = [row('virtual/deep/native.md'), row('lost.md', 'missing-state'), row('pristine.md', 'pristine'), row('absent/no.md', 'pristine')];
  assert.deepEqual(mergeWorkspaceDocumentTree(input, catalogue, '.', 4), [directory('empty', []), directory('virtual', [directory('virtual/deep', [file('virtual/deep/native.md')])]),
    file('asset.pdf', true), file('lost.md'), file('pristine.md', true)]);
});

test('missing, empty and stale projections give the same initialized/missing-state namespace without cache mutation', () => {
  for (const authority of ['initialized', 'missing-state'] as const) {
    const expected = [file('note.md')], catalogue = [row('note.md', authority)];
    for (const physical of [[], [file('note.md')], [file('note.md', true)]]) {
      const before = structuredClone(physical);
      assert.deepEqual(mergeWorkspaceDocumentTree(physical, catalogue, '.', 0), expected);
      assert.deepEqual(physical, before);
    }
  }
});

test('all nested physical cache objects remain independent after merging and later annotation enrichment', () => {
  const input = [directory('folder', [file('folder/native.md', true), file('folder/asset.pdf', true)])];
  input[0].children![1].publicShare = { id: 'share', status: 'active', publicUrl: '/shared', expiresAt: null, accessCount: 1 };
  const before = structuredClone(input), output = mergeWorkspaceDocumentTree(input, [row('folder/native.md')], '.', 3);
  output[0].children![1].title = 'View title'; output[0].children!.find(n => n.path === 'folder/asset.pdf')!.publicShare!.accessCount = 99;
  assert.deepEqual(input, before);
  assert.equal(input[0].children![0].size, 19);
});

test('depth zero and deeper levels match physical tree semantics, including selected virtual directories', () => {
  const catalogue = [row('a/b/c/note.md')];
  assert.deepEqual(mergeWorkspaceDocumentTree([], catalogue, '.', 0), [directory('a')]);
  assert.deepEqual(mergeWorkspaceDocumentTree([], catalogue, '.', 1), [directory('a', [directory('a/b')])]);
  assert.deepEqual(mergeWorkspaceDocumentTree([], catalogue, 'a/b', 0), [directory('a/b/c')]);
  assert.deepEqual(mergeWorkspaceDocumentTree([], catalogue, 'a/b', 1), [directory('a/b/c', [file('a/b/c/note.md')])]);
  const physical = [directory('a', [directory('a/b', [file('a/b/asset.pdf')])])];
  assert.deepEqual(mergeWorkspaceDocumentTree(physical, [], '.', 0), [directory('a')]);
  assert.deepEqual(mergeWorkspaceDocumentTree(physical, [], '.', 1), [directory('a', [directory('a/b')])]);
});

test('physical directories, file parents, native file parents and ambiguous case/NFC names fail closed', () => {
  for (const [physical, catalogue] of [
    [[directory('note.md')], [row('note.md')]],
    [[directory('note.md')], [row('note.md', 'pristine')]],
    [[file('parent')], [row('parent/child.md')]],
    [[], [row('parent.md'), row('parent.md/child.md')]],
    [[], [row('parent.md', 'pristine'), row('parent.md/child.md')]],
    [[file('Foo.md')], [row('foo.md')]],
    [[], [row('é.md'), row('e\u0301.md')]],
  ] as Array<[FileNode[], Row[]]>) assert.throws(() => mergeWorkspaceDocumentTree(physical, catalogue, '.', 3), { code: 'TREE_NAME_CONFLICT' });
});

test('excluded internal paths stay hidden even when only their native catalogue descendants exist', () => {
  const paths = ['node_modules/note.md', '.git/note.md', 'normal/.cache/note.md', '.canvas-copy-backups/note.md', '.canvas-skill-drafts/note.md',
    '.gitkeep', 'normal/.keep', 'note.md.canvas-write-00000000-0000-0000-0000-000000000000.tmp'];
  const native = paths.map(p => row(p));
  assert.deepEqual(mergeWorkspaceDocumentTree([directory('.git', [file('.git/note.md')]), file('.keep')], native, '.', 4), []);
  assert.deepEqual(mergeWorkspaceDocumentTree([], [row('normal/.canvas-skill-drafts/note.md')], '.', 3),
    [directory('normal', [directory('normal/.canvas-skill-drafts', [file('normal/.canvas-skill-drafts/note.md')])])]);
});

test('canonical scope, duplicate identity, malformed physical hierarchy and bounded catalogue remain explicit', () => {
  for (const bad of ['../outside', '/outside', 'C:\\outside', 'folder/../outside', 'a\0b']) {
    assert.throws(() => mergeWorkspaceDocumentTree([], [], bad, 0));
  }
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('outside.md')], 'inside', 1), { code: 'TREE_SOURCE_CHANGED' });
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('a.md'), row('b.md', 'initialized', 'document:a.md')], '.', 1), { code: 'TREE_SOURCE_CHANGED' });
  assert.throws(() => mergeWorkspaceDocumentTree([directory('a', [file('outside.md')])], [], '.', 1), { code: 'TREE_INVALID_PATH' });
  assert.throws(() => mergeWorkspaceDocumentTree([], Array.from({ length: 10_001 }, (_, i) => row(`${i}.md`)), '.', 1), { status: 413 });
});

async function fixture(representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks' = 'plain_text') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-document-tree-')), ws = workspace(root);
  const rows: Row[] = [], states = new Map<string, Uint8Array>(), commands: string[] = [];
  const controls = { active: false, closed: 0, checkouts: 0, catalogueReads: 0, stateReads: 0, physicalReads: 0,
    drift: false, unknownSql: false, ancestorPath: null as string | null };
  const connection: SqlConnection = {
    run: async sql => { commands.push(sql); assert(!/^\s*(INSERT|UPDATE|DELETE)/u.test(sql));
      if (sql === 'BEGIN READ ONLY') { assert(!controls.active); controls.active = true; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert(controls.active); controls.active = false; } },
    get: async sql => {
      assert(controls.active); commands.push(sql);
      if (sql.includes('UNION ALL SELECT s.path FROM collaboration_excalidraw_states')) {
        assert.doesNotMatch(sql, /d\.provider\s*=/u);
        return controls.ancestorPath ? { path: controls.ancestorPath } : undefined;
      }
      if (sql.includes('pg_advisory_xact_lock_shared') || sql.includes('LEFT JOIN collaboration_documents') || sql.includes('SELECT d.path FROM collaboration_documents')) return undefined;
      throw new Error('Unexpected SQL read.');
    },
    all: async (sql, args) => {
      assert(controls.active); commands.push(sql); controls.catalogueReads++;
      if (controls.unknownSql) throw new Error('Unknown SQL catalogue failure.');
      assert(sql.includes('FROM collaboration_documents d LEFT JOIN collaboration_yjs_states'));
      assert.equal(args?.[0], ws.workspaceId); assert.equal(args?.[2], 10_001);
      const scopes = args?.[1] as string[];
      return rows.filter(d => scopes.some(p => p === '' || d.path === p || d.path.startsWith(`${p}/`))).map(d => ({ ...d,
        state_version: controls.drift && controls.catalogueReads > 1 ? d.state_version + 1 : d.state_version }));
    },
    close: async () => { assert(!controls.active); controls.closed++; },
  };
  const dependencies: WorkspaceDocumentTreeDependencies = {
    openConnection: async () => { controls.checkouts++; return connection; },
    // Real catalogue validation/classification, including final namespace pin.
    readCatalogue: readWorkspaceDocumentCatalogue,
    readSceneCatalogue: async () => [],
    loadState: async () => { controls.stateReads++; throw new Error('A namespace read must never load native state.'); },
    buildPhysicalTree: async (...args) => { assert(controls.active); controls.physicalReads++; return buildFileTree(...args); },
  };
  const add = (filePath: string, authority: Row['authority'] = 'initialized') => {
    const d = row(filePath, authority); rows.push(d);
    if (authority === 'initialized') {
      const native = representation === 'plain_text' ? createPlainTextYDoc('# Current native 😀') : createRichMarkdownYDoc('# Current native 😀', representation);
      try { states.set(d.id, Y.encodeStateAsUpdate(native)); } finally { native.destroy(); }
    }
  };
  return { root, workspace: ws, rows, states, commands, controls, dependencies, add, connection,
    cleanup: async () => { assert(!controls.active); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`${representation}: real catalogue + read fence list native-only names without loading content or falling back to projections`, async () => {
    const f = await fixture(representation);
    try {
      f.add('virtual/deep/note.md'); f.add('lost.md', 'missing-state'); f.add('never.md', 'pristine');
      await fs.writeFile(path.join(f.root, 'asset.pdf'), Buffer.from([0, 255, 12])); await fs.mkdir(path.join(f.root, 'empty'));
      assert(f.states.size > 0);
      const output = await readWorkspaceDocumentTree(f.workspace, '.', 3, { includeMetadata: false }, f.dependencies);
      assert.deepEqual(output, [directory('empty', []), directory('virtual', [directory('virtual/deep', [file('virtual/deep/note.md')])]), file('asset.pdf'), file('lost.md')]);
      assert.equal(f.controls.stateReads, 0); assert.equal(f.controls.checkouts, 1); assert.equal(f.controls.catalogueReads, 2);
      assert.equal(f.controls.closed, 1); assert.deepEqual(f.commands.slice(-1), ['COMMIT']);
    } finally { await f.cleanup(); }
  });
}

test('actual absent, empty and stale physical projections retain identical native namespace without content reads', async () => {
  for (const authority of ['initialized', 'missing-state'] as const) {
    const f = await fixture();
    try {
      f.add('note.md', authority);
      const observed: FileNode[][] = [];
      for (const content of [null, '', 'A deliberately stale projection with different physical metadata']) {
        if (content !== null) await fs.writeFile(path.join(f.root, 'note.md'), content);
        observed.push(await readWorkspaceDocumentTree(f.workspace, '.', 0, { includeMetadata: true }, f.dependencies));
      }
      assert.deepEqual(observed, [[file('note.md')], [file('note.md')], [file('note.md')]]);
      assert.equal(f.controls.stateReads, 0); assert.equal(f.controls.catalogueReads, 6);
    } finally { await f.cleanup(); }
  }
});

test('selected logical folders require native descendants, retain depth, and do not call a cached physical builder', async () => {
  const f = await fixture();
  try {
    f.add('virtual/deep/note.md'); f.add('pristine/absent.md', 'pristine');
    assert.deepEqual(await readWorkspaceDocumentTree(f.workspace, 'virtual', 0, {}, f.dependencies), [directory('virtual/deep')]);
    assert.equal(f.controls.physicalReads, 0);
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, 'pristine', 0, {}, f.dependencies), { code: 'TREE_DIRECTORY_NOT_FOUND', status: 404 });
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, 'absent', 0, {}, f.dependencies), { code: 'TREE_DIRECTORY_NOT_FOUND', status: 404 });
    assert.equal(f.controls.stateReads, 0);
  } finally { await f.cleanup(); }
});

test('missing workspace root is never recreated or forgiven by native catalogue descendants', async () => {
  const f = await fixture();
  try {
    f.add('virtual/note.md'); await fs.rm(f.root, { recursive: true });
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, 'virtual', 0, {}, f.dependencies), { code: 'TREE_SOURCE_CHANGED', status: 409 });
    await assert.rejects(fs.lstat(f.root), { code: 'ENOENT' });
    assert.equal(f.controls.physicalReads, 0); assert(f.commands.includes('ROLLBACK'));
  } finally { await f.cleanup(); }
});

test('a known native file cannot become an empty directory when its projection is absent', async () => {
  const f = await fixture();
  try {
    f.add('native.md');
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, 'native.md', 0, {}, f.dependencies),
      { code: 'TREE_NAME_CONFLICT', status: 409 });
    assert.equal(f.controls.physicalReads, 0);
    assert(f.commands.includes('ROLLBACK'));
  } finally { await f.cleanup(); }
});

test('a disappearing physical entry is a changed source rather than a missing selected directory', async () => {
  const f = await fixture();
  try {
    f.add('native.md');
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, '.', 0, {}, { ...f.dependencies,
      buildPhysicalTree: async () => { throw Object.assign(new Error('Disappearing physical child'), { code: 'ENOENT' }); },
    }), { code: 'TREE_SOURCE_CHANGED', status: 409 });
    assert(f.commands.includes('ROLLBACK'));
    assert.equal(f.controls.stateReads, 0);
  } finally { await f.cleanup(); }
});

test('SQL catalogue failure never falls back to the physical namespace, and final catalogue drift rolls back', async () => {
  for (const kind of ['sql', 'drift'] as const) {
    const f = await fixture();
    try {
      f.add('note.md'); await fs.writeFile(path.join(f.root, 'note.md'), 'Stale projection');
      f.controls.unknownSql = kind === 'sql'; f.controls.drift = kind === 'drift';
      await assert.rejects(readWorkspaceDocumentTree(f.workspace, '.', 1, {}, f.dependencies), kind === 'sql' ? /Unknown SQL catalogue failure/u : { code: 'ARCHIVE_SOURCE_CHANGED' });
      if (kind === 'sql') assert.equal(f.controls.physicalReads, 0);
      assert.equal(f.controls.stateReads, 0); assert(f.commands.includes('ROLLBACK')); assert(!f.commands.includes('COMMIT'));
    } finally { await f.cleanup(); }
  }
});

test('permission and traversal failures cannot enter a physical read or create a missing root', async () => {
  const f = await fixture();
  try {
    await assert.rejects(readWorkspaceDocumentTree({ ...f.workspace, permissions: { ...f.workspace.permissions, canRead: false } }, '.', 0, {}, f.dependencies), { status: 403 });
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, '../outside', 0, {}, f.dependencies), { status: 400 });
    assert.equal(f.controls.checkouts, 0); assert.equal(f.controls.physicalReads, 0);
  } finally { await f.cleanup(); }
});

test('physical file parents, native-directory projections and aliases cannot authorize logical folder fallbacks', async () => {
  for (const kind of ['file-parent', 'directory-projection', 'symlink-parent'] as const) {
    const f = await fixture();
    try {
      if (kind === 'file-parent') { f.add('parent/child.md'); await fs.writeFile(path.join(f.root, 'parent'), 'physical file'); }
      if (kind === 'directory-projection') { f.add('parent/child.md'); await fs.mkdir(path.join(f.root, 'parent', 'child.md'), { recursive: true }); }
      if (kind === 'symlink-parent') { f.add('parent/child.md'); await fs.mkdir(path.join(f.root, 'actual')); await fs.symlink('actual', path.join(f.root, 'parent')); }
      await assert.rejects(readWorkspaceDocumentTree(f.workspace, '.', 0, {}, f.dependencies), { status: 409 });
      assert.equal(f.controls.stateReads, 0); assert(f.commands.includes('ROLLBACK'));
    } finally { await f.cleanup(); }
  }
});

test('Scene headers establish native-only names and parents with the same visibility, depth and detached-stat rules', () => {
  const scenes = [sceneRow('virtual/deep/drawing.excalidraw'), sceneRow('lost.bin', 'missing-state'),
    sceneRow('.git/private.excalidraw'), sceneRow('.canvas-skill-drafts/private.excalidraw')];
  const physical = [file('lost.bin', true)], before = structuredClone(physical);
  assert.deepEqual(mergeWorkspaceDocumentTree(physical, scenes, '.', 2), [
    directory('virtual', [directory('virtual/deep', [file('virtual/deep/drawing.excalidraw')])]), file('lost.bin')]);
  assert.deepEqual(physical, before);
  assert.deepEqual(mergeWorkspaceDocumentTree([], [scenes[0]], 'virtual', 0), [directory('virtual/deep')]);
  assert.deepEqual(mergeWorkspaceDocumentTree([], [scenes[0]], 'virtual/deep', 0), [file('virtual/deep/drawing.excalidraw')]);
});

test('Yjs and Scene headers form one namespace with shared identity, parent, case and total-entry conflicts', () => {
  assert.deepEqual(mergeWorkspaceDocumentTree([], [row('folder/note.md'), sceneRow('folder/drawing.excalidraw')], '.', 1),
    [directory('folder', [file('folder/drawing.excalidraw'), file('folder/note.md')])]);
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('same.md'), sceneRow('same.md')], '.', 1), { code: 'TREE_SOURCE_CHANGED' });
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('note.md'), { ...sceneRow('drawing.excalidraw'), id: 'document:note.md' }], '.', 1),
    { code: 'TREE_SOURCE_CHANGED' });
  assert.throws(() => mergeWorkspaceDocumentTree([], [sceneRow('parent.bin'), row('parent.bin/child.md')], '.', 1), { code: 'TREE_NAME_CONFLICT' });
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('parent.md'), sceneRow('parent.md/child.excalidraw')], '.', 1), { code: 'TREE_NAME_CONFLICT' });
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('Drawing.excalidraw'), sceneRow('drawing.excalidraw')], '.', 1), { code: 'TREE_NAME_CONFLICT' });
  assert.throws(() => mergeWorkspaceDocumentTree([], [row('é.md'), sceneRow('e\u0301.md')], '.', 1), { code: 'TREE_NAME_CONFLICT' });
  const yjs = Array.from({ length: 5_001 }, (_, index) => row(`note-${index}.md`));
  const scenes = Array.from({ length: 5_000 }, (_, index) => sceneRow(`drawing-${index}.excalidraw`));
  assert.throws(() => mergeWorkspaceDocumentTree([], [...yjs, ...scenes], '.', 0), { code: 'NATIVE_CATALOGUE_TOO_LARGE', status: 413 });
});

test('Scene tree reads borrow the exact active read-only connection and compare both full catalogues without content reads', async () => {
  const f = await fixture(), scene = sceneRow('virtual/deep/drawing.excalidraw'); let sceneReads = 0;
  try {
    f.add('note.md');
    const dependencies: WorkspaceDocumentTreeDependencies = { ...f.dependencies,
      readSceneCatalogue: async (connection, current, options) => {
        assert.equal(connection, f.connection); assert(f.controls.active); assert(f.commands.includes('BEGIN READ ONLY'));
        assert.equal(current.workspaceId, f.workspace.workspaceId); assert.deepEqual(options, { paths: ['.'], maxEntries: 10_000 });
        sceneReads++; return structuredClone([scene]);
      } };
    assert.deepEqual(await readWorkspaceDocumentTree(f.workspace, '.', 2, { includeMetadata: false }, dependencies),
      [directory('virtual', [directory('virtual/deep', [file(scene.path)])]), file('note.md')]);
    assert.equal(sceneReads, 2); assert.equal(f.controls.catalogueReads, 2); assert.equal(f.controls.checkouts, 1);
    assert.equal(f.controls.closed, 1); assert.equal(f.controls.stateReads, 0); assert.equal(f.commands.at(-1), 'COMMIT');
    assert(!f.commands.some(sql => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)/u.test(sql)));
  } finally { await f.cleanup(); }
});

test('selected Scene-only logical folders need no physical tree or projection and preserve missing-state entries', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const dependencies: WorkspaceDocumentTreeDependencies = { ...f.dependencies,
      readSceneCatalogue: async (connection, _workspace, options) => {
        assert.equal(connection, f.connection); assert(f.controls.active); assert.deepEqual(options?.paths, ['virtual']); reads++;
        return [sceneRow('virtual/deep/drawing.excalidraw'), sceneRow('virtual/lost.bin', 'missing-state')];
      } };
    assert.deepEqual(await readWorkspaceDocumentTree(f.workspace, 'virtual', 1, {}, dependencies), [
      directory('virtual/deep', [file('virtual/deep/drawing.excalidraw')]), file('virtual/lost.bin')]);
    assert.equal(reads, 2); assert.equal(f.controls.physicalReads, 0); assert.equal(f.controls.stateReads, 0);
    await assert.rejects(fs.lstat(path.join(f.root, 'virtual')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('full Scene-header drift, failed catalogue and foreign scope reject without content or physical fallback', async () => {
  for (const fault of ['checkpoint-drift', 'sql', 'workspace', 'organization', 'path'] as const) {
    const f = await fixture(); let reads = 0;
    try {
      const dependencies: WorkspaceDocumentTreeDependencies = { ...f.dependencies,
        readSceneCatalogue: async connection => {
          assert.equal(connection, f.connection); assert(f.controls.active); reads++;
          if (fault === 'sql') throw new Error('Unknown Scene catalogue failure.');
          const scene = sceneRow(fault === 'path' ? 'outside/drawing.excalidraw' : 'drawing.excalidraw');
          if (fault === 'checkpoint-drift' && reads === 2) scene.checkpoint_sequence = 2;
          if (fault === 'workspace') scene.workspace_id = 'foreign-workspace';
          if (fault === 'organization') scene.organization_id = 'foreign-organization';
          return [scene];
        } };
      // The path fault is requested from a distinct existing directory, so it
      // cannot be mistaken for an absent selected directory.
      if (fault === 'path') await fs.mkdir(path.join(f.root, 'inside'));
      await assert.rejects(readWorkspaceDocumentTree(f.workspace, fault === 'path' ? 'inside' : '.', 1, {}, dependencies),
        fault === 'sql' ? /Unknown Scene catalogue failure/u : { code: 'TREE_SOURCE_CHANGED' });
      assert.equal(f.controls.stateReads, 0); assert(f.commands.includes('ROLLBACK')); assert(!f.commands.includes('COMMIT'));
      if (['sql', 'workspace', 'organization'].includes(fault)) assert.equal(f.controls.physicalReads, 0);
    } finally { await f.cleanup(); }
  }
});

test('an active Scene or other-provider file ancestor blocks selected folders on the same read transaction', async () => {
  const f = await fixture();
  try {
    f.controls.ancestorPath = 'drawing.excalidraw';
    await assert.rejects(readWorkspaceDocumentTree(f.workspace, 'drawing.excalidraw/child', 0, {}, f.dependencies),
      { code: 'ARCHIVE_NAME_CONFLICT', status: 409 });
    assert.equal(f.controls.physicalReads, 0); assert.equal(f.controls.stateReads, 0);
    assert(f.commands.some(sql => sql.includes('UNION ALL SELECT s.path FROM collaboration_excalidraw_states')));
    assert(f.commands.includes('ROLLBACK')); assert(!f.commands.includes('COMMIT'));
  } finally { await f.cleanup(); }
});
