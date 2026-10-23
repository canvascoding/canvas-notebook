import 'server-only';

import { NextRequest } from 'next/server';
import { recordAuditEvent } from '../audit/audit-service';
import { authenticatedNativeTextSessionEnabled } from '../collaboration/native-text-session-activation';
import { classifyFileVersionFileV1 } from '../file-version-center/policy-v1';
import { publishWorkspaceUpload } from '../filesystem/upload-events';
import { replaceWorkspaceFileFromPath, type WorkspaceFileOperationOptions } from '../filesystem/workspace-files';
import { syncPublicSharesAfterWrite } from '../public-sharing/public-file-shares';
import { resolveWorkspacePath } from '../workspaces/path-guard';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceUploadCommit, WorkspaceUploadCompletion } from './upload-result';
import { sanitizeWorkspaceUploadPath } from './upload-paths';
import { runWorkspaceUploadWrite } from './workspace-upload-flow';
import { createWorkspaceUploadSession, writeWorkspaceUploadChunk, completeWorkspaceUploadFile,
  WorkspaceUploadServiceError, type WorkspaceUploadSession, type WorkspaceUploadFileRecord } from './workspace-upload-service';

export const COMPAT_MARKDOWN_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export type CompatMarkdownUploadLocator = Readonly<{ uploadId: string; fileId: string; targetPath: string }>;
type Phase = 'input' | 'session_create' | 'chunk' | 'complete';
export type CompatMarkdownUploadResult =
  | { status: 'completed'; locator: CompatMarkdownUploadLocator; completion: WorkspaceUploadCompletion; committed: WorkspaceUploadCommit }
  | { status: 'pending'; httpStatus: 202; locator: CompatMarkdownUploadLocator; completion: WorkspaceUploadCompletion }
  | { status: 'failed'; httpStatus: number; code: string; error: string; phase: Phase;
    locator: CompatMarkdownUploadLocator | null; unlocated: boolean };

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
function invalid(code: string, status: number, message: string): never {
  throw new WorkspaceUploadServiceError(code, status, message);
}
const fileName = Object.getOwnPropertyDescriptor(File.prototype, 'name')!.get!;
const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
const blobType = Object.getOwnPropertyDescriptor(Blob.prototype, 'type')!.get!;

/** Transport adapter only. The actual Complete owns Source/session fences,
 * current authentication, native creation and completion effects. No native
 * authority or upload identifier is constructed here. */
export async function importCompatMarkdownUpload(input: {
  request: NextRequest; workspace: WorkspaceContext; fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string; targetDir: string; file: File; relativePath: string;
}): Promise<CompatMarkdownUploadResult> {
  let phase: Phase = 'input', locator: CompatMarkdownUploadLocator | null = null;
  try {
    const { file, relativePath, actorUserId } = input;
    const workspace = { ...input.workspace, permissions: { ...input.workspace.permissions } };
    const fileOptions = { ...input.fileOptions, workspace };
    if (!(input.request instanceof Request)) invalid('MARKDOWN_UPLOAD_REQUEST_CONFLICT', 409, 'The original upload request is required.');
    const request = new NextRequest(input.request.url, { method: input.request.method, headers: new Headers(input.request.headers) });
    if (!authenticatedNativeTextSessionEnabled()) invalid('MARKDOWN_UPLOAD_NATIVE_UNAVAILABLE', 409, 'Native Markdown uploads are unavailable.');
    let actualName: string, size: number, mimeType: string;
    try { actualName = fileName.call(file) as string; size = blobSize.call(file) as number; mimeType = blobType.call(file) as string; }
    catch { return invalid('UPLOAD_FILE_REQUIRED', 400, 'A genuine uploaded File is required.'); }
    if (typeof relativePath !== 'string' || sanitizeWorkspaceUploadPath(relativePath) !== relativePath
      || sanitizeWorkspaceUploadPath(actualName) !== relativePath
      || classifyFileVersionFileV1(relativePath) !== 'markdown') invalid('UPLOAD_FILE_PATH_INVALID', 400, 'A Markdown upload path is required.');
    if (!Number.isSafeInteger(size) || size < 0) {
      invalid('UPLOAD_FILE_SIZE_INVALID', 400, 'The Markdown file size is invalid.');
    }
    if (size > COMPAT_MARKDOWN_UPLOAD_MAX_BYTES) invalid('MARKDOWN_UPLOAD_TOO_LARGE', 413, 'Markdown imports may contain at most 5 MiB.');
    mimeType ||= 'text/markdown';
    const targetDir = resolveWorkspacePath(workspace, input.targetDir || '.').relativePath;
    const targetPath = resolveWorkspacePath(workspace, targetDir === '.' ? relativePath : `${targetDir}/${relativePath}`).relativePath;
    if (Buffer.byteLength(targetPath, 'utf8') > 4096) invalid('UPLOAD_FILE_PATH_INVALID', 400, 'The Markdown upload path is too long.');
    const bytes = new Uint8Array(await Blob.prototype.arrayBuffer.call(file));
    if (bytes.byteLength !== size) invalid('UPLOAD_FILE_SIZE_INVALID', 400, 'The Markdown bytes do not match the declared size.');

    phase = 'session_create';
    const session = await createWorkspaceUploadSession({ userId: actorUserId, workspace, targetDir,
      files: [{ path: relativePath, size, mimeType }] });
    const actualFile = session.files[0];
    if (!uuid(session.id) || session.files.length !== 1 || !actualFile || !uuid(actualFile.id)
      || session.userId !== actorUserId || session.workspaceId !== workspace.workspaceId
      || actualFile.targetPath !== targetPath || actualFile.relativePath !== relativePath || actualFile.size !== size) {
      invalid('UPLOAD_SESSION_CREATE_UNCONFIRMED', 503, 'Upload session creation could not be confirmed; no recovery locator is available.');
    }
    locator = Object.freeze({ uploadId: session.id, fileId: actualFile.id, targetPath });
    const capturedLocator = locator;
    const sameFile = (value: { session: WorkspaceUploadSession; file: WorkspaceUploadFileRecord }) => {
      if (value.session.id !== capturedLocator.uploadId || value.session.workspaceId !== workspace.workspaceId
        || value.session.userId !== actorUserId || value.file.id !== capturedLocator.fileId
        || value.file.targetPath !== capturedLocator.targetPath || value.file.size !== size) {
        invalid('MARKDOWN_UPLOAD_REQUEST_CONFLICT', 409, 'The upload completion identity changed.');
      }
    };
    phase = 'chunk';
    if (size > 0) await writeWorkspaceUploadChunk({ sessionId: locator.uploadId, fileId: locator.fileId, userId: actorUserId,
      workspace, offset: 0, expectedBytes: size, includeFullSession: false,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
    // Real empty files deliberately skip Chunk. Complete creates/fsyncs its own
    // empty Source under the existing genuine transport fences.
    phase = 'complete';
    let committed: WorkspaceUploadCommit | undefined, effectsStarted = false;
    const result = await completeWorkspaceUploadFile({ sessionId: locator.uploadId, fileId: locator.fileId,
      userId: actorUserId, workspace, request, includeFullSession: false,
      commit: async ({ session: currentSession, file: currentFile, sourcePath, persistOfficeAttempt }) => {
        sameFile({ session: currentSession, file: currentFile });
        await runWorkspaceUploadWrite({ workspace, fileOptions, actorUserId, targetPath: currentFile.targetPath, sourcePath,
          idempotencyKey: `upload:${currentSession.id}:${currentFile.id}`, officeAttempt: currentFile.officeAttempt,
          persistOfficeAttempt,
          write: onBeforeReplace => replaceWorkspaceFileFromPath(sourcePath, currentFile.targetPath, fileOptions, onBeforeReplace) });
      },
      afterMarkdownCompletion: async value => {
        sameFile(value);
        if (effectsStarted) invalid('MARKDOWN_UPLOAD_RECOVERY_REQUIRED', 409, 'The upload effects were already attempted. The session was retained.');
        effectsStarted = true;
        await syncPublicSharesAfterWrite([value.file.targetPath], workspace);
        committed = await publishWorkspaceUpload(workspace, value.file.targetPath);
        await recordAuditEvent({ organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, userId: actorUserId,
          source: 'files', eventType: 'file', entityType: 'workspace_path', entityId: value.file.targetPath,
          action: 'file.upload', status: 'success', summary: `File uploaded: ${value.file.targetPath}`,
          metadata: { uploadSessionId: value.session.id, targetPath: value.file.targetPath, sizeBytes: value.file.size,
            mimeType: value.file.mimeType, workspaceType: workspace.workspaceType, chunked: true } });
      } });
    sameFile(result);
    const completion = result.completion;
    if (!completion || completion.uploadId !== locator.uploadId || completion.fileId !== locator.fileId
      || completion.targetPath !== locator.targetPath
      || !['completed', 'projection_pending', 'recovery_required', 'unavailable'].includes(completion.status)) {
      invalid('MARKDOWN_UPLOAD_RECOVERY_REQUIRED', 503, 'The native upload completion could not be confirmed. The session was retained.');
    }
    const publicCompletion: WorkspaceUploadCompletion = { status: completion.status, ...locator,
      ...(completion.code ? { code: completion.code } : {}) };
    if (completion.status !== 'completed') return { status: 'pending', httpStatus: 202, locator, completion: publicCompletion };
    return { status: 'completed', locator, completion: publicCompletion, committed: committed ?? { targetPath: locator.targetPath } };
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined;
    const known = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/u.test(code)
      && typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
    const creationUnconfirmed = phase === 'session_create' && !locator
      && !(error instanceof WorkspaceUploadServiceError && known && status < 500);
    return { status: 'failed', httpStatus: creationUnconfirmed ? 503 : known ? status : phase === 'input' ? 400 : 503,
      code: creationUnconfirmed ? 'UPLOAD_SESSION_CREATE_UNCONFIRMED' : known ? code : 'MARKDOWN_UPLOAD_RECOVERY_REQUIRED',
      error: creationUnconfirmed ? 'Upload session creation could not be confirmed; no recovery locator is available.'
        : known && error instanceof Error ? error.message.slice(0, 500) : 'The Markdown upload could not be confirmed. Existing data was retained.',
      phase, locator, unlocated: locator === null };
  }
}
