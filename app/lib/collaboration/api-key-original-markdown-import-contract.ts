import 'server-only';

import { createHash } from 'node:crypto';
import type { ApiKeyOriginalMarkdownImportOrigin } from '../api-keys/document-read-principal';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { MarkdownFileImportError } from './markdown-file-import';
import type { MarkdownFileImportReceipt } from './markdown-file-import-persistence';
import { decodeMarkdownOriginalImportSelectionV1, decodeMarkdownOriginalImportReceiptV1,
  type MarkdownOriginalImportSelectionV1 } from './markdown-original-import-contract';

const MAX_BYTES = 65_536;
const originKeys = ['kind', 'userId', 'integrationId', 'instanceId', 'credentialId', 'workspaceId', 'workspaceType',
  'organizationId', 'customerId', 'projectId', 'ownerUserId', 'rootPath', 'rootRelativePath', 'legacy', 'status',
  'schema', 'schemaOid', 'databaseOid', 'searchPath', 'purpose', 'entryPoint'] as const;
const selectionKeys = ['apiVersion', 'workspaceId', 'path', 'operationId', 'expectedFileVersion', 'initialRepresentation'] as const;

/** The native receipt remains the sole import journal. This immutable sidecar
 * records actual key attribution without converting it into a Session origin. */
export type ApiKeyOriginalMarkdownImportRecordV2 = Readonly<{
  version: 2;
  callerOperationId: string;
  selection: MarkdownOriginalImportSelectionV1;
  origin: ApiKeyOriginalMarkdownImportOrigin & Readonly<{ purpose: 'import_existing' }>;
  receipt: MarkdownFileImportReceipt;
}>;

function invalid(): never { throw new MarkdownFileImportError('MARKDOWN_IMPORT_INVALID_INPUT'); }
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, invalid, MAX_BYTES);
}
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value);
}
function id(value: unknown): value is string { return text(value, 256) && value.trim() === value; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function callerId(input: unknown): string {
  if (!text(input, 128) || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(input)) return invalid();
  return input;
}

/** Comparison data only. The coordinator must separately hold the genuine
 * fixed key principal before and after using any decoded stored facts. */
export function decodeApiKeyOriginalMarkdownImportOrigin(input: unknown): ApiKeyOriginalMarkdownImportOrigin {
  const value = record(capture(input), originKeys);
  if (value.kind !== 'api_key' || !['userId', 'integrationId', 'instanceId', 'credentialId', 'workspaceId'].every(key => id(value[key]))
    || !['personal', 'organization', 'team', 'project'].includes(value.workspaceType as string)
    || ['organizationId', 'projectId', 'customerId', 'ownerUserId'].some(key => value[key] !== null && !id(value[key]))
    || !text(value.rootPath, 8192) || !text(value.rootRelativePath, 4096, true) || value.legacy !== false || value.status !== 'active'
    || !id(value.schema) || value.schema.length > 63 || !text(value.searchPath, 4096)
    || ['schemaOid', 'databaseOid'].some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
    || value.purpose !== 'import_existing' && value.purpose !== 'import_existing_status'
    || value.entryPoint !== 'request' && value.entryPoint !== 'mcp') return invalid();
  return freeze(value as ApiKeyOriginalMarkdownImportOrigin);
}

/** Rotation and transport changes retain one caller operation. Credential and
 * entry point remain immutable attribution, never part of request identity. */
export function apiKeyOriginalMarkdownImportOperationId(originInput: unknown, caller: unknown): string {
  const origin = decodeApiKeyOriginalMarkdownImportOrigin(originInput);
  return `key-original-${hash(canonical({ domain: 'canvas-key-original-markdown-import-v2',
    userId: origin.userId, integrationId: origin.integrationId, instanceId: origin.instanceId,
    workspaceId: origin.workspaceId, callerOperationId: callerId(caller) }))}`;
}

export function apiKeyOriginalMarkdownImportRequestId(operationId: string): string {
  if (!/^key-original-[a-f0-9]{64}$/u.test(operationId)) return invalid();
  return `key-original-import:${operationId}`;
}

/** MCP retains its visible workspace namespace. HTTP uses the existing
 * workspace path rules; hidden historical paths cannot leak across entrypoints. */
export function apiKeyOriginalMarkdownImportPathVisible(path: string): boolean {
  return !path.split('/').some(segment => segment.startsWith('.'));
}

export function decodeApiKeyOriginalMarkdownImportRecordV2(input: unknown): ApiKeyOriginalMarkdownImportRecordV2 {
  const originalText = typeof input === 'string' ? input : undefined;
  if (originalText !== undefined) {
    if (Buffer.byteLength(originalText, 'utf8') > MAX_BYTES) return invalid();
    try { input = JSON.parse(originalText); } catch { return invalid(); }
  }
  const value = record(capture(input), ['version', 'callerOperationId', 'selection', 'origin', 'receipt']);
  record(value.selection, selectionKeys);
  const selection = decodeMarkdownOriginalImportSelectionV1(value.selection);
  const origin = decodeApiKeyOriginalMarkdownImportOrigin(value.origin), callerOperationId = callerId(value.callerOperationId);
  const receipt = decodeMarkdownOriginalImportReceiptV1(value.receipt);
  if (value.version !== 2 || origin.purpose !== 'import_existing' || selection.workspaceId !== origin.workspaceId
    || selection.operationId !== apiKeyOriginalMarkdownImportOperationId(origin, callerOperationId)
    || receipt.operationId !== selection.operationId || receipt.target.workspaceId !== selection.workspaceId
    || receipt.target.organizationId !== origin.organizationId || receipt.target.path !== selection.path
    || selection.initialRepresentation !== 'auto' && selection.initialRepresentation !== receipt.target.representation
    || origin.entryPoint === 'mcp' && !apiKeyOriginalMarkdownImportPathVisible(selection.path)) return invalid();
  const result = freeze({ version: 2 as const, callerOperationId, selection,
    origin: origin as ApiKeyOriginalMarkdownImportRecordV2['origin'], receipt });
  const serialized = canonical(result);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES || originalText !== undefined && originalText !== serialized) return invalid();
  return result;
}

export function serializeApiKeyOriginalMarkdownImportRecordV2(input: ApiKeyOriginalMarkdownImportRecordV2): string {
  return canonical(decodeApiKeyOriginalMarkdownImportRecordV2(input));
}
export function apiKeyOriginalMarkdownImportRecordDigest(input: ApiKeyOriginalMarkdownImportRecordV2): string {
  return hash(serializeApiKeyOriginalMarkdownImportRecordV2(input));
}
export function apiKeyOriginalMarkdownImportRequestDigest(input: ApiKeyOriginalMarkdownImportRecordV2): string {
  const value = decodeApiKeyOriginalMarkdownImportRecordV2(input);
  return hash(canonical({ domain: 'canvas-key-original-markdown-request-v2', callerOperationId: value.callerOperationId,
    userId: value.origin.userId, integrationId: value.origin.integrationId, instanceId: value.origin.instanceId,
    selection: value.selection }));
}
