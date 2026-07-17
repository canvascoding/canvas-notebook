import assert from 'node:assert/strict';

import { issueCollaborationTicket, verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { EXCALIDRAW_MAX_PATCH_ELEMENTS } from '@/app/lib/excalidraw-collaboration/protocol';
import { validateExcalidrawElement, validateExcalidrawElements, validateExcalidrawSceneReferences } from '@/app/lib/excalidraw-collaboration/scene';

process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'test-only-excalidraw-ticket-secret-0001';

const issued = issueCollaborationTicket({
  userId: 'user-a',
  sessionId: 'session-a',
  workspaceId: 'workspace-a',
  organizationId: 'org-a',
  documentId: 'document-a',
  path: 'drawing.excalidraw',
  provider: 'excalidraw',
  representation: 'excalidraw_scene',
  permission: 'write',
  lifecycleGeneration: 7,
}, 10_000);
const claims = verifyCollaborationTicket(issued.token, 10_001);
assert.equal(claims.provider, 'excalidraw');
assert.equal(claims.representation, 'excalidraw_scene');
assert.equal(claims.lifecycleGeneration, 7);
assert.throws(() => verifyCollaborationTicket(`${issued.token}x`, 10_001), /signature|format/u);
assert.throws(() => verifyCollaborationTicket(issued.token, issued.claims.expiresAt + 1), /expired/u);

assert.throws(() => validateExcalidrawElement({ id: '../bad', type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false }), /invalid id/u);
assert.throws(() => validateExcalidrawElement({ id: 'bad-type', type: 'video', version: 1, versionNonce: 1, isDeleted: false }), /Unsupported/u);
assert.throws(() => validateExcalidrawElement({ id: 'nan', type: 'rectangle', version: 1, versionNonce: 1, isDeleted: false, x: Number.NaN }), /finite/u);
assert.equal(validateExcalidrawElement({
  id: 'valid-null-bindings',
  type: 'rectangle',
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
}).boundElements, null, 'Excalidraw emits null when an element has no bound elements.');
assert.throws(() => validateExcalidrawElements(Array.from({ length: EXCALIDRAW_MAX_PATCH_ELEMENTS + 1 }, (_, index) => ({
  id: `limit-${index}`,
  type: 'rectangle',
  version: 1,
  versionNonce: index,
  isDeleted: false,
})), 'patch'), /limit/u);
assert.throws(() => validateExcalidrawSceneReferences([{
  id: 'arrow',
  type: 'arrow',
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  startBinding: { elementId: 'missing' },
}]), /missing/u);

console.log('excalidraw-collaboration-security-test: ok');
