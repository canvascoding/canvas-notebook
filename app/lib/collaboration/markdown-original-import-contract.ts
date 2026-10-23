import 'server-only';

import { createHash } from 'node:crypto';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { MarkdownFileImportError } from './markdown-file-import';
import type { MarkdownFileImportReceipt, PristineOriginalRequestScopeExpectation } from './markdown-file-import-persistence';

/** A selection is input, never a principal, permission, or native identity. */
export type MarkdownOriginalImportSelectionV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  path: string;
  operationId: string;
  expectedFileVersion: string;
  initialRepresentation: 'auto' | 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
}>;

/** Historical facts only. The owner must authenticate every read/retry/write. */
export type MarkdownOriginalImportRecordV1 = Readonly<{
  version: 1;
  selection: MarkdownOriginalImportSelectionV1;
  origin: PristineOriginalRequestScopeExpectation;
  receipt: MarkdownFileImportReceipt;
}>;

const MAX_RECORD_BYTES = 65_536;
const selectionKeys = ['apiVersion', 'workspaceId', 'path', 'operationId', 'expectedFileVersion', 'initialRepresentation'] as const;
const originKeys = ['userId', 'sessionId', 'workspaceId', 'workspaceType', 'organizationId', 'projectId', 'customerId',
  'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status', 'schema', 'schemaOid', 'databaseOid', 'searchPath'] as const;
const receiptKeys = ['version', 'operationId', 'requestFingerprint', 'sourceHash', 'sourceBytes', 'target', 'checkpointRequired'] as const;
const targetKeys = ['documentId', 'workspaceId', 'organizationId', 'path', 'representation', 'schemaVersion', 'lifecycleGeneration',
  'newlineStyle', 'hasBom', 'lineageId', 'initialSequence', 'initialStateProof', 'persistedAt'] as const;

function invalid(): never {
  throw new MarkdownFileImportError('MARKDOWN_IMPORT_INVALID_INPUT');
}

/** Detaches before any property read, serialization, or digest; no user code runs. */
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, () => invalid(), MAX_RECORD_BYTES);
}

function record(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => !optional.includes(key) && !Object.hasOwn(value, key))) return invalid();
  return value;
}

function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value) && value.isWellFormed();
}

function identifier(value: unknown): value is string {
  return text(value, 256) && value.trim() === value;
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Only detached, validated finite JSON data reaches this serializer. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function decodeMarkdownOriginalImportSelectionV1(input: unknown): MarkdownOriginalImportSelectionV1 {
  const value = record(capture(input), selectionKeys, ['initialRepresentation']);
  const initialRepresentation = value.initialRepresentation ?? 'auto';
  if (value.apiVersion !== 1 || !identifier(value.workspaceId)
    || !text(value.path, 4096) || !isCanonicalAdmissionPath(value.path) || !/\.(?:md|markdown)$/iu.test(value.path)
    || !text(value.operationId, 128) || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(value.operationId)
    || !text(value.expectedFileVersion, 1024) || value.expectedFileVersion.trim() !== value.expectedFileVersion
    || !/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?$/u.test(value.expectedFileVersion)
    || typeof initialRepresentation !== 'string' || !['auto', 'plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(initialRepresentation)
    || Object.hasOwn(value, 'initialRepresentation') && value.initialRepresentation === null) return invalid();
  return freeze({ ...value, initialRepresentation } as MarkdownOriginalImportSelectionV1);
}

export function markdownOriginalImportRequestId(operationId: string): string {
  if (!text(operationId, 128) || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(operationId)) return invalid();
  return `original-import:${operationId}`;
}

/** SID is intentionally historical: renewed authentication retains the request identity. */
export function markdownOriginalImportRequestDigest(selection: MarkdownOriginalImportSelectionV1, userId: string): string {
  const normalized = decodeMarkdownOriginalImportSelectionV1(selection);
  if (!identifier(userId)) return invalid();
  return sha256(canonicalJson({ domain: 'canvas-explicit-original-markdown-import-v1', selection: normalized, userId }));
}

function captureOrigin(input: unknown): PristineOriginalRequestScopeExpectation {
  const value = record(input, originKeys);
  if (!identifier(value.userId) || !identifier(value.sessionId) || !identifier(value.workspaceId)
    || typeof value.workspaceType !== 'string' || !['personal', 'organization', 'team', 'project'].includes(value.workspaceType)
    || ['organizationId', 'projectId', 'customerId', 'ownerUserId'].some(key => value[key] !== null && !identifier(value[key]))
    || !text(value.rootPath, 8192) || !text(value.rootRelativePath, 4096, true)
    || value.legacy !== false || value.status !== 'active' || !identifier(value.schema) || value.schema.length > 63
    || !integer(value.schemaOid, 1) || !integer(value.databaseOid, 1) || !text(value.searchPath, 4096)) return invalid();
  return value as PristineOriginalRequestScopeExpectation;
}

function captureReceipt(input: unknown): MarkdownFileImportReceipt {
  const value = record(input, receiptKeys);
  const target = record(value.target, targetKeys);
  if (value.version !== 1 || !identifier(value.operationId) || value.checkpointRequired !== true
    || typeof value.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.requestFingerprint)
    || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceHash)
    || !integer(value.sourceBytes, 0) || value.sourceBytes > 8 * 1024 * 1024
    || !identifier(target.documentId) || !identifier(target.lineageId) || !identifier(target.workspaceId)
    || target.organizationId !== null && !identifier(target.organizationId)
    || !text(target.path, 4096) || !isCanonicalAdmissionPath(target.path) || !/\.(?:md|markdown)$/iu.test(target.path)
    || typeof target.representation !== 'string' || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(target.representation)
    || target.schemaVersion !== 1 || target.lifecycleGeneration !== 1 || target.initialSequence !== 0
    || !integer(target.persistedAt, 0) || typeof target.initialStateProof !== 'string'
    || !/^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(target.initialStateProof)
    || !['lf', 'crlf'].includes(target.newlineStyle as string) || typeof target.hasBom !== 'boolean') return invalid();
  return value as MarkdownFileImportReceipt;
}

/** Decodes private historical data; the result is never authorization. */
export function decodeMarkdownOriginalImportRecordV1(input: unknown): MarkdownOriginalImportRecordV1 {
  const originalText = typeof input === 'string' ? input : undefined;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_RECORD_BYTES) return invalid();
    try { input = JSON.parse(input); } catch { return invalid(); }
  }
  const value = record(capture(input), ['version', 'selection', 'origin', 'receipt']);
  // Stored records contain the normalized field; absence is only a public-input convenience.
  record(value.selection, selectionKeys);
  const selection = decodeMarkdownOriginalImportSelectionV1(value.selection);
  const origin = captureOrigin(value.origin);
  const receipt = captureReceipt(value.receipt);
  if (value.version !== 1 || origin.workspaceId !== selection.workspaceId || receipt.operationId !== selection.operationId
    || receipt.target.workspaceId !== selection.workspaceId || receipt.target.organizationId !== origin.organizationId
    || receipt.target.path !== selection.path || selection.initialRepresentation !== 'auto'
      && selection.initialRepresentation !== receipt.target.representation) return invalid();
  const result = freeze({ version: 1 as const, selection, origin, receipt });
  const serialized = canonicalJson(result);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES
    || originalText !== undefined && originalText !== serialized) return invalid();
  return result;
}

export function serializeMarkdownOriginalImportRecordV1(input: MarkdownOriginalImportRecordV1): string {
  return canonicalJson(decodeMarkdownOriginalImportRecordV1(input));
}

export function markdownOriginalImportRecordDigest(input: MarkdownOriginalImportRecordV1): string {
  return sha256(serializeMarkdownOriginalImportRecordV1(input));
}
