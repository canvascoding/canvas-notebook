import assert from 'node:assert/strict';
import * as Y from 'yjs';

import {
  resolveAgentTextTargetRanges,
  visibleAgentTargetAnchors,
} from '../app/lib/collaboration/agent-target-decorations';
import type { CollaborationAgentOperation } from '../app/lib/collaboration/agent-operations-client';

function encodePosition(position: Y.RelativePosition) {
  return Buffer.from(Y.encodeRelativePosition(position)).toString('base64');
}

const doc = new Y.Doc();
const text = doc.getText('content');
text.insert(0, 'alpha beta gamma');

const target = {
  targetId: 'target-1',
  groupId: 'group-1',
  startAnchor: encodePosition(Y.createRelativePositionFromTypeIndex(text, 6)),
  endAnchor: encodePosition(Y.createRelativePositionFromTypeIndex(text, 10)),
};
const operation = {
  operationId: 'operation-1',
  operationStatus: 'needs_review',
  targetAnchors: [target],
} as CollaborationAgentOperation;

const visible = visibleAgentTargetAnchors([operation]);
assert.deepEqual(visible, [{ operationId: 'operation-1', ...target }]);
assert.deepEqual(resolveAgentTextTargetRanges(doc, 'content', visible), [{
  operationId: 'operation-1',
  ...target,
  from: 6,
  to: 10,
}]);

assert.deepEqual(visibleAgentTargetAnchors([{
  ...operation,
  operationStatus: 'checkpointed_file',
}]), [], 'completed operations belong in history and must not leave stale editor highlights');

assert.deepEqual(resolveAgentTextTargetRanges(doc, 'content', [{
  ...visible[0],
  startAnchor: 'not-base64',
}]), [], 'invalid or stale anchors must fail closed');

doc.destroy();
console.log('collaboration agent target decorations test passed');
