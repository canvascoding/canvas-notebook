import { ExactTextPatchError } from '@/app/lib/files/exact-text-patch';
import { WorkspaceFileRevisionError } from '@/app/lib/files/revision-guard';
import type { AgentFileChangeResult } from './agent-file-operations';

export type AgentFileToolOperation = 'write' | 'edit_file' | 'apply_patch';

export type AgentFileToolSuccess = Omit<AgentFileChangeResult, 'resolvedPath'> & {
  contractVersion: 1;
  kind: 'file_mutation';
  operation: AgentFileToolOperation;
  outcome: 'applied' | 'unchanged' | 'review_required';
  category: 'success' | 'review_required';
  recommendedAction: 'none' | 'reuse_after_sha256_if_sequential' | 'review_in_editor';
  safeToAutoRetry: false;
};

export type AgentFileToolError = {
  contractVersion: 1;
  kind: 'file_mutation_error';
  operation: AgentFileToolOperation;
  outcome: 'blocked';
  category: 'safety_conflict' | 'technical_error';
  code: string;
  path: string | null;
  message: string;
  editIndex: number | null;
  expectedOccurrences: number | null;
  actualOccurrences: number | null;
  matchMode: 'exact' | 'all' | null;
  oldTextPreview: string | null;
  occurrenceLines: number[];
  expectedSha256: string | null;
  currentSha256: string | null;
  recommendedAction: 'read_then_retry' | 'inspect_error';
  safeToAutoRetry: false;
  error: string;
};

export function asAgentFileToolSuccess(
  result: AgentFileChangeResult,
  operation: AgentFileToolOperation,
): AgentFileToolSuccess {
  const { resolvedPath: _resolvedPath, ...publicResult } = result;
  const reviewRequired = result.collaboration?.reviewRequired === true;
  return {
    ...publicResult,
    contractVersion: 1,
    kind: 'file_mutation',
    operation,
    outcome: reviewRequired ? 'review_required' : result.changed ? 'applied' : 'unchanged',
    category: reviewRequired ? 'review_required' : 'success',
    recommendedAction: reviewRequired
      ? 'review_in_editor'
      : result.changed && operation === 'edit_file'
        ? 'reuse_after_sha256_if_sequential'
        : 'none',
    safeToAutoRetry: false,
  };
}

export function asAgentFileToolError(
  error: unknown,
  operation: AgentFileToolOperation,
  fallbackPath?: string,
): AgentFileToolError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkspaceFileRevisionError) {
    return {
      contractVersion: 1,
      kind: 'file_mutation_error',
      operation,
      outcome: 'blocked',
      category: 'safety_conflict',
      code: error.code,
      path: error.path || fallbackPath || null,
      message,
      editIndex: null,
      expectedOccurrences: null,
      actualOccurrences: null,
      matchMode: null,
      oldTextPreview: null,
      occurrenceLines: [],
      expectedSha256: error.expectedSha256,
      currentSha256: error.currentSha256,
      recommendedAction: 'read_then_retry',
      safeToAutoRetry: false,
      error: message,
    };
  }
  if (error instanceof ExactTextPatchError) {
    return {
      contractVersion: 1,
      kind: 'file_mutation_error',
      operation,
      outcome: 'blocked',
      category: 'safety_conflict',
      code: `EXACT_TEXT_${error.code.toUpperCase()}`,
      path: fallbackPath || null,
      message,
      editIndex: error.editIndex,
      expectedOccurrences: error.expectedOccurrences,
      actualOccurrences: error.actualOccurrences,
      matchMode: error.matchMode,
      oldTextPreview: error.oldTextPreview || null,
      occurrenceLines: error.occurrenceLines,
      expectedSha256: null,
      currentSha256: null,
      recommendedAction: 'read_then_retry',
      safeToAutoRetry: false,
      error: message,
    };
  }
  return {
    contractVersion: 1,
    kind: 'file_mutation_error',
    operation,
    outcome: 'blocked',
    category: 'technical_error',
    code: 'FILE_OPERATION_FAILED',
    path: fallbackPath || null,
    message,
    editIndex: null,
    expectedOccurrences: null,
    actualOccurrences: null,
    matchMode: null,
    oldTextPreview: null,
    occurrenceLines: [],
    expectedSha256: null,
    currentSha256: null,
    recommendedAction: 'inspect_error',
    safeToAutoRetry: false,
    error: message,
  };
}
