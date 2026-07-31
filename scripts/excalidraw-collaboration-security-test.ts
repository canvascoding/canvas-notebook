import assert from 'node:assert/strict';

import { issueCollaborationTicket, verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { EXCALIDRAW_MAX_PATCH_ELEMENTS } from '@/app/lib/excalidraw-collaboration/protocol';
import { validateExcalidrawElement, validateExcalidrawElements, validateExcalidrawSceneReferences } from '@/app/lib/excalidraw-collaboration/scene';
import { sanitizeExcalidrawSvg } from '@/app/lib/excalidraw-collaboration/svg-sanitizer';

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

const validSvg = sanitizeExcalidrawSvg(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
));
assert.match(validSvg.toString('utf8'), /linearGradient/u, 'Valid SVG drawing features must be preserved.');
assert.match(validSvg.toString('utf8'), /fill="url\(#g\)"/u, 'Valid SVG paint references must be preserved.');
assert.match(
  sanitizeExcalidrawSvg(Buffer.from('<svg><rect width="10" height="10"/></svg>')).toString('utf8'),
  /<rect/u,
  'Existing namespace-less SVG assets must remain supported.',
);

const delayedActiveSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/>${' '.repeat(8_192)}<script>alert(1)</script><circle onload="alert(1)" r="5"/></svg>`,
);
const sanitizedSvg = sanitizeExcalidrawSvg(delayedActiveSvg).toString('utf8');
assert.doesNotMatch(sanitizedSvg, /<script|\bonload\s*=/iu);
assert.match(sanitizedSvg, /<rect/u, 'Sanitization must preserve the safe visual content.');
assert.match(sanitizedSvg, /<circle/u, 'Sanitization must remove active attributes without dropping the shape.');

console.log('excalidraw-collaboration-security-test: ok');
