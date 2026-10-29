import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildWorkspaceDocumentLinkIndexFromStage } from '../app/lib/markdown/workspace-document-link-index';
import { documentLinkResolutionProjectionStatistics } from '../app/lib/markdown/document-link-resolution-projection';
import { withFreshDocumentLinkReadProjection } from '../app/lib/markdown/document-link-read-projection';
import { inspectOriginalPhysicalDocumentLinksForRead, workspaceSourceAuthorityStageProof,
  type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import { inspectPersistedDocumentLinks } from '../app/lib/markdown/workspace-native-link-inventory';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';

const now = new Date('2026-10-29T12:00:00Z');
type File = { path: string; text: string };
function stage(workspaceId: string, files: File[], assets: string[] = [], catalogueProof = 'catalogue', organizationId: string | null = null): WorkspaceSourceAuthorityStage {
  const sources: WorkspaceSourceAuthorityStage['sources'] = files.map(file => ({ kind: 'physical',
    inventory: inspectOriginalPhysicalDocumentLinksForRead({ workspaceId, organizationId, ...file,
      bytes: Buffer.from(file.text), filesystemIdentity: `inode:${file.path}`,
      authority: { kind: 'unregistered', catalogueProof } }) }));
  const namespace = [...files.map(file => file.path), ...assets].map(path => ({ workspaceId, path, kind: 'file' as const,
    identity: `physical:${path}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: `inode:${path}` }));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId, organizationId,
    catalogueProof, namespace, sources, scope: { kind: 'document-index', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'blocked', executionReady: false };
  return { ...body, stageProof: workspaceSourceAuthorityStageProof(body) };
}
async function observe(source: WorkspaceSourceAuthorityStage) {
  const before = documentLinkResolutionProjectionStatistics();
  const index = buildWorkspaceDocumentLinkIndexFromStage(source, now);
  const after = documentLinkResolutionProjectionStatistics();
  const complete = await withFreshDocumentLinkReadProjection(async () => buildWorkspaceDocumentLinkIndexFromStage(source, now));
  assert.deepEqual(index, complete, 'Every incremental result must equal the complete current rebuild.');
  return { index, resolved: after.linksResolved - before.linksResolved, reused: after.sourcesReused - before.sourcesReused };
}
function target(index: ReturnType<typeof buildWorkspaceDocumentLinkIndexFromStage>, sourcePath: string, literal: string) {
  const edge = index.edges.find(edge => edge.sourcePath === sourcePath && edge.targetLiteral === literal);
  assert(edge, `Missing current edge ${sourcePath} → ${literal}`); return edge;
}

test('200-source warm reads reuse resolutions; changing one source resolves only its outgoing links', async () => {
  const id = randomUUID(), files = Array.from({ length: 200 }, (_, i) => ({ path: `note-${i}.md`, text: '[Target](target.md)' }));
  files.push({ path: 'target.md', text: '# Target' });
  const first = await observe(stage(id, files)); assert.equal(first.resolved, 200);
  const warm = await observe(stage(id, files)); assert.equal(warm.resolved, 0); assert.equal(warm.reused, 201);
  files[40] = { ...files[40], text: '[Missing](missing.md)' };
  const saved = await observe(stage(id, files)); assert.equal(saved.resolved, 1); assert.equal(saved.reused, 200);
  assert.equal(target(saved.index, files[40].path, 'missing.md').status, 'missing');
  assert.equal(saved.index.backlinks['target.md'].length, 199);
});

test('previously missing names and exact paths resolve after target creation and revert after removal', async () => {
  const id = randomUUID(), files = [{ path: 'source.md', text: '[[Future]] [Exact](future.md) [[Other]]' }];
  const missing = await observe(stage(id, files)); assert.equal(missing.index.brokenLinks.length, 3);
  const created = await observe(stage(id, [...files, { path: 'future.md', text: '---\naliases: [Future]\n---\n# Future' }]));
  assert.equal(created.resolved, 3); assert.equal(target(created.index, 'source.md', 'Future').targetPath, 'future.md');
  assert.equal(target(created.index, 'source.md', 'future.md').targetPath, 'future.md');
  const removed = await observe(stage(id, files)); assert.equal(removed.index.brokenLinks.length, 3);
});

test('alias changes invalidate resolved, missing and ambiguous references', async () => {
  const id = randomUUID(), source = { path: 'source.md', text: '[[Shared]] [[New Name]]' };
  const one = { path: 'one.md', text: '---\naliases: [Shared]\n---\n# One' };
  const two = { path: 'two.md', text: '---\naliases: [Shared]\n---\n# Two' };
  assert.equal(target((await observe(stage(id, [source, one]))).index, 'source.md', 'Shared').targetPath, 'one.md');
  const ambiguous = await observe(stage(id, [source, one, two]));
  assert.equal(target(ambiguous.index, 'source.md', 'Shared').status, 'ambiguous');
  assert.deepEqual(target(ambiguous.index, 'source.md', 'Shared').candidates, ['one.md', 'two.md']);
  const renamed = await observe(stage(id, [source, { ...one, text: '---\naliases: [New Name]\n---\n# Renamed' }, two]));
  assert.equal(target(renamed.index, 'source.md', 'Shared').targetPath, 'two.md');
  assert.equal(target(renamed.index, 'source.md', 'New Name').targetPath, 'one.md');
});

test('case-insensitive Wiki suffixes and new exact candidates retain canonical ranking', async () => {
  const id = randomUUID(), files = [{ path: 'deep/source.md', text: '[[TARGET]] [[section/target]]' },
    { path: 'far/section/target.md', text: '# Target' }];
  await observe(stage(id, files));
  const exact = await observe(stage(id, [...files, { path: 'deep/TARGET.md', text: '# Near' }]));
  assert.equal(target(exact.index, 'deep/source.md', 'TARGET').targetPath, 'deep/TARGET.md');
  assert.equal(target(exact.index, 'deep/source.md', 'section/target').targetPath, 'far/section/target.md');
});

test('moving a source re-resolves relative Markdown links; renaming a target removes stale backlinks', async () => {
  const id = randomUUID(), files = [{ path: 'a/source.md', text: '[Target](target.md)' },
    { path: 'a/target.md', text: '# A' }, { path: 'b/target.md', text: '# B' }];
  assert.equal(target((await observe(stage(id, files))).index, 'a/source.md', 'target.md').targetPath, 'a/target.md');
  files[0] = { ...files[0], path: 'b/source.md' };
  const moved = await observe(stage(id, files));
  assert.equal(target(moved.index, 'b/source.md', 'target.md').targetPath, 'b/target.md');
  files[2] = { ...files[2], path: 'b/renamed.md' };
  const renamed = await observe(stage(id, files));
  assert.equal(target(renamed.index, 'b/source.md', 'target.md').status, 'missing');
  assert.equal(renamed.index.backlinks['b/target.md'], undefined);
});

test('exact non-Markdown assets keep priority over inferred Markdown names', async () => {
  const id = randomUUID(), files = [{ path: 'source.md', text: '[[asset.pdf]] [PDF](asset.pdf)' }];
  await observe(stage(id, files));
  const withAsset = await observe(stage(id, [...files, { path: 'asset.pdf.md', text: '# Decoy' }], ['asset.pdf']));
  assert(withAsset.index.edges.every(edge => edge.targetPath === 'asset.pdf'));
  const removed = await observe(stage(id, files)); assert(removed.index.edges.every(edge => edge.status === 'missing'));
});

test('current physical link IDs and positions are rebuilt even when only catalogue evidence changes', async () => {
  const id = randomUUID(), files = [{ path: 'source.md', text: '[Target](target.md)' }, { path: 'target.md', text: '# Target' }];
  const before = await observe(stage(id, files, [], 'first-catalogue'));
  const after = await observe(stage(id, files, [], 'next-catalogue'));
  assert.equal(after.resolved, 0);
  assert.notEqual(after.index.edges[0].id, before.index.edges[0].id);
  assert.deepEqual(after.index.edges[0].sourcePreview, before.index.edges[0].sourcePreview);
  const shifted = await observe(stage(id, [{ ...files[0], text: '😀\n\n[Target](target.md)' }, files[1]]));
  assert.equal(shifted.resolved, 1); assert.notDeepEqual(shifted.index.edges[0].sourcePreview, before.index.edges[0].sourcePreview);
});

test('returned arrays cannot poison retained data; a current changed literal is never replaced by cached data', async () => {
  const id = randomUUID(), files = [{ path: 'source.md', text: '[[Target]]' }, { path: 'target.md', text: '# Target' }];
  const before = await observe(stage(id, files));
  before.index.edges[0].candidates.push('poison.md');
  assert.equal(Reflect.set(before.index.edges[0], 'targetPath', 'poison.md'), true);
  const unchanged = await observe(stage(id, files));
  assert.deepEqual(unchanged.index.edges[0].candidates, ['target.md']);
  const current = stage(id, files), source = current.sources[0]; assert(source.kind === 'physical');
  source.inventory.links[0].targetLiteral = 'Missing'; source.inventory.links[0].targetPathText = 'Missing';
  const changed = await observe(current); assert.equal(changed.resolved, 1); assert.equal(changed.index.edges[0].status, 'missing');
});

test('source gaps and empty global failures never recover old cached documents or edges', async () => {
  const id = randomUUID(), files = [{ path: 'source.md', text: '[[Target]]' }, { path: 'target.md', text: '# Target' }];
  await observe(stage(id, files));
  const partial = stage(id, files); partial.sources.splice(0, 1);
  partial.coverage = { complete: false, gaps: [{ code: 'unreadable-physical-source', path: 'source.md' }] };
  const observed = await observe(partial); assert.equal(observed.index.edges.length, 0);
  assert.equal(observed.index.diagnostics?.sourcesComplete, false);
  const failed = stage(id, files); failed.sources = [];
  failed.coverage = { complete: false, gaps: [{ code: 'source-authority-unavailable', path: '' }] };
  assert.deepEqual((await observe(failed)).index.documents, []);
  assert.equal((await observe(stage(id, files))).index.edges.length, 1);
});

test('native identity, generation and current state proof participate in source invalidation', async () => {
  const id = randomUUID();
  function native(generation: number, text: string) {
    const result = stage(id, [{ path: 'target.md', text: '# Target' }]);
    const doc = createPlainTextYDoc(text);
    try {
      const inventory = inspectPersistedDocumentLinks({ documentId: 'native-source', workspaceId: id, organizationId: null,
        path: 'source.bin', representation: 'plain_text', lifecycleGeneration: generation, schemaVersion: COLLABORATION_SCHEMA_VERSION,
        yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: generation,
        persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
        newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' });
      result.sources.push({ kind: 'native', inventory }); result.namespace.push({ workspaceId: id, path: 'source.bin', kind: 'file',
        identity: `native:${generation}`, documentId: 'native-source', lifecycleGeneration: generation, filesystemIdentity: null });
      return result;
    } finally { doc.destroy(); }
  }
  const initial = native(1, '[[Target]]'); await observe(initial);
  assert.equal((await observe(structuredClone(initial))).resolved, 0);
  const next = await observe(native(2, '[[Missing]]'));
  assert.equal(next.resolved, 1); assert.equal(next.index.edges[0].status, 'missing');
  assert.equal(next.index.documents.find(document => document.path === 'source.bin')?.nativeIdentity?.lifecycleGeneration, 2);
});

test('full rebuild bypass is shared with extraction and never replaces a warm retained result', async () => {
  const source = stage(randomUUID(), [{ path: 'source.md', text: '[[Missing]]' }]);
  await observe(source);
  const before = documentLinkResolutionProjectionStatistics();
  await withFreshDocumentLinkReadProjection(async () => buildWorkspaceDocumentLinkIndexFromStage(source, now));
  const after = documentLinkResolutionProjectionStatistics();
  assert.equal(after.linksResolved - before.linksResolved, 1); assert.equal(after.fullRebuilds - before.fullRebuilds, 1);
  assert.equal((await observe(source)).resolved, 0);
});

test('workspace/organization separation and bounded eviction retain full recomputation parity', async () => {
  const id = randomUUID(), files = [{ path: 'source.md', text: '[[Missing]]' }];
  await observe(stage(id, files)); assert.equal((await observe(stage(id, files, [], 'catalogue', 'other-org'))).resolved, 1);
  const count = documentLinkResolutionProjectionStatistics().maxWorkspaces;
  for (let i = 0; i <= count; i++) await observe(stage(randomUUID(), files));
  assert.equal((await observe(stage(id, files))).resolved, 1);
  const stats = documentLinkResolutionProjectionStatistics();
  assert(stats.workspaces <= stats.maxWorkspaces); assert(stats.retainedBytes <= stats.maxBytes); assert(stats.retainedLinks <= stats.maxLinks);
});

test('mixed path spellings, aliases, suffix collisions and changing namespaces match full rebuilds', async () => {
  const id = randomUUID(), references = ['[[Shared]]', '[[a/Target]]', '[[./Target]]', '[[a/../Target]]', '[[target.md]]',
    '[[asset.pdf]]', '[Exact](../Target.md)', '[Root](/Target.md)', '[Dot](../Target.md/.)', '[Escape](../../Target.md)',
    '[Encoded](A%20B.md)', '[Backslash](a\\Target.md)', '[External](https://example.test)', '[Anchor](#Part)'].join(' ');
  const source = { path: 'a/source.md', text: references };
  const candidates = ['Target.md', 'a/Target.md', 'deep/a/Target.md', 'a/target.markdown', 'A%20B.md', 'asset.pdf.md'];
  for (let step = 0; step < 48; step++) {
    const files = [source, ...candidates.filter((_, i) => ((step + 1) >> i & 1) === 1).map((path, i) => ({ path,
      text: `---\naliases: [${(step + i) % 3 ? 'Shared' : 'Other'}]\n---\n# Title ${step % 4}` }))];
    await observe(stage(id, files, step % 2 ? ['asset.pdf'] : []));
  }
});
