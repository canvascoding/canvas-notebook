import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as YTypes from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { getWorkspaceDocumentRelations } from '../app/lib/markdown/workspace-document-relations';
import { buildKnowledgeGraphData } from '../app/apps/knowledge-graph/lib/knowledge-graph-model';
import { buildWorkspaceDocumentLinkIndexFromStage, readWorkspaceDocumentLinkIndex } from '../app/lib/markdown/workspace-document-link-index';
import type { WorkspaceDocumentLinkIndex, WorkspaceLinkReadIndex } from '../app/lib/markdown/workspace-document-link-index-contract';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import type { NativeDocumentLinkInventory, NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import { inspectPersistedDocumentLinks } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks, workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';

const workspace: WorkspaceContext = {
  workspaceId: 'document-link-index', organizationId: null, workspaceType: 'personal',
  rootPath: '/no-document-link-index-projection-files', legacy: false, status: 'active',
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
};
const now = new Date('2026-10-17T12:00:00.000Z');
const representations = ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const;

function inventory(text: string, path: string, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks',
  customize?: (document: YTypes.Doc) => void): NativeDocumentLinkInventory {
  const document = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    customize?.(document);
    const state: PersistedCollaborationState = {
      documentId: `native:${path}`, workspaceId: workspace.workspaceId, organizationId: null, path, representation,
      lifecycleGeneration: 3, schemaVersion: COLLABORATION_SCHEMA_VERSION,
      yjsState: Y.encodeStateAsUpdate(document), stateVector: Y.encodeStateVector(document), documentSequence: 7,
      persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
      newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active',
    };
    return inspectPersistedDocumentLinks(state);
  } finally { document.destroy(); }
}

function stageFor(native: NativeDocumentLinkInventory[], physical: Array<{ path: string; text: string }> = [],
  assets: string[] = []): WorkspaceSourceAuthorityStage {
  const namespace = new Map<string, NativeNamespaceEntry>();
  const add = (entry: NativeNamespaceEntry) => {
    namespace.set(entry.path, entry);
    const parents = entry.path.split('/').slice(0, -1);
    while (parents.length) {
      const parent = parents.join('/');
      if (!namespace.has(parent)) namespace.set(parent, { workspaceId: workspace.workspaceId, path: parent, kind: 'directory',
        identity: `private-implied-parent:${parent}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: null });
      parents.pop();
    }
  };
  const sources: WorkspaceSourceAuthorityStage['sources'] = [];
  for (const entry of native) {
    add({ workspaceId: workspace.workspaceId, path: entry.document.path, kind: 'file', identity: 'private-native-identity',
      documentId: entry.document.documentId, lifecycleGeneration: entry.document.lifecycleGeneration, filesystemIdentity: null });
    sources.push({ kind: 'native', inventory: entry });
  }
  for (const entry of physical) {
    const inspected = inspectOriginalPhysicalLinks({ workspaceId: workspace.workspaceId, organizationId: null, path: entry.path,
      bytes: Buffer.from(entry.text), filesystemIdentity: 'private-physical-inode',
      authority: { kind: 'unregistered', catalogueProof: 'private-catalogue-proof' } });
    add({ workspaceId: workspace.workspaceId, path: entry.path, kind: 'file', identity: 'private-physical-identity',
      documentId: null, lifecycleGeneration: null, filesystemIdentity: inspected.physical.filesystemIdentity });
    sources.push({ kind: 'physical', inventory: inspected });
  }
  for (const path of assets) add({ workspaceId: workspace.workspaceId, path, kind: 'file', identity: 'private-asset-identity',
    documentId: null, lifecycleGeneration: null, filesystemIdentity: 'private-asset-inode' });
  const gaps = sources.flatMap(source => source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = {
    stageVersion: 1, workspaceId: workspace.workspaceId, organizationId: null, catalogueProof: 'private-catalogue-proof',
    namespace: [...namespace.values()], sources, scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: !gaps.length, gaps }, readiness: gaps.length ? 'blocked'
      : physical.length ? 'requires-import-and-rebinding' : 'native-coordinator-required', executionReady: false,
  };
  return { ...body, stageProof: workspaceSourceAuthorityStageProof(body) };
}

function edge(index: WorkspaceDocumentLinkIndex, source: string, literal: string) {
  const found = index.edges.find(candidate => candidate.sourcePath === source && candidate.targetLiteral === literal);
  assert(found, `Missing ${source} -> ${literal}`); return found;
}

for (const representation of representations) {
  test(`${representation}: registry-only native documents and physical sources share exact links, aliases and asset targets`, () => {
    const native = [inventory('# Source\n\n[Target](target.md#Part%2520) [[Shared|Visible]] [PDF](asset.pdf)', 'deep/source.md', representation),
      inventory('---\naliases: [Shared]\ntags: [one]\n---\n\n# Target', 'deep/target.md', representation)];
    const stage = stageFor(native, [{ path: 'physical.md', text: '😀 [Target](/deep/target.md#^block) [[Shared]]' }], ['deep/asset.pdf']);
    const before = JSON.stringify(stage), index = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
    assert.equal(JSON.stringify(stage), before, 'read projection must not mutate the observed Stage');
    assert.equal(index.indexVersion, 2); assert.equal(index.workspaceId, workspace.workspaceId);
    assert.equal(index.generatedAt, now.toISOString()); assert.equal(index.coverage.complete, true);
    assert.deepEqual(index.targetPaths, ['deep/asset.pdf', 'deep/source.md', 'deep/target.md', 'physical.md']);
    assert.deepEqual(index.documents.map(document => document.path), ['deep/source.md', 'deep/target.md', 'physical.md']);
    assert.equal(index.documents.some(document => document.path.endsWith('.pdf')), false);
    assert.equal(edge(index, 'deep/source.md', 'target.md#Part%2520').targetPath, 'deep/target.md');
    assert.equal(edge(index, 'deep/source.md', 'target.md#Part%2520').heading, 'Part%20');
    assert.equal(edge(index, 'deep/source.md', 'Shared').targetPath, 'deep/target.md');
    assert.equal(edge(index, 'deep/source.md', 'asset.pdf').targetPath, 'deep/asset.pdf');
    assert.equal(edge(index, 'physical.md', '/deep/target.md#^block').blockId, 'block');
    assert.equal(index.backlinks['deep/target.md'].length, 4);
    assert.equal(index.backlinks['deep/asset.pdf'].length, 1);
    assert(index.edges.filter(link => link.sourcePath === 'deep/source.md').every(link => !link.sourcePreview));
    assert.equal(edge(index, 'physical.md', '/deep/target.md#^block').sourcePreview?.focusOffset, 3);
    assert.deepEqual(index.documents[0].nativeIdentity, { documentId: native[0].document.documentId, lifecycleGeneration: 3 });
  });
}

test('native projection absence, empty checkpoint and stale checkpoint identity do not change any read result', () => {
  const stage = stageFor([inventory('[Target](target.md)', 'folder/note.md'), inventory('# Target', 'folder/target.md')]);
  const expected = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
  for (const projection of [null, 'empty-checkpoint-inode', 'wrong-stale-checkpoint-inode']) {
    const observed = structuredClone(stage);
    for (const entry of observed.namespace) if (entry.documentId) entry.filesystemIdentity = projection;
    assert.deepEqual(buildWorkspaceDocumentLinkIndexFromStage(observed, now), expected);
  }
});

test('supported native representations retain authority after a non-Markdown rename; PDF assets stay namespace-only', () => {
  const stage = stageFor([inventory('[[Shared]] [[target.pdf]]', 'source.md'),
    inventory('---\naliases: [Shared]\n---\n\n# Native', 'renamed.bin'), inventory('# Inferred decoy', 'target.pdf.md')], [], ['target.pdf']);
  const index = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
  assert.equal(edge(index, 'source.md', 'Shared').targetPath, 'renamed.bin');
  assert.equal(edge(index, 'source.md', 'target.pdf').targetPath, 'target.pdf');
  assert.equal(index.documents.some(document => document.path === 'target.pdf'), false);
  assert.equal(index.documents.find(document => document.path === 'renamed.bin')?.nativeIdentity?.lifecycleGeneration, 3);
});

test('exact Markdown never acquires Wiki basename or alias fallback; genuine ambiguous aliases remain ambiguous', () => {
  const stage = stageFor([inventory('[Alias](Shared) [[Shared]] [Other](same.md)', 'source.md'),
    inventory('---\naliases: [Shared]\n---\n\n# One', 'a/same.md'),
    inventory('---\naliases: [Shared]\n---\n\n# Two', 'b/same.md')]);
  const index = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
  assert.equal(index.edges.find(link => link.kind === 'markdown' && link.targetLiteral === 'Shared')?.status, 'missing');
  assert.equal(index.edges.find(link => link.kind === 'wiki' && link.targetLiteral === 'Shared')?.status, 'ambiguous');
  assert.deepEqual(index.edges.find(link => link.kind === 'wiki')?.candidates, ['a/same.md', 'b/same.md']);
  assert.equal(edge(index, 'source.md', 'same.md').status, 'missing');
  assert.equal(index.coverage.complete, false); assert.equal(index.brokenLinks.length, 3);
});

test('rich native external and same-document anchor links preserve their classification', () => {
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const stage = stageFor([inventory('# Section\n\n[Outside](https://example.com/path) [Here](#Section) [[#^block]]', 'source.md', representation)]);
    const index = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
    assert.equal(edge(index, 'source.md', 'https://example.com/path').status, 'external');
    assert.equal(edge(index, 'source.md', 'https://example.com/path').targetText, 'https://example.com/path');
    assert.equal(edge(index, 'source.md', '#Section').status, 'anchor-only');
    assert.equal(edge(index, 'source.md', '#Section').heading, 'Section');
    assert.equal(edge(index, 'source.md', '#^block').status, 'anchor-only');
    assert.equal(edge(index, 'source.md', '#^block').blockId, 'block');
    assert.deepEqual(index.brokenLinks, []); assert.equal(index.coverage.complete, true);
  }
});

test('native unknown roots, missing states, source limits and global failures remain explicit incomplete coverage', () => {
  const unknown = inventory('[Target](target.md)', 'source.md', 'tiptap_blocks', document => document.getText('futureRoot').insert(0, 'hidden'));
  const observed = stageFor([unknown, inventory('# Target', 'target.md')]);
  const partial = buildWorkspaceDocumentLinkIndexFromStage(observed, now);
  assert.equal(partial.coverage.complete, false);
  assert(partial.gaps.some(gap => gap.code === 'unknown-node' && gap.path === 'source.md'));
  for (const code of ['missing-native-state', 'source-byte-limit', 'source-authority-unavailable']) {
    const stage = stageFor([inventory('# Native', 'native.md')]); stage.sources = [];
    stage.coverage = { complete: false, gaps: [{ code, path: code === 'source-authority-unavailable' ? '' : 'native.md' }] };
    const index = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
    assert.equal(index.coverage.complete, false); assert(index.gaps.some(gap => gap.code === code));
    assert.deepEqual(index.documents, []);
    if (code === 'source-byte-limit') assert.equal(index.omittedDocuments[0].reason, 'too-large');
  }
  const incomplete = stageFor([]); incomplete.coverage.complete = false;
  assert.deepEqual(buildWorkspaceDocumentLinkIndexFromStage(incomplete, now).gaps, [{ code: 'source-authority-incomplete', path: '' }]);
});

test('duplicate sources, namespace identity collisions and physical attempts to replace native authority fail coverage', () => {
  const original = stageFor([inventory('# Native', 'native.md')]);
  const duplicate = structuredClone(original); duplicate.sources.push(duplicate.sources[0]);
  const duplicated = buildWorkspaceDocumentLinkIndexFromStage(duplicate, now);
  assert(duplicated.gaps.some(gap => gap.code === 'duplicate-source')); assert.deepEqual(duplicated.documents, []);
  const collision = structuredClone(original);
  collision.namespace.push({ ...collision.namespace[0], kind: 'directory', documentId: null, lifecycleGeneration: null });
  const collided = buildWorkspaceDocumentLinkIndexFromStage(collision, now);
  assert(collided.gaps.some(gap => gap.code === 'namespace-identity-conflict')); assert.equal(collided.coverage.complete, false);
  const physical = stageFor([], [{ path: 'native.md', text: '# Stale physical content' }]);
  physical.namespace = original.namespace;
  const stale = buildWorkspaceDocumentLinkIndexFromStage(physical, now);
  assert(stale.gaps.some(gap => gap.code === 'physical-source-is-native')); assert.deepEqual(stale.documents, []);
});

test('DTO contains semantic fields only and does not read private native references or physical source bytes', () => {
  const stage = stageFor([inventory('[Target](target.md)', 'source.md'), inventory('# Target', 'target.md')],
    [{ path: 'physical.md', text: '[Target](target.md)' }]);
  for (const source of stage.sources) {
    if (source.kind === 'native') for (const link of source.inventory.links) {
      Object.defineProperty(link, 'ref', { get: () => { throw new Error('A public read must not inspect private anchors.'); } });
      Object.defineProperty(link, 'cloneLocator', { get: () => { throw new Error('A public read must not inspect clone recipes.'); } });
    } else Object.defineProperty(source.inventory, 'originalBytes', { get: () => { throw new Error('The read DTO must use inspected physical links.'); } });
  }
  for (const entry of stage.namespace) if (entry.documentId) Object.defineProperty(entry, 'filesystemIdentity', {
    get: () => { throw new Error('Native projection identity cannot determine a document read.'); },
  });
  const index = buildWorkspaceDocumentLinkIndexFromStage(stage, now);
  const forbidden = new Set(['raw', 'start', 'end', 'targetRange', 'ref', 'cloneLocator', 'expected', 'startAnchor', 'endAnchor',
    'yjsState', 'stateVector', 'stateProof', 'originalBytes', 'privateNativeStates', 'privateCatalogue', 'filesystemIdentity', 'identity', 'stageProof']);
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { assert.equal(forbidden.has(key), false, `Private field ${key}`); inspect(child); }
  };
  inspect(index); assert.doesNotMatch(JSON.stringify(index), /private-(?:native|physical|asset|catalogue|implied)/u);
  assert.equal(index.coverage.complete, true);
});

test('read wrapper calls the existing fenced observer once and never exposes its private evidence', async () => {
  const stage = stageFor([inventory('# Native', 'native.md')]); let observations = 0;
  const index = await readWorkspaceDocumentLinkIndex(workspace, {
    observe: async received => {
      observations++; assert.equal(received, workspace);
      // The production observer owns the actual TX/fence; this seam proves
      // delegation and DTO isolation, not a second PostgreSQL acceptance run.
      return { stage, nativeBindings: [], privateNativeStates: [], privateCatalogue: [] };
    }, now: () => now,
  });
  assert.equal(observations, 1); assert.equal(index.generatedAt, now.toISOString());
  assert.equal('privateNativeStates' in index, false); assert.equal('privateCatalogue' in index, false);
  await assert.rejects(readWorkspaceDocumentLinkIndex(workspace, { observe: async () => ({ stage: { ...stage, workspaceId: 'foreign' },
    nativeBindings: [], privateNativeStates: [] }) }), /scope changed/u);
  await assert.rejects(readWorkspaceDocumentLinkIndex({ ...workspace, permissions: { ...workspace.permissions, canRead: false } },
    { observe: async () => { throw new Error('Unauthorized scope reached observer.'); } }), /read permission/u);
});

test('read structural contract accepts a legacy physical index without granting mutation fields to readers', () => {
  const legacy: WorkspaceLinkReadIndex = buildWorkspaceLinkIndexFromDocuments([{ path: 'source.md', content: '[Target](target.md)' },
    { path: 'target.md', content: '# Target' }], now);
  assert.equal(legacy.edges[0].targetPath, 'target.md');
  const semantic = buildWorkspaceDocumentLinkIndexFromStage(stageFor([inventory('# Native', 'native.md')]), now);
  const reader: WorkspaceLinkReadIndex = semantic;
  assert.equal(reader.documents[0].path, 'native.md');
});

test('native external links and section anchors do not become broken relations or missing graph nodes', () => {
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const index = buildWorkspaceDocumentLinkIndexFromStage(stageFor([
      inventory('# Section\n\n[Outside](https://example.com/path) [Here](#Section)', 'source.md', representation),
    ]), now);
    const relations = getWorkspaceDocumentRelations(index, 'source.md', { includeRelated: true });
    assert.deepEqual(relations.brokenLinks, []);
    assert.deepEqual(relations.outgoing, []);
    const graph = buildKnowledgeGraphData(index, { colorMode: 'status', showBroken: true, showOrphans: true });
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].kind, 'document');
    assert.equal(graph.nodes[0].degree, 0);
    assert.deepEqual(graph.edges, []);
  }
});
