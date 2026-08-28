import assert from 'node:assert/strict';

import { ExactTextPatchError } from '../app/lib/files/exact-text-patch';
import { WorkspaceFileRevisionError } from '../app/lib/files/revision-guard';
import { asAgentFileToolError, asAgentFileToolSuccess } from '../app/lib/pi/agent-file-tool-results';

const revision = new WorkspaceFileRevisionError({
  code: 'FILE_REVISION_CONFLICT',
  status: 409,
  path: 'notes.md',
  expectedSha256: 'a'.repeat(64),
  currentSha256: 'b'.repeat(64),
  message: 'changed',
});
const revisionResult = asAgentFileToolError(revision, 'edit_file');
assert.equal(revisionResult.category, 'safety_conflict');
assert.equal(revisionResult.recommendedAction, 'read_then_retry');
assert.equal(revisionResult.safeToAutoRetry, false);
assert.equal(revisionResult.currentSha256, 'b'.repeat(64));

const exactResult = asAgentFileToolError(new ExactTextPatchError({
  code: 'occurrence_mismatch',
  editIndex: 0,
  expectedOccurrences: 1,
  actualOccurrences: 0,
  message: 'missing',
}), 'apply_patch', 'notes.md');
assert.equal(exactResult.code, 'EXACT_TEXT_OCCURRENCE_MISMATCH');
assert.equal(exactResult.recommendedAction, 'read_then_retry');
assert.equal(exactResult.editIndex, 0);
assert.equal(exactResult.expectedOccurrences, 1);
assert.equal(exactResult.actualOccurrences, 0);
assert.equal(exactResult.matchMode, 'exact');

const success = asAgentFileToolSuccess({
  path: 'notes.md', resolvedPath: '/workspace/notes.md', changed: true, snapshot: null,
  beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), size: 2,
  diff: 'diff', validation: { ok: true, checks: [] },
}, 'edit_file');
assert.equal(success.recommendedAction, 'reuse_after_sha256_if_sequential');
assert.equal(success.safeToAutoRetry, false);
assert.equal('resolvedPath' in success, false);

console.log('agent-file-tool-results-test: ok');
