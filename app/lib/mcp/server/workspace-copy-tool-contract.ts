import { types } from 'node:util';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { WorkspaceOperationExecutionResult } from '../../files/workspace-file-operation-executor';
import type { WorkspaceOperationNativeCopyPreviewPublic } from '../../files/workspace-operation-native-copy-public';
import type { McpWorkspaceNativeCopyOperationStatus } from '../../files/workspace-operation-native-copy-status';
import { isCanonicalWorkspacePath } from '../../workspaces/path-identity';
import { DirectMcpAuthorizationError } from './access-token-verifier';
import { directMcpToolAuthorizationError } from './tool-auth';
import { captureBoundedMcpToolJson as data, freezeMcpToolJson as frozen, type Json, type JsonRecord } from './bounded-tool-json';

export const WORKSPACE_COPY_REQUEST_MAX_BYTES = 64 * 1024;
/** Entire JSON CallToolResult, including both text and structuredContent. */
export const WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES = 1024 * 1024;
const MAX_SELECTIONS = 1000, MAX_STEPS = 10_000, MAX_PATH = 1024, MAX_WORKSPACE = 200;
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u;
const planPattern = /^[a-f0-9]{64}$/u;
const statuses = {
  INVALID_REQUEST: 400, AUTHENTICATION_REQUIRED: 401, ACCESS_DENIED: 403,
  COPY_OPERATION_NOT_FOUND: 404, COPY_STATUS_NOT_FOUND: 404,
  COPY_PLAN_CHANGED: 409, COPY_SCOPE_CHANGED: 409, COPY_BUSY: 409, COPY_CONFLICT: 409,
  COPY_TOO_LARGE: 413, COPY_OUTPUT_TOO_LARGE: 413, COPY_NATIVE_REQUIRED: 409,
  COPY_OUTCOME_UNCONFIRMED: 503, COPY_UNAVAILABLE: 503,
} as const;
export type PublicCopyCode = keyof typeof statuses;
export const PUBLIC_COPY_ERROR_CODES = Object.freeze(Object.keys(statuses) as PublicCopyCode[]);

export class WorkspaceCopyToolError extends Error {
  readonly status: number;
  readonly operationId?: string;
  constructor(readonly code: PublicCopyCode, operationId?: string) {
    super(code); this.name = 'WorkspaceCopyToolError'; this.status = statuses[code];
    if (typeof operationId === 'string' && operationPattern.test(operationId)) this.operationId = operationId;
  }
}

type Selection = Readonly<{ sourcePath: string; destinationPath: string }>;
type Slots = Readonly<{ apiVersion: 1; sourceWorkspaceId: string; destinationWorkspaceId: string }>;
type Selected = Readonly<{ selections: readonly Selection[]; renameOnCollision: boolean; destinationDirectory?: string }>;
export type DecodedDirectMcpWorkspaceCopyRequestV1 = Slots & (
  Readonly<{ action: 'preview' }> & Selected
  | Readonly<{ action: 'apply' | 'recover'; operationId: string; planId: string }> & Selected & Readonly<{ renameOnCollision: false }>
  | Readonly<{ action: 'status'; operationId: string }>
);
type PublicExecution = Readonly<Omit<WorkspaceOperationExecutionResult, 'errorCode' | 'completedSteps' | 'pendingSteps'> & {
  completedSteps: readonly string[]; pendingSteps: readonly string[]; errorCode: PublicCopyCode | null;
}>;
type PublicOperation = Readonly<Omit<McpWorkspaceNativeCopyOperationStatus, 'journal'> & {
  journal: Readonly<Omit<McpWorkspaceNativeCopyOperationStatus['journal'], 'errorCode'> & { errorCode: PublicCopyCode | null }>;
}>;
export type DirectMcpWorkspaceCopyResultV1 = Readonly<
  { apiVersion: 1; action: 'preview'; preview: WorkspaceOperationNativeCopyPreviewPublic }
  | { apiVersion: 1; action: 'apply' | 'recover'; execution: PublicExecution; copied: readonly string[]; alreadyKnown: boolean }
  | { apiVersion: 1; action: 'status'; operation: PublicOperation }
>;
export type DirectMcpWorkspaceCopyFailureV1 = Readonly<{
  apiVersion: 1; success: false; code: PublicCopyCode; operationId?: string;
}>;

function record(value: Json | undefined, required: readonly string[], optional: readonly string[], invalid: () => never): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return value;
}
function text(value: Json | undefined, maximum: number, invalid: () => never, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value.length) return invalid(); return value;
}
function workspace(value: Json | undefined, invalid: () => never): string {
  const result = text(value, MAX_WORKSPACE, invalid);
  if (result !== result.trim() || /[\u0000-\u001f\u007f]/u.test(result)) return invalid(); return result;
}
function pathname(value: Json | undefined, invalid: () => never, root = false): string {
  const result = text(value, MAX_PATH, invalid, root);
  if (!isCanonicalWorkspacePath(result, root)) return invalid(); return result;
}
function opId(value: Json | undefined, invalid: () => never): string {
  if (typeof value !== 'string' || !operationPattern.test(value)) return invalid(); return value;
}
function planId(value: Json | undefined, invalid: () => never): string {
  if (typeof value !== 'string' || !planPattern.test(value)) return invalid(); return value;
}
function boolean(value: Json | undefined, invalid: () => never): boolean {
  if (typeof value !== 'boolean') return invalid(); return value;
}
function integer(value: Json | undefined, minimum: number, maximum: number, invalid: () => never): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(); return value;
}
function list(value: Json | undefined, maximum: number, invalid: () => never): Json[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(); return value;
}
function ownSelectedOperationId(value: unknown, result = false): string | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const nested = result ? Object.getOwnPropertyDescriptor(value, 'execution')?.value
    ?? Object.getOwnPropertyDescriptor(value, 'operation')?.value : value;
  if (!nested || typeof nested !== 'object' || types.isProxy(nested) || Object.getPrototypeOf(nested) !== Object.prototype) return undefined;
  const candidate: unknown = Object.getOwnPropertyDescriptor(nested, result ? 'operationId' : 'operation_id')?.value;
  return typeof candidate === 'string' && operationPattern.test(candidate) ? candidate : undefined;
}

/** There is no legacy Copy branch. Missing/unknown supplied versions fail here. */
export function decodeDirectMcpWorkspaceCopyRequestV1(input: unknown): DecodedDirectMcpWorkspaceCopyRequestV1 {
  const selected = ownSelectedOperationId(input);
  const invalid = (): never => { throw new WorkspaceCopyToolError('INVALID_REQUEST', selected); };
  const large = (): never => { throw new WorkspaceCopyToolError('COPY_TOO_LARGE', selected); };
  const value = data(input, WORKSPACE_COPY_REQUEST_MAX_BYTES, invalid, large, true);
  const initial = record(value, ['api_version', 'action', 'source_workspace_id', 'destination_workspace_id'],
    ['operation_id', 'plan_id', 'selections', 'rename_on_collision', 'destination_directory'], invalid);
  if (initial.api_version !== 1 || typeof initial.action !== 'string'
    || !['preview', 'apply', 'status', 'recover'].includes(initial.action)) return invalid();
  const common = ['api_version', 'action', 'source_workspace_id', 'destination_workspace_id'];
  const action = initial.action;
  const row = action === 'status' ? record(value, [...common, 'operation_id'], [], invalid)
    : record(value, [...common, 'selections', ...(action === 'preview' ? [] : ['operation_id', 'plan_id'])],
      ['rename_on_collision', 'destination_directory'], invalid);
  const slots: Slots = { apiVersion: 1, sourceWorkspaceId: workspace(row.source_workspace_id, invalid),
    destinationWorkspaceId: workspace(row.destination_workspace_id, invalid) };
  if (action === 'status') return frozen({ ...slots, action, operationId: opId(row.operation_id, invalid) });
  const selections = list(row.selections, MAX_SELECTIONS, invalid).map(value => {
    const selection = record(value, ['source_path', 'destination_path'], [], invalid);
    return { sourcePath: pathname(selection.source_path, invalid), destinationPath: pathname(selection.destination_path, invalid) };
  });
  if (!selections.length) return invalid();
  const selectedPaths = { selections, renameOnCollision: Object.hasOwn(row, 'rename_on_collision')
    ? boolean(row.rename_on_collision, invalid) : false,
  ...(Object.hasOwn(row, 'destination_directory') ? { destinationDirectory: pathname(row.destination_directory, invalid, true) } : {}) };
  if (action === 'preview') return frozen({ ...slots, action, ...selectedPaths });
  if (action !== 'apply' && action !== 'recover' || selectedPaths.renameOnCollision) return invalid();
  return frozen({ ...slots, action, operationId: opId(row.operation_id, invalid), planId: planId(row.plan_id, invalid),
    ...selectedPaths, renameOnCollision: false });
}

/** A stored/internal code is display data, never a public free-form string. */
export function normalizePublicCopyErrorCode(value: unknown): PublicCopyCode {
  if (typeof value !== 'string') return 'COPY_UNAVAILABLE';
  if (Object.hasOwn(statuses, value)) return value as PublicCopyCode;
  const mappings: Readonly<Record<string, PublicCopyCode>> = {
    NATIVE_COPY_INVALID_REQUEST: 'INVALID_REQUEST', NATIVE_COPY_PLAN_INVALID: 'INVALID_REQUEST',
    MANAGED_COPY_PLAN_INVALID: 'INVALID_REQUEST', COPY_ORIGIN_INVALID: 'INVALID_REQUEST',
    NATIVE_COPY_OPERATION_NOT_FOUND: 'COPY_OPERATION_NOT_FOUND', NATIVE_COPY_STATUS_NOT_FOUND: 'COPY_STATUS_NOT_FOUND',
    DESTINATION_NOT_FOUND: 'COPY_CONFLICT', DESTINATION_NOT_DIRECTORY: 'COPY_CONFLICT',
    NATIVE_COPY_PLAN_CHANGED: 'COPY_PLAN_CHANGED', MANAGED_COPY_PLAN_CHANGED: 'COPY_PLAN_CHANGED',
    NATIVE_COPY_STATUS_CHANGED: 'COPY_CONFLICT', COPY_ORIGIN_CHANGED: 'COPY_SCOPE_CHANGED',
    MCP_READ_PRINCIPAL_SCOPE_CHANGED: 'COPY_SCOPE_CHANGED', MCP_READ_PRINCIPAL_ACCESS_DENIED: 'ACCESS_DENIED',
    MCP_READ_PRINCIPAL_REQUIRED: 'AUTHENTICATION_REQUIRED', MCP_READ_PRINCIPAL_INVALID: 'INVALID_REQUEST',
    MCP_READ_PRINCIPAL_EXPIRED: 'AUTHENTICATION_REQUIRED', MCP_READ_PRINCIPAL_BUSY: 'COPY_BUSY',
    MCP_READ_PRINCIPAL_REENTRANT: 'COPY_BUSY', MCP_READ_PRINCIPAL_DETACHED: 'COPY_SCOPE_CHANGED',
    NATIVE_COPY_LIFECYCLE_BUSY: 'COPY_BUSY', WORKSPACE_FILE_LIFECYCLE_BUSY: 'COPY_BUSY',
    FILE_MUTATION_LOCK_TIMEOUT: 'COPY_BUSY', FILE_MUTATION_LOCK_BUSY: 'COPY_BUSY',
    NATIVE_COPY_REQUEST_TOO_LARGE: 'COPY_TOO_LARGE',
    NATIVE_COPY_PLAN_TOO_LARGE: 'COPY_TOO_LARGE', NATIVE_COPY_PHASE_TOO_LARGE: 'COPY_TOO_LARGE',
    NATIVE_COPY_STATUS_TOO_LARGE: 'COPY_TOO_LARGE', STAGE_TOO_LARGE: 'COPY_TOO_LARGE',
    EXCALIDRAW_COPY_TOO_LARGE: 'COPY_TOO_LARGE', NATIVE_COPY_METADATA_TOO_LARGE: 'COPY_TOO_LARGE',
    NATIVE_COPY_COMMIT_UNCONFIRMED: 'COPY_OUTCOME_UNCONFIRMED',
    NATIVE_COPY_PUBLICATION_UNCONFIRMED: 'COPY_OUTCOME_UNCONFIRMED',
    NATIVE_COPY_PHASE_UNCONFIRMED: 'COPY_OUTCOME_UNCONFIRMED',
    EXCALIDRAW_COPY_PUBLICATION_UNCONFIRMED: 'COPY_OUTCOME_UNCONFIRMED',
    NATIVE_COPY_STATUS_UNCONFIRMED: 'COPY_OUTCOME_UNCONFIRMED',
    NATIVE_COPY_STATUS_INVALID: 'COPY_CONFLICT', NATIVE_COPY_STATUS_REQUIRED: 'COPY_CONFLICT',
    NATIVE_COPY_OWNER_CHANGED: 'COPY_SCOPE_CHANGED', NATIVE_COPY_OWNER_REQUIRED: 'COPY_CONFLICT',
    NATIVE_COPY_PHASE_CHANGED: 'COPY_CONFLICT', NATIVE_COPY_PHASE_REQUIRED: 'COPY_CONFLICT',
    STAGE_CONFLICT: 'COPY_CONFLICT', CORRUPT_STAGE: 'COPY_CONFLICT', EXCALIDRAW_COPY_CHANGED: 'COPY_CONFLICT',
    NATIVE_COPY_METADATA_INVALID: 'COPY_CONFLICT', NATIVE_COPY_METADATA_CHANGED: 'COPY_PLAN_CHANGED',
    EXCALIDRAW_COPY_INVALID: 'COPY_CONFLICT', EXCALIDRAW_COPY_ASSET_CONFLICT: 'COPY_CONFLICT',
    EXCALIDRAW_COPY_STORAGE_CHANGED: 'COPY_SCOPE_CHANGED', EXCALIDRAW_COPY_TRANSACTION_CHANGED: 'COPY_CONFLICT',
    NATIVE_COPY_PLAN_UNSUPPORTED: 'COPY_NATIVE_REQUIRED', MANAGED_COPY_PLAN_UNSUPPORTED: 'COPY_NATIVE_REQUIRED',
    MANAGED_COPY_PLAN_IMPORT_REQUIRED: 'COPY_NATIVE_REQUIRED',
    NATIVE_COPY_PHASE_UNSUPPORTED: 'COPY_NATIVE_REQUIRED',
    PRINCIPAL_AUTH_REVOKED: 'AUTHENTICATION_REQUIRED', PRINCIPAL_ACCESS_DENIED: 'ACCESS_DENIED',
    'invalid-input': 'INVALID_REQUEST', 'scope-changed': 'COPY_SCOPE_CHANGED', 'source-changed': 'COPY_PLAN_CHANGED',
    'staging-changed': 'COPY_CONFLICT', 'destination-occupied': 'COPY_CONFLICT', 'recovery-conflict': 'COPY_CONFLICT',
    'unsafe-path': 'COPY_CONFLICT', 'budget-exceeded': 'COPY_TOO_LARGE',
    'parent-create-unconfirmed': 'COPY_OUTCOME_UNCONFIRMED', 'publication-unconfirmed': 'COPY_OUTCOME_UNCONFIRMED',
    'cleanup-unconfirmed': 'COPY_OUTCOME_UNCONFIRMED', 'disposal-unconfirmed': 'COPY_OUTCOME_UNCONFIRMED',
  };
  return Object.hasOwn(mappings, value) ? mappings[value] : 'COPY_UNAVAILABLE';
}

const unresolvedStatuses = ['missing', 'ambiguous', 'outside-workspace', 'external', 'anchor-only', 'not-evaluated', 'omitted'];
function preview(value: Json | undefined, invalid: () => never): WorkspaceOperationNativeCopyPreviewPublic {
  const row = record(value, ['version', 'kind', 'sourceWorkspaceId', 'destinationWorkspaceId', 'planId', 'readiness',
    'pathMappings', 'linkEdits', 'coverage', 'linkAssessment', 'issues'], [], invalid);
  if (row.version !== 4 || row.kind !== 'native-copy' || row.readiness !== 'ready') return invalid();
  const source = workspace(row.sourceWorkspaceId, invalid), destination = workspace(row.destinationWorkspaceId, invalid);
  planId(row.planId, invalid);
  for (const item of list(row.pathMappings, 100_000, invalid)) {
    const mapping = record(item, ['sourceWorkspaceId', 'sourcePath', 'destinationWorkspaceId', 'destinationPath', 'sourceKind', 'sourceIdentity'], [], invalid);
    if (mapping.sourceWorkspaceId !== source || mapping.destinationWorkspaceId !== destination
      || mapping.sourceKind !== 'file' && mapping.sourceKind !== 'directory'
      || typeof mapping.sourceIdentity !== 'string' || !/^native-copy-preview:[a-f0-9]{64}$/u.test(mapping.sourceIdentity)) return invalid();
    pathname(mapping.sourcePath, invalid); pathname(mapping.destinationPath, invalid);
  }
  for (const item of list(row.linkEdits, 100_000, invalid)) {
    const edit = record(item, ['sourcePathBefore', 'sourcePathAfter', 'previousTargetLiteral', 'nextTargetLiteral'], [], invalid);
    pathname(edit.sourcePathBefore, invalid); pathname(edit.sourcePathAfter, invalid);
    text(edit.previousTargetLiteral, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES, invalid, true);
    text(edit.nextTargetLiteral, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES, invalid, true);
  }
  const coverage = record(row.coverage, ['complete', 'omittedSources', 'unresolvedLinks'], [], invalid);
  boolean(coverage.complete, invalid);
  if (list(coverage.omittedSources, 0, invalid).length) return invalid();
  const unresolved = list(coverage.unresolvedLinks, 100_000, invalid);
  for (const item of unresolved) {
    const link = record(item, ['sourcePath', 'targetLiteral', 'status'], [], invalid);
    pathname(link.sourcePath, invalid); text(link.targetLiteral, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES, invalid, true);
    if (typeof link.status !== 'string' || !unresolvedStatuses.includes(link.status)) return invalid();
  }
  const assessment = record(row.linkAssessment, ['version', 'complete', 'warnings', 'blockers'], [], invalid);
  if (assessment.version !== 1 || list(assessment.blockers, 0, invalid).length) return invalid();
  boolean(assessment.complete, invalid);
  const warnings = list(assessment.warnings, 100_000, invalid);
  for (const item of warnings) {
    const warning = record(item, ['workspaceId', 'sourcePath', 'targetLiteral', 'status', 'reason'], [], invalid);
    if (workspace(warning.workspaceId, invalid) !== source && warning.workspaceId !== destination
      || warning.reason !== 'unaffected-existing-link' || typeof warning.status !== 'string'
      || !unresolvedStatuses.includes(warning.status)) return invalid();
    pathname(warning.sourcePath, invalid); text(warning.targetLiteral, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES, invalid, true);
  }
  if (list(row.issues, 0, invalid).length || coverage.complete !== (assessment.complete && unresolved.length === 0)) return invalid();
  return row as unknown as WorkspaceOperationNativeCopyPreviewPublic;
}
function paths(value: Json | undefined, invalid: () => never): string[] {
  return list(value, MAX_SELECTIONS, invalid).map(value => pathname(value, invalid));
}
function publicCode(value: Json | undefined, invalid: () => never): PublicCopyCode | null {
  if (value === null) return null;
  if (typeof value !== 'string') return invalid(); return normalizePublicCopyErrorCode(value);
}
function execution(value: Json | undefined, invalid: () => never): PublicExecution {
  const row = record(value, ['operationId', 'planId', 'status', 'completedSteps', 'pendingSteps', 'errorCode'], [], invalid);
  opId(row.operationId, invalid); planId(row.planId, invalid);
  if (row.status !== 'complete' && row.status !== 'needs_recovery' && row.status !== 'failed') return invalid();
  const steps = (value: Json | undefined) => list(value, MAX_STEPS, invalid).map(value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/u.test(value)) return invalid(); return value;
  });
  const completed = steps(row.completedSteps), pending = steps(row.pendingSteps);
  if (completed.length + pending.length > MAX_STEPS || new Set([...completed, ...pending]).size !== completed.length + pending.length
    || row.status === 'complete' && (pending.length !== 0 || row.errorCode !== null)) return invalid();
  return { operationId: row.operationId as string, planId: row.planId as string, status: row.status,
    completedSteps: completed, pendingSteps: pending, errorCode: publicCode(row.errorCode, invalid) };
}
function operation(value: Json | undefined, invalid: () => never): PublicOperation {
  const row = record(value, ['operationId', 'planId', 'revision', 'journal', 'completion'], [], invalid);
  opId(row.operationId, invalid); planId(row.planId, invalid); integer(row.revision, 1, Number.MAX_SAFE_INTEGER, invalid);
  const journal = record(row.journal, ['status', 'phase', 'expectedStepCount', 'recordedStepCount', 'appliedStepCount',
    'intentStepCount', 'createdAt', 'updatedAt', 'errorCode'], [], invalid);
  if (typeof journal.status !== 'string' || !['prepared', 'running', 'completed', 'failed', 'recovery_required'].includes(journal.status)
    || typeof journal.phase !== 'string' || !['prepared', 'path', 'link', 'completed'].includes(journal.phase)) return invalid();
  const expected = integer(journal.expectedStepCount, 1, MAX_STEPS, invalid);
  const recorded = integer(journal.recordedStepCount, 0, expected, invalid);
  const applied = integer(journal.appliedStepCount, 0, recorded, invalid), intent = integer(journal.intentStepCount, 0, recorded, invalid);
  if (recorded !== applied + intent) return invalid();
  integer(journal.createdAt, 0, Number.MAX_SAFE_INTEGER, invalid); integer(journal.updatedAt, 0, Number.MAX_SAFE_INTEGER, invalid);
  const completion = record(row.completion, ['status'], ['historical', 'copiedPaths'], invalid);
  if (completion.status === 'confirmed') {
    record(completion, ['status', 'historical', 'copiedPaths'], [], invalid);
    if (completion.historical !== true || journal.status !== 'completed' || journal.phase !== 'completed'
      || recorded !== expected || applied !== expected || intent !== 0) return invalid();
    paths(completion.copiedPaths, invalid);
  } else if (completion.status === 'not_confirmed') record(completion, ['status'], [], invalid);
  else return invalid();
  return { ...row, journal: { ...journal, errorCode: publicCode(journal.errorCode, invalid) } } as unknown as PublicOperation;
}

/** Accept only the already public projection/status DTO. Private Owner results
 * (plan, Stage, Origin, recipe or roots) are rejected by exact keys. */
export function encodeDirectMcpWorkspaceCopyResultV1(input: unknown, selectedOperationId?: string): DirectMcpWorkspaceCopyResultV1 {
  const selected = selectedOperationId ?? ownSelectedOperationId(input, true);
  const invalid = (): never => { throw new WorkspaceCopyToolError('COPY_UNAVAILABLE', selected); };
  const large = (): never => { throw new WorkspaceCopyToolError('COPY_OUTPUT_TOO_LARGE', selected); };
  const captured = data(input, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES, invalid, large);
  const initial = record(captured, ['apiVersion', 'action'], ['preview', 'execution', 'copied', 'alreadyKnown', 'operation'], invalid);
  if (initial.apiVersion !== 1) return invalid();
  if (initial.action === 'preview') {
    const row = record(captured, ['apiVersion', 'action', 'preview'], [], invalid);
    return frozen({ apiVersion: 1, action: 'preview', preview: preview(row.preview, invalid) });
  }
  if (initial.action === 'apply' || initial.action === 'recover') {
    const row = record(captured, ['apiVersion', 'action', 'execution', 'copied', 'alreadyKnown'], [], invalid);
    return frozen({ apiVersion: 1, action: initial.action, execution: execution(row.execution, invalid),
      copied: paths(row.copied, invalid), alreadyKnown: boolean(row.alreadyKnown, invalid) });
  }
  if (initial.action === 'status') {
    const row = record(captured, ['apiVersion', 'action', 'operation'], [], invalid);
    return frozen({ apiVersion: 1, action: 'status', operation: operation(row.operation, invalid) });
  }
  return invalid();
}

function errors(error: unknown, seen = new WeakSet<object>(), depth = 0, budget = { remaining: 64 }): unknown[] {
  if (!error || typeof error !== 'object' || types.isProxy(error) || seen.has(error) || depth > 4 || budget.remaining-- <= 0) return [];
  seen.add(error); const found: unknown[] = [error];
  const cause: unknown = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
  found.push(...errors(cause, seen, depth + 1, budget));
  const children: unknown = Object.getOwnPropertyDescriptor(error, 'errors')?.value;
  if (Array.isArray(children) && !types.isProxy(children) && Object.getPrototypeOf(children) === Array.prototype) {
    const length: unknown = Object.getOwnPropertyDescriptor(children, 'length')?.value;
    if (typeof length === 'number' && length <= 16) for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(children, String(index));
      if (descriptor && Object.hasOwn(descriptor, 'value')) found.push(...errors(descriptor.value as unknown, seen, depth + 1, budget));
    }
  }
  return found;
}
function authorizationError(value: unknown): DirectMcpAuthorizationError | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  let prototype: object | null = Object.getPrototypeOf(value), matched = false;
  for (let depth = 0; prototype && depth < 16; depth++) {
    if (types.isProxy(prototype)) return undefined;
    if (prototype === DirectMcpAuthorizationError.prototype) matched = true;
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!matched || prototype) return undefined;
  const own = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined;
  };
  if (!['invalid_token', 'insufficient_scope', 'authorization_unavailable'].includes(own('code') as string)
    || ![401, 403, 503].includes(own('status') as number)
    || own('challenge') !== null && typeof own('challenge') !== 'string') return undefined;
  return value as DirectMcpAuthorizationError;
}
export function workspaceCopyFailureV1(error: unknown, selectedOperationId?: string): Readonly<{
  body: DirectMcpWorkspaceCopyFailureV1; status: number;
}> {
  const candidates = errors(error), authorization = candidates.map(authorizationError).find(value => value !== undefined);
  const codes = candidates.map(value => normalizePublicCopyErrorCode(Object.getOwnPropertyDescriptor(value, 'code')?.value));
  const code = authorization
    ? authorization.status === 401 ? 'AUTHENTICATION_REQUIRED' : authorization.status === 403 ? 'ACCESS_DENIED' : 'COPY_UNAVAILABLE'
    : codes.find(code => code === 'COPY_OUTCOME_UNCONFIRMED') ?? codes.find(code => code !== 'COPY_UNAVAILABLE') ?? 'COPY_UNAVAILABLE';
  const selected = selectedOperationId ?? candidates.map(value => Object.getOwnPropertyDescriptor(value, 'operationId')?.value)
    .find((value): value is string => typeof value === 'string' && operationPattern.test(value));
  const failure = new WorkspaceCopyToolError(code, selected);
  return frozen({ body: { apiVersion: 1, success: false, code,
    ...(failure.operationId === undefined ? {} : { operationId: failure.operationId }) }, status: failure.status });
}
function boundedEnvelope(body: DirectMcpWorkspaceCopyResultV1 | DirectMcpWorkspaceCopyFailureV1,
  authorization?: DirectMcpAuthorizationError): CallToolResult {
  const selected = 'success' in body ? body.operationId : ownSelectedOperationId(body, true);
  const large = (): never => { throw new WorkspaceCopyToolError('COPY_OUTPUT_TOO_LARGE', selected); };
  const invalid = (): never => { throw new WorkspaceCopyToolError('COPY_UNAVAILABLE', selected); };
  const envelope: CallToolResult = { ...(authorization ? directMcpToolAuthorizationError(authorization, 'knowledge:write') : {}),
    ...('success' in body ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
  // Check after the genuine OAuth _meta merge. If it cannot fit, throw; never
  // silently drop a challenge or substitute a challenge-free error response.
  data(envelope, WORKSPACE_COPY_TOOL_RESULT_MAX_BYTES, invalid, large);
  return envelope;
}
export function formatDirectMcpWorkspaceCopyResult(input: unknown, selectedOperationId?: string): CallToolResult {
  return boundedEnvelope(encodeDirectMcpWorkspaceCopyResultV1(input, selectedOperationId));
}
export function formatDirectMcpWorkspaceCopyError(error: unknown, selectedOperationId?: string): CallToolResult {
  const authorization = errors(error).map(authorizationError).find(value => value !== undefined);
  return boundedEnvelope(workspaceCopyFailureV1(error, selectedOperationId).body, authorization);
}

const workspaceSchema = { type: 'string', minLength: 1, maxLength: MAX_WORKSPACE };
const pathSchema = { type: 'string', minLength: 1, maxLength: MAX_PATH,
  pattern: '^(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+)*$' };
const operationSchema = { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$' };
const planSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const arraySchema = (items: unknown, maximum = 100_000) => ({ type: 'array', items, maxItems: maximum });
const codeSchema = { type: 'string', enum: PUBLIC_COPY_ERROR_CODES };
const nullableCode = { anyOf: [codeSchema, { type: 'null' }] };
const wireSlots = { api_version: { const: 1, type: 'integer' }, source_workspace_id: workspaceSchema, destination_workspace_id: workspaceSchema };
const selectionSchema = { ...arraySchema(objectSchema({ source_path: pathSchema, destination_path: pathSchema }), MAX_SELECTIONS), minItems: 1 };
const options = { rename_on_collision: { type: 'boolean' }, destination_directory: { type: 'string', maxLength: MAX_PATH,
  anyOf: [{ const: '' }, pathSchema] } };
const requestBranch = (action: 'preview' | 'apply' | 'status' | 'recover') => {
  const properties = { ...wireSlots, action: { const: action, type: 'string' },
    ...(action === 'preview' ? {} : { operation_id: operationSchema }),
    ...(action === 'apply' || action === 'recover' ? { plan_id: planSchema } : {}),
    ...(action === 'status' ? {} : { selections: selectionSchema, ...options,
      ...(action === 'preview' ? {} : { rename_on_collision: { type: 'boolean', const: false,
        description: 'Apply and recover use the retained resolved root destinations from preview, in the original selection order.' } }) }) };
  return objectSchema(properties, Object.keys(properties).filter(key => key !== 'rename_on_collision' && key !== 'destination_directory'));
};
export const DIRECT_MCP_WORKSPACE_COPY_INPUT_SCHEMA_V1 = frozen({
  type: 'object', oneOf: [requestBranch('preview'), requestBranch('apply'), requestBranch('status'), requestBranch('recover')],
  description: 'Explicit native Copy V1. Maximum 64 KiB JSON arguments. Preview does not grant Apply; retain caller operation_id and plan_id. Status reads journal/history only; recover is one explicit existing-operation attempt. No automatic replay.',
});
const literalSchema = { type: 'string' };
const unresolvedSchema = objectSchema({ sourcePath: pathSchema, targetLiteral: literalSchema,
  status: { type: 'string', enum: unresolvedStatuses } });
const previewSchema = objectSchema({ version: { const: 4, type: 'integer' }, kind: { const: 'native-copy', type: 'string' },
  sourceWorkspaceId: workspaceSchema, destinationWorkspaceId: workspaceSchema, planId: planSchema,
  readiness: { const: 'ready', type: 'string' }, pathMappings: arraySchema(objectSchema({ sourceWorkspaceId: workspaceSchema,
    sourcePath: pathSchema, destinationWorkspaceId: workspaceSchema, destinationPath: pathSchema,
    sourceKind: { type: 'string', enum: ['file', 'directory'] }, sourceIdentity: { type: 'string', pattern: '^native-copy-preview:[a-f0-9]{64}$' } })),
  linkEdits: arraySchema(objectSchema({ sourcePathBefore: pathSchema, sourcePathAfter: pathSchema,
    previousTargetLiteral: literalSchema, nextTargetLiteral: literalSchema })),
  coverage: objectSchema({ complete: { type: 'boolean' }, omittedSources: { type: 'array', maxItems: 0 }, unresolvedLinks: arraySchema(unresolvedSchema) }),
  linkAssessment: objectSchema({ version: { const: 1, type: 'integer' }, complete: { type: 'boolean' }, warnings: arraySchema(objectSchema({
    workspaceId: workspaceSchema, sourcePath: pathSchema, targetLiteral: literalSchema, status: { type: 'string', enum: unresolvedStatuses },
    reason: { const: 'unaffected-existing-link', type: 'string' } })), blockers: { type: 'array', maxItems: 0 } }),
  issues: { type: 'array', maxItems: 0 } });
const stepSchema = { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,256}$' };
const executionSchema = objectSchema({ operationId: operationSchema, planId: planSchema,
  status: { type: 'string', enum: ['complete', 'needs_recovery', 'failed'] }, completedSteps: arraySchema(stepSchema, MAX_STEPS),
  pendingSteps: arraySchema(stepSchema, MAX_STEPS), errorCode: nullableCode });
const counterSchema = { type: 'integer', minimum: 0, maximum: MAX_STEPS };
const operationStatusSchema = objectSchema({ operationId: operationSchema, planId: planSchema,
  revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  journal: objectSchema({ status: { type: 'string', enum: ['prepared', 'running', 'completed', 'failed', 'recovery_required'] },
    phase: { type: 'string', enum: ['prepared', 'path', 'link', 'completed'] }, expectedStepCount: { ...counterSchema, minimum: 1 },
    recordedStepCount: counterSchema, appliedStepCount: counterSchema, intentStepCount: counterSchema,
    createdAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    updatedAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, errorCode: nullableCode }),
  completion: { oneOf: [objectSchema({ status: { const: 'confirmed', type: 'string' }, historical: { const: true, type: 'boolean' },
    copiedPaths: arraySchema(pathSchema, MAX_SELECTIONS) }), objectSchema({ status: { const: 'not_confirmed', type: 'string' } })] } });
const executionBranch = (action: 'apply' | 'recover') => objectSchema({ apiVersion: { const: 1, type: 'integer' },
  action: { const: action, type: 'string' }, execution: executionSchema, copied: arraySchema(pathSchema, MAX_SELECTIONS), alreadyKnown: { type: 'boolean' } });
export const DIRECT_MCP_WORKSPACE_COPY_OUTPUT_SCHEMA_V1 = frozen({ type: 'object', oneOf: [
  objectSchema({ apiVersion: { const: 1, type: 'integer' }, action: { const: 'preview', type: 'string' }, preview: previewSchema }),
  executionBranch('apply'), executionBranch('recover'),
  objectSchema({ apiVersion: { const: 1, type: 'integer' }, action: { const: 'status', type: 'string' }, operation: operationStatusSchema }),
  objectSchema({ apiVersion: { const: 1, type: 'integer' }, success: { const: false, type: 'boolean' }, code: codeSchema,
    operationId: operationSchema }, ['apiVersion', 'success', 'code']),
] });
