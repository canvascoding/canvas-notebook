import assert from 'node:assert/strict';

import {
  compactWorkspaceSelection,
  createWorkspaceMovePlan,
  isMoveIntoSelf,
  resolveMoveDestination,
} from '../app/lib/files/operation-flows';

assert.deepEqual(
  compactWorkspaceSelection([
    'files/00_dashboard',
    'files/00_dashboard/daily-content-reminder.html',
    'files/01_brand',
    'files/00_dashboard/daily-content-reminder.md',
    './files/01_brand/',
  ]),
  ['files/00_dashboard', 'files/01_brand'],
  'bulk operations should remove descendants and normalized duplicates when their parent is selected',
);

assert.equal(
  isMoveIntoSelf('files/00_dashboard', resolveMoveDestination('files/00_dashboard/assets', '00_dashboard')),
  true,
  'moving a directory into one of its descendants should be rejected before any mutations start',
);

assert.equal(
  isMoveIntoSelf('files/00_dashboard', resolveMoveDestination('archive', '00_dashboard')),
  false,
);

assert.deepEqual(
  createWorkspaceMovePlan([
    'docs',
    'docs/nested.md',
    'readme.md',
  ], 'archive'),
  {
    sourcePaths: ['docs', 'readme.md'],
    entries: [
      { sourcePath: 'docs', destinationPath: 'archive/docs' },
      { sourcePath: 'readme.md', destinationPath: 'archive/readme.md' },
    ],
    protectedPaths: [],
    invalidSourcePath: null,
  },
  'move planning should compact descendants and resolve every destination once',
);

assert.equal(
  createWorkspaceMovePlan(['docs'], 'docs/nested').invalidSourcePath,
  'docs',
  'move planning should reject a directory target inside the source selection',
);

console.log('file operation flows test passed');
