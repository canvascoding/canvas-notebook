import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { parseWorkspaceOperationJobScope } from '../files/workspace-operation-job-scope';
import { decodeWorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { captureExcalidrawReadonlyAssetMetadata } from './readonly-assets';
import { EXCALIDRAW_ASSET_MAX_BYTES } from './limits';
import { ExcalidrawCopyError, type ExcalidrawCopyAssetOriginal, type ExcalidrawCopyAssetReceipt,
  type ExcalidrawCopyIntent, type ExcalidrawCopyBirthReceipt } from './copy-contract';

export const copyDigest = nativeLinkJsonProof;
export const copyJson = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => !entry || typeof entry !== 'object' || Array.isArray(entry)
  ? entry : Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export const copyHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const copyId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
export const copyInteger = (value: unknown, min = 0): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value < Number.MAX_SAFE_INTEGER;
export function copyInvalid(code: ExcalidrawCopyError['code'] = 'EXCALIDRAW_COPY_INVALID'): never { throw new ExcalidrawCopyError(code); }
export function copyFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) { Object.values(value).forEach(copyFreeze); Object.freeze(value); } return value;
}
export function copyCapture(value: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(value, reason => copyInvalid(reason === 'too-large' ? 'EXCALIDRAW_COPY_TOO_LARGE' : 'EXCALIDRAW_COPY_INVALID'));
}
export function copyObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const field = Object.getOwnPropertyDescriptor(value, key); return !field?.enumerable || !Object.hasOwn(field, 'value');
    })) copyInvalid(); return value as Record<string, unknown>;
}
export function copyArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) copyInvalid();
  return value.map((_entry, index) => { const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) copyInvalid(); return field.value; });
}
function node(value: unknown, file: boolean): void {
  const row = copyObject(value, ['dev', 'ino', 'uid', 'mode', ...(file ? ['sizeBytes'] : [])]);
  for (const name of ['dev', 'ino']) if (typeof row[name] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(row[name] as string)
    || BigInt(row[name] as string) > BigInt('18446744073709551615')) copyInvalid();
  if (row.ino === '0' || !copyInteger(row.uid) || !copyInteger(row.mode) || (row.mode as number) > 0o7777
    || file && (!copyInteger(row.sizeBytes, 1) || (row.sizeBytes as number) > EXCALIDRAW_ASSET_MAX_BYTES || row.mode !== 0o600)) copyInvalid();
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function original(value: unknown): ExcalidrawCopyAssetOriginal {
  const row = copyObject(value, ['version', 'operationId', 'stageDigest', 'destinationScope', 'configuredDataRoot', 'resolvedDataRoot',
    'ancestors', 'privateDirectory', 'manifestIdentity', 'metadata', 'blobs', 'originalProof']);
  const scope = parseWorkspaceOperationJobScope(row.destinationScope);
  if (row.version !== 1 || !copyId(row.operationId) || !copyHash(row.stageDigest) || !copyHash(row.originalProof)
    || typeof row.configuredDataRoot !== 'string' || !row.configuredDataRoot || row.configuredDataRoot.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(row.configuredDataRoot) || Buffer.from(row.configuredDataRoot).toString('utf8') !== row.configuredDataRoot
    || typeof row.resolvedDataRoot !== 'string' || path.resolve(row.configuredDataRoot) !== row.resolvedDataRoot) copyInvalid();
  const ancestors = copyArray(row.ancestors, 4), names = ['', 'collaboration-assets', 'excalidraw', sha(scope.workspaceId).slice(0, 32)];
  if (ancestors.length !== 4) copyInvalid();
  ancestors.forEach((value, index) => { const entry = copyObject(value, ['name', 'identity']); node(entry.identity, false);
    if (entry.name !== names[index] || index > 0 && (entry.identity as { mode: number }).mode !== 0o700) copyInvalid(); });
  const privateDirectory = copyObject(row.privateDirectory, ['name', 'identity']); node(privateDirectory.identity, false);
  if (typeof privateDirectory.name !== 'string' || !/^\.copy-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(privateDirectory.name)
    || (privateDirectory.identity as { mode: number }).mode !== 0o700) copyInvalid();
  node(row.manifestIdentity, false);
  if ((row.manifestIdentity as { mode: number }).mode !== 0o600) copyInvalid();
  const metadata = copyArray(row.metadata, 2000).map(captureExcalidrawReadonlyAssetMetadata);
  if (new Set(metadata.map(item => item.fileId)).size !== metadata.length
    || !equal(metadata.map(item => item.fileId), metadata.map(item => item.fileId).sort((a, b) => a.localeCompare(b)))) copyInvalid();
  const expected = new Map(metadata.map(item => [item.contentHash, item.sizeBytes])), hashes = new Set<string>(); let bytes = 0;
  for (const metadataItem of metadata) if (expected.get(metadataItem.contentHash) !== metadataItem.sizeBytes) copyInvalid();
  const blobs = copyArray(row.blobs, 2000);
  for (const value of blobs) {
    const blob = copyObject(value, ['contentHash', 'sizeBytes', 'storageKey', 'disposition', 'identity']); node(blob.identity, true);
    if (!copyHash(blob.contentHash) || !copyInteger(blob.sizeBytes, 1) || expected.get(blob.contentHash) !== blob.sizeBytes
      || hashes.has(blob.contentHash) || blob.storageKey !== `${names[3]}/${blob.contentHash}`
      || !['birth', 'reuse'].includes(String(blob.disposition)) || (blob.identity as { sizeBytes: number }).sizeBytes !== blob.sizeBytes) copyInvalid();
    hashes.add(blob.contentHash); bytes += blob.sizeBytes;
    if (bytes > 50 * 1024 * 1024) copyInvalid('EXCALIDRAW_COPY_TOO_LARGE');
  }
  if (hashes.size !== expected.size || !equal([...hashes], [...hashes].sort((a, b) => a.localeCompare(b)))) copyInvalid();
  const { originalProof, ...body } = row; if (copyDigest(body) !== originalProof) copyInvalid();
  if (Buffer.byteLength(JSON.stringify(row)) > 4 * 1024 * 1024) copyInvalid('EXCALIDRAW_COPY_TOO_LARGE');
  return copyFreeze({ ...row, destinationScope: scope, metadata }) as unknown as ExcalidrawCopyAssetOriginal;
}
export function captureExcalidrawCopyAssetOriginal(value: unknown): ExcalidrawCopyAssetOriginal { return original(copyCapture(value)); }
export function captureExcalidrawCopyAssetReceipt(value: unknown, supplied: ExcalidrawCopyAssetOriginal): ExcalidrawCopyAssetReceipt {
  const assetOriginal = original(copyCapture(supplied));
  const row = copyObject(copyCapture(value), ['version', 'operationId', 'stageDigest', 'originalProof', 'blobs', 'receiptProof']);
  if (row.version !== 1 || row.operationId !== assetOriginal.operationId || row.stageDigest !== assetOriginal.stageDigest
    || row.originalProof !== assetOriginal.originalProof || !equal(row.blobs, assetOriginal.blobs)) copyInvalid();
  const { receiptProof, ...body } = row; if (!copyHash(receiptProof) || copyDigest(body) !== receiptProof) copyInvalid();
  return copyFreeze(row) as unknown as ExcalidrawCopyAssetReceipt;
}
export function captureExcalidrawCopyIntent(value: unknown): ExcalidrawCopyIntent {
  const row = copyObject(copyCapture(value), ['version', 'operationId', 'stageDigest', 'requestHash', 'origin', 'nativeRequestFingerprint',
    'nativeReceiptProof', 'b1TransactionId', 'createdAt', 'assetOriginal', 'documents', 'intentDigest']);
  const origin = decodeWorkspaceOperationCopyOrigin(row.origin), assetOriginal = original(row.assetOriginal);
  if (row.version !== 1 || !copyId(row.operationId) || !copyHash(row.stageDigest) || !copyHash(row.requestHash)
    || !copyHash(row.nativeRequestFingerprint) || !copyHash(row.nativeReceiptProof)
    || typeof row.b1TransactionId !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.b1TransactionId)
    || !copyInteger(row.createdAt, 1) || assetOriginal.operationId !== row.operationId || assetOriginal.stageDigest !== row.stageDigest
    || !equal(assetOriginal.destinationScope, origin.destinationScope)) copyInvalid();
  const ids = new Set<string>(), lineages = new Set<string>(), paths = new Set<string>(), sourceIds = new Set<string>();
  for (const value of copyArray(row.documents, 10_000)) {
    const doc = copyObject(value, ['sourceWorkspaceId', 'sourcePath', 'sourceDocumentId', 'sourceLineageId', 'sourceGeneration',
      'sourceSceneSequence', 'sourceCanonicalHash', 'sourceContentProof', 'destinationWorkspaceId', 'destinationPath', 'documentId', 'lineageId']);
    if (doc.sourceWorkspaceId !== origin.sourceScope.workspaceId || doc.destinationWorkspaceId !== origin.destinationScope.workspaceId
      || ![doc.sourceDocumentId, doc.sourceLineageId, doc.documentId, doc.lineageId].every(copyId)
      || ![doc.sourcePath, doc.destinationPath].every(item => isCanonicalWorkspacePath(item) && /[^/]\.excalidraw$/iu.test(item as string))
      || !copyInteger(doc.sourceGeneration, 1) || !copyInteger(doc.sourceSceneSequence) || !copyHash(doc.sourceCanonicalHash) || !copyHash(doc.sourceContentProof)
      || ids.has(doc.documentId as string) || lineages.has(doc.lineageId as string) || paths.has(doc.destinationPath as string)
      || doc.documentId === doc.sourceDocumentId || doc.lineageId === doc.sourceLineageId) copyInvalid();
    ids.add(doc.documentId as string); lineages.add(doc.lineageId as string); paths.add(doc.destinationPath as string); sourceIds.add(doc.sourceDocumentId as string);
  }
  if ([...ids].some(id => sourceIds.has(id))) copyInvalid();
  const { intentDigest, ...body } = row; if (!copyHash(intentDigest) || copyDigest(body) !== intentDigest) copyInvalid();
  return copyFreeze({ ...row, origin, assetOriginal }) as unknown as ExcalidrawCopyIntent;
}
export function captureExcalidrawCopyBirthReceipt(value: unknown): ExcalidrawCopyBirthReceipt {
  const row = copyObject(copyCapture(value), ['version', 'operationId', 'stageDigest', 'intent', 'documents', 'assetReceipt', 'pathReceiptProofs', 'b2TransactionId', 'receiptProof']);
  const intent = captureExcalidrawCopyIntent(row.intent), assetReceipt = captureExcalidrawCopyAssetReceipt(row.assetReceipt, intent.assetOriginal);
  const documents = copyArray(row.documents, 10_000);
  if (row.version !== 1 || row.operationId !== intent.operationId || row.stageDigest !== intent.stageDigest || documents.length !== intent.documents.length
    || typeof row.b2TransactionId !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.b2TransactionId)) copyInvalid();
  documents.forEach((value, index) => { const doc = copyObject(value, ['documentId', 'lineageId', 'workspaceId', 'path', 'lifecycleGeneration', 'sceneSequence', 'canonicalHash', 'persistedAt']);
    const expected = intent.documents[index];
    if (doc.documentId !== expected.documentId || doc.lineageId !== expected.lineageId || doc.workspaceId !== expected.destinationWorkspaceId
      || doc.path !== expected.destinationPath || doc.lifecycleGeneration !== 1 || doc.sceneSequence !== 0
      || doc.canonicalHash !== expected.sourceCanonicalHash || !copyInteger(doc.persistedAt, 1)) copyInvalid(); });
  if (copyArray(row.pathReceiptProofs, 1000).some(item => !copyHash(item))) copyInvalid();
  const { receiptProof, ...body } = row; if (!copyHash(receiptProof) || copyDigest(body) !== receiptProof) copyInvalid();
  return copyFreeze({ ...row, intent, assetReceipt }) as unknown as ExcalidrawCopyBirthReceipt;
}
