import assert from 'node:assert/strict';

import type { WorkspaceLinkDocument, WorkspaceLinkEdge } from '../app/lib/markdown/workspace-link-index-core';
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

console.log('workspace reference groups test passed');
