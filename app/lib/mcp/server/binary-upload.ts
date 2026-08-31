import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fileTypeFromBuffer } from 'file-type';

import { replaceWorkspaceFileFromPath } from '@/app/lib/filesystem/workspace-files';
import { publishWorkspaceFileMutation } from '@/app/lib/filesystem/file-watcher';
import { runWorkspaceUploadWrite } from '@/app/lib/files/workspace-upload-flow';
import {
  cancelWorkspaceUploadSession,
  completeWorkspaceUploadFile,
  createWorkspaceUploadSession,
  writeWorkspaceUploadChunk,
  WorkspaceUploadServiceError,
} from '@/app/lib/files/workspace-upload-service';
import {
  getWorkspaceFileRevision,
  sha256Buffer,
} from '@/app/lib/files/revision-guard';
import type { DirectMcpAccessPrincipal } from '@/app/lib/mcp/server/access-token-verifier';
import { DIRECT_MCP_ASSET_MAX_BYTES } from '@/app/lib/mcp/server/asset-reader';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { resolveAuthSecret } from '@/app/lib/security/auth-secret';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const DIRECT_MCP_UPLOAD_MAX_BYTES = DIRECT_MCP_ASSET_MAX_BYTES;
export const DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES = 512 * 1024;
export const DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS = Math.ceil(
  DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES / 3,
) * 4;
export const DIRECT_MCP_UPLOAD_HANDLE_TTL_MS = 15 * 60 * 1000;

const MAX_UPLOAD_HANDLE_LENGTH = 4096;
const MAX_ACTIVE_UPLOADS_PER_CLIENT = 4;
const HANDLE_VERSION = 1;
const HANDLE_IV_BYTES = 12;
const HANDLE_AUTH_TAG_BYTES = 16;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const TEXT_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/toml',
  'application/xml',
  'application/yaml',
]);
const TEXT_FILE_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.h', '.hpp', '.html', '.ini', '.java',
  '.js', '.json', '.jsx', '.kt', '.log', '.lua', '.md', '.mdx', '.mjs', '.php', '.properties', '.py',
  '.rb', '.rs', '.rst', '.sh', '.sql', '.svg', '.swift', '.text', '.toml', '.ts', '.tsx', '.tsv', '.txt',
  '.xml', '.yaml', '.yml',
]);
const activeUploadsByPrincipal = new Map<string, Map<string, number>>();

type DirectMcpUploadHandle = {
  version: 1;
  sessionId: string;
  fileId: string;
  workspaceId: string;
  principalBinding: string;
  targetPath: string;
  size: number;
  mimeType: string;
  contentSha256: string;
  beforeSha256: string | null;
  expiresAt: number;
};

export class DirectMcpBinaryUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectMcpBinaryUploadError';
  }
}

function uploadSignature(value: string): string {
  return createHmac(
    'sha256',
    resolveAuthSecret(process.env, { allowProductionBuildFallback: true }),
  ).update(value).digest('base64url');
}

function uploadEncryptionKey(): Buffer {
  return createHash('sha256')
    .update('canvas-direct-mcp-upload-handle\0', 'utf8')
    .update(resolveAuthSecret(process.env, { allowProductionBuildFallback: true }), 'utf8')
    .digest();
}

function principalBinding(principal: DirectMcpAccessPrincipal): string {
  return uploadSignature(
    `direct-mcp-upload:${principal.clientId}:${principal.userId}:${principal.sessionId}`,
  );
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function encodeUploadHandle(payload: DirectMcpUploadHandle): string {
  const iv = randomBytes(HANDLE_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', uploadEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function isUploadHandle(value: unknown): value is DirectMcpUploadHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Partial<DirectMcpUploadHandle>;
  return payload.version === HANDLE_VERSION
    && typeof payload.sessionId === 'string'
    && /^[a-f0-9-]{36}$/iu.test(payload.sessionId)
    && typeof payload.fileId === 'string'
    && /^[a-f0-9-]{36}$/iu.test(payload.fileId)
    && typeof payload.workspaceId === 'string'
    && Boolean(payload.workspaceId)
    && typeof payload.principalBinding === 'string'
    && /^[A-Za-z0-9_-]{40,64}$/u.test(payload.principalBinding)
    && typeof payload.targetPath === 'string'
    && Boolean(payload.targetPath)
    && typeof payload.size === 'number'
    && Number.isSafeInteger(payload.size)
    && payload.size > 0
    && payload.size <= DIRECT_MCP_UPLOAD_MAX_BYTES
    && typeof payload.mimeType === 'string'
    && MIME_TYPE_PATTERN.test(payload.mimeType)
    && typeof payload.contentSha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(payload.contentSha256)
    && (payload.beforeSha256 === null
      || (typeof payload.beforeSha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.beforeSha256)))
    && typeof payload.expiresAt === 'number'
    && Number.isSafeInteger(payload.expiresAt);
}

function decodeUploadHandle(input: {
  uploadId: string;
  principal: DirectMcpAccessPrincipal;
  workspaceId: string;
  now?: number;
}): DirectMcpUploadHandle {
  const invalid = (): never => {
    throw new DirectMcpBinaryUploadError('The upload session is invalid or expired. Start the upload again.');
  };
  if (!input.uploadId || input.uploadId.length > MAX_UPLOAD_HANDLE_LENGTH) invalid();
  if (!/^[A-Za-z0-9_-]+$/u.test(input.uploadId)) invalid();

  try {
    const decoded = Buffer.from(input.uploadId, 'base64url');
    if (
      decoded.length <= HANDLE_IV_BYTES + HANDLE_AUTH_TAG_BYTES
      || decoded.toString('base64url') !== input.uploadId
    ) {
      invalid();
    }
    const iv = decoded.subarray(0, HANDLE_IV_BYTES);
    const authTag = decoded.subarray(HANDLE_IV_BYTES, HANDLE_IV_BYTES + HANDLE_AUTH_TAG_BYTES);
    const encrypted = decoded.subarray(HANDLE_IV_BYTES + HANDLE_AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', uploadEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isUploadHandle(payload)) return invalid();
    if (
      payload.workspaceId !== input.workspaceId
      || !safeEqual(payload.principalBinding, principalBinding(input.principal))
      || payload.expiresAt <= (input.now ?? Date.now())
    ) {
      invalid();
    }
    return payload;
  } catch (error) {
    if (error instanceof DirectMcpBinaryUploadError) throw error;
    return invalid();
  }
}

function pruneTrackedUploads(now = Date.now()): void {
  for (const [trackingKey, uploads] of activeUploadsByPrincipal) {
    for (const [sessionId, expiresAt] of uploads) {
      if (expiresAt <= now) uploads.delete(sessionId);
    }
    if (uploads.size === 0) activeUploadsByPrincipal.delete(trackingKey);
  }
}

function assertUploadCapacity(trackingKey: string): void {
  pruneTrackedUploads();
  if ((activeUploadsByPrincipal.get(trackingKey)?.size ?? 0) >= MAX_ACTIVE_UPLOADS_PER_CLIENT) {
    throw new DirectMcpBinaryUploadError(
      `At most ${MAX_ACTIVE_UPLOADS_PER_CLIENT} binary uploads may be active for one MCP connection. Complete or abort an upload before starting another.`,
    );
  }
}

function trackUpload(trackingKey: string, sessionId: string, expiresAt: number): void {
  const uploads = activeUploadsByPrincipal.get(trackingKey) ?? new Map<string, number>();
  uploads.set(sessionId, expiresAt);
  activeUploadsByPrincipal.set(trackingKey, uploads);
}

function untrackUpload(trackingKey: string, sessionId: string): void {
  const uploads = activeUploadsByPrincipal.get(trackingKey);
  uploads?.delete(sessionId);
  if (uploads?.size === 0) activeUploadsByPrincipal.delete(trackingKey);
}

export function normalizeDirectMcpUploadMimeType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || 'application/octet-stream';
  if (normalized.length > 200 || !MIME_TYPE_PATTERN.test(normalized)) {
    throw new DirectMcpBinaryUploadError('mime_type must be a valid MIME type without parameters.');
  }
  if (normalized.startsWith('text/') || TEXT_MIME_TYPES.has(normalized)) {
    throw new DirectMcpBinaryUploadError(
      'This tool accepts binary files only. Use edit_knowledge_source for visible text documents.',
    );
  }
  return normalized;
}

function assertBinaryDestinationPath(targetPath: string): void {
  if (TEXT_FILE_EXTENSIONS.has(path.posix.extname(targetPath).toLowerCase())) {
    throw new DirectMcpBinaryUploadError(
      'This tool accepts binary file paths only. Use edit_knowledge_source for visible text documents.',
    );
  }
}

export function decodeDirectMcpUploadChunk(value: string): Buffer {
  if (!value || value.length > DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS) {
    throw new DirectMcpBinaryUploadError(
      `data_base64 must contain at most ${DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES} decoded bytes.`,
    );
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new DirectMcpBinaryUploadError('data_base64 must be canonical standard Base64 without whitespace.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES) {
    throw new DirectMcpBinaryUploadError(
      `data_base64 must contain between 1 and ${DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES} decoded bytes.`,
    );
  }
  if (decoded.toString('base64') !== value) {
    throw new DirectMcpBinaryUploadError('data_base64 must be canonical standard Base64 without whitespace.');
  }
  return decoded;
}

async function assertDestinationRevision(input: {
  workspace: WorkspaceContext;
  path: string;
  beforeSha256: string | null;
}): Promise<void> {
  const current = await getWorkspaceFileRevision(input.path, { workspace: input.workspace });
  if ((current?.sha256 ?? null) === input.beforeSha256) return;
  throw new DirectMcpBinaryUploadError(
    'The destination changed while the upload was in progress. Read the current file and start the upload again.',
  );
}

async function inspectUploadedMimeType(buffer: Buffer, declaredMimeType: string): Promise<string | null> {
  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (
    detected
    && declaredMimeType !== 'application/octet-stream'
    && detected.mime !== declaredMimeType
  ) {
    throw new DirectMcpBinaryUploadError(
      `The uploaded bytes are ${detected.mime}, not the declared ${declaredMimeType}.`,
    );
  }
  if (!detected && !buffer.subarray(0, 8192).includes(0)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, 8192));
      if (![...text].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 && ![9, 10, 13].includes(code);
      })) {
        throw new DirectMcpBinaryUploadError(
          'The uploaded content appears to be text. Use edit_knowledge_source for visible text documents.',
        );
      }
    } catch (error) {
      if (error instanceof DirectMcpBinaryUploadError) throw error;
      // Invalid UTF-8 is expected for an unrecognized binary format.
    }
  }
  return detected?.mime ?? null;
}

export async function beginDirectMcpBinaryUpload(input: {
  principal: DirectMcpAccessPrincipal;
  workspace: WorkspaceContext;
  path: string;
  size: number;
  mimeType: string;
  contentSha256: string;
  overwrite: boolean;
  expectedSha256: string | null;
}): Promise<{
  uploadId: string;
  nextOffset: number;
  maxChunkBytes: number;
  expiresAt: string;
  beforeSha256: string | null;
}> {
  const trackingKey = principalBinding(input.principal);
  assertUploadCapacity(trackingKey);
  assertBinaryDestinationPath(input.path);
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > DIRECT_MCP_UPLOAD_MAX_BYTES) {
    throw new DirectMcpBinaryUploadError(
      `size must be an integer between 1 and ${DIRECT_MCP_UPLOAD_MAX_BYTES} bytes.`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(input.contentSha256)) {
    throw new DirectMcpBinaryUploadError('sha256 must be the lowercase SHA-256 hash of the complete file.');
  }

  const currentRevision = await getWorkspaceFileRevision(input.path, { workspace: input.workspace });
  if (currentRevision) {
    if (!input.overwrite) {
      throw new DirectMcpBinaryUploadError(
        'The destination already exists. Set overwrite to true and provide its current expected_sha256 to replace it.',
      );
    }
    if (!input.expectedSha256 || input.expectedSha256 !== currentRevision.sha256) {
      throw new DirectMcpBinaryUploadError(
        'The destination changed or expected_sha256 is missing. Read the current file and start the upload again.',
      );
    }
  } else if (input.expectedSha256) {
    throw new DirectMcpBinaryUploadError(
      'The destination no longer exists. Start a new upload without expected_sha256.',
    );
  }

  const targetDir = path.posix.dirname(input.path);
  const session = await createWorkspaceUploadSession({
    userId: input.principal.userId,
    workspace: input.workspace,
    targetDir,
    files: [{
      path: path.posix.basename(input.path),
      size: input.size,
      mimeType: input.mimeType,
    }],
  });
  const file = session.files[0];
  if (!file || file.targetPath !== input.path) {
    await cancelWorkspaceUploadSession({
      sessionId: session.id,
      userId: input.principal.userId,
      workspace: input.workspace,
    }).catch(() => undefined);
    throw new DirectMcpBinaryUploadError('Could not create a safe upload destination.');
  }

  const expiresAt = Math.min(
    Date.now() + DIRECT_MCP_UPLOAD_HANDLE_TTL_MS,
    new Date(session.expiresAt).getTime(),
  );
  const payload: DirectMcpUploadHandle = {
    version: HANDLE_VERSION,
    sessionId: session.id,
    fileId: file.id,
    workspaceId: input.workspace.workspaceId,
    principalBinding: principalBinding(input.principal),
    targetPath: input.path,
    size: input.size,
    mimeType: input.mimeType,
    contentSha256: input.contentSha256,
    beforeSha256: currentRevision?.sha256 ?? null,
    expiresAt,
  };
  trackUpload(trackingKey, session.id, expiresAt);
  return {
    uploadId: encodeUploadHandle(payload),
    nextOffset: 0,
    maxChunkBytes: DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES,
    expiresAt: new Date(expiresAt).toISOString(),
    beforeSha256: payload.beforeSha256,
  };
}

export async function writeDirectMcpBinaryUploadChunk(input: {
  principal: DirectMcpAccessPrincipal;
  workspace: WorkspaceContext;
  uploadId: string;
  offset: number;
  buffer: Buffer;
}): Promise<{
  path: string;
  nextOffset: number;
  totalBytes: number;
  alreadyReceived: boolean;
}> {
  const handle = decodeUploadHandle({
    uploadId: input.uploadId,
    principal: input.principal,
    workspaceId: input.workspace.workspaceId,
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input.buffer);
      controller.close();
    },
  });
  const written = await writeWorkspaceUploadChunk({
    sessionId: handle.sessionId,
    fileId: handle.fileId,
    userId: input.principal.userId,
    workspace: input.workspace,
    offset: input.offset,
    expectedBytes: input.buffer.length,
    body,
  });
  return {
    path: handle.targetPath,
    nextOffset: written.file.uploadedBytes,
    totalBytes: handle.size,
    alreadyReceived: written.alreadyReceived,
  };
}

export async function completeDirectMcpBinaryUpload(input: {
  principal: DirectMcpAccessPrincipal;
  workspace: WorkspaceContext;
  uploadId: string;
}): Promise<{
  path: string;
  size: number;
  mimeType: string;
  detectedMimeType: string | null;
  beforeSha256: string | null;
  afterSha256: string;
  modifiedAt: number | undefined;
  alreadyCompleted: boolean;
}> {
  const handle = decodeUploadHandle({
    uploadId: input.uploadId,
    principal: input.principal,
    workspaceId: input.workspace.workspaceId,
  });
  let detectedMimeType: string | null = null;

  try {
    const completed = await completeWorkspaceUploadFile({
      sessionId: handle.sessionId,
      fileId: handle.fileId,
      userId: input.principal.userId,
      workspace: input.workspace,
      commit: async ({ file, sourcePath }) => {
        if (file.targetPath !== handle.targetPath || file.size !== handle.size) {
          throw new DirectMcpBinaryUploadError('The upload session no longer matches the requested file.');
        }
        const buffer = await fs.readFile(sourcePath);
        if (buffer.length !== handle.size || sha256Buffer(buffer) !== handle.contentSha256) {
          throw new DirectMcpBinaryUploadError(
            'The uploaded file does not match the declared size or SHA-256 hash. Start the upload again.',
          );
        }
        detectedMimeType = await inspectUploadedMimeType(buffer, handle.mimeType);
        await assertDestinationRevision({
          workspace: input.workspace,
          path: handle.targetPath,
          beforeSha256: handle.beforeSha256,
        });
        await runWorkspaceUploadWrite({
          workspace: input.workspace,
          fileOptions: { workspace: input.workspace },
          actorUserId: input.principal.userId,
          targetPath: handle.targetPath,
          write: (onBeforeReplace) => replaceWorkspaceFileFromPath(
            sourcePath,
            handle.targetPath,
            { workspace: input.workspace },
            async () => {
              await assertDestinationRevision({
                workspace: input.workspace,
                path: handle.targetPath,
                beforeSha256: handle.beforeSha256,
              });
              await onBeforeReplace();
            },
          ),
        });
      },
    });

    const afterRevision = await getWorkspaceFileRevision(handle.targetPath, { workspace: input.workspace });
    if (!afterRevision || afterRevision.sha256 !== handle.contentSha256) {
      throw new DirectMcpBinaryUploadError('The uploaded file could not be verified after it was saved.');
    }
    if (!completed.alreadyCompleted) {
      await syncPublicSharesAfterWrite([handle.targetPath], input.workspace);
      publishWorkspaceFileMutation({
        workspace: input.workspace,
        type: handle.beforeSha256 ? 'change' : 'add',
        relativePath: handle.targetPath,
      });
    }
    untrackUpload(principalBinding(input.principal), handle.sessionId);
    return {
      path: handle.targetPath,
      size: handle.size,
      mimeType: handle.mimeType,
      detectedMimeType,
      beforeSha256: handle.beforeSha256,
      afterSha256: afterRevision.sha256,
      modifiedAt: afterRevision.stats.modified,
      alreadyCompleted: completed.alreadyCompleted,
    };
  } catch (error) {
    if (error instanceof DirectMcpBinaryUploadError) {
      await cancelWorkspaceUploadSession({
        sessionId: handle.sessionId,
        userId: input.principal.userId,
        workspace: input.workspace,
      }).catch(() => undefined);
      untrackUpload(principalBinding(input.principal), handle.sessionId);
    }
    throw error;
  }
}

export async function abortDirectMcpBinaryUpload(input: {
  principal: DirectMcpAccessPrincipal;
  workspace: WorkspaceContext;
  uploadId: string;
}): Promise<{ path: string }> {
  const handle = decodeUploadHandle({
    uploadId: input.uploadId,
    principal: input.principal,
    workspaceId: input.workspace.workspaceId,
  });
  await cancelWorkspaceUploadSession({
    sessionId: handle.sessionId,
    userId: input.principal.userId,
    workspace: input.workspace,
  });
  untrackUpload(principalBinding(input.principal), handle.sessionId);
  return { path: handle.targetPath };
}

export function directMcpBinaryUploadErrorMessage(error: unknown): string {
  if (error instanceof DirectMcpBinaryUploadError) return error.message;
  if (error instanceof WorkspaceUploadServiceError) {
    if (['UPLOAD_NOT_FOUND', 'UPLOAD_FILE_NOT_FOUND', 'UPLOAD_FORBIDDEN', 'UPLOAD_EXPIRED'].includes(error.code)) {
      return 'The upload session is invalid or expired. Start the upload again.';
    }
    return error.message;
  }
  return 'Could not safely upload the binary file to the Canvas workspace.';
}
