import assert from 'node:assert/strict';

import {
  memoryReviewErrorCode,
  selectMemoryReviewThinkingLevel,
} from '../app/lib/memory/review-runtime';

assert.equal(selectMemoryReviewThinkingLevel(['off']), 'off');
assert.equal(selectMemoryReviewThinkingLevel(['low', 'minimal']), 'minimal');
assert.equal(selectMemoryReviewThinkingLevel(['high', 'medium']), 'medium');
assert.throws(
  () => selectMemoryReviewThinkingLevel([]),
  /exposes no supported thinking level/,
);

assert.equal(
  memoryReviewErrorCode({ name: 'AiRuntimePolicyError', code: 'INVALID_INTELLIGENCE' }),
  'INVALID_INTELLIGENCE',
);
assert.equal(memoryReviewErrorCode({ code: 'bad code/value' }), 'bad_code_value');
assert.equal(memoryReviewErrorCode(new TypeError('broken')), 'TypeError');
assert.equal(memoryReviewErrorCode(null), 'memory_review_failed');

console.log('memory review runtime tests passed');
