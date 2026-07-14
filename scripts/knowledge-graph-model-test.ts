import assert from 'node:assert/strict';

import { buildKnowledgeGraphData } from '../app/apps/knowledge-graph/lib/knowledge-graph-model';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';

const index = buildWorkspaceLinkIndexFromDocuments([
  { path: 'Research/Overview.md', content: '# Overview\n\n[[Research/Source]]\n[[Missing]]' },
  { path: 'Research/Source.md', content: '---\ntags: [reference]\n---\n\n# Source' },
  { path: 'Archive/Orphan.md', content: '# Orphan' },
], new Date('2026-07-14T12:00:00.000Z'));

const graph = buildKnowledgeGraphData(index, {
  colorMode: 'status',
  showBroken: true,
  showOrphans: true,
});
assert.equal(graph.nodes.filter((node) => node.kind === 'document').length, 3);
assert.equal(graph.nodes.filter((node) => node.kind === 'missing').length, 1);
assert.equal(graph.edges.length, 2);
assert.equal(graph.nodes.find((node) => node.path === 'Research/Overview.md')?.outgoing, 2);
assert.equal(graph.nodes.find((node) => node.path === 'Research/Source.md')?.incoming, 1);

const connectedOnly = buildKnowledgeGraphData(index, {
  colorMode: 'folder',
  showBroken: false,
  showOrphans: false,
});
assert.equal(connectedOnly.nodes.some((node) => node.path === 'Archive/Orphan.md'), false);
assert.equal(connectedOnly.nodes.some((node) => node.kind !== 'document'), false);
assert.equal(connectedOnly.edges.length, 1);
assert.equal(
  connectedOnly.nodes.find((node) => node.path === 'Research/Overview.md')?.color,
  connectedOnly.nodes.find((node) => node.path === 'Research/Source.md')?.color,
);

console.log('knowledge-graph-model-test: ok');
