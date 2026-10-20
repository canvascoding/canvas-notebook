import { types } from 'node:util';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { isCanonicalWorkspacePath } from '../../workspaces/path-identity';
import { DirectMcpAuthorizationError } from './access-token-verifier';
import { directMcpToolAuthorizationError } from './tool-auth';
import { captureBoundedMcpToolJson as data, freezeMcpToolJson as frozen, type Json, type JsonRecord } from './bounded-tool-json';

export const WORKSPACE_PATH_REQUEST_MAX_BYTES = 64 * 1024;
export const WORKSPACE_PATH_TOOL_RESULT_MAX_BYTES = 1024 * 1024;
const MAX_SELECTIONS = 1000, MAX_STEPS = 10_000, MAX_PATH = 1024, MAX_WORKSPACE = 200;
const operationPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/u, planPattern = /^[a-f0-9]{64}$/u;
const statuses = { INVALID_REQUEST: 400, AUTHENTICATION_REQUIRED: 401, ACCESS_DENIED: 403,
  PATH_OPERATION_NOT_FOUND: 404, PATH_STATUS_NOT_FOUND: 404, PATH_PLAN_CHANGED: 409, PATH_SCOPE_CHANGED: 409,
  PATH_BUSY: 409, PATH_CONFLICT: 409, PATH_TOO_LARGE: 413, PATH_OUTPUT_TOO_LARGE: 413,
  PATH_NATIVE_REQUIRED: 409, PATH_OUTCOME_UNCONFIRMED: 503, PATH_UNAVAILABLE: 503 } as const;
export type PublicWorkspacePathCode = keyof typeof statuses;
export const PUBLIC_WORKSPACE_PATH_ERROR_CODES = frozen(Object.keys(statuses) as PublicWorkspacePathCode[]);
export class WorkspacePathToolError extends Error {
  readonly status: number; readonly operationId?: string;
  constructor(readonly code: PublicWorkspacePathCode, operationId?: string) {
    super(code); this.name = 'WorkspacePathToolError'; this.status = statuses[code];
    if (typeof operationId === 'string' && operationPattern.test(operationId)) this.operationId = operationId;
  }
}
type Slots = Readonly<{ apiVersion: 1; workspaceId: string }>;
type Selection = Readonly<{ sourcePath: string; destinationPath: string }>;
type SelectedOperation = Readonly<{ operationId: string; planId: string }>;
export type DecodedDirectMcpWorkspaceMoveRequestV1 = Slots & (
  Readonly<{ action: 'preview'; selections: readonly Selection[] }>
  | Readonly<{ action: 'apply' | 'recover'; selections: readonly Selection[] }> & SelectedOperation
  | Readonly<{ action: 'status'; operationId: string }>);
export type DecodedDirectMcpWorkspaceDeleteRequestV1 = Slots & (
  Readonly<{ action: 'preview'; path: string }>
  | Readonly<{ action: 'apply' | 'recover'; path: string }> & SelectedOperation
  | Readonly<{ action: 'status'; operationId: string }>);
export type DirectMcpWorkspacePathNativePreviewV1 = Readonly<{ kind: 'move' | 'delete'; workspaceId: string; planId: string;
  readiness: 'ready'; paths: readonly Readonly<{ sourcePath: string; destinationPath?: string }>[];
  linkChanges: Readonly<{ rewrites: number; unlinks: number; affectedDocuments: number }>; coverage: Readonly<{ complete: true }> }>;
/** Read-only original-file preparation. Neither this summary nor its plan ID
 * is a native batch, import receipt, claim or authority to execute a mutation. */
export type DirectMcpWorkspacePathImportPreviewV1 = Readonly<{ version: 1; kind: 'native-path-import-preparation';
  operationKind: 'move' | 'delete'; workspaceId: string; planId: string; executionReady: false;
  readiness: 'requires-import-rebinding' | 'blocked'; paths: readonly Readonly<{ sourcePath: string; destinationPath?: string }>[];
  imports: readonly Readonly<{ path: string; reasons: readonly ('selected' | 'link-change')[] }>[];
  issues: readonly Readonly<{ code: string; path: string }>[]; coverage: Readonly<{ complete: true }> }>;
export type DirectMcpWorkspacePathHtmlDiagnosticV2 = Readonly<{ code: string; path: string; line?: number; targets: readonly string[] }>;
/** Original coverage and operation-specific HTML safety are separate facts.
 * This bounded summary contains no source bytes, native references or rights. */
export type DirectMcpWorkspacePathHtmlPreviewV2 = Readonly<{ version: 2; kind: 'native-path-html-assessment';
  operationKind: 'move'; executionReady: false; readiness: 'ready' | 'blocked'; workspaceId: string; planId: string;
  paths: readonly Readonly<{ sourcePath: string; destinationPath: string }>[];
  linkChanges: Readonly<{ rewrites: number; unlinks: number; affectedDocuments: number }>;
  coverage: Readonly<{ complete: boolean }>;
  linkAssessment: Readonly<{ complete: boolean; warnings: readonly DirectMcpWorkspacePathHtmlDiagnosticV2[];
    blockers: readonly DirectMcpWorkspacePathHtmlDiagnosticV2[] }>;
  issues: readonly Readonly<{ code: string; path: string }>[];
  imports: readonly Readonly<{ path: string; reasons: readonly ('selected' | 'link-change')[] }>[] }>;
export type DirectMcpWorkspacePathPreviewV1 = DirectMcpWorkspacePathNativePreviewV1 | DirectMcpWorkspacePathImportPreviewV1
  | DirectMcpWorkspacePathHtmlPreviewV2;
export type DirectMcpWorkspacePathExecutionV1 = Readonly<{ receiptStatus: 'available' | 'not_started' | 'unavailable';
  finalization: 'pending' | 'complete'; steps: readonly Readonly<{ key: string; phase: 'path' | 'link';
    kind: 'move' | 'rename' | 'delete' | 'link_update'; path: string; destinationPath?: string;
    state: 'pending' | 'applied' | 'needs_check'; openPath?: string }>[] }>;
export type DirectMcpWorkspacePathOperationV1 = Readonly<{ operationId: string; batchId: string; planId: string; workspaceId: string;
  preparation?: Readonly<{ version: 1; previewPlanId: string }>;
  journal: Readonly<{ status: 'applying' | 'applied' | 'failed' | 'needs_recovery';
    phase: 'preparing' | 'paths' | 'links' | 'complete' | 'recovery'; completedActions: number; totalActions: number;
    createdAt: number; updatedAt: number; errorCode: PublicWorkspacePathCode | null }>;
  execution: DirectMcpWorkspacePathExecutionV1;
  completion: Readonly<{ status: 'confirmed'; historical: true }> | Readonly<{ status: 'not_confirmed' }> }>;
export type DirectMcpWorkspacePathResultV1 = Readonly<
  { apiVersion: 1; action: 'preview'; preview: DirectMcpWorkspacePathPreviewV1 }
  | { apiVersion: 1; action: 'apply' | 'recover'; operation: DirectMcpWorkspacePathOperationV1; alreadyKnown: boolean }
  | { apiVersion: 1; action: 'status'; operation: DirectMcpWorkspacePathOperationV1 }>;
export type DirectMcpWorkspacePathFailureV1 = Readonly<{ apiVersion: 1; success: false; code: PublicWorkspacePathCode; operationId?: string }>;

const record = (value: Json | undefined, required: readonly string[], optional: readonly string[], invalid: () => never): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return value;
};
const text = (value: Json | undefined, maximum: number, invalid: () => never): string => {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
};
const workspace = (value: Json | undefined, invalid: () => never): string => {
  const result = text(value, MAX_WORKSPACE, invalid); if (result !== result.trim()) return invalid(); return result;
};
const pathname = (value: Json | undefined, invalid: () => never): string => {
  const result = text(value, MAX_PATH, invalid); if (!isCanonicalWorkspacePath(result) || result === '.') return invalid(); return result;
};
const operationId = (value: Json | undefined, invalid: () => never): string => {
  if (typeof value !== 'string' || !operationPattern.test(value)) return invalid(); return value;
};
const planId = (value: Json | undefined, invalid: () => never): string => {
  if (typeof value !== 'string' || !planPattern.test(value)) return invalid(); return value;
};
const integer = (value: Json | undefined, maximum: number, invalid: () => never): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) return invalid(); return value;
};
const list = (value: Json | undefined, maximum: number, invalid: () => never): Json[] => {
  if (!Array.isArray(value) || value.length > maximum) return invalid(); return value;
};
const selectedId = (value: unknown, result = false): string | undefined => {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || !result && Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, result ? 'operationId' : 'operation_id');
  if (descriptor?.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    && operationPattern.test(descriptor.value)) return descriptor.value;
  return undefined;
};
const decode = (input: unknown, kind: 'move' | 'delete'): DecodedDirectMcpWorkspaceMoveRequestV1 | DecodedDirectMcpWorkspaceDeleteRequestV1 => {
  const selected = selectedId(input), invalid = (): never => { throw new WorkspacePathToolError('INVALID_REQUEST', selected); };
  const large = (): never => { throw new WorkspacePathToolError('PATH_TOO_LARGE', selected); };
  const value = data(input, WORKSPACE_PATH_REQUEST_MAX_BYTES, invalid, large, true);
  const base = record(value, ['api_version', 'action', 'workspace_id'], ['operation_id', 'plan_id', 'selections', 'path'], invalid);
  if (base.api_version !== 1 || typeof base.action !== 'string' || !['preview', 'apply', 'status', 'recover'].includes(base.action)) return invalid();
  const action = base.action, common = ['api_version', 'action', 'workspace_id'];
  const row = record(value, [...common, ...(action === 'status' ? ['operation_id'] : [kind === 'move' ? 'selections' : 'path',
    ...(action === 'preview' ? [] : ['operation_id', 'plan_id'])])], [], invalid);
  const slots: Slots = { apiVersion: 1, workspaceId: workspace(row.workspace_id, invalid) };
  if (action === 'status') return frozen({ ...slots, action, operationId: operationId(row.operation_id, invalid) });
  const selectedPath: { selections: readonly Selection[] } | { path: string } = kind === 'move' ? { selections: list(row.selections, MAX_SELECTIONS, invalid).map(value => {
    const selection = record(value, ['source_path', 'destination_path'], [], invalid);
    return { sourcePath: pathname(selection.source_path, invalid), destinationPath: pathname(selection.destination_path, invalid) };
  }) } : { path: pathname(row.path, invalid) };
  if ('selections' in selectedPath && !selectedPath.selections.length) return invalid();
  if (action === 'preview') return frozen({ ...slots, action, ...selectedPath });
  if (action !== 'apply' && action !== 'recover') return invalid();
  return frozen({ ...slots, action, ...selectedPath, operationId: operationId(row.operation_id, invalid), planId: planId(row.plan_id, invalid) });
};
export function decodeDirectMcpWorkspaceMoveRequestV1(input: unknown): DecodedDirectMcpWorkspaceMoveRequestV1 {
  return decode(input, 'move') as DecodedDirectMcpWorkspaceMoveRequestV1;
}
export function decodeDirectMcpWorkspaceDeleteRequestV1(input: unknown): DecodedDirectMcpWorkspaceDeleteRequestV1 {
  return decode(input, 'delete') as DecodedDirectMcpWorkspaceDeleteRequestV1;
}

/** Only fixed public codes may escape stored errors or nested failures. */
export function normalizePublicWorkspacePathErrorCode(value: unknown): PublicWorkspacePathCode {
  if (typeof value !== 'string') return 'PATH_UNAVAILABLE';
  if (Object.hasOwn(statuses, value)) return value as PublicWorkspacePathCode;
  const mapping: Record<string, PublicWorkspacePathCode> = {
    invalid_token: 'AUTHENTICATION_REQUIRED', insufficient_scope: 'ACCESS_DENIED',
    MCP_READ_PRINCIPAL_REQUIRED: 'AUTHENTICATION_REQUIRED', MCP_READ_PRINCIPAL_EXPIRED: 'AUTHENTICATION_REQUIRED',
    MCP_READ_PRINCIPAL_ACCESS_DENIED: 'ACCESS_DENIED', MCP_READ_PRINCIPAL_SCOPE_CHANGED: 'PATH_SCOPE_CHANGED',
    MCP_READ_PRINCIPAL_BUSY: 'PATH_BUSY', MCP_READ_PRINCIPAL_REENTRANT: 'PATH_BUSY', MCP_READ_PRINCIPAL_DETACHED: 'PATH_SCOPE_CHANGED',
    MCP_JOB_PRINCIPAL_REQUIRED: 'AUTHENTICATION_REQUIRED', MCP_JOB_PRINCIPAL_INVALID: 'INVALID_REQUEST',
    MCP_JOB_PRINCIPAL_CHANGED: 'PATH_SCOPE_CHANGED', MCP_JOB_PRINCIPAL_DETACHED: 'PATH_SCOPE_CHANGED', MCP_JOB_PRINCIPAL_REENTRANT: 'PATH_BUSY',
    MCP_JOB_AUTHORIZATION_INVALID: 'INVALID_REQUEST', MCP_JOB_AUTHORIZATION_TOO_LARGE: 'PATH_TOO_LARGE', MCP_JOB_AUTHORIZATION_CHANGED: 'PATH_SCOPE_CHANGED',
    BATCH_NOT_FOUND: 'PATH_OPERATION_NOT_FOUND', BATCH_STATUS_NOT_FOUND: 'PATH_STATUS_NOT_FOUND',
    BATCH_IDEMPOTENCY_CONFLICT: 'PATH_CONFLICT', BATCH_SCOPE_CHANGED: 'PATH_SCOPE_CHANGED', PREVIEW_STALE: 'PATH_PLAN_CHANGED',
    BATCH_CLAIM_BUSY: 'PATH_BUSY', BATCH_CLAIM_CHANGED: 'PATH_CONFLICT', BATCH_CLAIM_INVALID: 'INVALID_REQUEST',
    BATCH_CLAIM_REQUIRED: 'PATH_CONFLICT', BATCH_CLAIM_DETACHED: 'PATH_SCOPE_CHANGED', BATCH_CLAIM_REENTRANT: 'PATH_BUSY',
    BATCH_CLAIM_COMMIT_UNCONFIRMED: 'PATH_OUTCOME_UNCONFIRMED', BATCH_CLAIM_DISPOSAL_UNCONFIRMED: 'PATH_OUTCOME_UNCONFIRMED',
    BATCH_JOURNAL_UNAVAILABLE: 'PATH_OUTCOME_UNCONFIRMED', BATCH_ACCESS_DENIED: 'ACCESS_DENIED', BATCH_CONFLICT: 'PATH_CONFLICT',
    NATIVE_MOVE_PLAN_UNSUPPORTED: 'PATH_NATIVE_REQUIRED', NATIVE_DELETE_PLAN_UNSUPPORTED: 'PATH_NATIVE_REQUIRED',
    NATIVE_SOURCE_IMPORT_REQUIRED: 'PATH_NATIVE_REQUIRED',
    NATIVE_MOVE_PLAN_INVALID: 'INVALID_REQUEST', NATIVE_DELETE_PLAN_INVALID: 'INVALID_REQUEST',
    NATIVE_MOVE_PLAN_CHANGED: 'PATH_PLAN_CHANGED', NATIVE_DELETE_PLAN_CHANGED: 'PATH_PLAN_CHANGED',
    NATIVE_MOVE_PLAN_TOO_LARGE: 'PATH_TOO_LARGE', NATIVE_DELETE_PLAN_TOO_LARGE: 'PATH_TOO_LARGE',
    JOB_LIFECYCLE_COMMIT_UNCONFIRMED: 'PATH_OUTCOME_UNCONFIRMED', JOB_LIFECYCLE_DISPOSAL_UNCONFIRMED: 'PATH_OUTCOME_UNCONFIRMED',
    JOB_LIFECYCLE_CHANGED: 'PATH_CONFLICT', JOB_LIFECYCLE_INVALID: 'PATH_CONFLICT', JOB_LIFECYCLE_REQUIRED: 'PATH_CONFLICT',
    JOB_LIFECYCLE_REENTRANT: 'PATH_BUSY', JOB_LIFECYCLE_DETACHED: 'PATH_SCOPE_CHANGED',
    COLLABORATION_FILE_LIFECYCLE_BUSY: 'PATH_BUSY', WORKSPACE_FILE_LIFECYCLE_BUSY: 'PATH_BUSY',
    FILE_MUTATION_LOCK_TIMEOUT: 'PATH_BUSY', FILE_MUTATION_LOCK_BUSY: 'PATH_BUSY',
    ORIGINAL_MOVE_CHANGED: 'PATH_CONFLICT', ORIGINAL_MOVE_INVALID: 'PATH_CONFLICT', ORIGINAL_MOVE_SCOPE_CHANGED: 'PATH_SCOPE_CHANGED',
    ORIGINAL_MOVE_TOO_LARGE: 'PATH_TOO_LARGE', ORIGINAL_MOVE_UNSUPPORTED: 'PATH_NATIVE_REQUIRED',
    ORIGINAL_DELETE_UNSUPPORTED: 'PATH_NATIVE_REQUIRED', ORIGINAL_DELETE_CHANGED: 'PATH_CONFLICT', ORIGINAL_DELETE_UNPROVEN: 'PATH_CONFLICT',
    ORIGINAL_DELETE_STORAGE_CHANGED: 'PATH_SCOPE_CHANGED', ORIGINAL_DELETE_BUSY: 'PATH_BUSY',
    PATH_IMPORT_HISTORY_INVALID: 'INVALID_REQUEST', PATH_IMPORT_HISTORY_CHANGED: 'PATH_PLAN_CHANGED',
    PATH_IMPORT_HISTORY_ORPHAN: 'PATH_OUTCOME_UNCONFIRMED', PATH_IMPORT_HISTORY_UNAVAILABLE: 'PATH_UNAVAILABLE',
    PATH_IMPORT_PREPARATION_INVALID: 'INVALID_REQUEST', PATH_IMPORT_PREPARATION_CHANGED: 'PATH_PLAN_CHANGED',
    PATH_IMPORT_PREPARATION_TOO_LARGE: 'PATH_TOO_LARGE', PATH_IMPORT_PREPARATION_UNSUPPORTED: 'PATH_NATIVE_REQUIRED',
    PATH_IMPORT_PREPARATION_PHASE_INVALID: 'INVALID_REQUEST', PATH_IMPORT_PREPARATION_PHASE_REQUIRED: 'PATH_SCOPE_CHANGED',
    PATH_IMPORT_PREPARATION_PHASE_CHANGED: 'PATH_PLAN_CHANGED', PATH_IMPORT_PREPARATION_NOT_READY: 'PATH_NATIVE_REQUIRED',
    PATH_IMPORT_PREPARATION_RECORD_INVALID: 'PATH_OUTCOME_UNCONFIRMED', PATH_IMPORT_PREPARATION_RECORD_CHANGED: 'PATH_OUTCOME_UNCONFIRMED',
    PATH_IMPORT_PREPARATION_RECORD_TOO_LARGE: 'PATH_TOO_LARGE', PATH_IMPORT_PREPARATION_RECORD_UNAVAILABLE: 'PATH_UNAVAILABLE',
    PATH_IMPORT_OPERATION_INVALID: 'INVALID_REQUEST', PATH_IMPORT_OPERATION_OUTCOME_UNCONFIRMED: 'PATH_OUTCOME_UNCONFIRMED',
    PATH_IMPORT_PREVIEW_INVALID: 'INVALID_REQUEST', PATH_IMPORT_PREVIEW_BUSY: 'PATH_BUSY',
    PATH_IMPORT_PREVIEW_UNAVAILABLE: 'PATH_UNAVAILABLE', PATH_IMPORT_PREVIEW_ACCESS_DENIED: 'ACCESS_DENIED',
    MARKDOWN_IMPORT_INVALID_INPUT: 'INVALID_REQUEST', MARKDOWN_IMPORT_ENCODING_UNSUPPORTED: 'PATH_NATIVE_REQUIRED',
    MARKDOWN_IMPORT_RICH_UNAVAILABLE: 'PATH_NATIVE_REQUIRED', MARKDOWN_IMPORT_TARGET_CHANGED: 'PATH_PLAN_CHANGED',
    MARKDOWN_IMPORT_TARGET_NOT_EMPTY: 'PATH_CONFLICT', MARKDOWN_IMPORT_LIFECYCLE_REQUIRED: 'PATH_SCOPE_CHANGED',
    MARKDOWN_IMPORT_REQUEST_CONFLICT: 'PATH_CONFLICT', MARKDOWN_IMPORT_BUSY: 'PATH_BUSY', MARKDOWN_IMPORT_COMMIT_UNCONFIRMED: 'PATH_OUTCOME_UNCONFIRMED',
  };
  return Object.hasOwn(mapping, value) ? mapping[value] : 'PATH_UNAVAILABLE';
}
function htmlPreviewV2(value: Json | undefined, invalid: () => never): DirectMcpWorkspacePathHtmlPreviewV2 {
  const row = record(value, ['version', 'kind', 'operationKind', 'executionReady', 'readiness', 'workspaceId', 'planId',
    'paths', 'linkChanges', 'coverage', 'linkAssessment', 'issues', 'imports'], [], invalid);
  if (row.version !== 2 || row.kind !== 'native-path-html-assessment' || row.operationKind !== 'move'
    || row.executionReady !== false || row.readiness !== 'ready' && row.readiness !== 'blocked') return invalid();
  workspace(row.workspaceId, invalid); planId(row.planId, invalid);
  const paths = list(row.paths, MAX_SELECTIONS, invalid), sourcePaths = new Set<string>(), destinationPaths = new Set<string>();
  if (!paths.length) return invalid();
  for (const item of paths) {
    const path = record(item, ['sourcePath', 'destinationPath'], [], invalid);
    const source = pathname(path.sourcePath, invalid), destination = pathname(path.destinationPath, invalid);
    if (source === destination || sourcePaths.has(source) || destinationPaths.has(destination)) return invalid();
    sourcePaths.add(source); destinationPaths.add(destination);
  }
  const links = record(row.linkChanges, ['rewrites', 'unlinks', 'affectedDocuments'], [], invalid);
  for (const key of Object.keys(links)) integer(links[key], 100_000, invalid);
  if (links.unlinks !== 0) return invalid();
  const coverage = record(row.coverage, ['complete'], [], invalid);
  if (typeof coverage.complete !== 'boolean') return invalid();
  const assessment = record(row.linkAssessment, ['complete', 'warnings', 'blockers'], [], invalid);
  if (typeof assessment.complete !== 'boolean') return invalid();
  const warnings = list(assessment.warnings, MAX_STEPS, invalid), blockers = list(assessment.blockers, MAX_STEPS, invalid);
  for (const [items, warning] of [[warnings, true], [blockers, false]] as const) for (const item of items) {
    const diagnostic = record(item, ['code', 'path', 'targets'], ['line'], invalid);
    if (warning ? diagnostic.code !== 'unaffected-explicit-html-link'
      : diagnostic.code !== 'affected-html-link' && diagnostic.code !== 'unevaluated-link') return invalid();
    pathname(diagnostic.path, invalid);
    if (Object.hasOwn(diagnostic, 'line') && integer(diagnostic.line, Number.MAX_SAFE_INTEGER, invalid) < 1) return invalid();
    const targets = list(diagnostic.targets, MAX_STEPS, invalid);
    if ((warning || diagnostic.code === 'affected-html-link') && !targets.length) return invalid();
    const uniqueTargets = new Set<string>();
    for (const target of targets) {
      const literal = text(target, 4096, invalid); if (uniqueTargets.has(literal)) return invalid(); uniqueTargets.add(literal);
    }
  }
  if (assessment.complete && blockers.length) return invalid();
  const imports = list(row.imports, MAX_STEPS, invalid), importedPaths = new Set<string>();
  for (const item of imports) {
    const imported = record(item, ['path', 'reasons'], [], invalid), file = pathname(imported.path, invalid);
    if (!/\.(?:md|markdown)$/iu.test(file) || importedPaths.has(file)) return invalid(); importedPaths.add(file);
    const reasons = list(imported.reasons, 2, invalid);
    if (!reasons.length || reasons.some(reason => reason !== 'selected' && reason !== 'link-change')
      || JSON.stringify(reasons) !== JSON.stringify(['selected', 'link-change'].filter(reason => reasons.includes(reason)))) return invalid();
  }
  const issues = list(row.issues, MAX_STEPS, invalid);
  for (const item of issues) {
    const issue = record(item, ['code', 'path'], [], invalid);
    if (typeof issue.code !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/u.test(issue.code)) return invalid();
    if (issue.path !== '') pathname(issue.path, invalid);
  }
  if (row.readiness === 'ready' ? !assessment.complete || blockers.length || issues.length || imports.length
    : assessment.complete && !blockers.length && !issues.length && !imports.length) return invalid();
  if (row.readiness === 'blocked' && (links.rewrites !== 0 || links.affectedDocuments !== 0)) return invalid();
  return row as unknown as DirectMcpWorkspacePathHtmlPreviewV2;
}
const preview = (value: Json | undefined, invalid: () => never): DirectMcpWorkspacePathPreviewV1 => {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'native-path-html-assessment') return htmlPreviewV2(value, invalid);
  if (value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'native-path-import-preparation') {
    const row = record(value, ['version', 'kind', 'operationKind', 'workspaceId', 'planId', 'executionReady', 'readiness', 'paths', 'imports', 'issues', 'coverage'], [], invalid);
    if (row.version !== 1 || row.executionReady !== false || typeof row.operationKind !== 'string' || !['move', 'delete'].includes(row.operationKind)
      || row.readiness !== 'requires-import-rebinding' && row.readiness !== 'blocked') return invalid();
    workspace(row.workspaceId, invalid); planId(row.planId, invalid);
    const paths = list(row.paths, MAX_SELECTIONS, invalid); if (!paths.length || row.operationKind === 'delete' && paths.length !== 1) return invalid();
    for (const value of paths) {
      const selected = record(value, ['sourcePath', ...(row.operationKind === 'move' ? ['destinationPath'] : [])], [], invalid);
      pathname(selected.sourcePath, invalid); if (row.operationKind === 'move') pathname(selected.destinationPath, invalid);
    }
    const imports = list(row.imports, MAX_STEPS, invalid), seen = new Set<string>();
    for (const value of imports) {
      const imported = record(value, ['path', 'reasons'], [], invalid), file = pathname(imported.path, invalid);
      if (seen.has(file)) return invalid(); seen.add(file);
      const reasons = list(imported.reasons, 2, invalid);
      if (!reasons.length || reasons.some(reason => reason !== 'selected' && reason !== 'link-change')
        || JSON.stringify(reasons) !== JSON.stringify(['selected', 'link-change'].filter(reason => reasons.includes(reason)))) return invalid();
    }
    const issues = list(row.issues, MAX_STEPS, invalid);
    for (const value of issues) {
      const issue = record(value, ['code', 'path'], [], invalid);
      if (typeof issue.code !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/u.test(issue.code)) return invalid();
      if (issue.path !== '') pathname(issue.path, invalid);
    }
    if (row.readiness === 'blocked' ? !issues.length : issues.length || !imports.length) return invalid();
    const coverage = record(row.coverage, ['complete'], [], invalid); if (coverage.complete !== true) return invalid();
    return row as unknown as DirectMcpWorkspacePathImportPreviewV1;
  }
  const row = record(value, ['kind', 'workspaceId', 'planId', 'readiness', 'paths', 'linkChanges', 'coverage'], [], invalid);
  if (typeof row.kind !== 'string' || !['move', 'delete'].includes(row.kind) || row.readiness !== 'ready') return invalid();
  workspace(row.workspaceId, invalid); planId(row.planId, invalid);
  const paths = list(row.paths, MAX_SELECTIONS, invalid); if (!paths.length || row.kind === 'delete' && paths.length !== 1) return invalid();
  for (const value of paths) {
    const path = record(value, ['sourcePath', ...(row.kind === 'move' ? ['destinationPath'] : [])], [], invalid);
    pathname(path.sourcePath, invalid); if (row.kind === 'move') pathname(path.destinationPath, invalid);
  }
  const links = record(row.linkChanges, ['rewrites', 'unlinks', 'affectedDocuments'], [], invalid);
  for (const key of Object.keys(links)) integer(links[key], 100_000, invalid);
  const coverage = record(row.coverage, ['complete'], [], invalid); if (coverage.complete !== true) return invalid();
  return row as unknown as DirectMcpWorkspacePathPreviewV1;
};
const operation = (value: Json | undefined, invalid: () => never): DirectMcpWorkspacePathOperationV1 => {
  const row = record(value, ['operationId', 'batchId', 'planId', 'workspaceId', 'journal', 'execution', 'completion'], ['preparation'], invalid);
  operationId(row.operationId, invalid); planId(row.batchId, invalid); planId(row.planId, invalid); workspace(row.workspaceId, invalid);
  if (Object.hasOwn(row, 'preparation')) {
    const preparation = record(row.preparation, ['version', 'previewPlanId'], [], invalid);
    if (preparation.version !== 1) return invalid(); planId(preparation.previewPlanId, invalid);
  }
  const journal = record(row.journal, ['status', 'phase', 'completedActions', 'totalActions', 'createdAt', 'updatedAt', 'errorCode'], [], invalid);
  if (typeof journal.status !== 'string' || !['applying', 'applied', 'failed', 'needs_recovery'].includes(journal.status)
    || typeof journal.phase !== 'string' || !['preparing', 'paths', 'links', 'complete', 'recovery'].includes(journal.phase)) return invalid();
  const total = integer(journal.totalActions, MAX_STEPS, invalid); integer(journal.completedActions, total, invalid);
  const created = integer(journal.createdAt, Number.MAX_SAFE_INTEGER, invalid);
  if (integer(journal.updatedAt, Number.MAX_SAFE_INTEGER, invalid) < created) return invalid();
  if (journal.errorCode !== null) {
    if (typeof journal.errorCode !== 'string' || journal.errorCode.length > 256) return invalid();
    journal.errorCode = normalizePublicWorkspacePathErrorCode(journal.errorCode);
  }
  const execution = record(row.execution, ['receiptStatus', 'finalization', 'steps'], [], invalid);
  if (typeof execution.receiptStatus !== 'string' || !['available', 'not_started', 'unavailable'].includes(execution.receiptStatus)
    || typeof execution.finalization !== 'string' || !['pending', 'complete'].includes(execution.finalization)) return invalid();
  const steps = list(execution.steps, MAX_STEPS, invalid), keys = new Set<string>();
  for (const value of steps) {
    const step = record(value, ['key', 'phase', 'kind', 'path', 'state'], ['destinationPath', 'openPath'], invalid);
    const key = text(step.key, 256, invalid); if (keys.has(key)) return invalid(); keys.add(key);
    if (typeof step.phase !== 'string' || !['path', 'link'].includes(step.phase)
      || typeof step.kind !== 'string' || !['move', 'rename', 'delete', 'link_update'].includes(step.kind)
      || typeof step.state !== 'string' || !['pending', 'applied', 'needs_check'].includes(step.state)) return invalid();
    pathname(step.path, invalid); if (Object.hasOwn(step, 'destinationPath')) pathname(step.destinationPath, invalid);
    if (Object.hasOwn(step, 'openPath')) pathname(step.openPath, invalid);
  }
  const completion = record(row.completion, ['status'], ['historical'], invalid);
  if (completion.status === 'confirmed') {
    if (completion.historical !== true || execution.receiptStatus !== 'available' || execution.finalization !== 'complete'
      || steps.some(value => (value as JsonRecord).state !== 'applied')) return invalid();
  } else if (completion.status !== 'not_confirmed' || Object.hasOwn(completion, 'historical')) return invalid();
  return row as unknown as DirectMcpWorkspacePathOperationV1;
};
export function encodeDirectMcpWorkspacePathResultV1(input: unknown, selectedOperationId?: string): DirectMcpWorkspacePathResultV1 {
  const selected = typeof selectedOperationId === 'string' && operationPattern.test(selectedOperationId) ? selectedOperationId : undefined;
  const invalid = (): never => { throw new WorkspacePathToolError('PATH_UNAVAILABLE', selected); };
  const large = (): never => { throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE', selected); };
  const value = data(input, WORKSPACE_PATH_TOOL_RESULT_MAX_BYTES, invalid, large);
  const base = record(value, ['apiVersion', 'action'], ['preview', 'operation', 'alreadyKnown'], invalid);
  if (base.apiVersion !== 1 || typeof base.action !== 'string') return invalid();
  if (base.action === 'preview') { record(value, ['apiVersion', 'action', 'preview'], [], invalid); preview(base.preview, invalid); }
  else {
    if (!['apply', 'recover', 'status'].includes(base.action)) return invalid();
    record(value, ['apiVersion', 'action', 'operation', ...(base.action === 'status' ? [] : ['alreadyKnown'])], [], invalid);
    if (base.action !== 'status' && typeof base.alreadyKnown !== 'boolean') return invalid();
    const observed = operation(base.operation, invalid); if (selected && observed.operationId !== selected) return invalid();
  }
  return frozen(value) as unknown as DirectMcpWorkspacePathResultV1;
}
const errors = (error: unknown, seen = new WeakSet<object>(), depth = 0, budget = { remaining: 64 }): unknown[] => {
  if (!error || typeof error !== 'object' || types.isProxy(error) || seen.has(error) || depth > 4 || budget.remaining-- <= 0) return [];
  seen.add(error); const found: unknown[] = [error];
  found.push(...errors(Object.getOwnPropertyDescriptor(error, 'cause')?.value, seen, depth + 1, budget));
  const children: unknown = Object.getOwnPropertyDescriptor(error, 'errors')?.value;
  if (Array.isArray(children) && !types.isProxy(children) && Object.getPrototypeOf(children) === Array.prototype) {
    const length: unknown = Object.getOwnPropertyDescriptor(children, 'length')?.value;
    if (typeof length === 'number' && length <= 16) for (let index = 0; index < length; index++) {
      const child = Object.getOwnPropertyDescriptor(children, String(index));
      if (child && Object.hasOwn(child, 'value')) found.push(...errors(child.value, seen, depth + 1, budget));
    }
  }
  return found;
};
const authorization = (values: unknown[]): DirectMcpAuthorizationError | undefined => {
  for (const value of values) {
    if (!value || typeof value !== 'object' || types.isProxy(value)) continue;
    let prototype: object | null = Object.getPrototypeOf(value), matched = false;
    for (let depth = 0; prototype && depth < 16; depth++) {
      if (types.isProxy(prototype)) { matched = false; break; }
      if (prototype === DirectMcpAuthorizationError.prototype) matched = true;
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!matched || prototype) continue;
    const own = (key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined; };
    if (['invalid_token', 'insufficient_scope', 'authorization_unavailable'].includes(own('code') as string)
      && [401, 403, 503].includes(own('status') as number)
      && (own('challenge') === null || typeof own('challenge') === 'string')) return value as DirectMcpAuthorizationError;
  }
  return undefined;
};
export function workspacePathFailureV1(error: unknown, selectedOperationId?: string): Readonly<{ body: DirectMcpWorkspacePathFailureV1; status: number }> {
  const values = errors(error), auth = authorization(values);
  const codes = values.map(value => normalizePublicWorkspacePathErrorCode(Object.getOwnPropertyDescriptor(value, 'code')?.value));
  const code = auth ? auth.status === 401 ? 'AUTHENTICATION_REQUIRED' : auth.status === 403 ? 'ACCESS_DENIED' : 'PATH_UNAVAILABLE'
    : codes.find(value => value === 'PATH_OUTCOME_UNCONFIRMED') ?? codes.find(value => value !== 'PATH_UNAVAILABLE') ?? 'PATH_UNAVAILABLE';
  const selected = typeof selectedOperationId === 'string' && operationPattern.test(selectedOperationId) ? selectedOperationId
    : values.map(value => selectedId(value, true)).find(value => value !== undefined);
  return { body: frozen({ apiVersion: 1, success: false, code, ...(selected ? { operationId: selected } : {}) }), status: statuses[code] };
}
const envelope = (body: DirectMcpWorkspacePathResultV1 | DirectMcpWorkspacePathFailureV1, auth?: DirectMcpAuthorizationError): CallToolResult => {
  const selected = 'operation' in body ? body.operation.operationId : 'operationId' in body ? body.operationId : undefined;
  const large = (): never => { throw new WorkspacePathToolError('PATH_OUTPUT_TOO_LARGE', selected); };
  const invalid = (): never => { throw new WorkspacePathToolError('PATH_UNAVAILABLE', selected); };
  const result: CallToolResult = { ...(auth ? directMcpToolAuthorizationError(auth, 'knowledge:write') : {}),
    ...('success' in body ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
  data(result, WORKSPACE_PATH_TOOL_RESULT_MAX_BYTES, invalid, large); return result;
};
export function formatDirectMcpWorkspacePathResult(input: unknown, selectedOperationId?: string): CallToolResult {
  return envelope(encodeDirectMcpWorkspacePathResultV1(input, selectedOperationId));
}
export function formatDirectMcpWorkspacePathError(error: unknown, selectedOperationId?: string): CallToolResult {
  return envelope(workspacePathFailureV1(error, selectedOperationId).body, authorization(errors(error)));
}

const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const arraySchema = (items: unknown, maximum = MAX_STEPS) => ({ type: 'array', items, maxItems: maximum });
const pathSchema = { type: 'string', minLength: 1, maxLength: MAX_PATH,
  pattern: '^(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+)*$' };
const workspaceSchema = { type: 'string', minLength: 1, maxLength: MAX_WORKSPACE }, planSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const operationSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$', minLength: 16, maxLength: 128 };
const integerSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, booleanSchema = { type: 'boolean' };
const requestSchema = (kind: 'move' | 'delete') => frozen({ type: 'object', oneOf: (['preview', 'apply', 'status', 'recover'] as const).map(action => objectSchema({
  api_version: { const: 1, type: 'integer' }, action: { const: action, type: 'string' }, workspace_id: workspaceSchema,
  ...(action === 'status' ? {} : kind === 'move' ? { selections: { ...arraySchema(objectSchema({ source_path: pathSchema, destination_path: pathSchema }), MAX_SELECTIONS), minItems: 1 } } : { path: pathSchema }),
  ...(action === 'preview' ? {} : { operation_id: operationSchema }), ...(action === 'apply' || action === 'recover' ? { plan_id: planSchema } : {}),
})) });
export const DIRECT_MCP_WORKSPACE_MOVE_INPUT_SCHEMA_V1 = requestSchema('move');
export const DIRECT_MCP_WORKSPACE_DELETE_INPUT_SCHEMA_V1 = requestSchema('delete');
const codeSchema = { type: 'string', enum: PUBLIC_WORKSPACE_PATH_ERROR_CODES };
const stepSchema = objectSchema({ key: { type: 'string', minLength: 1, maxLength: 256 }, phase: { enum: ['path', 'link'], type: 'string' },
  kind: { enum: ['move', 'rename', 'delete', 'link_update'], type: 'string' }, path: pathSchema, destinationPath: pathSchema,
  state: { enum: ['pending', 'applied', 'needs_check'], type: 'string' }, openPath: pathSchema }, ['key', 'phase', 'kind', 'path', 'state']);
const operationResultSchema = objectSchema({ operationId: operationSchema, batchId: planSchema, planId: planSchema, workspaceId: workspaceSchema,
  preparation: objectSchema({ version: { const: 1, type: 'integer' }, previewPlanId: planSchema }),
  journal: objectSchema({ status: { type: 'string', enum: ['applying', 'applied', 'failed', 'needs_recovery'] },
    phase: { type: 'string', enum: ['preparing', 'paths', 'links', 'complete', 'recovery'] }, completedActions: { ...integerSchema, maximum: MAX_STEPS },
    totalActions: { ...integerSchema, maximum: MAX_STEPS }, createdAt: integerSchema, updatedAt: integerSchema, errorCode: { anyOf: [codeSchema, { type: 'null' }] } }),
  execution: objectSchema({ receiptStatus: { type: 'string', enum: ['available', 'not_started', 'unavailable'] },
    finalization: { type: 'string', enum: ['pending', 'complete'] }, steps: arraySchema(stepSchema) }),
  completion: { type: 'object', oneOf: [objectSchema({ status: { const: 'confirmed', type: 'string' }, historical: { const: true, type: 'boolean' } }),
    objectSchema({ status: { const: 'not_confirmed', type: 'string' } })] } },
  ['operationId', 'batchId', 'planId', 'workspaceId', 'journal', 'execution', 'completion']);
const htmlDiagnosticSchemaV2 = (warning: boolean) => ({
  ...objectSchema({ code: { type: 'string', enum: warning ? ['unaffected-explicit-html-link'] : ['affected-html-link', 'unevaluated-link'] },
    path: pathSchema, line: { ...integerSchema, minimum: 1 }, targets: { ...arraySchema({ type: 'string', minLength: 1, maxLength: 4096,
      pattern: '^[^\\u0000-\\u001f\\u007f]+$' }), uniqueItems: true, ...(warning ? { minItems: 1 } : {}) } }, ['code', 'path', 'targets']),
  ...(!warning ? { allOf: [{ if: { properties: { code: { const: 'affected-html-link' } } },
    then: { properties: { targets: { minItems: 1 } } } }] } : {}),
});
const htmlPreviewSchemaV2 = {
  ...objectSchema({ version: { const: 2, type: 'integer' }, kind: { const: 'native-path-html-assessment', type: 'string' },
    operationKind: { const: 'move', type: 'string' }, executionReady: { const: false, type: 'boolean' },
    readiness: { type: 'string', enum: ['ready', 'blocked'] }, workspaceId: workspaceSchema, planId: planSchema,
    paths: { ...arraySchema(objectSchema({ sourcePath: pathSchema, destinationPath: pathSchema }), MAX_SELECTIONS), minItems: 1 },
    linkChanges: objectSchema({ rewrites: { ...integerSchema, maximum: 100_000 }, unlinks: { const: 0, type: 'integer' },
      affectedDocuments: { ...integerSchema, maximum: 100_000 } }), coverage: objectSchema({ complete: booleanSchema }),
    linkAssessment: objectSchema({ complete: booleanSchema, warnings: arraySchema(htmlDiagnosticSchemaV2(true)),
      blockers: arraySchema(htmlDiagnosticSchemaV2(false)) }),
    issues: arraySchema(objectSchema({ code: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,99}$' },
      path: { anyOf: [pathSchema, { const: '', type: 'string' }] } })),
    imports: arraySchema(objectSchema({ path: { ...pathSchema, pattern: `${pathSchema.pattern.slice(0, -1)}\\.(?:[mM][dD]|[mM][aA][rR][kK][dD][oO][wW][nN])$` },
      reasons: { type: 'array', items: { type: 'string', enum: ['selected', 'link-change'] }, minItems: 1, maxItems: 2, uniqueItems: true } })),
  }),
  allOf: [
    { if: { properties: { readiness: { const: 'ready' } } }, then: { properties: {
      linkAssessment: { properties: { complete: { const: true }, blockers: { maxItems: 0 } } },
      issues: { maxItems: 0 }, imports: { maxItems: 0 },
    } } },
    { if: { properties: { readiness: { const: 'blocked' } } }, then: { properties: {
      linkChanges: { properties: { rewrites: { const: 0 }, affectedDocuments: { const: 0 } } },
    }, anyOf: [
      { properties: { issues: { minItems: 1 } } }, { properties: { imports: { minItems: 1 } } },
      { properties: { linkAssessment: { properties: { complete: { const: false } } } } },
      { properties: { linkAssessment: { properties: { blockers: { minItems: 1 } } } } },
    ] } },
    { if: { properties: { linkAssessment: { properties: { complete: { const: true } } } } },
      then: { properties: { linkAssessment: { properties: { blockers: { maxItems: 0 } } } } } },
  ],
};
export const DIRECT_MCP_WORKSPACE_MOVE_HTML_PREVIEW_SCHEMA_V2 = frozen(htmlPreviewSchemaV2);

const outputSchema = (kind: 'move' | 'delete') => frozen({ type: 'object', oneOf: [
  objectSchema({ apiVersion: { const: 1, type: 'integer' }, action: { const: 'preview', type: 'string' }, preview: objectSchema({ kind: { const: kind, type: 'string' },
    workspaceId: workspaceSchema, planId: planSchema, readiness: { const: 'ready', type: 'string' },
    paths: { ...arraySchema(objectSchema({ sourcePath: pathSchema, ...(kind === 'move' ? { destinationPath: pathSchema } : {}) }), kind === 'move' ? MAX_SELECTIONS : 1), minItems: 1 },
    linkChanges: objectSchema({ rewrites: { ...integerSchema, maximum: 100_000 }, unlinks: { ...integerSchema, maximum: 100_000 }, affectedDocuments: { ...integerSchema, maximum: 100_000 } }),
    coverage: objectSchema({ complete: { const: true, type: 'boolean' } }) }) }),
  objectSchema({ apiVersion: { const: 1, type: 'integer' }, action: { const: 'preview', type: 'string' }, preview: objectSchema({
    version: { const: 1, type: 'integer' }, kind: { const: 'native-path-import-preparation', type: 'string' },
    operationKind: { const: kind, type: 'string' }, workspaceId: workspaceSchema, planId: planSchema,
    executionReady: { const: false, type: 'boolean' }, readiness: { type: 'string', enum: ['requires-import-rebinding', 'blocked'] },
    paths: { ...arraySchema(objectSchema({ sourcePath: pathSchema, ...(kind === 'move' ? { destinationPath: pathSchema } : {}) }), kind === 'move' ? MAX_SELECTIONS : 1), minItems: 1 },
    imports: arraySchema(objectSchema({ path: pathSchema, reasons: { type: 'array', items: { type: 'string', enum: ['selected', 'link-change'] }, minItems: 1, maxItems: 2, uniqueItems: true } })),
    issues: arraySchema(objectSchema({ code: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,99}$' }, path: { anyOf: [pathSchema, { const: '', type: 'string' }] } })),
    coverage: objectSchema({ complete: { const: true, type: 'boolean' } }),
  }) }),
  ...(['apply', 'recover', 'status'] as const).map(action => objectSchema({ apiVersion: { const: 1, type: 'integer' }, action: { const: action, type: 'string' },
    operation: operationResultSchema, ...(action === 'status' ? {} : { alreadyKnown: booleanSchema }) })),
  objectSchema({ apiVersion: { const: 1, type: 'integer' }, success: { const: false, type: 'boolean' }, code: codeSchema, operationId: operationSchema }, ['apiVersion', 'success', 'code']),
  ...(kind === 'move' ? [objectSchema({ apiVersion: { const: 1, type: 'integer' }, action: { const: 'preview', type: 'string' },
    preview: htmlPreviewSchemaV2 })] : []),
] });
export const DIRECT_MCP_WORKSPACE_MOVE_OUTPUT_SCHEMA_V1 = outputSchema('move');
export const DIRECT_MCP_WORKSPACE_DELETE_OUTPUT_SCHEMA_V1 = outputSchema('delete');
