import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createDirectory } from '@/app/lib/filesystem/workspace-files';
import { getWorkspaceFileRevision } from '@/app/lib/files/revision-guard';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import { assertWorkspacePathHasNoAliases, normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { createAtomicTempPath, resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import type { DirectMcpAccessPrincipal } from './access-token-verifier';
import type { DirectMcpIngestContentValidation } from './ingest-validation';
import { resolveDirectMcpOrigin } from './config';

export class DirectMcpFileIngestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DirectMcpFileIngestError'; }
}

export type DirectMcpFileReceipt = {
  status: 'created' | 'already_created';
  workspace_id: string;
  path: string;
  size: number;
  sha256: string;
  mime_type: string;
  revision_id: string;
  operation_id: string;
  document_url: string;
  markdown: DirectMcpIngestContentValidation['markdown'];
  warnings: DirectMcpIngestContentValidation['warnings'];
};

type IngestRecord = {
  version: 1;
  fingerprint: string;
  sha256: string;
  phase: 'prepared' | 'completed';
  receipt?: DirectMcpFileReceipt;
};

export function normalizeDirectMcpIngestPath(value: string): string {
  if (!value || value.length > 1024 || value.split(/[\\/]/u).some(part => !part || part.startsWith('.'))) {
    throw new DirectMcpFileIngestError('MCP_INGEST_INVALID_PATH', 'Use a visible workspace-relative file path without hidden or traversal segments.');
  }
  const normalized = normalizeWorkspaceRelativePath(value);
  if (normalized === '.') throw new DirectMcpFileIngestError('MCP_INGEST_INVALID_PATH', 'A file destination is required.');
  return normalized;
}

export function directMcpIngestFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function writeRecord(recordPath: string, record: IngestRecord): Promise<void> {
  await fs.mkdir(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  const temporaryPath = createAtomicTempPath(recordPath);
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporaryPath, recordPath);
    const directory = await fs.open(path.dirname(recordPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporaryPath, { force: true }); }
}

async function readRecord(recordPath: string): Promise<IngestRecord | null> {
  try {
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as IngestRecord;
    if (record.version !== 1 || !/^[a-f0-9]{64}$/u.test(record.fingerprint)
      || !/^[a-f0-9]{64}$/u.test(record.sha256) || !['prepared', 'completed'].includes(record.phase)
      || (record.phase === 'completed' && !record.receipt)) throw new Error('Invalid import record');
    return record;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new DirectMcpFileIngestError('MCP_INGEST_RECOVERY_REQUIRED', 'The previous import receipt needs inspection before retrying.');
  }
}

/** Durable, create-only ingestion. Network adapters supply bytes; workspace services own publication. */
export async function createDirectMcpWorkspaceFile(input: {
  principal: DirectMcpAccessPrincipal;
  workspace: WorkspaceContext;
  path: string;
  idempotencyKey: string;
  fingerprint: string;
  loadContent: () => Promise<{ content: Buffer; validation: DirectMcpIngestContentValidation }>;
  verifyAuthority: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<DirectMcpFileReceipt> {
  const target = normalizeDirectMcpIngestPath(input.path);
  const operationId = directMcpIngestFingerprint([
    input.principal.clientId, input.principal.userId, input.workspace.workspaceId, input.idempotencyKey,
  ]);
  const recordPath = path.join(resolveCanvasDataRoot(), 'system', 'mcp-file-ingest', `${operationId}.json`);
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    await input.verifyAuthority();
    await assertWorkspacePathHasNoAliases(input.workspace, target);
    const previous = await readRecord(recordPath);
    if (previous && previous.fingerprint !== input.fingerprint) {
      throw new DirectMcpFileIngestError('MCP_INGEST_IDEMPOTENCY_CONFLICT', 'This idempotency_key belongs to a different import request.');
    }
    const existing = await getWorkspaceFileRevision(target, { workspace: input.workspace });
    if (previous?.phase === 'completed') {
      if (!existing || existing.sha256 !== previous.sha256) {
        throw new DirectMcpFileIngestError('MCP_INGEST_DESTINATION_CHANGED', 'The previously imported file has changed or moved. Read its current state before retrying.');
      }
      return { ...previous.receipt!, status: 'already_created' };
    }
    if (existing) {
      throw new DirectMcpFileIngestError(previous ? 'MCP_INGEST_RECOVERY_REQUIRED' : 'MCP_INGEST_PATH_EXISTS',
        previous ? 'The previous import may have published the file. Inspect its history before retrying; the existing file was preserved.'
          : 'A file already exists at this path. Choose a new path or edit the existing document.');
    }
    const { content, validation } = await input.loadContent();
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (previous && previous.sha256 !== sha256) {
      throw new DirectMcpFileIngestError('MCP_INGEST_IDEMPOTENCY_CONFLICT', 'The file bytes changed since the previous import attempt.');
    }
    await writeRecord(recordPath, { version: 1, fingerprint: input.fingerprint, sha256, phase: 'prepared' });
    await input.verifyAuthority();
    const parent = path.posix.dirname(target);
    if (parent !== '.') await createDirectory(parent, { workspace: input.workspace });
    const written = await writeWorkspaceFileContent({
      workspace: input.workspace, fileOptions: { workspace: input.workspace },
      actorUserId: input.principal.userId, actorType: 'agent', actorSessionId: `mcp-ingest:${operationId}`,
      path: target, content, createOnly: true, idempotencyKey: operationId, signal: input.signal,
      versionSource: 'external_import', beforePublish: input.verifyAuthority,
    });
    const verified = await getWorkspaceFileRevision(target, { workspace: input.workspace });
    if (!verified || verified.sha256 !== sha256 || verified.stats.size !== content.length) {
      throw new DirectMcpFileIngestError('MCP_INGEST_VERIFICATION_FAILED', 'The imported file could not be verified. Inspect the stored file before retrying.');
    }
    const url = new URL('/notebook', resolveDirectMcpOrigin());
    url.searchParams.set('workspaceId', input.workspace.workspaceId);
    url.searchParams.set('path', target);
    const receipt: DirectMcpFileReceipt = {
      status: 'created', workspace_id: input.workspace.workspaceId, path: target, size: content.length,
      sha256, mime_type: validation.mimeType, revision_id: written.revision.id, operation_id: operationId,
      document_url: url.toString(), markdown: validation.markdown, warnings: validation.warnings,
    };
    await writeRecord(recordPath, { version: 1, fingerprint: input.fingerprint, sha256, phase: 'completed', receipt });
    return receipt;
  });
}
