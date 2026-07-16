import assert from 'node:assert/strict';

import {
  buildKnowledgeGraphData,
  getConnectedKnowledgeGraphNodes,
  getKnowledgeGraphFacets,
  searchKnowledgeGraphDocuments,
} from '../app/apps/knowledge-graph/lib/knowledge-graph-model';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';

const index = buildWorkspaceLinkIndexFromDocuments([
  { path: 'Research/Overview.md', content: '---\naliases: [Atlas Home, Übersicht]\ntags: [project/atlas, type/overview]\n---\n\n# Overview\n\n[[Research/Source]]\n[[Missing]]' },
  { path: 'Research/Source.md', content: '---\ntags: [reference, project/atlas]\n---\n\n# Source' },
  { path: 'Archive/Orphan.md', content: '---\ntags: [archive]\n---\n\n# Orphan' },
  { path: 'Archive/Broken only.md', content: '---\ntags: [archive]\n---\n\n# Broken only\n\n[[Nowhere]]' },
], new Date('2026-07-14T12:00:00.000Z'));

const graph = buildKnowledgeGraphData(index, {
  colorMode: 'status',
  showBroken: true,
  showOrphans: true,
});
assert.equal(graph.nodes.filter((node) => node.kind === 'document').length, 4);
assert.equal(graph.nodes.filter((node) => node.kind === 'missing').length, 2);
assert.equal(graph.edges.length, 3);
assert.equal(graph.nodes.find((node) => node.path === 'Research/Overview.md')?.outgoing, 2);
assert.equal(graph.nodes.find((node) => node.path === 'Research/Source.md')?.incoming, 1);
assert.deepEqual(
  getConnectedKnowledgeGraphNodes(graph, 'Research/Overview.md')
    .map((node) => node.path ?? `kind:${node.kind}`)
    .sort(),
  ['Research/Source.md', 'kind:missing'],
);
assert.deepEqual(
  getConnectedKnowledgeGraphNodes(graph, 'Research/Source.md').map((node) => node.path),
  ['Research/Overview.md'],
);

const connectedOnly = buildKnowledgeGraphData(index, {
  colorMode: 'folder',
  showBroken: false,
  showOrphans: false,
});
assert.equal(connectedOnly.nodes.some((node) => node.path === 'Archive/Orphan.md'), false);
assert.equal(connectedOnly.nodes.some((node) => node.path === 'Archive/Broken only.md'), false);
assert.equal(connectedOnly.nodes.some((node) => node.kind !== 'document'), false);
assert.equal(connectedOnly.edges.length, 1);
assert.equal(
  connectedOnly.nodes.find((node) => node.path === 'Research/Overview.md')?.color,
  connectedOnly.nodes.find((node) => node.path === 'Research/Source.md')?.color,
);
assert.equal(connectedOnly.nodes.find((node) => node.path === 'Research/Overview.md')?.group, 'Research');

const facets = getKnowledgeGraphFacets(index);
assert.deepEqual(facets.folders, [
  { count: 2, value: 'Archive' },
  { count: 2, value: 'Research' },
]);
assert.deepEqual(facets.tags.find((facet) => facet.value === 'project/atlas'), {
  count: 2,
  value: 'project/atlas',
});

const tagged = buildKnowledgeGraphData(index, {
  colorMode: 'tag',
  selectedTags: ['project/atlas'],
  showBroken: true,
  showOrphans: true,
});
assert.deepEqual(
  tagged.nodes.filter((node) => node.kind === 'document').map((node) => node.path).sort(),
  ['Research/Overview.md', 'Research/Source.md'],
);
assert.equal(tagged.nodes.find((node) => node.path === 'Research/Overview.md')?.group, 'project/atlas');
assert.equal(tagged.edges.length, 2);

const filteredFolderAndTag = buildKnowledgeGraphData(index, {
  colorMode: 'folder',
  selectedFolders: ['Archive'],
  selectedTags: ['archive'],
  showBroken: false,
  showOrphans: true,
});
assert.deepEqual(
  filteredFolderAndTag.nodes.map((node) => node.path).sort(),
  ['Archive/Broken only.md', 'Archive/Orphan.md'],
);

assert.deepEqual(
  searchKnowledgeGraphDocuments(index.documents, 'atlas home').map((result) => ({
    kind: result.matchKind,
    path: result.document.path,
  })),
  [{ kind: 'alias', path: 'Research/Overview.md' }],
);
assert.equal(
  searchKnowledgeGraphDocuments(index.documents, 'ubersicht')[0]?.document.path,
  'Research/Overview.md',
);
assert.deepEqual(
  searchKnowledgeGraphDocuments(index.documents, 'project atlas source').map((result) => result.document.path),
  ['Research/Source.md'],
);
assert.deepEqual(
  searchKnowledgeGraphDocuments(index.documents, 'archive').map((result) => result.document.path).sort(),
  ['Archive/Broken only.md', 'Archive/Orphan.md'],
);
assert.equal(searchKnowledgeGraphDocuments(index.documents, 'source', 1).length, 1);
assert.deepEqual(searchKnowledgeGraphDocuments(index.documents, 'not in workspace'), []);

console.log('knowledge-graph-model-test: ok');
