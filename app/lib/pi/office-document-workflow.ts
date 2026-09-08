import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { DOCX_PACKAGE_LIMITS, validateDocxPackage } from '@/app/lib/office/docx-package';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { WriteWorkspaceFileContentInput } from '@/app/lib/files/write-service';
import { prepareScratchDirectory } from '@/app/lib/pi/agent-shell-sandbox';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { resolveCanvasDataRoot } from '@/app/lib/runtime-data-paths';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

type Authority = { context: AgentExecutionContext; workspace: WorkspaceContext };
type Lease = { id: string; expiresAt: number; lineageId: string | null };
type Published = { stats: { sha256?: string; size: number }; revision: { id: string }; [key: string]: unknown };
type CheckoutStatus = 'checked_out' | 'prepared' | 'committed' | 'conflict' | 'released';

type CheckoutManifest = {
  version: 1;
  id: string;
  userId: string;
  sessionId: string;
  agentId: string | null;
  workspaceId: string;
  workspaceRoot: string;
  path: string;
  documentId: string | null;
  createOnly: boolean;
  baseSha256: string | null;
  baseRevisionId: string | null;
  lockId: string;
  lockExpiresAt: number;
  workingPath: string;
  status: CheckoutStatus;
  createdAt: number;
  candidateHash?: string;
  idempotencyKey?: string;
  error?: { code: string; message: string };
  result?: Published;
};

export type OfficeCheckoutResult = {
  checkoutId: string;
  status: CheckoutStatus;
  path: string;
  workingPath: string;
  documentId: string | null;
  baseSha256: string | null;
  lockExpiresAt: number;
  recoveryId: string;
  error?: { code: string; message: string };
  result?: Published;
};

export type OfficeDocumentDependencies = {
  resolveAuthority: (context: AgentExecutionContext) => Promise<Authority>;
  canonicalPath: (workspace: WorkspaceContext, filePath: string) => Promise<string>;
  readSource: (workspace: WorkspaceContext, filePath: string) => Promise<Buffer | null>;
  ensureRevision: (workspace: WorkspaceContext, filePath: string, buffer: Buffer) => Promise<{ id: string; lineageId: string | null }>;
  acquire: (authority: Authority, filePath: string, revisionId: string | null, leaseSessionId: string) => Promise<Lease>;
  renew: (authority: Authority, filePath: string, lockId: string, leaseSessionId: string) => Promise<Lease>;
  release: (authority: Authority, filePath: string, lockId: string, leaseSessionId: string) => Promise<unknown>;
  publish: (input: WriteWorkspaceFileContentInput) => Promise<Published>;
};

const defaults: OfficeDocumentDependencies = {
  async resolveAuthority(context) {
    const { resolveAgentExecutionContextForStoredSession, workspaceFromAgentExecutionContext } = await import('./session-workspace-context');
    const { DEFAULT_MANAGED_AGENT_ID } = await import('@/app/lib/agents/storage');
    const fresh = await resolveAgentExecutionContextForStoredSession({
      userId: context.userId, sessionId: context.sessionId,
      agentId: context.agentId || DEFAULT_MANAGED_AGENT_ID,
      permissions: ['canRead', 'canRunAgent', 'canWrite'],
    });
    return { context: fresh, workspace: workspaceFromAgentExecutionContext(fresh) };
  },
  async canonicalPath(workspace, filePath) {
    const { resolveWritableWorkspacePath } = await import('@/app/lib/workspaces/path-guard');
    const canonical = await resolveWritableWorkspacePath(workspace, filePath);
    return path.relative(await fs.realpath(workspace.rootPath), canonical).split(path.sep).join('/');
  },
  async readSource(workspace, filePath) {
    const { readOfficeDocumentSnapshot } = await import('@/app/lib/office/document-service');
    try {
      // This bounded read also completes an interrupted publication journal
      // before a fresh checkout records the document's revision/author.
      return (await readOfficeDocumentSnapshot(workspace, filePath)).content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  async ensureRevision(workspace, filePath, buffer) {
    const { ensureFileRevisionForCurrentContent } = await import('@/app/lib/files/collaboration-policy');
    return ensureFileRevisionForCurrentContent({ workspace, path: filePath, contentHash: digest(buffer), sizeBytes: buffer.length, actorType: 'system' });
  },
  async acquire(authority, filePath, revisionId, leaseSessionId) {
    const { acquireFileLock } = await import('@/app/lib/files/collaboration-policy');
    const result = await acquireFileLock({
      workspace: authority.workspace, path: filePath,
      lockedByUserId: authority.context.userId, lockedBySessionId: leaseSessionId,
      lockType: 'agent_write', baseRevisionId: revisionId,
    });
    return { id: result.lock.id, expiresAt: result.lock.expiresAt, lineageId: result.state.lineageId };
  },
  async renew(authority, filePath, lockId, leaseSessionId) {
    const { renewFileLock } = await import('@/app/lib/files/collaboration-policy');
    const result = await renewFileLock({
      workspace: authority.workspace, path: filePath, lockId,
      actorUserId: authority.context.userId, actorSessionId: leaseSessionId,
    });
    return { id: result.lock.id, expiresAt: result.lock.expiresAt, lineageId: result.state.lineageId };
  },
  async release(authority, filePath, lockId, leaseSessionId) {
    const { releaseFileLock } = await import('@/app/lib/files/collaboration-policy');
    return releaseFileLock({ workspace: authority.workspace, path: filePath, lockId,
      actorUserId: authority.context.userId, actorSessionId: leaseSessionId });
  },
  async publish(input) {
    const { writeWorkspaceFileContent } = await import('@/app/lib/files/write-service');
    return writeWorkspaceFileContent(input);
  },
};

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeDocxPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || normalized.includes('\0') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    || !normalized.toLowerCase().endsWith('.docx')) {
    throw new Error('A DOCX path must be a .docx file relative to the active workspace, without traversal.');
  }
  return normalized;
}

async function privateDirectory(segments: string[]): Promise<string> {
  let directory = await fs.realpath(resolveCanvasDataRoot());
  for (const segment of segments) {
    directory = path.join(directory, segment);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('Office recovery storage must be private directories owned by the runtime user.');
    }
  }
  return directory;
}

async function checkoutDirectory(id: string): Promise<string> {
  if (!/^office-checkout-[0-9a-f-]{36}$/u.test(id)) throw new Error('Invalid DOCX checkout ID.');
  return privateDirectory(['office', 'checkouts', id]);
}

async function writeDurable(filePath: string, bytes: Buffer): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filePath);
    const parent = await fs.open(path.dirname(filePath), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readRegular(filePath: string, maximum: number): Promise<Buffer> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(1) || before.size > BigInt(maximum)) {
      throw new Error('DOCX working data must be a regular, unlinked file within the size limit.');
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const next = await handle.read(buffer, count, buffer.length - count, null);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (count !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('The DOCX working copy changed while it was being captured. Finish the writer before committing.');
    }
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

async function persist(manifest: CheckoutManifest): Promise<void> {
  await writeDurable(path.join(await checkoutDirectory(manifest.id), 'manifest.json'), Buffer.from(JSON.stringify(manifest)));
}

async function load(id: string, context: AgentExecutionContext): Promise<CheckoutManifest> {
  const bytes = await readRegular(path.join(await checkoutDirectory(id), 'manifest.json'), 128 * 1024);
  const manifest = JSON.parse(bytes.toString()) as CheckoutManifest;
  if (manifest.version !== 1 || manifest.id !== id || manifest.userId !== context.userId
    || manifest.sessionId !== context.sessionId || manifest.agentId !== context.agentId || manifest.workspaceId !== context.workspaceId) {
    throw new Error('This DOCX checkout belongs to another user, agent, session or workspace.');
  }
  return manifest;
}

function result(manifest: CheckoutManifest): OfficeCheckoutResult {
  return {
    checkoutId: manifest.id, status: manifest.status, path: manifest.path,
    workingPath: manifest.workingPath, documentId: manifest.documentId,
    baseSha256: manifest.baseSha256, lockExpiresAt: manifest.lockExpiresAt,
    recoveryId: manifest.id, error: manifest.error, result: manifest.result,
  };
}

function errorDetails(error: unknown): { code: string; message: string } {
  const typed = error as { code?: unknown; message?: unknown; name?: string };
  return {
    code: typeof typed?.code === 'string' ? typed.code : typed?.name === 'AbortError' ? 'ABORTED' : 'DOCX_COMMIT_FAILED',
    message: typeof typed?.message === 'string' ? typed.message : 'DOCX publication failed.',
  };
}

async function workingBytes(manifest: CheckoutManifest, context: AgentExecutionContext): Promise<Buffer> {
  const temp = await prepareScratchDirectory(context);
  const expected = path.join(temp, 'office', manifest.id, 'working.docx');
  if (manifest.workingPath !== expected || await fs.realpath(path.dirname(expected)) !== path.dirname(expected)) {
    throw new Error('The DOCX working copy must stay inside its original checkout directory.');
  }
  return readRegular(expected, DOCX_PACKAGE_LIMITS.compressedBytes);
}

async function workingDirectory(context: AgentExecutionContext, id: string): Promise<string> {
  let directory = await prepareScratchDirectory(context);
  for (const segment of ['office', id]) {
    directory = path.join(directory, segment);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The DOCX working directory must not contain symbolic links.');
  }
  return directory;
}

async function capture(manifest: CheckoutManifest, context: AgentExecutionContext): Promise<Buffer> {
  const bytes = await workingBytes(manifest, context);
  const hash = digest(bytes);
  await writeDurable(path.join(await checkoutDirectory(manifest.id), `${hash}.docx`), bytes);
  if (manifest.candidateHash !== hash) manifest.idempotencyKey = `office-commit-${randomUUID()}`;
  manifest.candidateHash = hash;
  await persist(manifest);
  return bytes;
}

async function assertAuthority(dependencies: OfficeDocumentDependencies, context: AgentExecutionContext, manifest?: CheckoutManifest): Promise<Authority> {
  const authority = await dependencies.resolveAuthority(context);
  if (!authority.context.canWrite || !authority.workspace.permissions.canWrite
    || authority.context.userId !== context.userId || authority.context.sessionId !== context.sessionId
    || authority.context.workspaceId !== context.workspaceId
    || (manifest && await fs.realpath(authority.workspace.rootPath) !== manifest.workspaceRoot)) {
    throw new Error('The agent session no longer has write access to the original workspace.');
  }
  return authority;
}

export function createOfficeDocumentWorkflow(dependencies: OfficeDocumentDependencies = defaults) {
  return {
    async checkout(input: { path: string; createOnly?: boolean }, context: AgentExecutionContext, signal?: AbortSignal): Promise<OfficeCheckoutResult> {
      signal?.throwIfAborted();
      const authority = await assertAuthority(dependencies, context);
      return withWorkspaceMutationLock(context.workspaceId, async () => {
        signal?.throwIfAborted();
        const filePath = normalizeDocxPath(await dependencies.canonicalPath(authority.workspace, normalizeDocxPath(input.path)));
        const bytes = await dependencies.readSource(authority.workspace, filePath);
        if (input.createOnly ? bytes !== null : bytes === null) {
          throw new Error(input.createOnly ? 'The requested DOCX output already exists.' : 'The DOCX input does not exist. Use createOnly for a new document.');
        }
        if (bytes) await validateDocxPackage(bytes);
        const revision = bytes ? await dependencies.ensureRevision(authority.workspace, filePath, bytes) : null;
        const id = `office-checkout-${randomUUID()}`;
        // Conversation ownership and edit ownership are distinct: two
        // checkouts in the same conversation must not share a write lease.
        const lease = await dependencies.acquire(authority, filePath, revision?.id ?? null, id);
        try {
          signal?.throwIfAborted();
          const workingPath = path.join(await workingDirectory(context, id), 'working.docx');
          const manifest: CheckoutManifest = {
            version: 1, id, userId: context.userId, sessionId: context.sessionId,
            agentId: context.agentId, workspaceId: context.workspaceId,
            workspaceRoot: await fs.realpath(authority.workspace.rootPath), path: filePath,
            documentId: revision?.lineageId ?? lease.lineageId, createOnly: input.createOnly === true,
            baseSha256: bytes ? digest(bytes) : null, baseRevisionId: revision?.id ?? null,
            lockId: lease.id, lockExpiresAt: lease.expiresAt, workingPath, status: 'checked_out', createdAt: Date.now(),
          };
          if (bytes) {
            await fs.writeFile(workingPath, bytes, { flag: 'wx', mode: 0o600 });
            await writeDurable(path.join(await checkoutDirectory(id), 'original.docx'), bytes);
          }
          await persist(manifest);
          return result(manifest);
        } catch (error) {
          await dependencies.release(authority, filePath, lease.id, id).catch(() => undefined);
          throw error;
        }
      });
    },

    async commit(id: string, context: AgentExecutionContext, signal?: AbortSignal): Promise<OfficeCheckoutResult> {
      const initial = await load(id, context);
      return withWorkspaceMutationLock(initial.workspaceId, async () => {
        const manifest = await load(id, context);
        if (manifest.status === 'committed') return result(manifest);
        if (manifest.status === 'released' || manifest.status === 'conflict') {
          return result(manifest);
        }
        let authority: Authority | undefined;
        try {
          // Capture before checking current permissions or cancellation: a
          // rejected publication must still preserve the agent's work durably.
          const bytes = manifest.status === 'prepared' && manifest.candidateHash
            ? await readRegular(path.join(await checkoutDirectory(id), `${manifest.candidateHash}.docx`), DOCX_PACKAGE_LIMITS.compressedBytes)
            : await capture(manifest, context);
          signal?.throwIfAborted();
          await validateDocxPackage(bytes);
          authority = await assertAuthority(dependencies, context, manifest);
          signal?.throwIfAborted();
          manifest.status = 'prepared';
          await persist(manifest);
          manifest.result = await dependencies.publish({
            workspace: authority.workspace, fileOptions: { workspace: authority.workspace },
            actorUserId: context.userId, actorSessionId: manifest.id, actorType: 'agent',
            path: manifest.path, content: bytes, expectedSha256: manifest.baseSha256,
            baseRevisionId: manifest.baseRevisionId, lockId: manifest.lockId,
            idempotencyKey: manifest.idempotencyKey, createOnly: manifest.createOnly,
            requireExpectedRevision: !manifest.createOnly, signal,
          });
          manifest.status = 'committed';
          delete manifest.error;
          await persist(manifest);
          await dependencies.release(authority, manifest.path, manifest.lockId, manifest.id).catch(() => undefined);
          return result(manifest);
        } catch (error) {
          // A successful writer followed by a manifest fsync failure must keep
          // the durable prepared request retryable through the writer journal.
          if (manifest.result) throw error;
          const status = (error as { status?: number })?.status;
          const code = (error as { code?: string })?.code;
          const terminal = signal?.aborted || (status !== undefined && status >= 400 && status < 500)
            || code?.startsWith('FILE_LOCK_') || code?.startsWith('FILE_REVISION_');
          manifest.status = manifest.status === 'prepared' && !terminal ? 'prepared' : 'conflict';
          manifest.error = errorDetails(error);
          await persist(manifest);
          if (manifest.status === 'conflict') {
            // Cancellation/validation can happen before authority resolution.
            // Release only our exact lease if the session is still authorized.
            authority ??= await assertAuthority(dependencies, context, manifest).catch(() => undefined);
            if (authority) await dependencies.release(authority, manifest.path, manifest.lockId, manifest.id).catch(() => undefined);
          }
          return result(manifest);
        }
      });
    },

    async inspect(input: { checkoutId: string; renewLease?: boolean; restoreWorkingCopy?: boolean }, context: AgentExecutionContext, signal?: AbortSignal): Promise<OfficeCheckoutResult> {
      const initial = await load(input.checkoutId, context);
      return withWorkspaceMutationLock(initial.workspaceId, async () => {
        const manifest = await load(input.checkoutId, context);
        signal?.throwIfAborted();
        if (input.restoreWorkingCopy) {
          const filename = manifest.candidateHash ? `${manifest.candidateHash}.docx` : 'original.docx';
          const bytes = await readRegular(path.join(await checkoutDirectory(manifest.id), filename), DOCX_PACKAGE_LIMITS.compressedBytes);
          const directory = await workingDirectory(context, manifest.id);
          await writeDurable(path.join(directory, 'working.docx'), bytes);
        }
        if (input.renewLease) {
          if (!['checked_out', 'prepared'].includes(manifest.status)) throw new Error('A completed, conflicted or released DOCX checkout cannot renew its lease.');
          const authority = await assertAuthority(dependencies, context, manifest);
          const lease = await dependencies.renew(authority, manifest.path, manifest.lockId, manifest.id);
          manifest.lockExpiresAt = lease.expiresAt;
          await persist(manifest);
        }
        return result(manifest);
      });
    },

    async release(id: string, context: AgentExecutionContext): Promise<OfficeCheckoutResult> {
      const initial = await load(id, context);
      return withWorkspaceMutationLock(initial.workspaceId, async () => {
        const manifest = await load(id, context);
        if (manifest.status === 'committed' || manifest.status === 'released') return result(manifest);
        try { await capture(manifest, context); } catch (error) {
          if (!manifest.candidateHash && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const authority = await assertAuthority(dependencies, context, manifest);
        await dependencies.release(authority, manifest.path, manifest.lockId, manifest.id).catch(() => undefined);
        manifest.status = 'released';
        await persist(manifest);
        return result(manifest);
      });
    },
  };
}
