import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { MarkdownFileImportReceipt } from '../collaboration/markdown-file-import-persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceOperationJobScope, WorkspaceOperationDeleteBatchPlan } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { decodeWorkspaceOperationPhysicalDeleteBatchPlanV5 } from './workspace-operation-physical-delete-html-plan-v5';
import { decodeWorkspaceOperationNativeDeleteBatchPlan } from './workspace-operation-native-delete-plan';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { workspaceOperationMcpBatchId } from './workspace-operation-mcp-authorization';
import { workspaceOperationSourceNativeEvidence } from './workspace-operation-mixed-source-evidence';
import { decodeWorkspacePathHtmlImportPreparationPlanV4, type WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import type { PhysicalNativeImportBindingV1 } from '../markdown/physical-native-import-binding';
import { decodeRawHtmlNativeBindingV1, type RawHtmlNativeBindingV1 } from '../markdown/workspace-raw-html-source-binding';
import { WorkspacePathImportPreparationRecordError, workspacePathOriginalImportIds } from './workspace-path-import-preparation-record';

/** Immutable original B0 facts only. This data never authenticates a request,
 * creates a principal/claim, grants SQL access, or describes today's pathname. */
export type WorkspacePathHtmlImportPreparationRecordV2 = Readonly<{
  version: 2; operationId: string; batchId: string;
  origin: Readonly<{ version: 1; kind: 'request' | 'direct-mcp'; userId: string; sessionId: string;
    clientId: string | null; tool: 'move' | 'rename' | 'delete'; scope: WorkspaceOperationJobScope;
    realm: Readonly<{ schemaName: string; schemaOid: number; databaseOid: number }> }>;
  previewPlan: WorkspacePathHtmlImportPreparationPlanV4;
  imports: readonly Readonly<{ requirementIndex: number; receipt: MarkdownFileImportReceipt;
    bindingProof: string; initialBinaryHash: string; initialVectorHash: string;
    legacyBinding: PhysicalNativeImportBindingV1; ordinaryBinding: RawHtmlNativeBindingV1 }>[];
  nativePlan: WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationDeleteBatchPlan;
  b0TransactionId: string; preparedAt: number; recordProof: string;
}>;
type Code = 'PATH_IMPORT_PREPARATION_RECORD_INVALID' | 'PATH_IMPORT_PREPARATION_RECORD_CHANGED'
  | 'PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE' | 'PATH_IMPORT_PREPARATION_RECORD_UNAVAILABLE';
type Row = Record<string, unknown>;
const recordLimit = 16 * 1024 * 1024;
const receiptLimit = 32768;
const recordKeys = ['version', 'operationId', 'batchId', 'origin', 'previewPlan', 'imports', 'nativePlan', 'b0TransactionId', 'preparedAt', 'recordProof'];
const receiptKeys = ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired'];
const targetKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration',
  'newlineStyle', 'hasBom', 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'];

function workspacePathRecordFailure(code: Code = 'PATH_IMPORT_PREPARATION_RECORD_INVALID'): never {
  throw new WorkspacePathImportPreparationRecordError(code);
}
function captureWorkspacePathRecordData(input: unknown, maximum = recordLimit): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => workspacePathRecordFailure(reason === 'too-large'
    ? 'PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE' : 'PATH_IMPORT_PREPARATION_RECORD_INVALID'), maximum);
}
function workspacePathRecordObject(input: unknown, keys: readonly string[]): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return workspacePathRecordFailure();
  return input as Row;
}
function workspacePathRecordIdentifier(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
}
function workspacePathRecordInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}
function workspacePathRecordDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
/** Called only after bounded own-data capture. Arrays keep cohort order. */
function workspacePathRecordCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => workspacePathRecordCanonical(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${workspacePathRecordCanonical((value as Row)[key])}`).join(',')}}`;
  const text = JSON.stringify(value); if (typeof text !== 'string') return workspacePathRecordFailure(); return text;
}
function workspacePathRecordFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) workspacePathRecordFreeze(child); Object.freeze(value); }
  return value;
}
function workspacePathRecordReceipt(input: unknown): MarkdownFileImportReceipt {
  const value = workspacePathRecordObject(input, receiptKeys), target = workspacePathRecordObject(value.target, targetKeys);
  if (value.version !== 1 || !workspacePathRecordIdentifier(value.operationId) || value.checkpointRequired !== true
    || !workspacePathRecordDigest(value.requestFingerprint) || !workspacePathRecordDigest(value.sourceHash)
    || !workspacePathRecordInteger(value.sourceBytes, 0, 4 * 1024 * 1024)
    || !['documentId', 'lineageId', 'workspaceId'].every(key => workspacePathRecordIdentifier(target[key]))
    || target.organizationId !== null && !workspacePathRecordIdentifier(target.organizationId)
    || !workspacePathRecordIdentifier(target.path, 4096) || !isCanonicalAdmissionPath(target.path)
    || !/\.(?:md|markdown)$/iu.test(target.path) || typeof target.representation !== 'string'
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(target.representation)
    || target.schemaVersion !== 1 || target.lifecycleGeneration !== 1 || target.initialSequence !== 0
    || typeof target.newlineStyle !== 'string' || !['lf', 'crlf'].includes(target.newlineStyle) || typeof target.hasBom !== 'boolean'
    || !workspacePathRecordInteger(target.persistedAt) || typeof target.initialStateProof !== 'string'
    || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(target.initialStateProof)
    || Buffer.byteLength(workspacePathRecordCanonical(value)) > receiptLimit) return workspacePathRecordFailure();
  return value as MarkdownFileImportReceipt;
}

/** History decoder: all initial identities are facts in the original native
 * plan. No live-state read, source import, rebind, authority or D2 adoption. */
export function decodeWorkspacePathHtmlImportPreparationRecordV2(input: unknown): WorkspacePathHtmlImportPreparationRecordV2 {
  const originalText = typeof input === 'string' ? input : undefined;
  if (originalText !== undefined) {
    if (Buffer.byteLength(originalText) < 1 || Buffer.byteLength(originalText) > recordLimit) return workspacePathRecordFailure('PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE');
    try { input = JSON.parse(originalText); } catch { return workspacePathRecordFailure(); }
  }
  const value = workspacePathRecordObject(captureWorkspacePathRecordData(input), recordKeys);
  const origin = workspacePathRecordObject(value.origin, ['version', 'kind', 'userId', 'sessionId', 'clientId', 'tool', 'scope', 'realm']);
  const realm = workspacePathRecordObject(origin.realm, ['schemaName', 'schemaOid', 'databaseOid']);
  if (value.version !== 2 || typeof value.operationId !== 'string' || value.operationId.length < 1 || value.operationId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value.operationId) || Buffer.from(value.operationId).toString('utf8') !== value.operationId
    || !workspacePathRecordIdentifier(value.batchId, 128)
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.batchId) || origin.version !== 1 || typeof origin.kind !== 'string'
    || !['request', 'direct-mcp'].includes(origin.kind)
    || !workspacePathRecordIdentifier(origin.userId) || !workspacePathRecordIdentifier(origin.sessionId)
    || (origin.kind === 'request' ? origin.clientId !== null : !workspacePathRecordIdentifier(origin.clientId)
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.operationId))
    || typeof origin.tool !== 'string' || !['move', 'rename', 'delete'].includes(origin.tool) || !workspacePathRecordIdentifier(realm.schemaName, 63)
    || Buffer.byteLength(realm.schemaName) > 63 || !workspacePathRecordInteger(realm.schemaOid, 1, 4294967295)
    || !workspacePathRecordInteger(realm.databaseOid, 1, 4294967295) || !workspacePathRecordInteger(value.preparedAt)
    || typeof value.b0TransactionId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value.b0TransactionId)
    || BigInt(value.b0TransactionId) > BigInt('18446744073709551615') || !workspacePathRecordDigest(value.recordProof)
    || !Array.isArray(value.imports) || !value.imports.length || value.imports.length > 10000) return workspacePathRecordFailure();
  let scope: WorkspaceOperationJobScope, previewPlan: WorkspacePathHtmlImportPreparationPlanV4;
  let nativePlan: WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationDeleteBatchPlan;
  try {
    scope = parseWorkspaceOperationJobScope(origin.scope);
    previewPlan = decodeWorkspacePathHtmlImportPreparationPlanV4(value.previewPlan);
    const native = workspacePathRecordObject(value.nativePlan, Object.keys(value.nativePlan as object));
    nativePlan = native.version === 3 ? decodeWorkspaceOperationNativeMoveBatchPlan(native)
      : native.version === 5 ? decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(native) : decodeWorkspaceOperationNativeDeleteBatchPlan(native);
  } catch (error) {
    if (error instanceof WorkspacePathImportPreparationRecordError) throw error;
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
    return workspacePathRecordFailure(typeof code === 'string' && code.endsWith('_TOO_LARGE')
      ? 'PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE' : 'PATH_IMPORT_PREPARATION_RECORD_INVALID');
  }
  if (scope.legacy || scope.rootRelativePath === null || previewPlan.readiness !== 'requires-import-rebinding'
    || !equal(scope, previewPlan.scope) || origin.tool !== previewPlan.request.kind || !equal(scope, nativePlan.sourceEvidence.workspaceScope)
    || nativePlan.planIdentityVersion !== 4 && nativePlan.planIdentityVersion !== 5 || nativePlan.readiness !== 'ready'
    || !nativePlan.linkAssessment.complete || nativePlan.linkAssessment.blockers.length || nativePlan.actions.length !== 1 || nativePlan.actions[0].kind !== origin.tool
    || (origin.tool === 'delete' ? nativePlan.version !== 2 && nativePlan.version !== 5 : nativePlan.version !== 3)
    || !equal(nativePlan.actions[0].selections, previewPlan.request.selections)
    || value.imports.length !== previewPlan.importRequirements.length) return workspacePathRecordFailure();
  let expectedBatchId: string;
  try { expectedBatchId = origin.kind === 'request'
    ? createHash('sha256').update(JSON.stringify(['workspace-path-operation-id-v1', scope.workspaceId, origin.userId, value.operationId])).digest('hex')
    : workspaceOperationMcpBatchId({ userId: origin.userId as string, clientId: origin.clientId as string, workspaceId: scope.workspaceId,
      tool: origin.tool === 'delete' ? 'delete_knowledge_source' : 'move_knowledge_source', operationId: value.operationId as string }); }
  catch { return workspacePathRecordFailure(); }
  if (value.batchId !== expectedBatchId) return workspacePathRecordFailure();
  const reviewId = `${createHash('sha256').update(JSON.stringify(['workspace-path-action-v1', scope.workspaceId,
    origin.tool, previewPlan.request.selections.map(selection => ({ sourcePath: selection.sourcePath,
      ...(selection.destinationPath === undefined ? {} : { destinationPath: selection.destinationPath }) })), false, false])).digest('hex')}-request`;
  if (nativePlan.actions[0].reviewId !== reviewId) return workspacePathRecordFailure();
  const nativeEvidence = workspaceOperationSourceNativeEvidence(nativePlan.sourceEvidence);
  const nativeById = new Map(nativeEvidence.nativeBindings.map(binding => [binding.expected.documentId, binding]));
  const usedDocuments = new Set<string>(), usedLineages = new Set<string>(), usedOperations = new Set<string>();
  const imports = value.imports.map((entry, index) => {
    const item = workspacePathRecordObject(entry, ['requirementIndex', 'receipt', 'bindingProof', 'initialBinaryHash', 'initialVectorHash', 'legacyBinding', 'ordinaryBinding']);
    const receipt = workspacePathRecordReceipt(item.receipt), target = receipt.target;
    const requirement = previewPlan.importRequirements[index], ids = workspacePathOriginalImportIds(value.operationId as string, previewPlan.planId, index);
    const binding = nativeById.get(target.documentId);
    const legacyBinding = item.legacyBinding as PhysicalNativeImportBindingV1;
    const sourceBinding = previewPlan.sourceBindings[index];
    const ordinaryBinding = decodeRawHtmlNativeBindingV1(item.ordinaryBinding, sourceBinding, legacyBinding);
    if (!equal(legacyBinding.receipt, receipt) || legacyBinding.bindingProof !== item.bindingProof
      || legacyBinding.nativeBinaryHash !== item.initialBinaryHash || legacyBinding.nativeVectorHash !== item.initialVectorHash
      || nativePlan.sourceEvidence.evidenceVersion !== 5 || !equal(ordinaryBinding.inventory4,
        nativePlan.sourceEvidence.nativeOrdinarySources4.find(value => value.documentId === target.documentId)?.inventory)) return workspacePathRecordFailure();
    if (item.requirementIndex !== index || !workspacePathRecordDigest(item.bindingProof) || !workspacePathRecordDigest(item.initialBinaryHash)
      || !workspacePathRecordDigest(item.initialVectorHash) || receipt.operationId !== ids.operationId
      || requirement.workspaceId !== scope.workspaceId || target.workspaceId !== scope.workspaceId || target.organizationId !== scope.organizationId
      || target.path !== requirement.path || receipt.sourceHash !== requirement.physical.byteHash
      || receipt.sourceBytes !== requirement.physical.byteLength || receipt.sourceHash !== requirement.preparation.sourceHash
      || receipt.sourceBytes !== requirement.preparation.sourceBytes || target.representation !== requirement.preparation.representation
      || target.newlineStyle !== requirement.preparation.newlineStyle || target.hasBom !== requirement.preparation.hasBom
      || target.persistedAt > Number(value.preparedAt) || usedDocuments.has(target.documentId) || usedLineages.has(target.lineageId)
      || usedOperations.has(receipt.operationId) || !binding || binding.expected.lineageId !== target.lineageId
      || binding.expected.workspaceId !== target.workspaceId || binding.expected.organizationId !== target.organizationId
      || binding.expected.path !== target.path || binding.expected.representation !== target.representation
      || binding.expected.schemaVersion !== target.schemaVersion || binding.expected.lifecycleGeneration !== target.lifecycleGeneration
      || binding.expected.registryStateVersion !== 0 || binding.expected.documentSequence !== target.initialSequence
      || binding.expected.persistedAt !== target.persistedAt || binding.expected.stateProof !== target.initialStateProof
      || binding.expected.binaryHash !== item.initialBinaryHash || binding.expected.vectorHash !== item.initialVectorHash
      || binding.byteProfile.newlineStyle !== target.newlineStyle || binding.byteProfile.hasBom !== target.hasBom) return workspacePathRecordFailure();
    usedDocuments.add(target.documentId); usedLineages.add(target.lineageId); usedOperations.add(receipt.operationId);
    return { requirementIndex: index, receipt, bindingProof: item.bindingProof,
      initialBinaryHash: item.initialBinaryHash, initialVectorHash: item.initialVectorHash, legacyBinding, ordinaryBinding };
  });
  const capturedOrigin: WorkspacePathHtmlImportPreparationRecordV2['origin'] = { version: 1,
    kind: origin.kind as 'request' | 'direct-mcp', userId: origin.userId as string, sessionId: origin.sessionId as string,
    clientId: origin.clientId as string | null, tool: origin.tool as 'move' | 'rename' | 'delete', scope,
    realm: { schemaName: realm.schemaName as string, schemaOid: realm.schemaOid as number, databaseOid: realm.databaseOid as number } };
  const body = { version: 2 as const, operationId: value.operationId, batchId: value.batchId,
    origin: capturedOrigin, previewPlan, imports, nativePlan, b0TransactionId: value.b0TransactionId, preparedAt: value.preparedAt };
  const recordProof = createHash('sha256').update(workspacePathRecordCanonical(body)).digest('hex');
  const result = { ...body, recordProof } as WorkspacePathHtmlImportPreparationRecordV2;
  const text = workspacePathRecordCanonical(result);
  if (recordProof !== value.recordProof || Buffer.byteLength(text) > recordLimit
    || originalText !== undefined && originalText !== text) return workspacePathRecordFailure();
  return workspacePathRecordFreeze(result);
}
export function serializeWorkspacePathHtmlImportPreparationRecordV2(input: WorkspacePathHtmlImportPreparationRecordV2): string {
  return workspacePathRecordCanonical(decodeWorkspacePathHtmlImportPreparationRecordV2(input));
}
