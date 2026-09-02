import assert from 'node:assert/strict';

import {
  COLLABORATION_CHECKPOINT_ERROR_CODES,
  CollaborationCheckpointRequestError,
  CollaborationCheckpointValidationError,
  collaborationCheckpointValidationFailure,
  isCollaborationCheckpointValidationErrorCode,
  type RichMarkdownCheckpointValidationCode,
} from '../app/lib/collaboration/checkpoint-errors';

const expectedCodes: Record<
  RichMarkdownCheckpointValidationCode,
  string
> = {
  schema_invalid: COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid,
  stable_id_missing: COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdMissing,
  stable_id_duplicate: COLLABORATION_CHECKPOINT_ERROR_CODES.stableIdDuplicate,
  roundtrip_unstable: COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable,
};

for (const [validationCode, expectedCode] of Object.entries(expectedCodes)) {
  const error = new CollaborationCheckpointValidationError(
    validationCode as RichMarkdownCheckpointValidationCode,
  );
  const failure = collaborationCheckpointValidationFailure(error);
  assert(failure, `Expected a public failure for ${validationCode}.`);
  assert.equal(failure.status, 422);
  assert.equal(failure.code, expectedCode);
  assert.equal(failure.message.includes(validationCode), false);
  assert.equal(isCollaborationCheckpointValidationErrorCode(failure.code), true);
}

assert.equal(collaborationCheckpointValidationFailure(new Error('unexpected')), null);
assert.equal(
  isCollaborationCheckpointValidationErrorCode(
    COLLABORATION_CHECKPOINT_ERROR_CODES.failed,
  ),
  false,
);

const requestError = new CollaborationCheckpointRequestError(
  COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable,
  'Safe public message.',
);
assert.equal(requestError.code, COLLABORATION_CHECKPOINT_ERROR_CODES.roundtripUnstable);
assert.equal(requestError.message, 'Safe public message.');

console.log('Collaboration checkpoint error contract test passed.');
