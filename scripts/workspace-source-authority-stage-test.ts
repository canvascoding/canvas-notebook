import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { originalPhysicalByteHash, previewStagedWorkspaceLinkEffects } from '../app/lib/markdown/workspace-physical-link-inventory';
import { stageWorkspaceLinkSourceAuthority } from '../app/lib/markdown/workspace-source-authority-stage';

const workspaceId = 'source-authority-workspace';
// SQL-trace/FS fixture only, not a PG concurrency or authority proof.
const persistedStates = new Map<string, PersistedCollaborationState>();
function context(rootPath: string): WorkspaceContext {
  return { workspaceId, rootPath, workspaceType: 'personal', organizationId: null, legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true, canCreatePublicLinks: true, canRunAgent: true } };
}
function record(filePath: string, authority: WorkspaceDocumentCatalogueEntry['authority']): WorkspaceDocumentCatalogueEntry {
  return { id: `document:${filePath}`, path: filePath, workspace_id: workspaceId, organization_id: null, lineage_id: authority === 'initialized' ? `lineage:${filePath}` : null,
    status: 'active', state_version: authority === 'pristine' ? 0 : 7, yjs_state_lifecycle: authority === 'pristine' ? 'never_initialized' : 'initialized',
    has_persisted_state: authority === 'initialized', has_state_history: authority !== 'pristine', lifecycle_generation: authority === 'initialized' ? 1 : null,
    state_status: authority === 'initialized' ? 'active' : null, state_path: authority === 'initialized' ? filePath : null,
    state_workspace_id: authority === 'initialized' ? workspaceId : null, state_organization_id: null, authority };
}
function native(markdown: string, filePath: string): PersistedCollaborationState {
  const doc = createRichMarkdownYDoc(markdown, 'tiptap_blocks');
  try {
    const state: PersistedCollaborationState = { documentId: `document:${filePath}`, workspaceId, organizationId: null, path: filePath, representation: 'tiptap_blocks',
      lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 7,
      persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
      hasBom: false, newlineStyle: 'lf', degraded: false, status: 'active' };
    persistedStates.set(state.documentId, state); return state;
  } finally { doc.destroy(); }
}
function database(rows: WorkspaceDocumentCatalogueEntry[], options: { fail?: 'lock' | 'catalogue' | 'close'; after?: WorkspaceDocumentCatalogueEntry[]; states?: PersistedCollaborationState[] } = {}) {
  let transaction = false; let fence = false; let reads = 0; const trace: string[] = [];
  const sourceRows = (documentId: unknown) => {
    const document = rows.find(row => row.id === documentId); assert(document);
    const registry = { ...document, workspace_type: 'personal',
      provider: 'yjs', customer_id: null, project_id: null, lineage_id_actual: document.lineage_id,
      lineage_workspace_id: workspaceId, lineage_workspace_type: 'personal', lineage_organization_id: null,
      lineage_customer_id: null, lineage_project_id: null, lineage_path: document.path, lineage_status: 'active',
      lineage_archived_at: null, lineage_trash_entry_id: null };
    const state = (options.states ?? [...persistedStates.values()]).find(candidate => candidate.documentId === documentId); assert(state);
    const raw = { document_id: state.documentId, workspace_id: state.workspaceId, organization_id: state.organizationId, path: state.path,
      representation: state.representation, lifecycle_generation: String(state.lifecycleGeneration), schema_version: String(state.schemaVersion),
      status: state.status, document_sequence: String(state.documentSequence), persisted_at: String(state.persistedAt),
      checkpoint_sequence: String(state.checkpointSequence), checkpointed_at: state.checkpointedAt === null ? null : String(state.checkpointedAt),
      newline_style: state.newlineStyle, has_bom: state.hasBom ? '1' : '0', degraded: state.degraded ? '1' : '0',
      canonical_hash: state.canonicalHash, serialized_hash: state.serializedHash, projection_error_code: state.projectionError?.code ?? null,
      projection_error_sequence: state.projectionError ? String(state.projectionError.sequence) : null,
      projection_error_generation: state.projectionError ? String(state.lifecycleGeneration) : null,
      projection_error_phase: state.projectionError?.phase ?? null, projection_error_permanent: state.projectionError?.permanent ? '1' : '0',
      yjs_state: state.yjsState, state_vector: state.stateVector };
    return { registry, raw, state };
  };
  const connection = {
    run: async (sql: string) => {
      trace.push(sql);
      if (sql.startsWith('BEGIN')) transaction = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert(transaction); transaction = false; fence = false; }
    },
    get: async (sql: string) => {
      trace.push(sql);
      if (sql.includes('pg_advisory_xact_lock_shared')) {
        assert(transaction); if (options.fail === 'lock') throw new Error('fixture lock failure'); fence = true; return {};
      }
      assert(fence);
      assert(sql.includes('LEFT JOIN collaboration_documents')); return undefined;
    },
    all: async (sql: string, params: unknown[]) => {
      trace.push(sql); assert(fence);
      if (sql.startsWith('SELECT requested.document_id')) return (params[0] as string[]).map(documentId => {
        const { registry, raw, state } = sourceRows(documentId);
        return { ...registry, requested_document_id: documentId, requested_lineage_id: registry.lineage_id,
          ...Object.fromEntries(Object.entries(raw).filter(([key]) => !['yjs_state', 'state_vector', 'canonical_hash', 'serialized_hash'].includes(key))
            .map(([key, value]) => [`state_${key}`, value])), state_bytes: state.yjsState.byteLength, vector_bytes: state.stateVector.byteLength };
      });
      if (sql.startsWith('WITH expected AS MATERIALIZED')) return (params[0] as string[]).map(documentId => sourceRows(documentId).raw);
      assert(sql.includes('has_state_history'));
      if (options.fail === 'catalogue') throw new Error('fixture catalogue failure');
      const selected = reads++ && options.after ? options.after : rows;
      const scopes = params[1] as string[];
      return structuredClone(selected.filter((row) => scopes.some((scope) => !scope || row.path === scope || row.path.startsWith(`${scope}/`))));
    },
    close: async () => { trace.push('close'); if (options.fail === 'close') throw new Error('fixture close failure'); },
  } as unknown as SqlConnection;
  return { connection, trace, assertFence: () => assert(fence && transaction) };
}
async function fixture(run: (root: string, workspace: WorkspaceContext) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-source-authority-'));
  try { await run(root, context(root)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

for (const environmentName of ['venv', '.venv']) {
  test(`document index excludes a marked ${environmentName} without changing mutation observations`, async () => fixture(async (root, workspace) => {
    await fs.writeFile(path.join(root, 'source.md'), '[Target](target.md)');
    await fs.writeFile(path.join(root, 'target.md'), '# Target');
    await fs.mkdir(path.join(root, environmentName, 'bin'), { recursive: true });
    await fs.writeFile(path.join(root, environmentName, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\n');
    await fs.writeFile(path.join(root, environmentName, 'dependency.md'), '[Unrelated](missing.md)');
    await fs.symlink('/outside-workspace/python', path.join(root, environmentName, 'bin/python'));

    const indexed = database([]);
    const options = { sourceScope: 'document-index' as const, openConnection: async () => indexed.connection };
    const stage = await stageWorkspaceLinkSourceAuthority(workspace, options);
    assert.equal(stage.coverage.complete, true, JSON.stringify(stage.coverage.gaps));
    assert.deepEqual(stage.sources.map(source => source.kind === 'physical' ? source.inventory.path : source.inventory.document.path).sort(),
      ['source.md', 'target.md']);
    assert(stage.scope.excludedPaths.includes(environmentName));
    assert.equal(stage.executionReady, false);
    const preview = previewStagedWorkspaceLinkEffects(stage, { kind: 'rename', sourcePath: 'target.md', destinationPath: 'renamed.md' });
    assert.equal(preview.readiness, 'blocked', 'Document-index observations cannot certify a mutation preview.');
    assert.deepEqual(preview.effects, []);

    const strict = database([]);
    const mutation = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => strict.connection });
    assert.equal(mutation.coverage.complete, false);
    assert.equal(mutation.readiness, 'blocked');
    assert.deepEqual(mutation.sources, []);
    assert.equal(mutation.scope.excludedPaths.includes(environmentName), false);
    assert.equal(await fs.readlink(path.join(root, environmentName, 'bin/python')), '/outside-workspace/python');
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), '[Target](target.md)');
  }));
}

test('document index keeps authored documents in a directory named venv without a real environment marker', async () => fixture(async (root, workspace) => {
  await fs.mkdir(path.join(root, 'venv'));
  await fs.writeFile(path.join(root, 'venv/notes.md'), '# Authored environment notes');
  const db = database([]);
  const options = { sourceScope: 'document-index' as const, openConnection: async () => db.connection };
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, options);
  assert.equal(stage.coverage.complete, true);
  assert.equal(stage.scope.excludedPaths.includes('venv'), false);
  assert.equal(stage.sources[0].kind === 'physical' && stage.sources[0].inventory.path, 'venv/notes.md');
}));

test('document index reports an unrelated symlink while retaining independently verified document sources', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'source.md'), '[Target](target.md)');
  await fs.writeFile(path.join(root, 'target.md'), '# Target');
  await fs.symlink('/outside-workspace/secret.md', path.join(root, 'alias.md'));
  const db = database([]);
  const options = { sourceScope: 'document-index' as const, openConnection: async () => db.connection };
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, options);
  assert.equal(stage.coverage.complete, false);
  assert(stage.coverage.gaps.some(gap => gap.code === 'unsafe-physical-source' && gap.path === 'alias.md'));
  assert.deepEqual(stage.sources.map(source => source.kind === 'physical' ? source.inventory.path : source.inventory.document.path).sort(),
    ['source.md', 'target.md']);
  assert.equal(stage.sources.some(source => source.kind === 'physical' && source.inventory.path === 'alias.md'), false);
}));

test('unregistered and explicitly never-initialized Markdown gain byte-proven preview coverage without native identities', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'note.md'), '[Target](target.md) and [[Shared|Visible]]');
  await fs.writeFile(path.join(root, 'target.md'), '---\naliases: [Shared]\n---\n\n# Target');
  const db = database([record('target.md', 'pristine')]); const reads: string[] = [];
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
    afterSourceFingerprint: async (filePath) => { db.assertFence(); reads.push(filePath); } });
  assert.equal(stage.coverage.complete, true, JSON.stringify(stage.coverage.gaps)); assert.equal(stage.executionReady, false);
  assert.equal(stage.readiness, 'requires-import-and-rebinding'); assert.equal(stage.sources.length, 2);
  const note = stage.sources.find((source) => source.kind === 'physical' && source.inventory.path === 'note.md')!;
  assert.equal(note.kind, 'physical'); if (note.kind !== 'physical') throw new Error('fixture');
  assert.equal(note.inventory.authority.kind, 'unregistered'); assert.equal(note.inventory.links.length, 2);
  assert.equal('documentId' in note.inventory, false); assert.equal('stateVector' in note.inventory, false); assert.equal('documentSequence' in note.inventory, false);
  assert.equal(note.inventory.physical.byteHash, originalPhysicalByteHash(await fs.readFile(path.join(root, 'note.md'))));
  assert.deepEqual(reads.sort(), ['note.md', 'target.md']);
  const rename = previewStagedWorkspaceLinkEffects(stage, { kind: 'rename', sourcePath: 'target.md', destinationPath: 'new.md' });
  assert.equal(rename.readiness, 'requires-import-and-rebinding'); assert.equal(rename.effects.length, 2);
  assert(rename.effects.every((effect) => effect.nextTargetPath === 'new.md' && effect.sourceEvidence.kind === 'physical'));
  const deletion = previewStagedWorkspaceLinkEffects(stage, { kind: 'delete', sourcePath: 'target.md' });
  assert.equal(deletion.effects.length, 2); assert(deletion.effects.every((effect) => effect.action === 'unlink' && effect.nextTargetPath === null));
  assert(db.trace[0].includes('READ COMMITTED READ ONLY')); assert.equal(db.trace.at(-2), 'COMMIT');
}));

test('BOM, emoji frontmatter and exact UTF-16/UTF-8 spans survive LF, CRLF and mixed original bytes', async () => {
  for (const eol of ['\n', '\r\n']) await fixture(async (root, workspace) => {
    const text = `\uFEFF---${eol}title: 😀${eol}aliases: ["😀 Alias"]${eol}tags: [one]${eol}---${eol}${eol}😀 [Label](target.md#Heading) [[target#Heading|Visible]]${eol}`;
    await fs.writeFile(path.join(root, 'note.md'), text); await fs.writeFile(path.join(root, 'target.md'), '# Heading');
    const db = database([]); const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
    assert.equal(stage.coverage.complete, true, JSON.stringify(stage.coverage.gaps));
    const source = stage.sources.find((source) => source.kind === 'physical' && source.inventory.path === 'note.md')!;
    if (source.kind !== 'physical') throw new Error('fixture');
    const inventory = source.inventory; assert.equal(inventory.hasBom, true); assert.equal(inventory.lineEndings.style, eol === '\n' ? 'lf' : 'crlf');
    assert.equal(Buffer.from(inventory.originalBytes).toString('utf8'), text); assert.equal(inventory.metadata.title, '😀');
    assert.deepEqual(inventory.metadata.aliases, ['😀 Alias']); assert.equal(inventory.links.length, 2);
    for (const link of inventory.links) {
      assert.equal(text.slice(link.targetRange.startUtf16, link.targetRange.endUtf16), link.targetLiteral);
      assert.equal(Buffer.from(inventory.originalBytes).subarray(link.targetRange.startUtf8Byte, link.targetRange.endUtf8Byte).toString('utf8'), link.targetLiteral);
      assert.equal(text.slice(link.syntaxRange.startUtf16, link.syntaxRange.endUtf16), link.raw);
      assert.equal(link.targetStart, text.indexOf(link.targetLiteral, link.start));
    }
    assert.equal(inventory.frontmatterPrefix, text.slice(0, text.indexOf(`${eol}${eol}😀`) + eol.length));
  });
  await fixture(async (root, workspace) => {
    await fs.writeFile(path.join(root, 'note.md'), 'one\r\ntwo\nthree\r'); const db = database([]);
    const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
    const source = stage.sources[0]; if (source.kind !== 'physical') throw new Error('fixture');
    assert.deepEqual(source.inventory.lineEndings, { style: 'bare-cr', lf: 1, crlf: 1, bareCr: 1 });
  });
});

test('initialized native documents renamed as binary never read stale physical content and join physical inbound graph', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'native.bin'), Buffer.from([0xff, 0, 0xfe]));
  await fs.writeFile(path.join(root, 'incoming.md'), '[Native](native.bin)');
  const db = database([record('native.bin', 'initialized')]); const observed: string[] = [];
  const persisted = native('[Physical](incoming.md)', 'native.bin');
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
    loadState: async () => { db.assertFence(); return persisted; },
    afterSourceFingerprint: async (filePath) => { db.assertFence(); observed.push(filePath); } });
  assert.equal(stage.coverage.complete, true, JSON.stringify(stage.coverage.gaps)); assert.deepEqual(observed, ['incoming.md']);
  assert(stage.sources.some((source) => source.kind === 'native' && source.inventory.document.path === 'native.bin'));
  const preview = previewStagedWorkspaceLinkEffects(stage, { kind: 'rename', sourcePath: 'native.bin', destinationPath: 'renamed.bin' });
  assert(preview.effects.some((effect) => effect.sourcePath === 'incoming.md' && effect.sourceEvidence.kind === 'physical'));
  assert.equal(preview.executionReady, false);
}));

test('missing-state, legacy-unknown and history evidence prohibit disk fallback for every extension', async () => fixture(async (root, workspace) => {
  const rows = [record('missing.md', 'missing-state'), { ...record('legacy.bin', 'pristine'), yjs_state_lifecycle: 'legacy_unknown' as const },
    { ...record('history.md', 'pristine'), has_state_history: true }];
  for (const row of rows) await fs.writeFile(path.join(root, row.path), '[Stale](target.md)');
  const db = database(rows); const reads: string[] = [];
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
    afterSourceFingerprint: async (filePath) => { reads.push(filePath); } });
  assert.equal(stage.readiness, 'blocked'); assert.deepEqual(reads, []); assert.equal(stage.sources.length, 0);
  assert.equal(stage.coverage.gaps.filter((gap) => gap.code === 'missing-native-state').length, 3);
}));

test('database/lock/scope failures fail closed before any physical source is read', async () => {
  for (const failure of ['lock', 'catalogue'] as const) await fixture(async (root, workspace) => {
    await fs.writeFile(path.join(root, 'note.md'), '[Target](target.md)'); const db = database([], { fail: failure }); let reads = 0;
    const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
      afterSourceFingerprint: async () => { reads += 1; } });
    assert.equal(stage.coverage.complete, false); assert.equal(stage.sources.length, 0); assert.equal(reads, 0); assert(db.trace.includes('ROLLBACK'));
  });
  await fixture(async (root, workspace) => {
    await fs.writeFile(path.join(root, 'note.md'), '[Target](target.md)'); const foreign = { ...record('note.md', 'pristine'), organization_id: 'other' };
    const db = database([foreign]); let reads = 0;
    const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection, afterSourceFingerprint: async () => { reads += 1; } });
    assert.equal(stage.sources.length, 0); assert.equal(reads, 0); assert.equal(stage.readiness, 'blocked');
  });
});

test('a pristine-to-native catalogue transition invalidates the entire staged authority proof', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'note.md'), '[Target](target.md)');
  const db = database([record('note.md', 'pristine')], { after: [record('note.md', 'initialized')] });
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
  assert.equal(stage.sources.length, 0); assert(stage.coverage.gaps.some((gap) => gap.code === 'source-authority-changed')); assert(db.trace.includes('ROLLBACK'));
  assert(stage.coverage.gaps.some((gap) => gap.code === 'physical-authority-changed'));
}));

test('inode replacement and a parent symlink introduced after async fingerprint are rejected without certifying bytes', async () => {
  for (const mode of ['inode', 'parent-symlink'] as const) await fixture(async (root, workspace) => {
    await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'folder/note.md'), '[Target](target.md)');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-source-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'note.md'), 'Outside original must never be staged');
      const db = database([]);
      const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
        afterSourceFingerprint: async () => {
          db.assertFence();
          if (mode === 'inode') { await fs.rename(path.join(root, 'folder/note.md'), path.join(root, 'folder/old.md')); await fs.writeFile(path.join(root, 'folder/note.md'), '[Other](other.md)'); }
          else { await fs.rename(path.join(root, 'folder'), path.join(root, 'original-folder')); await fs.symlink(outside, path.join(root, 'folder')); }
        } });
      assert.equal(stage.readiness, 'blocked'); assert.equal(stage.sources.length, 0);
      assert.equal(JSON.stringify(stage).includes('Outside original must never'), false);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});

test('MDX, HTML, malformed frontmatter, unreadable and invalid UTF-8 sources stay explicit gaps', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'source.mdx'), '<Component href="target.md" />');
  await fs.writeFile(path.join(root, 'page.html'), '<a href="target.md">Known</a>');
  await fs.writeFile(path.join(root, 'bad-frontmatter.md'), '---\naliases: [\n---\n\n[Target](target.md)');
  await fs.writeFile(path.join(root, 'invalid.md'), Buffer.from([0xff, 0xfe]));
  await fs.writeFile(path.join(root, 'denied.md'), '[Denied](target.md)'); await fs.chmod(path.join(root, 'denied.md'), 0);
  try {
    const db = database([]); const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
    assert.equal(stage.coverage.complete, false); assert.equal(stage.readiness, 'blocked');
    for (const code of ['unsupported-mdx-source', 'uninspected-html', 'invalid-frontmatter', 'unreadable-physical-source']) assert(stage.coverage.gaps.some((gap) => gap.code === code), code);
    const html = stage.coverage.gaps.find((gap) => gap.path === 'page.html')!; assert.deepEqual(html.htmlTargets, ['target.md']);
    assert.equal(stage.sources.some((source) => source.kind === 'physical' && source.inventory.path === 'source.mdx'), false);
  } finally { await fs.chmod(path.join(root, 'denied.md'), 0o600); }
}));

test('count, depth, source-byte and total-byte limits report incomplete coverage', async () => {
  for (const limits of [{ maxPaths: 1 }, { maxDepth: 1 }, { maxSourceBytes: 2 }, { maxTotalSourceBytes: 2 }]) await fixture(async (root, workspace) => {
    await fs.mkdir(path.join(root, 'a/b'), { recursive: true }); await fs.writeFile(path.join(root, 'a/b/note.md'), 'Long source');
    const db = database([]); const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection, limits });
    assert.equal(stage.readiness, 'blocked'); assert.equal(stage.coverage.complete, false); assert(stage.coverage.gaps.length > 0);
  });
});

test('original-byte or span tampering changes the private proof and never yields executable preview effects', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'note.md'), '[Target](target.md)'); await fs.writeFile(path.join(root, 'target.md'), '# Target');
  const db = database([]); const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
  const tampered = structuredClone(stage); const source = tampered.sources.find((value) => value.kind === 'physical' && value.inventory.path === 'note.md')!;
  if (source.kind !== 'physical') throw new Error('fixture'); source.inventory.originalBytes[0] = 0;
  const preview = previewStagedWorkspaceLinkEffects(tampered, { kind: 'delete', sourcePath: 'target.md' });
  assert.equal(preview.readiness, 'blocked'); assert(preview.coverage.gaps.some((gap) => gap.code === 'stage-proof-mismatch'));
  assert(preview.coverage.gaps.some((gap) => gap.code === 'physical-proof-mismatch')); assert.equal(preview.executionReady, false);
  assert.notEqual(nativeLinkJsonProof(stage), nativeLinkJsonProof(tampered));
}));

test('a native peer edit during staged physical reads invalidates the native proof without disk fallback', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'native.bin'), 'Stale projection'); await fs.writeFile(path.join(root, 'incoming.md'), '[Native](native.bin)');
  const initial = native('[Before](incoming.md)', 'native.bin'); const later = { ...native('[After](incoming.md)', 'native.bin'), documentSequence: 8 };
  const db = database([record('native.bin', 'initialized')], { states: [initial] }); let loads = 0; const physicalReads: string[] = [];
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
    loadState: async () => loads++ ? later : initial, afterSourceFingerprint: async (filePath) => { physicalReads.push(filePath); } });
  assert.equal(stage.readiness, 'blocked'); assert(stage.coverage.gaps.some((gap) => gap.code === 'native-source-changed'));
  assert.equal(stage.sources.length, 0); assert.deepEqual(physicalReads, ['incoming.md']);
  // Actual public preview + actual collector/E5/lifecycle code, with declared
  // SQL/Principal mechanics only. No genuine PG/authorization or mutation proof.
  const [tsModule, transaction, admission, jobScope, htmlPreparation, pathContract] = await Promise.all([
    import('typescript'), import('../app/lib/collaboration/lifecycle-transaction'),
    import('../app/lib/collaboration/room-admission-contract'), import('../app/lib/files/workspace-operation-job-scope'),
    import('../app/lib/files/workspace-path-html-import-preparation'), import('../app/lib/mcp/server/workspace-path-tool-contract'),
  ]);
  const ts = tsModule.default;
  const staleSource = ts.createSourceFile('workspace-file-operation-preview.ts', await fs.readFile(path.resolve(
    'app/lib/markdown/workspace-file-operation-preview.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const staleClass = staleSource.statements.find(statement => ts.isClassDeclaration(statement)
    && statement.name?.text === 'WorkspacePreviewStaleError');
  assert(staleClass);
  const staleExports = {} as { WorkspacePreviewStaleError: new () => Error };
  new Function('exports', ts.transpileModule(staleClass.getText(staleSource), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(staleExports);
  const Stale = staleExports.WorkspacePreviewStaleError;
  const sourceModule = await import('../app/lib/markdown/workspace-source-authority-stage');
  const compiled = ts.transpileModule(await fs.readFile(path.resolve(
    'app/lib/files/workspace-path-import-operation-preview.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const changed = (value: import('../app/lib/markdown/workspace-source-authority-stage').WorkspaceLinkSourceAuthorityObservation) => {
    // Missing on the old product: no missing-export startup failure may count as RED.
    const getter: unknown = Reflect.get(sourceModule, 'requiresWorkspaceLinkSourceAuthorityRevalidation');
    return typeof getter === 'function' && getter(value) === true;
  };
  type Mode = 'native' | 'catalogue' | 'catalogue-missing' | 'sql' | 'corrupt' | 'unrelated-gap' | 'auth' | 'current-sql' | 'close' | 'rollback';
  const runPreview = async (mode: Mode) => {
    const states = [initial];
    const traced = database([record('native.bin', 'initialized')], { states,
      ...(mode === 'catalogue' ? { after: [{ ...record('native.bin', 'initialized'), state_version: 8 }] }
        : mode === 'catalogue-missing' ? { after: [record('native.bin', 'missing-state')] } : {}) });
    const realAll = traced.connection.all, realGet = traced.connection.get, realRun = traced.connection.run;
    let binaryReads = 0, headerReads = 0, currentChecks = 0, principalDepth = 0, htmlCalls = 0;
    let observation: import('../app/lib/markdown/workspace-source-authority-stage').WorkspaceLinkSourceAuthorityObservation | undefined;
    const currentFailure = Object.assign(new Error('Declared fresh current failure.'), { status: mode === 'auth' ? 403 : 503,
      code: mode === 'auth' ? 'PRINCIPAL_AUTH_REVOKED' : '55P03' });
    const cleanupFailure = new Error('Declared cleanup failure.');
    const databaseConnection: SqlConnection = {
      ...traced.connection,
      get: async (sql, values) => {
        if (sql.includes('pg_try_advisory_xact_lock_shared')) {
          // The existing SQL-trace fixture models the acquired shared fence.
          await realGet('SELECT pg_advisory_xact_lock_shared($1::bigint)', values); return { locked: true };
        }
        return realGet(sql, values);
      },
      all: async (sql, values) => {
        if (sql.startsWith('SELECT requested.document_id') && ++headerReads === 2 && mode === 'sql') throw currentFailure;
        const rows = await realAll(sql, values);
        if (sql.startsWith('WITH expected AS MATERIALIZED') && ++binaryReads === 1 && mode !== 'sql') {
          states[0] = mode === 'corrupt' ? { ...later, yjsState: new Uint8Array([0xff]) } : later;
        }
        return rows;
      },
      run: async (sql, values) => {
        if (sql === 'ROLLBACK' && mode === 'rollback') throw cleanupFailure;
        return realRun(sql, values);
      },
      close: async error => { await traced.connection.close(error); if (mode === 'close') throw cleanupFailure; },
    };
    const principal = Object.freeze({ fixture: 'declared-current-principal' }) as unknown as
      import('../app/lib/workspaces/request-principal').WorkspaceRequestPrincipal;
    const unexpected = () => { throw new Error('Unexpected preparation arm in rejection-only regression.'); };
    const mocks: Record<string, unknown> = {
      'server-only': {}, 'node:util': await import('node:util'), '../db': { openDb: async () => databaseConnection },
      '../collaboration/lifecycle-transaction': transaction,
      '../collaboration/native-text-session-activation': { authenticatedNativeTextSessionEnabled: () => true },
      '../collaboration/room-admission-contract': admission,
      '../markdown/workspace-file-operation-preview': staleExports,
      '../markdown/workspace-source-authority-stage': { ...sourceModule,
        readWorkspaceLinkSourceAuthorityOnConnection: async (...args: Parameters<typeof sourceModule.readWorkspaceLinkSourceAuthorityOnConnection>) => {
          observation = await sourceModule.readWorkspaceLinkSourceAuthorityOnConnection(...args); return observation;
        } },
      '../workspaces/request-principal': { withWorkspaceRequestPrincipalOnConnection: async (actual: SqlConnection,
        supplied: object, read: (access: { workspace: WorkspaceContext; assertCurrent: () => Promise<void> }) => Promise<unknown>) => {
        assert.equal(typeof actual.get, 'function'); assert.equal(supplied, principal);
        assert.deepEqual(traced.trace.slice(0, 2), ['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE']);
        principalDepth++;
        try { return await read({ workspace, assertCurrent: async () => {
          currentChecks++; if (currentChecks === 2 && (mode === 'auth' || mode === 'current-sql')) throw currentFailure;
        } }); } finally { principalDepth--; }
      } },
      '../mcp/server/document-read-principal': { withDirectMcpWorkspaceMovePrincipalOnConnection: unexpected,
        withDirectMcpWorkspaceDeletePrincipalOnConnection: unexpected },
      './workspace-operation-job-scope': jobScope,
      './workspace-path-cohort-delete-preparation': { isWorkspaceCohortDeleteRequest: unexpected,
        createWorkspacePathCohortDeletePreparation: unexpected },
      './workspace-path-physical-delete-preparation-v5': { createWorkspacePathPhysicalDeletePreparationPlanV5: unexpected },
      './workspace-path-import-preparation-plan': { createWorkspacePathImportPreparationPlanV1: unexpected },
      './workspace-path-html-no-import-preparation': { createWorkspacePathHtmlNoImportPreparationPlanV2: unexpected },
      './workspace-path-html-native-delete-preparation': { createWorkspacePathHtmlNativeDeletePreparationPlanV3: unexpected },
      './workspace-path-html-import-preparation': { createWorkspacePathHtmlImportPreparationPlanV4:
        (...args: Parameters<typeof htmlPreparation.createWorkspacePathHtmlImportPreparationPlanV4>) => {
          htmlCalls++; return htmlPreparation.createWorkspacePathHtmlImportPreparationPlanV4(...args);
        } },
    };
    const exported = {} as typeof import('../app/lib/files/workspace-path-import-operation-preview');
    new Function('require', 'module', 'exports', compiled)((name: string) => {
      assert(Object.hasOwn(mocks, name), `Unexpected preview runtime import ${name}`); return mocks[name];
    }, { exports: exported }, exported);
    const invalidPath = path.join(root, 'unrelated-alias.md');
    if (mode === 'unrelated-gap') await fs.symlink('incoming.md', invalidPath);
    let received: unknown;
    try { await exported.readWorkspacePathImportPreparationPlan({ principal: { kind: 'request', principal }, kind: 'rename',
      selections: [{ sourcePath: 'native.bin', destinationPath: 'renamed.bin' }] }); }
    catch (error) { received = error; }
    finally { if (mode === 'unrelated-gap') await fs.unlink(invalidPath); }
    assert(observation, `Collector was not reached: ${received instanceof Error ? `${received.name}: ${received.message}` : String(received)}`);
    assert.equal(principalDepth, 0); assert.equal(traced.trace.at(-1), 'close');
    assert(!traced.trace.includes('COMMIT')); assert.equal(observation.stage.sources.length, 0);
    assert.equal(observation.privateCatalogue, undefined); assert.equal(observation.stage.coverage.complete, false);
    assert.equal(observation.stage.executionReady, false);
    assert.equal(await fs.readFile(path.join(root, 'native.bin'), 'utf8'), 'Stale projection');
    assert.equal(await fs.readFile(path.join(root, 'incoming.md'), 'utf8'), '[Native](native.bin)');
    return { received, observation, traced, currentChecks, htmlCalls, currentFailure, cleanupFailure };
  };
  // This is the first new oracle: old public preview reports the actual E5
  // NATIVE_SOURCE_EVIDENCE_INVALID here, not a missing new export at startup.
  for (const mode of ['native', 'catalogue'] as const) {
    const result = await runPreview(mode);
    assert.equal(result.received instanceof Stale, true,
      `Expected PREVIEW_STALE for two valid differing reads; got ${(result.received as { code?: string })?.code}`);
    const failure = result.received as { status?: number; code?: string };
    assert.equal(failure.status, 409); assert.equal(failure.code, 'PREVIEW_STALE');
    assert.equal(pathContract.normalizePublicWorkspacePathErrorCode(failure.code), 'PATH_PLAN_CHANGED');
    assert.equal(result.currentChecks, 2); assert.equal(result.htmlCalls, 0);
    assert(result.traced.trace.includes('ROLLBACK')); assert.equal(changed(result.observation), true);
    assert.equal(changed(structuredClone(result.observation)), false);
    assert.equal(changed({ ...result.observation }), false);
    assert.equal(changed(new Proxy(result.observation, {})), false);
  }
  for (const mode of ['sql', 'corrupt', 'unrelated-gap', 'catalogue-missing'] as const) {
    const result = await runPreview(mode);
    assert.equal(result.received instanceof Stale, false); assert.equal(changed(result.observation), false);
    assert.equal((result.received as { code?: string }).code, 'NATIVE_SOURCE_EVIDENCE_INVALID');
    assert.equal(result.currentChecks, 1); assert.equal(result.htmlCalls, 1); assert(result.traced.trace.includes('ROLLBACK'));
  }
  for (const mode of ['auth', 'current-sql', 'close', 'rollback'] as const) {
    const result = await runPreview(mode);
    if (mode === 'auth' || mode === 'current-sql') assert.equal(result.received, result.currentFailure);
    else if (mode === 'close') {
      const failure = result.received as { code?: string; status?: number; cause?: unknown };
      assert.equal(failure.code, 'PATH_IMPORT_PREVIEW_UNAVAILABLE'); assert.equal(failure.status, 503);
      assert.equal(failure.cause, result.cleanupFailure);
    }
    else { assert(result.received instanceof AggregateError); assert(result.received.errors.includes(result.cleanupFailure)); }
    assert.equal(result.htmlCalls, 0); assert.equal(result.currentChecks, 2);
  }
}));

test('directory inode replacement retaining the original file inode is detected after async fingerprint', async () => fixture(async (root, workspace) => {
  await fs.mkdir(path.join(root, 'outer/inner'), { recursive: true }); await fs.writeFile(path.join(root, 'outer/inner/note.md'), 'Original');
  const originalStat = await fs.lstat(path.join(root, 'outer/inner/note.md')); const db = database([]);
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
    afterSourceFingerprint: async () => {
      await fs.rename(path.join(root, 'outer/inner'), path.join(root, 'outer/previous'));
      await fs.mkdir(path.join(root, 'outer/inner')); await fs.rename(path.join(root, 'outer/previous/note.md'), path.join(root, 'outer/inner/note.md'));
      assert.equal((await fs.lstat(path.join(root, 'outer/inner/note.md'))).ino, originalStat.ino);
    } });
  assert.equal(stage.readiness, 'blocked'); assert.equal(stage.sources.length, 0);
}));

test('registry-only initialized documents retain real native proofs without a fake filesystem fingerprint', async () => fixture(async (_root, workspace) => {
  const state = native('[Native](missing-target.md)', 'native.bin'); const db = database([record('native.bin', 'initialized')]); let physicalReads = 0;
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection, loadState: async () => state,
    afterSourceFingerprint: async () => { physicalReads += 1; } });
  assert.equal(stage.coverage.complete, true); assert.equal(stage.readiness, 'native-coordinator-required'); assert.equal(stage.executionReady, false);
  assert.equal(stage.sources[0].kind, 'native'); assert.equal(stage.namespace[0].filesystemIdentity, null);
  assert.equal(stage.namespace[0].documentId, state.documentId); assert.equal(stage.namespace[0].lifecycleGeneration, 1); assert.equal(physicalReads, 0);
}));

test('inline HTML limitations and shared reference-definition unlink remain blocking before preparation', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'html.md'), '<img srcset="one.png 1x, two.png 2x">');
  await fs.writeFile(path.join(root, 'references.md'), '[One][target] [Two][target]\n\n[target]: target.md');
  await fs.writeFile(path.join(root, 'target.md'), '# Target'); const db = database([]);
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
  assert(stage.coverage.gaps.some((gap) => gap.path === 'html.md' && gap.code === 'uninspected-html'));
  const preview = previewStagedWorkspaceLinkEffects(stage, { kind: 'delete', sourcePath: 'target.md' });
  assert.equal(preview.readiness, 'blocked'); assert(preview.coverage.gaps.some((gap) => gap.code === 'unsupported-reference-unlink'));
}));

test('staged single-transition preview rejects basename capture and occupied destinations before import', async () => fixture(async (root, workspace) => {
  await fs.mkdir(path.join(root, 'one')); await fs.mkdir(path.join(root, 'two'));
  await fs.writeFile(path.join(root, 'note.md'), '[[Target]]'); await fs.writeFile(path.join(root, 'one/Target.md'), '# Target');
  await fs.writeFile(path.join(root, 'other.md'), '# Other'); const db = database([]);
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection });
  const capture = previewStagedWorkspaceLinkEffects(stage, { kind: 'rename', sourcePath: 'other.md', destinationPath: 'two/Target.md' });
  assert.equal(capture.readiness, 'blocked'); assert(capture.coverage.gaps.some((gap) => gap.code === 'resolution-changed'));
  const collision = previewStagedWorkspaceLinkEffects(stage, { kind: 'rename', sourcePath: 'other.md', destinationPath: 'note.md' });
  assert.equal(collision.readiness, 'blocked'); assert(collision.coverage.gaps.some((gap) => gap.code === 'destination-collision'));
}));

test('link bound rejects the whole over-limit source before creating partial physical spans', async () => fixture(async (root, workspace) => {
  await fs.writeFile(path.join(root, 'links.md'), '😀 [First](one.md) 🦊 [[two.md]]'); const db = database([]);
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection, limits: { maxLinks: 1 } });
  assert.equal(stage.coverage.complete, false); assert(stage.coverage.gaps.some((gap) => gap.code === 'source-link-limit'));
  const source = stage.sources.find((entry) => entry.kind === 'physical' && entry.inventory.path === 'links.md');
  assert(source && source.kind === 'physical'); assert.equal(source.inventory.links.length, 0);
  assert.equal(previewStagedWorkspaceLinkEffects(stage, { kind: 'delete', sourcePath: 'links.md' }).readiness, 'blocked');
}));

test('registry-only subtrees expose implied directories for folder rename and delete without physical claims', async () => fixture(async (_root, workspace) => {
  const inside = native('[Outside](../../outside.bin)', 'folder/nested/note.bin');
  const outside = native('[Inside](folder/nested/note.bin)', 'outside.bin');
  const states = new Map([inside, outside].map((state) => [state.documentId, state]));
  const db = database([record(inside.path, 'initialized'), record(outside.path, 'initialized')]);
  const stage = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection,
    loadState: async (_connection, documentId) => states.get(documentId) ?? null });
  assert.equal(stage.coverage.complete, true);
  for (const folderPath of ['folder', 'folder/nested']) {
    const entry = stage.namespace.find((candidate) => candidate.path === folderPath); assert(entry);
    assert.equal(entry.kind, 'directory'); assert(entry.identity.startsWith('registry-directory:'));
    assert.equal(entry.filesystemIdentity, null); assert.equal(entry.documentId, null); assert.equal(entry.lifecycleGeneration, null);
  }
  const renamed = previewStagedWorkspaceLinkEffects(stage, { kind: 'rename', sourcePath: 'folder', destinationPath: 'moved' });
  assert.equal(renamed.coverage.complete, true); assert.equal(renamed.executionReady, false);
  assert(renamed.effects.some((effect) => effect.sourcePath === outside.path && effect.nextTargetPath === 'moved/nested/note.bin'));
  assert(renamed.effects.some((effect) => effect.sourcePath === inside.path && effect.sourcePathAfter === 'moved/nested/note.bin'));
  const deleted = previewStagedWorkspaceLinkEffects(stage, { kind: 'delete', sourcePath: 'folder' });
  assert.equal(deleted.coverage.complete, true); assert.equal(deleted.executionReady, false);
  assert.equal(deleted.effects.length, 1); assert.equal(deleted.effects[0].sourcePath, outside.path); assert.equal(deleted.effects[0].action, 'unlink');
}));

test('implied registry directories obey namespace limits and reject physical file ancestors', async () => fixture(async (root, workspace) => {
  const state = native('# Native', 'folder/nested/note.bin'); const rows = [record(state.path, 'initialized')];
  for (const limits of [{ maxPaths: 1 }, { maxDepth: 1 }]) {
    const db = database(rows); const stage = await stageWorkspaceLinkSourceAuthority(workspace,
      { openConnection: async () => db.connection, loadState: async () => state, limits });
    assert.equal(stage.coverage.complete, false); assert(stage.coverage.gaps.some((gap) => gap.code === 'source-namespace-limit'));
  }
  await fs.writeFile(path.join(root, 'folder'), 'Physical file'); const db = database(rows);
  const conflicted = await stageWorkspaceLinkSourceAuthority(workspace, { openConnection: async () => db.connection, loadState: async () => state });
  assert.equal(conflicted.coverage.complete, false); assert(conflicted.coverage.gaps.some((gap) => gap.code === 'identity-conflict'));
  assert.equal(conflicted.sources.length, 0);
}));
