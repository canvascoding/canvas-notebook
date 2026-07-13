import assert from 'node:assert/strict';

import { sortFileNodes } from '../app/lib/files/sort';
import type { FileNode } from '../app/lib/files/types';

const nodes: FileNode[] = [
  { name: 'file10.md', path: 'file10.md', type: 'file', size: 10, modified: 100 },
  { name: 'folder-b', path: 'folder-b', type: 'directory', modified: 50 },
  { name: 'image.png', path: 'image.png', type: 'file', size: 20, modified: 300 },
  { name: 'file2.md', path: 'file2.md', type: 'file', size: 5, modified: 200 },
  { name: 'folder-a', path: 'folder-a', type: 'directory', modified: 400 },
  { name: 'unknown.bin', path: 'unknown.bin', type: 'file' },
];

assert.deepEqual(
  sortFileNodes(nodes, 'name', 'asc').map((node) => node.name),
  ['folder-a', 'folder-b', 'file2.md', 'file10.md', 'image.png', 'unknown.bin'],
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
