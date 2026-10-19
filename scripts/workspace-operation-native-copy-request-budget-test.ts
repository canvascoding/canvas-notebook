import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { WorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { captureWorkspaceOperationCopyOrigin, captureWorkspaceOperationCopyMcpOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { serializeWorkspaceOperationRequest, type WorkspaceOperationRequest } from '../app/lib/files/workspace-operation-journal';
import { assertNativeCopyRequestBudget, NativeCopyRequestTooLargeError } from '../app/lib/files/workspace-operation-native-copy-request-budget';

// Declared historical DTO fixtures only. They prove serialized request costs,
// never a current user, MCP principal, permission, filesystem or SQL boundary.
const workspace = (id: string, unicode: boolean): WorkspaceContext => ({
  workspaceId: id, workspaceType: 'team', organizationId: 'budget-org', customerId: null, projectId: null, ownerUserId: 'owner',
  rootPath: `/private/budget-fixture/${id}${unicode ? '/Grüße-"-🧪' : ''}`, rootRelativePath: `workspaces/${id}`,
  legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false },
});
const bytes = (request: WorkspaceOperationRequest) => Buffer.byteLength(serializeWorkspaceOperationRequest(request).requestJson, 'utf8');
function boundary(origin: WorkspaceOperationCopyOrigin, target: number, unicode = true): WorkspaceOperationRequest {
  const marker = unicode ? 'ü"🧪' : 'plain"';
  const selections = Array.from({ length: 40 }, (_, index) => ({
    sourcePath: ['source', ...Array.from({ length: 4 }, () => 's'.repeat(180)), `item-${index}-${marker}.md`].join('/'),
    destinationPath: ['target', ...Array.from({ length: 4 }, () => 'd'.repeat(180)), `item-${index}-${marker}.md`].join('/'),
  }));
  const request: WorkspaceOperationRequest = { kind: 'copy', origin, selections };
  let count = bytes(request); assert(count < target);
  for (const selected of selections) {
    if (count === target) break;
    const add = Math.min(180, target - count), before = count;
    selected.destinationPath = selected.destinationPath.slice(0, -3) + 'x'.repeat(add) + '.md';
    count = bytes(request); assert.equal(count - before, add);
    assert(selected.destinationPath.length <= 1024);
  }
  assert.equal(count, target); return request;
}
const tooLarge = (error: unknown) => {
  assert(error instanceof NativeCopyRequestTooLargeError); assert.equal(error.code, 'NATIVE_COPY_REQUEST_TOO_LARGE');
  assert.equal(error.status, 413); return true;
};
let groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
export function nativeCopyRequestBudgetTest(): void {
  const source = workspace('source', true), destination = workspace('destination', true);
  const web = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-A' },
    sourceWorkspace: source, destinationWorkspace: destination });
  const mcp = captureWorkspaceOperationCopyMcpOrigin({ userId: 'member', clientId: 'actual-shape-ü-client', sessionId: 'session-A',
    sourceWorkspace: source, destinationWorkspace: destination });
  for (const origin of [web, mcp]) {
    const allowed = boundary(origin, 65536), over = boundary(origin, 65537);
    const actual = serializeWorkspaceOperationRequest(allowed), actualOver = serializeWorkspaceOperationRequest(over);
    assert.equal(Buffer.byteLength(actual.requestJson), 65536); assert.equal(Buffer.byteLength(actualOver.requestJson), 65537);
    assert(actualOver.requestJson.length < 65536, 'The journal character limit alone accepts this UTF-8 overflow.');
    assert(actual.requestJson.includes('\\"')); assert(actual.requestJson.includes('🧪'));
    const before = structuredClone(allowed); assertNativeCopyRequestBudget(allowed); assert.deepEqual(allowed, before);
    assert.deepEqual(serializeWorkspaceOperationRequest(allowed), actual);
    assert.throws(() => assertNativeCopyRequestBudget(over), tooLarge);
    const withoutOrigin = serializeWorkspaceOperationRequest({ kind: 'copy', selections: over.selections });
    assert(Buffer.byteLength(withoutOrigin.requestJson) < 65536, 'Selections alone omit the decisive full Origin cost.');
    groups++; console.log(`PASS native Copy request budget ${groups}: full V${origin.version} Unicode/escaping 65536 accepted, 65537 rejected`);
  }
  const ascii = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: 'session-A' },
    sourceWorkspace: workspace('source', false), destinationWorkspace: workspace('destination', false) });
  const allowed = boundary(ascii, 65536, false), over = structuredClone(allowed);
  const selected = over.selections[0];
  over.selections = [{ ...selected, destinationPath: selected.destinationPath + 'x' }, ...over.selections.slice(1)];
  assert.equal(bytes(allowed), 65536); assert.equal(Buffer.byteLength(JSON.stringify(over)), 65537);
  assert.throws(() => serializeWorkspaceOperationRequest(over), error => {
    assert(error instanceof Error); assert(!(error instanceof NativeCopyRequestTooLargeError)); return true;
  });
  assertNativeCopyRequestBudget(allowed); assert.throws(() => assertNativeCopyRequestBudget(over), tooLarge);
  groups++; console.log(`PASS native Copy request budget ${groups}: ASCII overflow retains the explicit 413 contract before character-limit failure`);
  assert.equal(groups, 3); completed = true;
  console.log('Native Copy request budget: 3/3 pure real-helper/canonical-serializer families; no authority or PG acceptance.');
}
nativeCopyRequestBudgetTest();
