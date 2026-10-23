import type { WorkspaceImplicitMoveBindingPublic, WorkspaceImplicitMovePreparationPublicV2, WorkspaceImplicitMoveLegacyReplayPublic } from './workspace-implicit-move-public';

type ExpectedBinding = Readonly<{ actorUserId?: string; workspaceId?: string; operationId?: string;
  requestId?: string; selectionDigest?: string }>;
type ExpectedPreparation = ExpectedBinding & Readonly<{ actorUserId: string; workspaceId: string;
  action?: 'rename' | 'move'; selections?: readonly Readonly<{ sourcePath: string; destinationPath: string }>[] }>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const digest = /^[a-f0-9]{64}$/u;
function invalid(): never { throw new Error('Invalid implicit file preparation response.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)) invalid();
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid(); result[key] = field.value;
  }
  return result;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && new TextEncoder().encode(value).byteLength <= maximum && !/[\p{Cc}\p{Cf}]/u.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function path(value: unknown): value is string {
  return text(value, 4096) && !value.startsWith('/') && !value.includes('\\')
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) && value.split('/').length <= 33
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
export function readWorkspaceImplicitMoveBinding(value: unknown, expected: ExpectedBinding = {}): WorkspaceImplicitMoveBindingPublic {
  const row = record(value);
  exact(row, ['version','kind','actorUserId','workspaceId','operationId','requestId','selectionDigest']);
  if (row.version !== 1 || row.kind !== 'implicit-move-binding' || !text(row.actorUserId, 256)
    || !text(row.workspaceId, 256) || !text(row.operationId, 512) || typeof row.requestId !== 'string' || !uuid.test(row.requestId)
    || typeof row.selectionDigest !== 'string' || !digest.test(row.selectionDigest)) invalid();
  for (const key of ['actorUserId','workspaceId','operationId','requestId','selectionDigest'] as const) {
    if (expected[key] !== undefined && row[key] !== expected[key]) invalid();
  }
  return Object.freeze({ version: 1, kind: 'implicit-move-binding', actorUserId: row.actorUserId,
    workspaceId: row.workspaceId, operationId: row.operationId, requestId: row.requestId, selectionDigest: row.selectionDigest });
}
export function readWorkspaceImplicitMovePreparation(value: unknown, expected: ExpectedPreparation): WorkspaceImplicitMovePreparationPublicV2 {
  const row = record(value);
  const base = ['version','kind','state','actorUserId','workspaceId','operationId','requestId','selectionDigest','action','selections'];
  exact(row, [...base, ...(row.state === 'pending' ? ['status','canResume','statusUrl','resumeUrl'] : ['reason'])]);
  if (row.version !== 2 || row.kind !== 'implicit-move-preparation' || (row.state !== 'pending' && row.state !== 'aborted')
    || row.action !== 'move' && row.action !== 'rename' || expected.action !== undefined && row.action !== expected.action
    || !Array.isArray(row.selections) || Object.getPrototypeOf(row.selections) !== Array.prototype
    || !row.selections.length || row.selections.length > 1000
    || Reflect.ownKeys(row.selections).length !== row.selections.length + 1) invalid();
  const binding = readWorkspaceImplicitMoveBinding({ version: 1, kind: 'implicit-move-binding', actorUserId: row.actorUserId,
    workspaceId: row.workspaceId, operationId: row.operationId, requestId: row.requestId, selectionDigest: row.selectionDigest }, expected);
  const sourceSelections = row.selections;
  const selections = Array.from({ length: sourceSelections.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(sourceSelections, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid();
    const item = record(field.value); exact(item, ['sourcePath','destinationPath']);
    if (!path(item.sourcePath) || !path(item.destinationPath)) invalid();
    return Object.freeze({ sourcePath: item.sourcePath, destinationPath: item.destinationPath });
  });
  if (new TextEncoder().encode(JSON.stringify(selections)).byteLength > 65536) invalid();
  const expectedSelections = expected.selections;
  if (expectedSelections && (selections.length !== expectedSelections.length || selections.some((selection, index) =>
    selection.sourcePath !== expectedSelections[index].sourcePath || selection.destinationPath !== expectedSelections[index].destinationPath))) invalid();
  const common = { version: 2 as const, kind: 'implicit-move-preparation' as const, actorUserId: binding.actorUserId,
    workspaceId: binding.workspaceId, operationId: binding.operationId, requestId: binding.requestId,
    selectionDigest: binding.selectionDigest, action: row.action, selections: Object.freeze(selections) } as const;
  if (row.state === 'pending') {
    const url = `/api/files/operations/implicit-moves/${binding.requestId}`;
    if ((row.status !== 'reserved' && row.status !== 'draining' && row.status !== 'recovery_required')
      || row.canResume !== (row.status === 'reserved' || row.status === 'draining')
      || row.statusUrl !== url || row.resumeUrl !== url) invalid();
    return Object.freeze({ ...common, state: 'pending', status: row.status,
      canResume: row.status === 'reserved' || row.status === 'draining', statusUrl: url, resumeUrl: url });
  }
  if (row.reason !== 'user_cancelled' && row.reason !== 'precondition_failed') invalid();
  return Object.freeze({ ...common, state: 'aborted', reason: row.reason });
}
export function workspaceImplicitMovePreparationBinding(value: WorkspaceImplicitMovePreparationPublicV2): WorkspaceImplicitMoveBindingPublic {
  return readWorkspaceImplicitMoveBinding({ version: 1, kind: 'implicit-move-binding', actorUserId: value.actorUserId,
    workspaceId: value.workspaceId, operationId: value.operationId, requestId: value.requestId, selectionDigest: value.selectionDigest });
}

export function readWorkspaceImplicitMoveLegacyReplay(value: unknown,
  expected: Readonly<{ actorUserId?: string; workspaceId?: string; operationId?: string; batchId?: string; planId?: string }> = {},
): WorkspaceImplicitMoveLegacyReplayPublic {
  const row = record(value);
  exact(row, ['version','kind','actorUserId','workspaceId','operationId','batchId','planId']);
  if (row.version !== 1 || row.kind !== 'implicit-move-legacy-replay' || !text(row.actorUserId,256)
    || !text(row.workspaceId,256) || !text(row.operationId,512)
    || typeof row.batchId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(row.batchId)
    || typeof row.planId !== 'string' || !digest.test(row.planId)) invalid();
  for (const key of ['actorUserId','workspaceId','operationId','batchId','planId'] as const) {
    if (expected[key] !== undefined && row[key] !== expected[key]) invalid();
  }
  return Object.freeze({ version: 1, kind: 'implicit-move-legacy-replay', actorUserId: row.actorUserId,
    workspaceId: row.workspaceId, operationId: row.operationId, batchId: row.batchId, planId: row.planId });
}
