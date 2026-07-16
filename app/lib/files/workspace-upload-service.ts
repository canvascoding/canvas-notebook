import 'server-only';

import crypto from 'node:crypto';
import path from 'node:path';
import { createWriteStream, promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import {
  WORKSPACE_UPLOAD_CHUNK_SIZE,
  WORKSPACE_UPLOAD_MAX_FILE_BYTES,
  WORKSPACE_UPLOAD_MAX_FILES,
  WORKSPACE_UPLOAD_MAX_TOTAL_BYTES,
  formatUploadBytes,
} from '@/app/lib/files/upload-limits';
import { sanitizeWorkspaceUploadPath } from '@/app/lib/files/upload-paths';
import { createAtomicTempPath, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const SESSION_FILE_NAME = 'session.json';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MINIMUM_FREE_BYTES_AFTER_UPLOAD = 1024 * 1024 * 1024;

export type WorkspaceUploadSessionStatus = 'receiving' | 'completed';
export type WorkspaceUploadFileStatus = 'pending' | 'uploading' | 'uploaded' | 'completed';

export interface WorkspaceUploadFileInput {
  path: string;
  size: number;
  mimeType?: string;
}

export interface WorkspaceUploadFileRecord {
  id: string;
  sourceIndex: number;
  relativePath: string;
  targetPath: string;
  size: number;
  mimeType: string;
  uploadedBytes: number;
  status: WorkspaceUploadFileStatus;
}

export interface WorkspaceUploadSession {
  id: string;
  userId: string;
  workspaceId: string;
  targetDir: string;
  totalBytes: number;
  status: WorkspaceUploadSessionStatus;
  files: WorkspaceUploadFileRecord[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export class WorkspaceUploadServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkspaceUploadServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  fileLocks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === current) {
      fileLocks.delete(key);
    }
  }
}

function uploadsRoot(): string {
  return path.join(resolveCanvasDataRoot(), '.uploads', 'workspace');
}

function isValidSessionId(sessionId: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(sessionId);
}

function sessionDir(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new WorkspaceUploadServiceError('UPLOAD_NOT_FOUND', 404, 'Upload session was not found.');
  }
  return requirePathInside(uploadsRoot(), sessionId);
}

function sessionStatusPath(sessionId: string): string {
  return requirePathInside(sessionDir(sessionId), SESSION_FILE_NAME);
}

function uploadFilePath(sessionId: string, fileId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(fileId)) {
    throw new WorkspaceUploadServiceError('UPLOAD_FILE_NOT_FOUND', 404, 'Upload file was not found.');
  }
  return requirePathInside(sessionDir(sessionId), `${fileId}.part`);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function writeSession(session: WorkspaceUploadSession): Promise<void> {
  await ensurePrivateDirectory(sessionDir(session.id));
  session.updatedAt = new Date().toISOString();
  const statusPath = sessionStatusPath(session.id);
  const temporaryPath = createAtomicTempPath(statusPath);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, statusPath);
    await fs.chmod(statusPath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readSession(sessionId: string): Promise<WorkspaceUploadSession | null> {
  try {
    const raw = await fs.readFile(sessionStatusPath(sessionId), 'utf8');
    return JSON.parse(raw) as WorkspaceUploadSession;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof WorkspaceUploadServiceError) throw error;
    return null;
  }
}

function assertSessionAccess(
  session: WorkspaceUploadSession | null,
  userId: string,
  workspace: WorkspaceContext,
): asserts session is WorkspaceUploadSession {
  if (!session) {
    throw new WorkspaceUploadServiceError('UPLOAD_NOT_FOUND', 404, 'Upload session was not found.');
  }
  if (session.userId !== userId || session.workspaceId !== workspace.workspaceId) {
    throw new WorkspaceUploadServiceError('UPLOAD_FORBIDDEN', 403, 'Upload session belongs to another user or workspace.');
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    throw new WorkspaceUploadServiceError('UPLOAD_EXPIRED', 410, 'Upload session expired. Start the upload again.');
  }
}

function findSessionFile(session: WorkspaceUploadSession, fileId: string): WorkspaceUploadFileRecord {
  const file = session.files.find((candidate) => candidate.id === fileId);
  if (!file) {
    throw new WorkspaceUploadServiceError('UPLOAD_FILE_NOT_FOUND', 404, 'Upload file was not found.');
  }
  return file;
}

async function assertEnoughDiskSpace(totalBytes: number): Promise<void> {
  const root = uploadsRoot();
  await ensurePrivateDirectory(root);
  const stats = await fs.statfs(root);
  const availableBytes = stats.bavail * stats.bsize;
  if (availableBytes - totalBytes < MINIMUM_FREE_BYTES_AFTER_UPLOAD) {
    throw new WorkspaceUploadServiceError(
      'INSUFFICIENT_STORAGE',
      507,
      `Not enough free disk space. The upload needs ${formatUploadBytes(totalBytes)} plus ${formatUploadBytes(MINIMUM_FREE_BYTES_AFTER_UPLOAD)} of free reserve.`,
      { availableBytes, requiredBytes: totalBytes, reserveBytes: MINIMUM_FREE_BYTES_AFTER_UPLOAD },
    );
  }
}

export async function cleanupExpiredWorkspaceUploadSessions(nowMs = Date.now()): Promise<void> {
  const root = uploadsRoot();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const directory = requirePathInside(root, entry.name);
    try {
      const session = await readSession(entry.name);
      const expiresAt = session ? new Date(session.expiresAt).getTime() : 0;
      const stats = await fs.stat(directory);
      if ((expiresAt > 0 && expiresAt <= nowMs) || (!session && stats.mtimeMs + SESSION_TTL_MS <= nowMs)) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    } catch {
      // Cleanup must never prevent a new upload from starting.
    }
  }));
}

export async function createWorkspaceUploadSession(params: {
  userId: string;
  workspace: WorkspaceContext;
  targetDir: string;
  files: WorkspaceUploadFileInput[];
}): Promise<WorkspaceUploadSession> {
  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new WorkspaceUploadServiceError('UPLOAD_FILES_REQUIRED', 400, 'At least one file is required.');
  }
  if (params.files.length > WORKSPACE_UPLOAD_MAX_FILES) {
    throw new WorkspaceUploadServiceError(
      'UPLOAD_TOO_MANY_FILES',
      400,
      `A single upload can contain at most ${WORKSPACE_UPLOAD_MAX_FILES} files.`,
      { maxFiles: WORKSPACE_UPLOAD_MAX_FILES, actualFiles: params.files.length },
    );
  }

  const targetDir = resolveWorkspacePath(params.workspace, params.targetDir || '.').relativePath;
  let totalBytes = 0;
  const targetPaths = new Set<string>();
  const files = params.files.map((input, sourceIndex): WorkspaceUploadFileRecord => {
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new WorkspaceUploadServiceError('UPLOAD_FILE_SIZE_INVALID', 400, `File ${sourceIndex + 1} has an invalid size.`);
    }
    if (input.size > WORKSPACE_UPLOAD_MAX_FILE_BYTES) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_FILE_TOO_LARGE',
        413,
        `File "${input.path}" exceeds the ${formatUploadBytes(WORKSPACE_UPLOAD_MAX_FILE_BYTES)} per-file limit.`,
        { path: input.path, maxBytes: WORKSPACE_UPLOAD_MAX_FILE_BYTES, actualBytes: input.size },
      );
    }

    const relativePath = sanitizeWorkspaceUploadPath(input.path);
    if (!relativePath) {
      throw new WorkspaceUploadServiceError('UPLOAD_FILE_PATH_INVALID', 400, `File ${sourceIndex + 1} has an invalid path.`);
    }
    const targetPath = targetDir === '.' ? relativePath : path.posix.join(targetDir, relativePath);
    resolveWorkspacePath(params.workspace, targetPath);
    if (targetPaths.has(targetPath)) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_DUPLICATE_PATH',
        409,
        `Multiple selected files resolve to the same destination: ${targetPath}`,
        { path: targetPath },
      );
    }
    targetPaths.add(targetPath);
    totalBytes += input.size;

    return {
      id: crypto.randomUUID(),
      sourceIndex,
      relativePath,
      targetPath,
      size: input.size,
      mimeType: input.mimeType?.trim() || 'application/octet-stream',
      uploadedBytes: 0,
      status: 'pending',
    };
  });

  if (totalBytes > WORKSPACE_UPLOAD_MAX_TOTAL_BYTES) {
    throw new WorkspaceUploadServiceError(
      'UPLOAD_TOTAL_TOO_LARGE',
      413,
      `The selected files exceed the ${formatUploadBytes(WORKSPACE_UPLOAD_MAX_TOTAL_BYTES)} total upload limit.`,
      { maxBytes: WORKSPACE_UPLOAD_MAX_TOTAL_BYTES, actualBytes: totalBytes },
    );
  }

  await assertEnoughDiskSpace(totalBytes);
  void cleanupExpiredWorkspaceUploadSessions().catch(() => undefined);

  const id = crypto.randomUUID();
  const now = new Date();
  const session: WorkspaceUploadSession = {
    id,
    userId: params.userId,
    workspaceId: params.workspace.workspaceId,
    targetDir,
    totalBytes,
    status: 'receiving',
    files,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
  await writeSession(session);
  return session;
}

export async function getWorkspaceUploadSession(params: {
  sessionId: string;
  userId: string;
  workspace: WorkspaceContext;
}): Promise<WorkspaceUploadSession> {
  const session = await readSession(params.sessionId);
  assertSessionAccess(session, params.userId, params.workspace);
  return session;
}

export async function writeWorkspaceUploadChunk(params: {
  sessionId: string;
  fileId: string;
  userId: string;
  workspace: WorkspaceContext;
  offset: number;
  expectedBytes: number;
  body: ReadableStream<Uint8Array> | null;
}): Promise<{ session: WorkspaceUploadSession; file: WorkspaceUploadFileRecord; alreadyReceived: boolean }> {
  return withFileLock(`${params.sessionId}:${params.fileId}`, async () => {
    const session = await readSession(params.sessionId);
    assertSessionAccess(session, params.userId, params.workspace);
    if (session.status !== 'receiving') {
      throw new WorkspaceUploadServiceError('UPLOAD_NOT_RECEIVING', 409, 'Upload session is no longer receiving data.');
    }
    const file = findSessionFile(session, params.fileId);
    if (!params.body) {
      throw new WorkspaceUploadServiceError('UPLOAD_CHUNK_REQUIRED', 400, 'Upload chunk body is required.');
    }
    if (!Number.isSafeInteger(params.offset) || params.offset < 0) {
      throw new WorkspaceUploadServiceError('UPLOAD_OFFSET_INVALID', 400, 'Upload chunk offset is invalid.');
    }
    if (!Number.isSafeInteger(params.expectedBytes) || params.expectedBytes <= 0) {
      throw new WorkspaceUploadServiceError('UPLOAD_CHUNK_SIZE_INVALID', 400, 'Upload chunk size is invalid.');
    }
    if (params.expectedBytes > WORKSPACE_UPLOAD_CHUNK_SIZE) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_CHUNK_TOO_LARGE',
        413,
        `Upload chunks may not exceed ${formatUploadBytes(WORKSPACE_UPLOAD_CHUNK_SIZE)}.`,
        { maxBytes: WORKSPACE_UPLOAD_CHUNK_SIZE, actualBytes: params.expectedBytes },
      );
    }
    if (params.offset + params.expectedBytes > file.size) {
      throw new WorkspaceUploadServiceError('UPLOAD_CHUNK_RANGE_INVALID', 400, 'Upload chunk exceeds the declared file size.');
    }

    if (
      params.offset < file.uploadedBytes
      && params.offset + params.expectedBytes === file.uploadedBytes
    ) {
      return { session, file, alreadyReceived: true };
    }
    if (params.offset !== file.uploadedBytes) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_OFFSET_MISMATCH',
        409,
        `Upload offset mismatch. Server expects byte ${file.uploadedBytes}.`,
        { expectedOffset: file.uploadedBytes, actualOffset: params.offset, path: file.relativePath },
      );
    }
    if (file.status === 'completed') {
      return { session, file, alreadyReceived: true };
    }

    const partPath = uploadFilePath(session.id, file.id);
    await ensurePrivateDirectory(sessionDir(session.id));
    const existingSize = await fs.stat(partPath).then((stats) => stats.size).catch(() => 0);
    if (existingSize !== params.offset) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_STORAGE_OFFSET_MISMATCH',
        409,
        'Stored upload data does not match the session offset. Restart this file upload.',
        { expectedOffset: params.offset, actualOffset: existingSize, path: file.relativePath },
      );
    }

    let receivedBytes = 0;
    const byteLimit = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > params.expectedBytes) {
          callback(new WorkspaceUploadServiceError(
            'UPLOAD_CHUNK_SIZE_MISMATCH',
            400,
            `Upload chunk contains more than the declared ${params.expectedBytes} bytes.`,
          ));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(params.body as unknown as NodeReadableStream<Uint8Array>),
        byteLimit,
        createWriteStream(partPath, {
          flags: params.offset === 0 ? 'w' : 'a',
          mode: 0o600,
        }),
      );
      if (receivedBytes !== params.expectedBytes) {
        throw new WorkspaceUploadServiceError(
          'UPLOAD_CHUNK_SIZE_MISMATCH',
          400,
          `Upload chunk size mismatch: expected ${params.expectedBytes} bytes, received ${receivedBytes}.`,
        );
      }
    } catch (error) {
      await fs.truncate(partPath, params.offset).catch(() => undefined);
      throw error;
    }

    file.uploadedBytes += receivedBytes;
    file.status = file.uploadedBytes === file.size ? 'uploaded' : 'uploading';
    await writeSession(session);
    return { session, file, alreadyReceived: false };
  });
}

export async function completeWorkspaceUploadFile(params: {
  sessionId: string;
  fileId: string;
  userId: string;
  workspace: WorkspaceContext;
  commit: (input: {
    session: WorkspaceUploadSession;
    file: WorkspaceUploadFileRecord;
    sourcePath: string;
  }) => Promise<void>;
}): Promise<{ session: WorkspaceUploadSession; file: WorkspaceUploadFileRecord; alreadyCompleted: boolean }> {
  return withFileLock(`${params.sessionId}:${params.fileId}`, async () => {
    const session = await readSession(params.sessionId);
    assertSessionAccess(session, params.userId, params.workspace);
    const file = findSessionFile(session, params.fileId);
    if (file.status === 'completed') {
      return { session, file, alreadyCompleted: true };
    }
    if (file.uploadedBytes !== file.size || (file.size > 0 && file.status !== 'uploaded')) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_FILE_INCOMPLETE',
        409,
        `File "${file.relativePath}" is incomplete (${file.uploadedBytes}/${file.size} bytes).`,
        { path: file.relativePath, uploadedBytes: file.uploadedBytes, totalBytes: file.size },
      );
    }

    const sourcePath = uploadFilePath(session.id, file.id);
    if (file.size === 0) {
      await fs.writeFile(sourcePath, Buffer.alloc(0), { mode: 0o600 });
    }
    const stats = await fs.stat(sourcePath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size !== file.size) {
      throw new WorkspaceUploadServiceError(
        'UPLOAD_STORED_FILE_INVALID',
        409,
        `Stored data for "${file.relativePath}" is missing or incomplete.`,
        { path: file.relativePath, expectedBytes: file.size, actualBytes: stats?.size ?? null },
      );
    }

    await params.commit({ session, file, sourcePath });
    file.status = 'completed';
    file.uploadedBytes = file.size;
    if (session.files.every((candidate) => candidate.status === 'completed')) {
      session.status = 'completed';
    }
    await writeSession(session);
    await fs.rm(sourcePath, { force: true }).catch(() => undefined);
    return { session, file, alreadyCompleted: false };
  });
}

export async function cancelWorkspaceUploadSession(params: {
  sessionId: string;
  userId: string;
  workspace: WorkspaceContext;
}): Promise<void> {
  const session = await readSession(params.sessionId);
  assertSessionAccess(session, params.userId, params.workspace);
  await fs.rm(sessionDir(params.sessionId), { recursive: true, force: true });
}

export function workspaceUploadLimits() {
  return {
    chunkBytes: WORKSPACE_UPLOAD_CHUNK_SIZE,
    maxFiles: WORKSPACE_UPLOAD_MAX_FILES,
    maxFileBytes: WORKSPACE_UPLOAD_MAX_FILE_BYTES,
    maxTotalBytes: WORKSPACE_UPLOAD_MAX_TOTAL_BYTES,
  };
}

export function publicWorkspaceUploadSession(session: WorkspaceUploadSession) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    targetDir: session.targetDir,
    totalBytes: session.totalBytes,
    status: session.status,
    files: session.files,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  };
}
