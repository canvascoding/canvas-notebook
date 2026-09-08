import assert from 'node:assert/strict';

import {
  getCanvasDesktopFileDragPreparationKey,
  isCanvasDesktopFileDragPrepared,
  startCanvasDesktopFileDrag,
  type CanvasDesktopFileDragBridge,
  type DesktopFileDragRequest,
} from '../app/lib/desktop/file-drag';

const request: DesktopFileDragRequest = {
  workspaceId: 'workspace-a',
  paths: ['reports/q1.md', 'reports/q2.md'],
};
const now = 50_000;
const preparedAtByKey = new Map(request.paths.map((filePath) => [
  getCanvasDesktopFileDragPreparationKey(request.workspaceId, filePath),
  now - 1_000,
]));

assert.equal(
  isCanvasDesktopFileDragPrepared(preparedAtByKey, request, 5_000, now),
  true,
  'all selected files must be freshly prepared before native drag starts',
);
preparedAtByKey.delete(getCanvasDesktopFileDragPreparationKey(request.workspaceId, request.paths[1]));
assert.equal(
  isCanvasDesktopFileDragPrepared(preparedAtByKey, request, 5_000, now),
  false,
  'a partially prepared selection must stay on the web drag path',
);
preparedAtByKey.set(
  getCanvasDesktopFileDragPreparationKey(request.workspaceId, request.paths[1]),
  now - 5_000,
);
assert.equal(
  isCanvasDesktopFileDragPrepared(preparedAtByKey, request, 5_000, now),
  false,
  'expired preparations must not start a native drag',
);

const lifecycle: string[] = [];
const bridge: CanvasDesktopFileDragBridge = {
  prepareFileDrag: async () => undefined,
  startFileDrag: (startedRequest) => {
    lifecycle.push('start');
    assert.deepEqual(startedRequest, request);
  },
};

assert.equal(startCanvasDesktopFileDrag({
  preventDefault: () => lifecycle.push('prevent-default'),
}, bridge, request), true);
assert.deepEqual(
  lifecycle,
  ['prevent-default', 'start'],
  'the browser drag must be cancelled before Electron starts its native drag',
);

assert.equal(startCanvasDesktopFileDrag({
  preventDefault: () => lifecycle.push('unexpected-prevent-default'),
}, null, request), false);
assert.deepEqual(lifecycle, ['prevent-default', 'start']);

console.log('desktop-file-drag-client-test: ok');
