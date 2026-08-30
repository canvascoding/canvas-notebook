import assert from 'node:assert/strict';

import { filterFileNodes, sortFileNodes } from '../app/lib/files/sort';
import type { FileNode } from '../app/lib/files/types';

const nodes: FileNode[] = [
  { name: 'file10.md', path: 'file10.md', type: 'file', title: 'Alpha', size: 10, created: 150, modified: 100, isFavorite: true },
  { name: 'folder-b', path: 'folder-b', type: 'directory', modified: 50 },
  { name: 'image.png', path: 'image.png', type: 'file', size: 20, created: 350, modified: 300, pinnedAt: 400 },
  { name: 'file2.md', path: 'file2.md', type: 'file', title: 'Beta', size: 5, created: 250, modified: 200 },
  { name: 'folder-a', path: 'folder-a', type: 'directory', modified: 400 },
  { name: 'unknown.bin', path: 'unknown.bin', type: 'file' },
];

assert.deepEqual(
  sortFileNodes(nodes, 'name', 'asc').map((node) => node.name),
  ['folder-a', 'folder-b', 'file2.md', 'file10.md', 'image.png', 'unknown.bin'],
);
assert.deepEqual(
  sortFileNodes(nodes, 'created', 'desc').map((node) => node.name),
  ['folder-b', 'folder-a', 'image.png', 'file2.md', 'file10.md', 'unknown.bin'],
);
assert.deepEqual(
  sortFileNodes(nodes, 'title', 'asc').map((node) => node.name),
  ['folder-a', 'folder-b', 'file10.md', 'file2.md', 'image.png', 'unknown.bin'],
);
assert.deepEqual(
  filterFileNodes(nodes, { favorite: true }).map((node) => node.name),
  ['file10.md'],
);
assert.deepEqual(
  filterFileNodes(nodes, { extensions: ['md'], minSize: 6 }).map((node) => node.name),
  ['file10.md'],
);
assert.deepEqual(
  sortFileNodes(nodes, 'modified', 'desc').map((node) => node.name),
  ['folder-a', 'folder-b', 'image.png', 'file2.md', 'file10.md', 'unknown.bin'],
);
assert.deepEqual(
  sortFileNodes(nodes, 'type', 'asc').map((node) => node.name),
  ['folder-a', 'folder-b', 'unknown.bin', 'file2.md', 'file10.md', 'image.png'],
);

console.log('file sort test passed');
