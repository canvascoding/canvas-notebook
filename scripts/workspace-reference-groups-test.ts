import assert from 'node:assert/strict';

import type { WorkspaceLinkDocument, WorkspaceLinkEdge } from '../app/lib/markdown/workspace-link-index-core';
import type { WorkspaceLinkReadEdge } from '../app/lib/markdown/workspace-document-link-index-contract';
import {
  groupWorkspaceReferenceEdges,
  workspaceReferenceDirectory,
} from '../app/lib/markdown/workspace-reference-groups';

const documents: WorkspaceLinkDocument[] = [
  { aliases: [], blockIds: [], headings: [], path: 'Notes/Alpha.md', tags: [], title: 'Alpha note' },
  { aliases: [], blockIds: [], headings: [], path: 'Notes/Beta.md', tags: [], title: 'Beta note' },
  { aliases: [], blockIds: [], headings: [], path: 'Current.md', tags: [], title: 'Current' },
];

function edge(overrides: Partial<WorkspaceLinkEdge>): WorkspaceLinkEdge {
  return {
    alias: null,
    blockId: null,
    candidates: [],
    embed: false,
    end: 20,
    heading: null,
    id: 'edge',
    kind: 'wiki',
    raw: '[[Current]]',
    sourcePath: 'Notes/Alpha.md',
    start: 10,
    status: 'resolved',
    syntax: 'wiki-link',
    targetLiteral: 'Current',
    targetRange: { startUtf16: 12, endUtf16: 19, startUtf8Byte: 12, endUtf8Byte: 19 },
    targetPath: 'Current.md',
    targetText: 'Current',
    ...overrides,
  };
}

const incoming = groupWorkspaceReferenceEdges([
  edge({ id: 'alpha-2', start: 80 }),
  edge({ id: 'beta', sourcePath: 'Notes/Beta.md', start: 30 }),
  edge({ id: 'alpha-1', start: 20 }),
], documents, 'incoming');

assert.equal(incoming.length, 2, 'multiple links from one source document should form one row');
assert.equal(incoming[0].reference.title, 'Alpha note');
assert.equal(incoming[0].edges.length, 2);
assert.equal(incoming[0].reference.focusOffset, 20, 'the preview should focus the first occurrence');

const outgoing = groupWorkspaceReferenceEdges([
  edge({ id: 'out-1', sourcePath: 'Current.md', targetPath: 'Notes/Beta.md', heading: 'Result' }),
  edge({ id: 'out-2', sourcePath: 'Current.md', targetPath: 'Notes/Beta.md', heading: 'Appendix' }),
], documents, 'outgoing');

assert.equal(outgoing.length, 1);
assert.equal(outgoing[0].reference.title, 'Beta note');
assert.equal(outgoing[0].reference.heading, 'Result');
assert.equal(outgoing[0].edges.length, 2);
assert.equal(workspaceReferenceDirectory('Notes/Alpha.md'), 'Notes');
assert.equal(workspaceReferenceDirectory('Root.md'), null);

const nativeReadEdge: WorkspaceLinkReadEdge = {
  alias: null, blockId: null, candidates: [], embed: false, heading: null,
  id: 'native-incoming-1', kind: 'wiki', sourcePath: 'Notes/Beta.md',
  status: 'resolved', syntax: 'wiki-link', targetLiteral: 'Current',
  targetPath: 'Current.md', targetText: 'Current',
};
const nativeIncoming = groupWorkspaceReferenceEdges([
  nativeReadEdge,
  { ...nativeReadEdge, id: 'native-incoming-2' },
], documents, 'incoming');
assert.equal(nativeIncoming.length, 1);
assert.equal(nativeIncoming[0].reference.title, 'Beta note');
assert.equal(nativeIncoming[0].edges.length, 2);
assert.equal(nativeIncoming[0].reference.focusOffset, null, 'native semantic links have no Markdown projection offset');
for (const nativeEdge of nativeIncoming[0].edges) {
  for (const field of ['start', 'end', 'raw', 'targetRange', 'sourcePreview']) assert.equal(Object.hasOwn(nativeEdge, field), false);
}

const mixedIncoming = groupWorkspaceReferenceEdges([
  nativeReadEdge,
  { ...nativeReadEdge, id: 'physical-later', sourcePath: 'Notes/Alpha.md',
    sourcePreview: { kind: 'physical-markdown', focusOffset: 80 } },
  { ...nativeReadEdge, id: 'native-incoming-2' },
  { ...nativeReadEdge, id: 'physical-earlier', sourcePath: 'Notes/Alpha.md',
    sourcePreview: { kind: 'physical-markdown', focusOffset: 20 } },
], documents, 'incoming');
assert.equal(mixedIncoming.length, 2, 'native and original physical sources retain their separate document groups');
assert.equal(mixedIncoming[0].reference.title, 'Alpha note');
assert.equal(mixedIncoming[0].edges.length, 2);
assert.equal(mixedIncoming[0].reference.focusOffset, 20, 'a real physical sourcePreview preserves the first occurrence');
assert.equal(mixedIncoming[1].reference.title, 'Beta note');
assert.equal(mixedIncoming[1].edges.length, 2);
assert.equal(mixedIncoming[1].reference.focusOffset, null, 'physical previews cannot supply a synthetic offset to native sources');

const nativeOutgoing = groupWorkspaceReferenceEdges([
  { ...nativeReadEdge, id: 'native-outgoing', sourcePath: 'Current.md', targetPath: 'Notes/Beta.md', heading: 'Result' },
], documents, 'outgoing');
assert.equal(nativeOutgoing.length, 1);
assert.equal(nativeOutgoing[0].reference.title, 'Beta note');
assert.equal(nativeOutgoing[0].reference.heading, 'Result');
assert.equal(nativeOutgoing[0].reference.focusOffset, null);

console.log('workspace reference groups test passed');
