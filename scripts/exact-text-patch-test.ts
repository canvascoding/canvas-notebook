import assert from 'node:assert/strict';

import {
  applyExactTextEdits,
  ExactTextPatchError,
  resolveExactTextEditMatchCount,
} from '../app/lib/files/exact-text-patch';

assert.equal(
  applyExactTextEdits('status: draft\nstatus: draft\n', [{
    oldText: 'status: draft',
    newText: 'status: ready',
    replaceAll: true,
  }], 'notes.md'),
  'status: ready\nstatus: ready\n',
);

assert.equal(
  applyExactTextEdits('one one', [{
    oldText: 'one',
    newText: 'two',
    expectedOccurrences: 2,
  }], 'notes.md'),
  'two two',
);

assert.throws(
  () => applyExactTextEdits('one one', [{ oldText: 'one', newText: 'two' }], 'notes.md'),
  (error: unknown) => error instanceof ExactTextPatchError
    && error.code === 'occurrence_mismatch'
    && error.expectedOccurrences === 1
    && error.actualOccurrences === 2
    && error.matchMode === 'exact'
    && error.occurrenceLines.join(',') === '1,1',
);

assert.throws(
  () => applyExactTextEdits('one', [{
    oldText: 'one',
    newText: 'two',
    replaceAll: true,
    expectedOccurrences: 1,
  }], 'notes.md'),
  (error: unknown) => error instanceof ExactTextPatchError
    && error.code === 'conflicting_occurrence_mode'
    && error.matchMode === 'all',
);

assert.throws(
  () => resolveExactTextEditMatchCount({
    content: 'heading\n',
    edit: { oldText: 'missing', newText: 'present', replaceAll: true },
    label: 'notes.md',
    editIndex: 2,
  }),
  (error: unknown) => error instanceof ExactTextPatchError
    && error.code === 'occurrence_mismatch'
    && error.expectedOccurrences === null
    && error.actualOccurrences === 0
    && error.editIndex === 2
    && error.matchMode === 'all',
);

console.log('exact-text-patch-test: ok');
