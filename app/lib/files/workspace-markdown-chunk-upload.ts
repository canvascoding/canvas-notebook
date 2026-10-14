import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest } from 'next/server';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { MarkdownFileImportError } from '../collaboration/markdown-file-import';
import { logCollaborationDiagnostic } from '../collaboration/diagnostics';
import { classifyCollaborationProjectionError } from '../collaboration/projection-errors';
import { observeAuthenticatedMarkdownUploadCompletion, persistAndProjectAuthenticatedMarkdownUploadFile } from '../collaboration/markdown-file-import-persistence';
import { requireRequestWorkspace } from '../workspaces/request';
import type { WorkspaceContext } from '../workspaces/types';
import type { MarkdownUploadAttemptSelection } from './workspace-markdown-upload-attempt';
import type { WorkspaceUploadFileRecord, WorkspaceUploadSession } from './workspace-upload-service';
import type { WorkspaceUploadCompletion } from './upload-result';

export class MarkdownChunkUploadError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'MarkdownChunkUploadError'; }
}
type Dispatch = { active: boolean; started: boolean; completed: boolean; request: NextRequest;
  selection: MarkdownUploadAttemptSelection; sourcePath: string };
const dispatch = new AsyncLocalStorage<Dispatch>();

/** Only the actual single-file chunk Complete installs this private lifetime.
 * The context is intent, never Auth: I04 reauthenticates the original request. */
export async function completeMarkdownChunkUpload(input: { request: NextRequest; session: WorkspaceUploadSession;
  file: WorkspaceUploadFileRecord; sourcePath: string; commit: () => Promise<void> }): Promise<{
    completion: WorkspaceUploadCompletion; alreadyCompleted: boolean;
  }> {
  const { session, file } = input;
  if (!(input.request instanceof NextRequest) || session.files.length !== 1 || session.files[0].id !== file.id
    || !/\.(?:md|markdown)$/iu.test(file.targetPath) || file.officeAttempt) {
    throw new MarkdownChunkUploadError('MARKDOWN_UPLOAD_REQUEST_CONFLICT', 409, 'The Markdown upload request could not be confirmed.');
  }
  if (file.size > 5 * 1024 * 1024) throw new MarkdownChunkUploadError('MARKDOWN_UPLOAD_TOO_LARGE', 413, 'Markdown imports may contain at most 5 MiB.');
  const original = new NextRequest(input.request.url, { method: input.request.method, headers: new Headers(input.request.headers) });
  const current = await requireRequestWorkspace(original, { workspaceId: session.workspaceId, permissions: 'canWrite' });
  if (current.response) throw new MarkdownChunkUploadError('MARKDOWN_UPLOAD_AUTH_REQUIRED', current.response.status, 'Current upload write permission is required.');
  if (current.session.user.id !== session.userId || !current.session.session.id) {
    throw new MarkdownChunkUploadError('MARKDOWN_UPLOAD_REQUEST_CONFLICT', 409, 'The Markdown upload request could not be confirmed.');
  }
  const operationId = `upload:${session.id}:${file.id}`;
  const selection: MarkdownUploadAttemptSelection = Object.freeze({ uploadSessionId: session.id, fileId: file.id,
    workspaceId: session.workspaceId, targetPath: file.targetPath, actorUserId: current.session.user.id,
    actorSessionId: current.session.session.id, requestId: operationId, operationId });
  const result = (status: WorkspaceUploadCompletion['status'], alreadyCompleted = false) => ({
    completion: { status, uploadId: session.id, fileId: file.id, targetPath: file.targetPath,
      ...(status === 'completed' ? {} : { code: status === 'unavailable' ? 'MARKDOWN_UPLOAD_NATIVE_UNAVAILABLE' as const
        : status === 'projection_pending' ? 'MARKDOWN_UPLOAD_PROJECTION_PENDING' as const : 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED' as const }) }, alreadyCompleted,
  });
  let scope: Dispatch | undefined;
  try {
    const prior = await observeAuthenticatedMarkdownUploadCompletion(original, selection, file.size);
    if (prior === 'completed') return result('completed', file.status === 'completed');
    if (file.status === 'completed') return result('recovery_required');
    // Reuse the opening routes' single central gate. It remains false in product.
    if (!authenticatedNativeTextSessionEnabled()) return result('unavailable');
    scope = { active: true, started: false, completed: false, request: original, selection, sourcePath: input.sourcePath };
    await dispatch.run(scope, input.commit);
    if (!scope.started || !scope.completed) return result('recovery_required');
    return result('completed');
  } catch (error) {
    if (error instanceof MarkdownFileImportError && ['MARKDOWN_IMPORT_INVALID_INPUT', 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED',
      'MARKDOWN_IMPORT_NEWLINE_UNSUPPORTED', 'MARKDOWN_IMPORT_RICH_UNAVAILABLE'].includes(error.code)) {
      throw new MarkdownChunkUploadError(error.code, 422, 'The Markdown file uses an unsupported import profile.');
    }
    const diagnostic = classifyCollaborationProjectionError(error), queue: unknown[] = [error];
    const retainedCodes = new Set(['25P03', '25P04', 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED', 'MARKDOWN_IMPORT_TARGET_CHANGED',
      'MARKDOWN_IMPORT_REQUEST_CONFLICT', 'MARKDOWN_IMPORT_BUSY', 'MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED',
      'MARKDOWN_CREATE_BIRTH_TARGET_CHANGED', 'MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED', 'MARKDOWN_CREATE_BIRTH_RECORD_CHANGED',
      'MARKDOWN_CREATE_BIRTH_RECOVERY_REQUIRED', 'UPLOAD_STATE_UNCONFIRMED', 'UPLOAD_SOURCE_CLOSED', 'UPLOAD_UNAWAITED_IO',
      'UPLOAD_LOCK_ORDER', 'PRINCIPAL_EXPIRED', 'PRINCIPAL_DETACHED', 'PRINCIPAL_AUTH_REVOKED', 'PRINCIPAL_ACCESS_DENIED']);
    let hasProjectionPhase = false;
    for (let count = 0; queue.length && count < 8; count++) {
      const failure = queue.shift();
      if (!failure || typeof failure !== 'object') continue;
      // Preserve finite private causes too, without messages or source names.
      const code = Reflect.get(failure, 'code');
      if (typeof code === 'string' && retainedCodes.has(code)) diagnostic.causeCode = code;
      if (['snapshot_validate', 'receipt_begin', 'file_write', 'checkpoint_confirm', 'projection_finalize', 'receipt_finalize']
        .includes(Reflect.get(failure, 'collaborationPhase'))) hasProjectionPhase = true;
      if (failure instanceof Error && failure.cause !== undefined) queue.push(failure.cause);
      if (failure instanceof AggregateError) queue.push(...failure.errors.slice(0, 4));
    }
    logCollaborationDiagnostic('warn', { event: 'projection_recovery_failed', code: diagnostic.code,
      phase: hasProjectionPhase ? diagnostic.phase : scope ? 'chunk_complete' : 'completed_observation',
      causeCode: diagnostic.causeCode, permanent: diagnostic.permanent });
    // Classify only genuine retained receipts. Never infer a native commit from
    // an exception/HTTP status, and never rerun a raw callback after a failure.
    let observed: 'absent' | 'projection_pending' | 'completed' | undefined;
    try { observed = await observeAuthenticatedMarkdownUploadCompletion(original, selection, file.size); } catch { /* Preserve uncertainty. */ }
    return result(observed === 'projection_pending' ? 'projection_pending' : 'recovery_required');
  } finally { if (scope) scope.active = false; }
}

/** Called before the generic writer performs any lock/revision/mkdir/raw IO. */
export async function dispatchMarkdownChunkWrite(input: { workspace: WorkspaceContext; actorUserId: string;
  targetPath: string; sourcePath?: string; idempotencyKey?: string }): Promise<boolean> {
  const scope = dispatch.getStore();
  if (!scope) return false;
  const selection = scope.selection;
  if (!scope.active || scope.started || input.workspace.workspaceId !== selection.workspaceId || input.actorUserId !== selection.actorUserId
    || input.targetPath !== selection.targetPath || input.sourcePath !== scope.sourcePath || input.idempotencyKey !== selection.operationId) {
    throw new MarkdownChunkUploadError('MARKDOWN_UPLOAD_REQUEST_CONFLICT', 409, 'The Markdown upload request could not be confirmed.');
  }
  scope.started = true;
  // The whole promise includes genuine A/B/C/D, helper and Source closure.
  await persistAndProjectAuthenticatedMarkdownUploadFile(scope.request, selection);
  scope.completed = true;
  return true;
}
