import assert from 'node:assert/strict';
import { isExplicitAgentWorkflowVersion, parseStoredAgentWorkflowHeader } from '../app/lib/agents/workflow-version';

assert.deepEqual(parseStoredAgentWorkflowHeader(null, 0), { workflowVersion: null, workflowRevision: 0 });
assert.deepEqual(parseStoredAgentWorkflowHeader('1', '17'), { workflowVersion: 1, workflowRevision: 17 });
assert.deepEqual(parseStoredAgentWorkflowHeader(2, 1), { workflowVersion: 2, workflowRevision: 1 });
assert.deepEqual(parseStoredAgentWorkflowHeader(null, '17'), { workflowVersion: null, workflowRevision: 17 },
  'Explicitly returning to legacy mode keeps its monotonically advanced revision.');
assert.equal(isExplicitAgentWorkflowVersion(1), true);
assert.equal(isExplicitAgentWorkflowVersion(2), true);
assert.equal(isExplicitAgentWorkflowVersion('2'), false, 'Raw SQL strings require the header decoder.');
assert.equal(Object.isFrozen(parseStoredAgentWorkflowHeader(2, 1)), true);

for (const [version, revision] of [
  [undefined, 0], [false, 0], ['', 0], ['01', 1], [3, 1], [{}, 0], [[1], 1],
  [1, 0], [2, 0], [1, -1], [1, undefined], [1, ''], [1, '1e1'], [1, '0x10'],
  [1, true], [2, '01'], [2, NaN], [2, Infinity], [2, Number.MAX_SAFE_INTEGER + 1],
]) assert.throws(() => parseStoredAgentWorkflowHeader(version, revision),
  'A corrupt or unsupported header must not become legacy inheritance.');

console.log('EXTENSION_WORKFLOW_VERSION_PASS');
