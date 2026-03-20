import assert from 'node:assert/strict';

import type { FileReferenceEntry } from '../app/lib/filesystem/file-reference-search';
import { searchFileReferenceEntries } from '../app/lib/filesystem/file-reference-search';

const SAMPLE_FILES: FileReferenceEntry[] = [
  {
    name: 'notes.md',
    path: 'Test/notes.md',
    type: 'file',
    extension: 'md',
    isImage: false,
  },
  {
    name: 'Test.md',
    path: 'Elsewhere/Test.md',
    type: 'file',
    extension: 'md',
    isImage: false,
  },
  {
    name: 'alpha-test-plan.md',
    path: 'docs/alpha-test-plan.md',
    type: 'file',
    extension: 'md',
    isImage: false,
  },
  {
    name: 'Test',
    path: 'shallow/Test',
    type: 'file',
    isImage: false,
  },
  {
    name: 'Readme.md',
    path: 'product/Test/Readme.md',
    type: 'file',
    extension: 'md',
    isImage: false,
  },
  {
    name: 'test-cases.md',
    path: 'nested/deeper/test-cases.md',
    type: 'file',
    extension: 'md',
    isImage: false,
  },
];

function getPaths(query: string): string[] {
  return searchFileReferenceEntries(SAMPLE_FILES, query).map((entry) => entry.path);
}

function main() {
  assert.deepEqual(getPaths('test').slice(0, 4), [
    'shallow/Test',
    'Elsewhere/Test.md',
    'nested/deeper/test-cases.md',
    'docs/alpha-test-plan.md',
  ]);

  assert.equal(getPaths('TEST')[0], 'shallow/Test');
  assert.equal(getPaths('test.md')[0], 'Elsewhere/Test.md');
  assert.equal(getPaths('readme')[0], 'product/Test/Readme.md');
  assert.equal(getPaths('product')[0], 'product/Test/Readme.md');

  assert.deepEqual(getPaths('alpha'), [
    'docs/alpha-test-plan.md',
  ]);

  console.log('file-reference-ranking-test: ok');
}

main();
