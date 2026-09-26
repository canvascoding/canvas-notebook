import assert from 'node:assert/strict';
import { proposalReviewWritesEnabled } from '../app/lib/file-version-center/proposal-review-capability';

const originalMode = process.env.NODE_ENV;
const originalFlag = process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST;
const testEnvironment: Record<string, string | undefined> = process.env;
try {
  for (const mode of ['development', 'test', 'production', undefined]) {
    if (mode === undefined) delete testEnvironment.NODE_ENV; else testEnvironment.NODE_ENV = mode;
    delete process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST;
    assert.equal(proposalReviewWritesEnabled(), false);
    process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST = '1';
    assert.equal(proposalReviewWritesEnabled(), mode === 'development' || mode === 'test');
  }
} finally {
  if (originalMode === undefined) delete testEnvironment.NODE_ENV; else testEnvironment.NODE_ENV = originalMode;
  if (originalFlag === undefined) delete process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST; else process.env.CANVAS_PROPOSAL_REVIEW_LOCAL_TEST = originalFlag;
}
console.log('proposal-review-capability-test: ok');
