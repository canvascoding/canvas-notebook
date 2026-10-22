import 'server-only';

import { decodeWorkspaceOperationCopyOrigin, type WorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { decodePhysicalNativeImportBindingV2, PhysicalNativeImportBindingV2Error,
  type PhysicalNativeImportBindingV2 } from '../markdown/physical-native-import-binding-v2';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';

export const NATIVE_COPY_MARKDOWN_BIRTH_V2_LIMIT = 16 * 1024 * 1024;
/** Historical data commitments only. A future fixed Stage/Owner must derive
 * these exact proofs from its actual E5 and concrete namespace operation. No
 * caller-provided digest authenticates an assessment or grants persistence. */
export type NativeCopyMarkdownNamespaceAssessmentV1 = Readonly<{
  version: 1; kind: 'copy-html-v4-assessment'; sourceSemanticProof: string; destinationSemanticProof: string;
  requestProof: string; beforeNamespaceProof: string; finalNamespaceProof: string; htmlAssessmentProof: string;
}>;
export type NativeCopyMarkdownBirthV2 = Readonly<{
  version: 2;
  parent: Readonly<{ operationId: string; planId: string; stageDigest: string; requestHash: string;
    requirementIndex: number; entityKey: string; requirementProof: string }>;
  origin: WorkspaceOperationCopyOrigin; binding: PhysicalNativeImportBindingV2;
  namespaceAssessment: NativeCopyMarkdownNamespaceAssessmentV1;
  b1TransactionId: string; birthProof: string;
}>;
function nativeBirthV2Fail(): never { throw new PhysicalNativeImportBindingV2Error('CHANGED'); }
function nativeBirthV2Object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return nativeBirthV2Fail();
  return input as Record<string, unknown>;
}
function nativeBirthV2Freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) nativeBirthV2Freeze(child); Object.freeze(value); }
  return value;
}
/** Strict data-only variant, deliberately disjoint from historical Birth1.
 * It does not insert a Birth, read SQL, identify a live B/XID or authorize any
 * operation. Those fixed genuine dispatch/storage boundaries remain absent. */
export function decodeNativeCopyMarkdownBirthV2(input: unknown): NativeCopyMarkdownBirthV2 {
  const value = nativeBirthV2Object(captureWorkspaceOperationNativePlanData(input, nativeBirthV2Fail, NATIVE_COPY_MARKDOWN_BIRTH_V2_LIMIT),
    ['version', 'parent', 'origin', 'binding', 'namespaceAssessment', 'b1TransactionId', 'birthProof']);
  const parent = nativeBirthV2Object(value.parent, ['operationId', 'planId', 'stageDigest', 'requestHash', 'requirementIndex', 'entityKey', 'requirementProof']);
  const digest = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item);
  const id = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256
    && item.trim() === item && !/[\u0000-\u001f\u007f]/u.test(item) && Buffer.from(item).toString('utf8') === item;
  if (value.version !== 2 || !id(parent.operationId) || ![parent.planId, parent.stageDigest, parent.requestHash, parent.requirementProof].every(digest)
    || typeof parent.requirementIndex !== 'number' || !Number.isSafeInteger(parent.requirementIndex) || Object.is(parent.requirementIndex, -0)
    || parent.requirementIndex < 0 || parent.requirementIndex > 9999 || typeof parent.entityKey !== 'string' || !parent.entityKey
    || parent.entityKey.length > 4096 || Buffer.from(parent.entityKey).toString('utf8') !== parent.entityKey
    || typeof value.b1TransactionId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value.b1TransactionId)
    || BigInt(value.b1TransactionId) > BigInt('18446744073709551615') || !digest(value.birthProof)) return nativeBirthV2Fail();
  const origin = decodeWorkspaceOperationCopyOrigin(value.origin), binding = decodePhysicalNativeImportBindingV2(value.binding);
  if (binding.source.workspaceId !== origin.sourceScope.workspaceId || binding.source.organizationId !== origin.sourceScope.organizationId
    || binding.receipt.target.workspaceId !== origin.destinationScope.workspaceId
    || binding.receipt.target.organizationId !== origin.destinationScope.organizationId) return nativeBirthV2Fail();
  const assessment = nativeBirthV2Object(value.namespaceAssessment, ['version', 'kind', 'sourceSemanticProof', 'destinationSemanticProof',
    'requestProof', 'beforeNamespaceProof', 'finalNamespaceProof', 'htmlAssessmentProof']);
  if (assessment.version !== 1 || assessment.kind !== 'copy-html-v4-assessment'
    || ![assessment.sourceSemanticProof, assessment.destinationSemanticProof, assessment.requestProof,
      assessment.beforeNamespaceProof, assessment.finalNamespaceProof, assessment.htmlAssessmentProof].every(digest)) return nativeBirthV2Fail();
  const { birthProof, ...body } = value;
  if (proof(body) !== birthProof) return nativeBirthV2Fail();
  return nativeBirthV2Freeze(value) as unknown as NativeCopyMarkdownBirthV2;
}
export function nativeCopyMarkdownBirthV2Text(input: NativeCopyMarkdownBirthV2): string {
  const value = decodeNativeCopyMarkdownBirthV2(input);
  const text = JSON.stringify(value, (_key, item: unknown) => !item || typeof item !== 'object' || Array.isArray(item)
    ? item : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  if (Buffer.byteLength(text) > NATIVE_COPY_MARKDOWN_BIRTH_V2_LIMIT) return nativeBirthV2Fail();
  return text;
}
