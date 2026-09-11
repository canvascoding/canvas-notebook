import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { logger } from '@/app/lib/logging';
import {
  normalizeExpectedSha256 as normalizeAgentExpectedSha256,
  WorkspaceFileRevisionError,
} from '@/app/lib/files/revision-guard';
import {
  archiveFileCollaborationPaths,
  assertFileCollaborationWriteAllowed,
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
  readFileCollaborationState,
  initializeCopiedFileCollaborationPaths,
  moveFileCollaborationPath,
} from '@/app/lib/files/collaboration-policy';
import {
  CollaborationDocumentStateError,
  resolveTextCollaborationState,
  selectInitialTextCollaborationRepresentation,
} from '@/app/lib/collaboration/document-state-service';
import { loadCollaborationStateIncludingArchived } from '@/app/lib/collaboration/persistence';
import { AgentFileEditOperationScopeError, findAgentFileEditOperation, type PersistedAgentApplyResult } from '@/app/lib/collaboration/agent-operations';
import {
  executePreparedCollaborationTextEdit,
  prepareCollaborationTextEdit,
  prepareCollaborationBlockEdit,
  readCurrentCollaborationTextSnapshot,
  type CollaborationTextSnapshot,
  type PreparedCollaborationTextEdit,
  type CollaborationAgentDocumentReference,
  type CollaborationStructureReadOptions,
} from '@/app/lib/collaboration/agent-file-edits';
import { hashAgentBlockJson } from '@/app/lib/collaboration/agent-block-structure';
import type { AgentBlockEditRequest } from '@/app/lib/collaboration/agent-block-edits';
import { applyExactTextEdits } from '@/app/lib/files/exact-text-patch';
import {
  validateTextFileContent,
  type TextFileValidationCheck,
  type TextFileValidationResult,
} from '@/app/lib/files/text-content-validation';
import {
  syncPublicSharesAfterDelete,
  syncPublicSharesAfterMove,
  syncPublicSharesAfterWrite,
} from '@/app/lib/public-sharing/public-file-shares';
import {
  withWorkspaceFileMutationLocks,
  writeFile as writeWorkspaceFile,
} from '@/app/lib/filesystem/workspace-files';
import { publishWorkspaceFileMutation, withWorkspacePathRenameEvent, type FileEventType } from '@/app/lib/filesystem/file-watcher';
import { getAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { getToolOutputRoot, getToolOutputSessionDirectory } from '@/app/lib/pi/tool-output-store';
import { getAgentDisplayName } from '@/app/lib/chat/agent-display';
import {
  assertAgentRuntimeTempQuota,
  ensureAgentRuntimeTempDir,
  resolveAgentRuntimeTempDir,
} from '@/app/lib/pi/agent-runtime-temp';
import { getStudioRoot, getStudioWorkspaceRoot } from '@/app/lib/integrations/studio-workspace';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  createExcalidrawAgentOperation,
  type ExcalidrawAgentOperation,
  type ExcalidrawAgentSceneAction,
} from '@/app/lib/excalidraw-collaboration/agent-operations';
import { loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';

const SNAPSHOT_DIR_NAME = 'agent-file-snapshots';
const MAX_DIFF_CHARS = 24_000;
const DEFAULT_MAX_SNAPSHOT_COUNT = 500;
const DEFAULT_MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;
const MAX_PATH_SUMMARY_ENTRIES = 5_000;
const MAX_AUDIT_PATH_ENTRIES = 100;
const MAX_AUDIT_ENTITY_ID_LENGTH = 500;
const agentFileAuditLogger = logger.module('AgentFileAudit');

export type AgentFileValidationCheck = TextFileValidationCheck;
export type AgentFileValidationResult = TextFileValidationResult;

export type AgentFileSnapshotMetadata = {
  version: 1;
  id: string;
  path: string;
  resolvedPath: string;
  existed: boolean;
  size: number;
  sha256: string | null;
  operation: string;
  createdAt: string;
};

export type AgentFileChangeResult = {
  path: string;
  resolvedPath: string;
  changed: boolean;
  snapshot: AgentFileSnapshotMetadata | null;
  beforeSha256: string | null;
  afterSha256: string;
  size: number;
  diff: string;
  validation: AgentFileValidationResult;
  collaboration?: {
    operationId: string;
    operationStatus: string;
    durability: string;
    reviewRequired: boolean;
    proposedSha256: string;
  };
};

/** An existing operation must be inspected instead of silently applying a new edit. */
export class AgentFileOperationOutcomeUnavailableError extends Error {
  readonly code = 'COLLABORATION_OPERATION_OUTCOME_UNAVAILABLE';
  readonly operationId: string;
  readonly operationStatus: string;
  readonly durability: string;

  constructor(readonly path: string, operation: Pick<PersistedAgentApplyResult, 'operationId' | 'operationStatus' | 'durability'>) {
    super(`Live operation ${operation.operationId} is already recorded (${operation.operationStatus}, ${operation.durability}), but its current document outcome could not be confirmed. Inspect this operation before attempting another edit.`);
    this.name = 'AgentFileOperationOutcomeUnavailableError';
    this.operationId = operation.operationId;
    this.operationStatus = operation.operationStatus;
    this.durability = operation.durability;
  }
}

export type AgentPathType = 'file' | 'directory' | 'other' | 'missing' | 'mixed';

export type AgentPathOperationEntry = {
  sourcePath: string;
  destinationPath?: string;
  sourceResolvedPath: string;
  destinationResolvedPath?: string;
  type: AgentPathType;
  changed: boolean;
  overwritten: boolean;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
  verification?: {
    destinationExists: boolean;
    destinationTypeMatches: boolean;
    sourceRemoved: boolean | null;
    contentVerified: boolean;
  };
};

export type AgentPathOperationResult = {
  operation: 'copy_path' | 'move_path' | 'delete_path';
  sourcePath: string;
  sourcePaths: string[];
  destinationPath?: string;
  sourceResolvedPath: string;
  sourceResolvedPaths: string[];
  destinationResolvedPath?: string;
  type: AgentPathType;
  changed: boolean;
  overwritten: boolean;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
  verified: boolean | null;
  entries: AgentPathOperationEntry[];
};

type PreparedPathOperationEntry = AgentPathOperationEntry & {
  sourceSha256: string | null;
};

export type AgentPatchFileInput = {
  path: string;
  expectedSha256?: string;
  edits: Array<{
    oldText: string;
    newText: string;
    expectedOccurrences?: number;
    replaceAll?: boolean;
  }>;
};

function getRuntimeCwd(): string {
  return Reflect.apply(process.cwd, process, []) as string;
}

export function getAgentDataRoot(): string {
  const configuredDataDir = process.env.DATA?.trim();
  if (!configuredDataDir || configuredDataDir === './data' || configuredDataDir === 'data') {
    return path.join(getRuntimeCwd(), 'data');
  }

  return path.isAbsolute(configuredDataDir)
    ? configuredDataDir
    : path.resolve(getRuntimeCwd(), configuredDataDir);
}

export function getAgentWorkspaceRoot(): string {
  const executionContext = getAgentExecutionContext();
  if (executionContext?.workspaceRoot) {
    return executionContext.workspaceRoot;
  }

  return path.join(getAgentDataRoot(), 'workspace');
}

function getSnapshotRoot(): string {
  return path.join(getAgentDataRoot(), 'cache', SNAPSHOT_DIR_NAME);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function getMaxSnapshotCount(): number {
  return readPositiveIntegerEnv('AGENT_FILE_SNAPSHOT_MAX_COUNT', DEFAULT_MAX_SNAPSHOT_COUNT);
}

function getMaxSnapshotBytes(): number {
  return readPositiveIntegerEnv('AGENT_FILE_SNAPSHOT_MAX_BYTES', DEFAULT_MAX_SNAPSHOT_BYTES);
}

function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function rootPathVariants(rootPath: string): string[] {
  const variants = new Set([path.resolve(rootPath)]);
  try {
    if (existsSync(rootPath)) {
      variants.add(realpathSync(rootPath));
    }
  } catch {
    // Keep the configured path variant when the root cannot be resolved synchronously.
  }
  return [...variants];
}

function isPathWithinRootVariants(candidatePath: string, rootPath: string): boolean {
  return rootPathVariants(rootPath).some((rootVariant) => isPathWithin(candidatePath, rootVariant));
}

function isPathWithinAnyRootVariant(candidatePath: string, rootPaths: string[]): boolean {
  return rootPaths.some((rootPath) => isPathWithinRootVariants(candidatePath, rootPath));
}

function getLegacyWorkspaceRoots(): string[] {
  const dataRoot = getAgentDataRoot();
  return [
    path.join(dataRoot, 'workspace'),
    '/data/workspace',
  ];
}

function getAllowedRuntimeReadRoots(executionContext: AgentExecutionContext): string[] {
  const dataRoot = getAgentDataRoot();
  const roots = [
    path.join(dataRoot, 'user-uploads'),
    '/data/user-uploads',
    path.join(getStudioRoot(), 'system'),
    '/data/studio/system',
    ...(executionContext.skillReadRoots || []),
  ];

  if (executionContext.organizationId) {
    roots.push(
      getStudioWorkspaceRoot({
        organizationId: executionContext.organizationId,
        workspaceId: executionContext.workspaceId,
      }),
      path.join(
        '/data/studio/organizations',
        executionContext.organizationId,
        'workspaces',
        executionContext.workspaceId,
      ),
    );
  }

  return roots;
}

function isAllowedRuntimeReadPath(candidatePath: string, executionContext: AgentExecutionContext): boolean {
  return isPathWithinAnyRootVariant(candidatePath, getAllowedRuntimeReadRoots(executionContext));
}

function isAgentRuntimeTempPath(candidatePath: string, executionContext: AgentExecutionContext): boolean {
  return isPathWithinRootVariants(candidatePath, resolveAgentRuntimeTempDir(executionContext));
}

async function assertAgentRuntimeTempWriteQuota(params: {
  fullPath: string;
  additionalBytes: number;
  additionalFiles: number;
  releasedBytes?: number;
  releasedFiles?: number;
}): Promise<void> {
  const executionContext = getAgentExecutionContext();
  if (!executionContext || !isAgentRuntimeTempPath(params.fullPath, executionContext)) return;
  const tempDir = await ensureAgentRuntimeTempDir(executionContext);
  await assertAgentRuntimeTempQuota(tempDir, {
    additionalBytes: params.additionalBytes,
    additionalFiles: params.additionalFiles,
    releasedBytes: params.releasedBytes,
    releasedFiles: params.releasedFiles,
  });
}

function assertContextWorkspaceReadAllowed(candidatePath: string): void {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const resolvedPath = path.resolve(candidatePath);
  if (isPathWithinRootVariants(resolvedPath, getToolOutputRoot())) {
    if (isPathWithinRootVariants(resolvedPath, getToolOutputSessionDirectory(executionContext))) return;
    throw new Error('Stored tool output belongs to another chat session.');
  }
  if (
    isPathWithinRootVariants(resolvedPath, executionContext.workspaceRoot) ||
    isAllowedRuntimeReadPath(resolvedPath, executionContext) ||
    isAgentRuntimeTempPath(resolvedPath, executionContext)
  ) {
    return;
  }

  throw new Error('Agent file access is limited to the workspace bound to this chat session or trusted runtime intake paths.');
}

async function assertPathWithinRootRealPath(
  candidatePath: string,
  rootPath: string,
  errorMessage: string,
): Promise<void> {
  const rootRealPath = await resolveWorkspaceRootRealPath(rootPath);
  const resolvedPath = path.resolve(candidatePath);
  try {
    const realPath = await fs.realpath(resolvedPath);
    if (!isPathWithin(realPath, rootRealPath)) {
      throw new Error(errorMessage);
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }

    const realParent = await resolveNearestExistingParentPath(resolvedPath);
    if (!isPathWithin(realParent, rootRealPath)) {
      throw new Error(errorMessage);
    }
  }
}

async function assertContextWorkspaceMutationAllowed(
  candidatePath: string,
  permission: 'write' | 'delete',
): Promise<void> {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;

  const workspaceRoot = path.resolve(executionContext.workspaceRoot);
  const resolvedPath = path.resolve(candidatePath);
  if (isPathWithinRootVariants(resolvedPath, getToolOutputRoot())) {
    throw new Error('Stored tool output is read-only.');
  }
  const runtimeTempRoot = resolveAgentRuntimeTempDir(executionContext);
  if (isPathWithin(resolvedPath, runtimeTempRoot)) {
    await ensureAgentRuntimeTempDir(executionContext);
    await assertPathWithinRootRealPath(
      resolvedPath,
      runtimeTempRoot,
      'Agent runtime temp mutations are limited to this session temporary directory.',
    );
    return;
  }

  if (!isPathWithin(resolvedPath, workspaceRoot)) {
    throw new Error('Agent file mutations are limited to the workspace bound to this chat session.');
  }

  if (permission === 'write' && !executionContext.canWrite) {
    throw new Error('Agent file writes are disabled for the active workspace.');
  }
  if (permission === 'delete' && !executionContext.canDelete) {
    throw new Error('Agent file deletes are disabled for the active workspace.');
  }

  await assertPathWithinRootRealPath(
    resolvedPath,
    workspaceRoot,
    'Agent file mutations are limited to the workspace bound to this chat session.',
  );
}

function getProtectedAgentPaths(): string[] {
  const dataRoot = getAgentDataRoot();
  return [
    path.join(dataRoot, 'secrets'),
    path.join(dataRoot, 'cache', SNAPSHOT_DIR_NAME),
    '/data/secrets',
    '/data/cache/agent-file-snapshots',
    '/proc',
    '/run/secrets',
    '/sys/firmware',
  ];
}

export function isProtectedAgentPath(candidatePath: string): boolean {
  return getProtectedAgentPaths().some((protectedPath) => isPathWithin(candidatePath, protectedPath));
}

export async function assertAgentPathAllowed(candidatePath: string): Promise<void> {
  assertContextWorkspaceReadAllowed(candidatePath);

  if (isProtectedAgentPath(candidatePath)) {
    throw new Error('Access to this path is restricted for security reasons.');
  }

  try {
    const realPath = await fs.realpath(candidatePath);
    assertContextWorkspaceReadAllowed(realPath);
    if (isProtectedAgentPath(realPath)) {
      throw new Error('Access to this path is restricted for security reasons.');
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function resolveNearestExistingParentPath(candidatePath: string): Promise<string> {
  let current = path.dirname(path.resolve(candidatePath));

  while (current !== path.dirname(current)) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        current = path.dirname(current);
        continue;
      }
      throw error;
    }
  }

  throw new Error('Unable to resolve a writable parent directory.');
}

async function resolveWorkspaceRootRealPath(workspaceRoot: string): Promise<string> {
  try {
    return await fs.realpath(workspaceRoot);
  } catch (error) {
    if (isEnoent(error)) {
      return path.resolve(workspaceRoot);
    }
    throw error;
  }
}

async function assertNearestWritableParentAllowed(candidatePath: string): Promise<void> {
  const realParent = await resolveNearestExistingParentPath(candidatePath);
  if (isProtectedAgentPath(realParent)) {
    throw new Error('Access to this path is restricted for security reasons.');
  }
}

export async function assertAgentWritablePathAllowed(candidatePath: string): Promise<void> {
  await assertContextWorkspaceMutationAllowed(candidatePath, 'write');
  await assertAgentPathAllowed(candidatePath);
  await assertNearestWritableParentAllowed(candidatePath);
}

export async function assertAgentDeletablePathAllowed(candidatePath: string): Promise<void> {
  await assertContextWorkspaceMutationAllowed(candidatePath, 'delete');
  await assertAgentPathAllowed(candidatePath);
  await assertNearestWritableParentAllowed(candidatePath);
}

function assertValidAgentPathInput(filePath: string): void {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Agent file path must be a non-empty string.');
  }
  if (filePath.includes('\0')) {
    throw new Error('Agent file path contains an invalid null byte.');
  }
}

function relativePathWithin(candidatePath: string, basePath: string): string | null {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedBase = path.resolve(basePath);
  const relativePath = path.relative(normalizedBase, normalizedCandidate);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return normalizedCandidate === normalizedBase ? '.' : null;
  }
  return relativePath;
}

function auditPathReference(fullPath: string, executionContext: AgentExecutionContext | null): string {
  const resolvedPath = path.resolve(fullPath);
  if (!executionContext?.workspaceRoot) {
    return resolvedPath;
  }

  const workspaceRelativePath = relativePathWithin(resolvedPath, executionContext.workspaceRoot);
  return workspaceRelativePath ?? resolvedPath;
}

function auditResolvedPathReference(value: string, executionContext: AgentExecutionContext | null): string {
  return path.isAbsolute(value) ? auditPathReference(value, executionContext) : value;
}

function auditWorkspaceMetadata(executionContext: AgentExecutionContext | null) {
  if (!executionContext) return null;
  return {
    workspaceId: executionContext.workspaceId,
    workspaceType: executionContext.workspaceType,
    workspaceName: executionContext.workspaceName,
    workspaceRootRelativePath: executionContext.workspaceRootRelativePath,
    legacy: executionContext.legacy,
  };
}

function activePathRequiresRevisionGuard(filePath: string): boolean {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return false;
  const sharedWorkspace = executionContext.workspaceType === 'organization' ||
    executionContext.workspaceType === 'team' ||
    executionContext.workspaceType === 'project';
  if (!sharedWorkspace) return false;

  const resolvedPath = resolveAgentPath(filePath);
  return isPathWithinRootVariants(resolvedPath, executionContext.workspaceRoot);
}

export function getAgentWorkspaceContext(): WorkspaceContext | null {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return null;

  return {
    workspaceId: executionContext.workspaceId,
    workspaceType: executionContext.workspaceType,
    rootPath: executionContext.workspaceRoot,
    rootRelativePath: executionContext.workspaceRootRelativePath ?? undefined,
    displayName: executionContext.workspaceName ?? undefined,
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    permissions: {
      canRead: true,
      canWrite: executionContext.canWrite,
      canDelete: executionContext.canDelete,
      canCreatePublicLinks: executionContext.canShare,
      canManageWorkspace: false,
      canRunAgent: true,
    },
    legacy: executionContext.legacy,
  };
}

function workspaceRelativeAgentPath(workspace: WorkspaceContext, fullPath: string): string {
  return path.relative(workspace.rootPath, fullPath).split(path.sep).join('/');
}

function workspaceRelativeAgentPathIfWithin(workspace: WorkspaceContext, fullPath: string): string | null {
  return isPathWithin(fullPath, workspace.rootPath)
    ? workspaceRelativeAgentPath(workspace, fullPath)
    : null;
}

async function collaborativeAgentFileContext(fullPath: string, initialBuffer?: Buffer): Promise<{
  workspace: WorkspaceContext;
  executionContext: AgentExecutionContext;
  relativePath: string;
  documentId: string;
} | null> {
  const workspace = getAgentWorkspaceContext();
  const executionContext = getAgentExecutionContext();
  if (!workspace || !executionContext || !isPathWithin(fullPath, workspace.rootPath)) return null;
  const relativePath = workspaceRelativeAgentPath(workspace, fullPath);
  const eligibility = await readFileCollaborationState({ workspace, path: relativePath });
  if (!eligibility.crdtCapable) return null;
  await assertExistingAgentFile(fullPath, relativePath);
  const document = eligibility.document;
  if (document) {
    const existing = await loadCollaborationStateIncludingArchived(document.id);
    if (existing) {
      if (existing.status !== 'active') {
        throw new CollaborationDocumentStateError('The collaboration document lifecycle is archived or stale.', 'COLLABORATION_LIFECYCLE_STALE');
      }
      if (document.status !== 'active' || document.provider !== 'yjs'
        || document.workspaceId !== workspace.workspaceId || document.path !== relativePath
        || existing.workspaceId !== workspace.workspaceId || existing.path !== relativePath
        || existing.organizationId !== (workspace.organizationId ?? null)) {
        throw new CollaborationDocumentStateError('The persisted collaboration state does not match the active workspace file.', 'COLLABORATION_DOCUMENT_MISMATCH');
      }
      // The file is only a projection once Yjs exists. Reading its bytes or
      // registering a revision here would make live tools depend on export.
      return { workspace, executionContext, relativePath, documentId: document.id };
    }
  }
  const sourceBuffer = initialBuffer ?? await fs.readFile(fullPath);
  const initialContent = sourceBuffer.toString('utf8');
  await ensureFileRevisionForCurrentContent({
    workspace,
    path: relativePath,
    contentHash: sha256Buffer(sourceBuffer),
    sizeBytes: sourceBuffer.length,
    actorUserId: executionContext.userId,
    actorType: 'agent',
    sourceSessionId: executionContext.sessionId,
  });
  const collaboration = await getFileCollaborationState({
    workspace,
    path: relativePath,
    ensureDocument: true,
  });
  if (!collaboration.document) return null;
  await resolveTextCollaborationState({
    document: collaboration.document,
    workspace,
    path: relativePath,
    initialRepresentation: selectInitialTextCollaborationRepresentation(relativePath, initialContent),
    initialContent,
  });
  return {
    workspace,
    executionContext,
    relativePath,
    documentId: collaboration.document.id,
  };
}

async function collaborativeAgentExcalidrawContext(fullPath: string): Promise<{
  workspace: WorkspaceContext;
  executionContext: AgentExecutionContext;
  relativePath: string;
  documentId: string;
} | null> {
  const workspace = getAgentWorkspaceContext();
  const executionContext = getAgentExecutionContext();
  if (!workspace || !executionContext || !isPathWithin(fullPath, workspace.rootPath)) return null;
  const relativePath = workspaceRelativeAgentPath(workspace, fullPath);
  const collaboration = await getFileCollaborationState({
    workspace,
    path: relativePath,
    ensureDocument: false,
  });
  if (!collaboration.sceneCapable || collaboration.document?.provider !== 'excalidraw') return null;
  return {
    workspace,
    executionContext,
    relativePath,
    documentId: collaboration.document.id,
  };
}

function collaborationAgentIdentity(executionContext: AgentExecutionContext) {
  return {
    initiatedByUserId: executionContext.userId,
    actorId: executionContext.agentId || DEFAULT_MANAGED_AGENT_ID,
    actorDisplayName: getAgentDisplayName(executionContext.agentId),
    actorSessionId: executionContext.sessionId,
  };
}

export async function readAgentCollaborativeTextFile(
  fullPath: string,
  initialBuffer?: Buffer,
  options: CollaborationStructureReadOptions = {},
): Promise<CollaborationTextSnapshot | null> {
  await assertAgentPathAllowed(fullPath);
  const collaboration = await collaborativeAgentFileContext(fullPath, initialBuffer);
  if (!collaboration) return null;
  return readCurrentCollaborationTextSnapshot({
    documentId: collaboration.documentId,
    workspace: collaboration.workspace,
    ...options,
  });
}

export async function readAgentCollaborativeExcalidrawFile(fullPath: string): Promise<{
  content: string;
  canonicalHash: string;
  documentId: string;
  sceneSequence: number;
  lifecycleGeneration: number;
} | null> {
  const collaboration = await collaborativeAgentExcalidrawContext(fullPath);
  if (!collaboration) return null;
  const state = await loadExcalidrawScene(collaboration.documentId);
  if (!state || state.workspaceId !== collaboration.workspace.workspaceId || state.status !== 'active') return null;
  return {
    content: JSON.stringify({
      type: 'excalidraw-live-scene',
      version: 1,
      documentId: state.documentId,
      sceneSequence: state.sceneSequence,
      lifecycleGeneration: state.lifecycleGeneration,
      canonicalHash: state.canonicalHash,
      elements: state.elements,
      appState: state.appState,
      assets: state.assets,
    }, null, 2),
    canonicalHash: state.canonicalHash,
    documentId: state.documentId,
    sceneSequence: state.sceneSequence,
    lifecycleGeneration: state.lifecycleGeneration,
  };
}

export async function editAgentExcalidrawScene(params: {
  path: string;
  observedSceneSequence: number;
  actions: ExcalidrawAgentSceneAction[];
  idempotencyKey: string;
}): Promise<ExcalidrawAgentOperation> {
  const fullPath = resolveAgentPath(params.path);
  await assertAgentPathAllowed(fullPath);
  const collaboration = await collaborativeAgentExcalidrawContext(fullPath);
  if (!collaboration) {
    throw new Error('edit_excalidraw_scene requires an active shared .excalidraw document. Read the file first to obtain its live scene sequence and element versions.');
  }
  if (!collaboration.workspace.permissions.canWrite || !collaboration.executionContext.canWrite) {
    throw new Error('Workspace write access is required for Excalidraw scene edits.');
  }
  return createExcalidrawAgentOperation({
    workspace: collaboration.workspace,
    documentId: collaboration.documentId,
    observedSceneSequence: params.observedSceneSequence,
    actions: params.actions,
    initiatedByUserId: collaboration.executionContext.userId,
    actorId: collaboration.executionContext.agentId || DEFAULT_MANAGED_AGENT_ID,
    idempotencyKey: params.idempotencyKey,
  });
}

function publishAgentWorkspaceMutation(fullPath: string, type: FileEventType): void {
  const workspace = getAgentWorkspaceContext();
  if (!workspace) return;

  const relativePath = relativePathWithin(fullPath, workspace.rootPath);
  if (!relativePath) return;

  publishWorkspaceFileMutation({ workspace, type, relativePath });
}

function assertAgentSharedWorkspaceRevision(params: {
  operation: string;
  path: string;
  beforeExisted: boolean;
  expectedSha256?: string | null;
}): void {
  if (!params.beforeExisted || !activePathRequiresRevisionGuard(params.path)) return;
  if (normalizeAgentExpectedSha256(params.expectedSha256)) return;

  throw new WorkspaceFileRevisionError({
    code: 'FILE_REVISION_REQUIRED',
    status: 428,
    path: params.path,
    expectedSha256: null,
    currentSha256: null,
    message: `Refusing to ${params.operation} ${params.path}: existing shared workspace files require expectedSha256. Read the file first and retry with the current SHA-256 hash.`,
  });
}

function throwAgentFileRevisionConflict(params: {
  operation: string;
  path: string;
  expectedSha256: string;
  currentSha256: string | null;
}): never {
  throw new WorkspaceFileRevisionError({
    code: 'FILE_REVISION_CONFLICT',
    status: 409,
    path: params.path,
    expectedSha256: params.expectedSha256,
    currentSha256: params.currentSha256,
    message: `Refusing to ${params.operation} ${params.path}: expectedSha256 did not match the current file hash. Read the file again before retrying.`,
  });
}

async function recordAgentFileChangeAudit(result: AgentFileChangeResult, operation: string): Promise<void> {
  if (!result.changed) return;

  const executionContext = getAgentExecutionContext();
  if (!executionContext) {
    agentFileAuditLogger.warn('Skipping agent file audit without execution context', {
      operation,
      path: result.path,
    });
    return;
  }

  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'file',
    entityType: 'workspace_file',
    entityId: result.path,
    action: `agent_file.${operation}`,
    status: 'success',
    summary: `Agent file ${operation} changed ${result.path}.`,
    metadata: {
      path: result.path,
      resolvedPath: auditPathReference(result.resolvedPath, executionContext),
      workspace: auditWorkspaceMetadata(executionContext),
      revision: {
        snapshotId: result.snapshot?.id ?? null,
        snapshotOperation: result.snapshot?.operation ?? null,
        snapshotExisted: result.snapshot?.existed ?? null,
        beforeSha256: result.beforeSha256,
        afterSha256: result.afterSha256,
      },
      size: result.size,
      validation: {
        ok: result.validation.ok,
        checks: result.validation.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          message: check.message,
        })),
      },
    },
    inputHash: result.beforeSha256,
    outputHash: result.afterSha256,
    artifactRef: result.snapshot ? `agent-file-snapshot:${result.snapshot.id}` : null,
  });
}

function summarizeAuditPathEntries(entries: AgentPathOperationEntry[], executionContext: AgentExecutionContext | null) {
  return entries.slice(0, MAX_AUDIT_PATH_ENTRIES).map((entry) => ({
    sourcePath: entry.sourcePath,
    destinationPath: entry.destinationPath,
    sourceResolvedPath: auditPathReference(entry.sourceResolvedPath, executionContext),
    destinationResolvedPath: entry.destinationResolvedPath
      ? auditPathReference(entry.destinationResolvedPath, executionContext)
      : undefined,
    type: entry.type,
    changed: entry.changed,
    overwritten: entry.overwritten,
    bytes: entry.bytes,
    files: entry.files,
    directories: entry.directories,
    truncated: entry.truncated,
  }));
}

function truncateAuditEntityId(entityId: string): string {
  if (entityId.length <= MAX_AUDIT_ENTITY_ID_LENGTH) return entityId;
  return `${entityId.slice(0, MAX_AUDIT_ENTITY_ID_LENGTH - 3)}...`;
}

function pathOperationEntityId(result: AgentPathOperationResult): string {
  const paths = result.operation === 'delete_path'
    ? result.entries.map((entry) => entry.sourcePath)
    : result.entries.map((entry) => entry.destinationPath ?? entry.sourcePath);
  return truncateAuditEntityId(paths.join(', '));
}

async function recordAgentPathOperationAudit(result: AgentPathOperationResult): Promise<void> {
  if (!result.changed) return;

  const executionContext = getAgentExecutionContext();
  if (!executionContext) {
    agentFileAuditLogger.warn('Skipping agent path audit without execution context', {
      operation: result.operation,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
    });
    return;
  }

  await recordAuditEvent({
    organizationId: executionContext.organizationId,
    customerId: executionContext.customerId,
    projectId: executionContext.projectId,
    workspaceId: executionContext.workspaceId,
    userId: executionContext.userId,
    sessionId: executionContext.sessionId,
    agentId: executionContext.agentId,
    source: 'agent_tool',
    eventType: 'file',
    entityType: 'workspace_path',
    entityId: pathOperationEntityId(result),
    action: `agent_path.${result.operation}`,
    status: 'success',
    summary: `Agent path ${result.operation} changed ${result.destinationPath ?? result.sourcePath}.`,
    metadata: {
      operation: result.operation,
      sourcePath: result.sourcePath,
      sourcePaths: result.sourcePaths,
      destinationPath: result.destinationPath,
      sourceResolvedPath: auditResolvedPathReference(result.sourceResolvedPath, executionContext),
      sourceResolvedPaths: result.sourceResolvedPaths.map((sourcePath) => auditPathReference(sourcePath, executionContext)),
      destinationResolvedPath: result.destinationResolvedPath
        ? auditPathReference(result.destinationResolvedPath, executionContext)
        : null,
      workspace: auditWorkspaceMetadata(executionContext),
      type: result.type,
      overwritten: result.overwritten,
      bytes: result.bytes,
      files: result.files,
      directories: result.directories,
      truncated: result.truncated,
      entries: summarizeAuditPathEntries(result.entries, executionContext),
      entriesTruncated: result.entries.length > MAX_AUDIT_PATH_ENTRIES,
      totalEntries: result.entries.length,
    },
  });
}

function resolveLegacyWorkspaceAlias(filePath: string): string | null {
  const workspaceRoot = getAgentWorkspaceRoot();
  for (const legacyRoot of getLegacyWorkspaceRoots()) {
    const relativePath = relativePathWithin(filePath, legacyRoot);
    if (relativePath) {
      return relativePath === '.'
        ? workspaceRoot
        : path.join(workspaceRoot, relativePath);
    }
  }
  return null;
}

export function resolveAgentPath(filePath: string): string {
  assertValidAgentPathInput(filePath);
  const trimmedPath = filePath.trim();
  if (trimmedPath.startsWith('tool-output://')) {
    throw new Error('Stored tool output is read-only; open its reference with read or rg.');
  }
  if (!path.isAbsolute(trimmedPath)) {
    return path.join(getAgentWorkspaceRoot(), trimmedPath);
  }

  return resolveLegacyWorkspaceAlias(trimmedPath) ?? path.resolve(trimmedPath);
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.split('\n');
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...`;
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export function createUnifiedDiff(
  before: string,
  after: string,
  beforeLabel: string,
  afterLabel: string,
): string {
  if (before === after) {
    return '(no textual changes)';
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;

  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const beforeContextEnd = Math.min(beforeLines.length - 1, beforeSuffix + 3);
  const afterContextEnd = Math.min(afterLines.length - 1, afterSuffix + 3);
  const lines = [
    `--- ${beforeLabel}`,
    `+++ ${afterLabel}`,
    `@@ -${contextStart + 1},${Math.max(0, beforeContextEnd - contextStart + 1)} +${contextStart + 1},${Math.max(0, afterContextEnd - contextStart + 1)} @@`,
  ];

  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${beforeLines[index]}`);
  }
  for (let index = prefix; index <= beforeSuffix; index += 1) {
    lines.push(`-${beforeLines[index]}`);
  }
  for (let index = prefix; index <= afterSuffix; index += 1) {
    lines.push(`+${afterLines[index]}`);
  }
  for (let index = beforeSuffix + 1; index <= beforeContextEnd; index += 1) {
    if (index >= prefix && beforeLines[index] !== undefined) {
      lines.push(` ${beforeLines[index]}`);
    }
  }

  return truncateDiff(lines.join('\n'));
}

export function validateAgentFileContent(filePath: string, content: string): AgentFileValidationResult {
  return validateTextFileContent(filePath, content);
}

async function ensureSnapshotRoot(): Promise<string> {
  const root = getSnapshotRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

function snapshotMetadataPath(snapshotId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(snapshotId)) {
    throw new Error('Invalid snapshot ID.');
  }
  return path.join(getSnapshotRoot(), `${snapshotId}.json`);
}

function snapshotContentPath(snapshotId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(snapshotId)) {
    throw new Error('Invalid snapshot ID.');
  }
  return path.join(getSnapshotRoot(), `${snapshotId}.bin`);
}

async function readSnapshotMetadata(snapshotId: string): Promise<AgentFileSnapshotMetadata> {
  const raw = await fs.readFile(snapshotMetadataPath(snapshotId), 'utf8');
  return JSON.parse(raw) as AgentFileSnapshotMetadata;
}

async function listAllSnapshotMetadata(): Promise<AgentFileSnapshotMetadata[]> {
  const root = getSnapshotRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const metadata = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.json'))
      .map(async (entry) => {
        try {
          const raw = await fs.readFile(path.join(root, entry), 'utf8');
          return JSON.parse(raw) as AgentFileSnapshotMetadata;
        } catch {
          return null;
        }
      }),
  );

  return metadata
    .filter((entry): entry is AgentFileSnapshotMetadata => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function pruneSnapshots(): Promise<void> {
  const snapshots = await listAllSnapshotMetadata();
  const maxCount = getMaxSnapshotCount();
  const maxBytes = getMaxSnapshotBytes();
  const stale = new Set<AgentFileSnapshotMetadata>(snapshots.slice(maxCount));
  let runningBytes = 0;

  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (!snapshot) continue;
    if (stale.has(snapshot)) continue;
    if (index === 0) {
      runningBytes += snapshot.size;
      continue;
    }
    if (runningBytes + snapshot.size > maxBytes) {
      stale.add(snapshot);
      continue;
    }
    runningBytes += snapshot.size;
  }

  await Promise.allSettled(
    [...stale].map(async (snapshot) => {
      await fs.rm(snapshotMetadataPath(snapshot.id), { force: true });
      await fs.rm(snapshotContentPath(snapshot.id), { force: true });
    }),
  );
}

async function createSnapshotFromBuffer(params: {
  inputPath: string;
  fullPath: string;
  existed: boolean;
  beforeBuffer: Buffer | null;
  operation: string;
}): Promise<AgentFileSnapshotMetadata> {
  const root = await ensureSnapshotRoot();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const metadata: AgentFileSnapshotMetadata = {
    version: 1,
    id,
    path: params.inputPath,
    resolvedPath: path.resolve(params.fullPath),
    existed: params.existed,
    size: params.beforeBuffer?.length ?? 0,
    sha256: params.beforeBuffer ? sha256Buffer(params.beforeBuffer) : null,
    operation: params.operation,
    createdAt: new Date().toISOString(),
  };

  if (params.beforeBuffer) {
    await fs.writeFile(path.join(root, `${id}.bin`), params.beforeBuffer, { mode: 0o600 });
  }
  await fs.writeFile(path.join(root, `${id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await pruneSnapshots().catch(() => undefined);
  return metadata;
}

async function assertExistingAgentFile(fullPath: string, inputPath: string): Promise<void> {
  const stats = await fs.stat(fullPath).catch((error: unknown) => {
    if (isEnoent(error)) throw new Error(`File does not exist: ${inputPath}`);
    throw error;
  });
  if (!stats.isFile()) throw new Error(`Path is not a file: ${inputPath}`);
}

async function readExistingFile(fullPath: string): Promise<{ existed: boolean; buffer: Buffer | null }> {
  try {
    return { existed: true, buffer: await fs.readFile(fullPath) };
  } catch (error) {
    if (isEnoent(error)) {
      return { existed: false, buffer: null };
    }
    throw error;
  }
}

type AgentPathMutationState = {
  inputPath: string;
  fullPath: string;
  existed: boolean;
  type: AgentPathType;
  sha256: string | null;
};

async function sha256AgentDirectory(fullPath: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (currentPath: string, relativePath: string): Promise<void> => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const entryFullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${entryRelativePath}\0`);
        await visit(entryFullPath, entryRelativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${entryRelativePath}\0`);
        hash.update(await fs.readFile(entryFullPath));
      } else {
        const stats = await fs.lstat(entryFullPath);
        hash.update(`other\0${entryRelativePath}\0${stats.size}\0`);
      }
    }
  };

  await visit(fullPath, '');
  return hash.digest('hex');
}

async function captureAgentPathMutationState(inputPath: string, fullPath: string): Promise<AgentPathMutationState> {
  try {
    const stats = await fs.stat(fullPath);
    const type = getPathType(stats);
    return {
      inputPath,
      fullPath,
      existed: true,
      type,
      sha256: type === 'file'
        ? sha256Buffer(await fs.readFile(fullPath))
        : type === 'directory'
          ? await sha256AgentDirectory(fullPath)
          : null,
    };
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { inputPath, fullPath, existed: false, type: 'missing', sha256: null };
  }
}

async function assertAgentPathMutationStatesUnchanged(
  states: readonly AgentPathMutationState[],
  operation: string,
): Promise<void> {
  for (const state of states) {
    const current = await captureAgentPathMutationState(state.inputPath, state.fullPath);
    if (
      current.existed === state.existed
      && current.type === state.type
      && current.sha256 === state.sha256
    ) {
      continue;
    }
    throw new WorkspaceFileRevisionError({
      code: 'FILE_REVISION_CONFLICT',
      status: 409,
      path: state.inputPath,
      expectedSha256: state.sha256,
      currentSha256: current.sha256,
      message: `Refusing to ${operation} ${state.inputPath}: the path changed after it was read. Read it again before retrying.`,
    });
  }
}

async function withAgentWorkspaceMutationLocks<T>(
  fullPaths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const workspace = getAgentWorkspaceContext();
  if (!workspace) return operation();

  const workspacePaths = fullPaths
    .filter((fullPath) => isPathWithin(fullPath, workspace.rootPath))
    .map((fullPath) => workspaceRelativeAgentPath(workspace, fullPath));
  if (workspacePaths.length === 0) return operation();

  return withWorkspaceFileMutationLocks(workspacePaths, { workspace }, operation);
}

async function assertAgentFileUnchangedBeforeReplace(params: {
  inputPath: string;
  fullPath: string;
  beforeExisted: boolean;
  beforeBuffer: Buffer | null;
  operation: string;
}): Promise<void> {
  const current = await readExistingFile(params.fullPath);
  const beforeSha256 = params.beforeBuffer ? sha256Buffer(params.beforeBuffer) : null;
  const currentSha256 = current.buffer ? sha256Buffer(current.buffer) : null;
  if (current.existed === params.beforeExisted && currentSha256 === beforeSha256) return;

  throw new WorkspaceFileRevisionError({
    code: 'FILE_REVISION_CONFLICT',
    status: 409,
    path: params.inputPath,
    expectedSha256: beforeSha256,
    currentSha256,
    message: `Refusing to ${params.operation} ${params.inputPath}: the file changed after it was read. Read the file again before retrying.`,
  });
}

async function commitTextChange(params: {
  inputPath: string;
  fullPath: string;
  beforeBuffer: Buffer | null;
  beforeExisted: boolean;
  nextContent: string;
  operation: string;
  enforceValidation: boolean;
}): Promise<AgentFileChangeResult> {
  const beforeContent = params.beforeBuffer?.toString('utf8') ?? '';
  const beforeSha256 = params.beforeBuffer ? sha256Buffer(params.beforeBuffer) : null;
  const validation = validateAgentFileContent(params.inputPath, params.nextContent);
  if (params.enforceValidation && !validation.ok) {
    throw new Error(`Refusing to write ${params.inputPath}: validation failed. ${validation.checks.map((check) => check.message).join(' ')}`);
  }

  if (params.beforeExisted && beforeContent === params.nextContent) {
    return {
      path: params.inputPath,
      resolvedPath: params.fullPath,
      changed: false,
      snapshot: null,
      beforeSha256,
      afterSha256: beforeSha256 ?? sha256Text(params.nextContent),
      size: Buffer.byteLength(params.nextContent, 'utf8'),
      diff: '(no textual changes)',
      validation,
    };
  }

  await assertAgentWritablePathAllowed(params.fullPath);
  await fs.mkdir(path.dirname(params.fullPath), { recursive: true });
  const executionContext = getAgentExecutionContext();
  const workspaceContext = getAgentWorkspaceContext();
  const workspacePath = workspaceContext && isPathWithin(params.fullPath, workspaceContext.rootPath)
    ? workspaceRelativeAgentPath(workspaceContext, params.fullPath)
    : null;
  const runtimeTempPath = executionContext
    ? isAgentRuntimeTempPath(params.fullPath, executionContext)
    : false;
  const baseRevision = workspaceContext && workspacePath && params.beforeBuffer
    ? await ensureFileRevisionForCurrentContent({
        workspace: workspaceContext,
        path: workspacePath,
        contentHash: sha256Buffer(params.beforeBuffer),
        sizeBytes: params.beforeBuffer.length,
        actorType: 'system',
      })
    : null;

  if (workspaceContext && workspacePath) {
    await assertFileCollaborationWriteAllowed({
      workspace: workspaceContext,
      path: workspacePath,
      actorUserId: executionContext?.userId ?? null,
      actorSessionId: executionContext?.sessionId ?? null,
      actorType: 'agent',
      baseRevisionId: baseRevision?.id ?? null,
    });
  }

  const snapshot = runtimeTempPath
    ? null
    : await createSnapshotFromBuffer({
        inputPath: workspacePath ?? params.inputPath,
        fullPath: params.fullPath,
        existed: params.beforeExisted,
        beforeBuffer: params.beforeBuffer,
        operation: params.operation,
      });

  if (workspaceContext && workspacePath) {
    await writeWorkspaceFile(workspacePath, params.nextContent, { workspace: workspaceContext }, async () => {
      await assertAgentFileUnchangedBeforeReplace({
        inputPath: params.inputPath,
        fullPath: params.fullPath,
        beforeExisted: params.beforeExisted,
        beforeBuffer: params.beforeBuffer,
        operation: params.operation,
      });
    });
  } else {
    await assertAgentRuntimeTempWriteQuota({
      fullPath: params.fullPath,
      additionalBytes: Buffer.byteLength(params.nextContent, 'utf8'),
      additionalFiles: 1,
      releasedBytes: params.beforeBuffer?.length ?? 0,
      releasedFiles: params.beforeExisted ? 1 : 0,
    });
    await fs.writeFile(params.fullPath, params.nextContent, 'utf8');
  }
  const readBack = await fs.readFile(params.fullPath);
  const readBackText = readBack.toString('utf8');
  if (readBackText !== params.nextContent) {
    throw new Error(`Read-after-write verification failed for ${params.inputPath}.`);
  }
  if (workspaceContext && workspacePath) {
    await ensureFileRevisionForCurrentContent({
      workspace: workspaceContext,
      path: workspacePath,
      contentHash: sha256Buffer(readBack),
      sizeBytes: readBack.length,
      actorUserId: executionContext?.userId ?? null,
      actorType: 'agent',
      sourceSessionId: executionContext?.sessionId ?? null,
      baseRevisionId: baseRevision?.id ?? null,
    });
  }
  if (!runtimeTempPath) {
    await syncPublicSharesAfterWrite([params.fullPath]);
  }

  const result: AgentFileChangeResult = {
    path: params.inputPath,
    resolvedPath: params.fullPath,
    changed: true,
    snapshot,
    beforeSha256,
    afterSha256: sha256Buffer(readBack),
    size: readBack.length,
    diff: createUnifiedDiff(beforeContent, readBackText, `${params.inputPath} (before)`, `${params.inputPath} (after)`),
    validation,
  };
  publishAgentWorkspaceMutation(params.fullPath, params.beforeExisted ? 'change' : 'add');
  await recordAgentFileChangeAudit(result, params.operation);
  return result;
}

export async function writeAgentTextFile(params: {
  path: string;
  content: string;
  expectedSha256?: string;
  operation?: string;
}): Promise<AgentFileChangeResult> {
  const fullPath = resolveAgentPath(params.path);
  await assertAgentWritablePathAllowed(fullPath);
  const before = await readExistingFile(fullPath);
  const beforeSha256 = before.buffer ? sha256Buffer(before.buffer) : null;
  const expectedSha256 = normalizeAgentExpectedSha256(params.expectedSha256);
  assertAgentSharedWorkspaceRevision({
    operation: params.operation ?? 'write',
    path: params.path,
    beforeExisted: before.existed,
    expectedSha256,
  });

  if (expectedSha256 && beforeSha256 !== expectedSha256) {
    throwAgentFileRevisionConflict({ operation: 'write', path: params.path, expectedSha256, currentSha256: beforeSha256 });
  }

  return commitTextChange({
    inputPath: params.path,
    fullPath,
    beforeBuffer: before.buffer,
    beforeExisted: before.existed,
    nextContent: params.content,
    operation: params.operation ?? 'write',
    enforceValidation: true,
  });
}

export async function writeAgentBinaryFile(params: {
  path: string;
  content: Buffer;
  expectedSha256?: string;
  operation?: string;
  overwrite?: boolean;
}): Promise<AgentFileChangeResult> {
  if (!Buffer.isBuffer(params.content)) {
    throw new Error('Binary file content must be a Buffer.');
  }
  if (params.content.length === 0) {
    throw new Error('Refusing to write an empty binary file.');
  }

  const fullPath = resolveAgentPath(params.path);
  await assertAgentWritablePathAllowed(fullPath);
  const before = await readExistingFile(fullPath);
  const beforeSha256 = before.buffer ? sha256Buffer(before.buffer) : null;
  const expectedSha256 = normalizeAgentExpectedSha256(params.expectedSha256);
  const operation = params.operation ?? 'write_binary';

  if (before.existed && !params.overwrite) {
    throw new Error(`Refusing to overwrite existing file without overwrite: true: ${params.path}`);
  }
  if (before.existed && !expectedSha256) {
    throw new Error(
      `Refusing to overwrite ${params.path} without expectedSha256. Read the file first and retry with the current SHA-256 hash.`,
    );
  }
  assertAgentSharedWorkspaceRevision({
    operation,
    path: params.path,
    beforeExisted: before.existed,
    expectedSha256,
  });
  if (expectedSha256 && beforeSha256 !== expectedSha256) {
    throwAgentFileRevisionConflict({ operation, path: params.path, expectedSha256, currentSha256: beforeSha256 });
  }

  const afterSha256 = sha256Buffer(params.content);
  const validation: AgentFileValidationResult = {
    ok: true,
    checks: [{
      name: 'binary-read-after-write',
      ok: true,
      message: 'Binary output will be verified by size and SHA-256 after writing.',
    }],
  };
  if (before.buffer && beforeSha256 === afterSha256) {
    return {
      path: params.path,
      resolvedPath: fullPath,
      changed: false,
      snapshot: null,
      beforeSha256,
      afterSha256,
      size: params.content.length,
      diff: '(no binary changes)',
      validation,
    };
  }

  const mutationState: AgentPathMutationState = {
    inputPath: params.path,
    fullPath,
    existed: before.existed,
    type: before.existed ? 'file' : 'missing',
    sha256: beforeSha256,
  };
  return withAgentWorkspaceMutationLocks([fullPath], async () => {
    await assertAgentPathMutationStatesUnchanged([mutationState], operation);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const executionContext = getAgentExecutionContext();
    const workspaceContext = getAgentWorkspaceContext();
    const workspacePath = workspaceContext && isPathWithin(fullPath, workspaceContext.rootPath)
      ? workspaceRelativeAgentPath(workspaceContext, fullPath)
      : null;
    const runtimeTempPath = executionContext
      ? isAgentRuntimeTempPath(fullPath, executionContext)
      : false;
    const baseRevision = workspaceContext && workspacePath && before.buffer
      ? await ensureFileRevisionForCurrentContent({
          workspace: workspaceContext,
          path: workspacePath,
          contentHash: beforeSha256!,
          sizeBytes: before.buffer.length,
          actorType: 'system',
        })
      : null;

    if (workspaceContext && workspacePath) {
      await assertFileCollaborationWriteAllowed({
        workspace: workspaceContext,
        path: workspacePath,
        actorUserId: executionContext?.userId ?? null,
        actorSessionId: executionContext?.sessionId ?? null,
        actorType: 'agent',
        baseRevisionId: baseRevision?.id ?? null,
      });
    }

    const snapshot = runtimeTempPath
      ? null
      : await createSnapshotFromBuffer({
          inputPath: workspacePath ?? params.path,
          fullPath,
          existed: before.existed,
          beforeBuffer: before.buffer,
          operation,
        });
    const stagingPath = path.join(
      path.dirname(fullPath),
      `.${path.basename(fullPath)}.canvas-agent-${randomUUID()}.tmp`,
    );
    try {
      try {
        await assertAgentRuntimeTempWriteQuota({
          fullPath,
          additionalBytes: params.content.length,
          additionalFiles: 1,
        });
      } catch (error) {
        if (
          runtimeTempPath &&
          before.existed &&
          error instanceof Error &&
          error.message.startsWith('Agent runtime temp quota exceeded:')
        ) {
          throw new Error(
            `${error.message} Atomic binary replacement requires temporary quota headroom for the staging file so the original remains recoverable if the process stops.`,
            { cause: error },
          );
        }
        throw error;
      }
      await fs.writeFile(stagingPath, params.content, { flag: 'wx', mode: 0o600 });
      await fs.rename(stagingPath, fullPath);
    } finally {
      await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    }

    const readBack = await fs.readFile(fullPath);
    const readBackSha256 = sha256Buffer(readBack);
    if (readBack.length !== params.content.length || readBackSha256 !== afterSha256) {
      throw new Error(`Read-after-write verification failed for ${params.path}.`);
    }
    if (workspaceContext && workspacePath) {
      await ensureFileRevisionForCurrentContent({
        workspace: workspaceContext,
        path: workspacePath,
        contentHash: readBackSha256,
        sizeBytes: readBack.length,
        actorUserId: executionContext?.userId ?? null,
        actorType: 'agent',
        sourceSessionId: executionContext?.sessionId ?? null,
        baseRevisionId: baseRevision?.id ?? null,
      });
    }
    if (!runtimeTempPath) {
      await syncPublicSharesAfterWrite([fullPath]);
    }

    const result: AgentFileChangeResult = {
      path: params.path,
      resolvedPath: fullPath,
      changed: true,
      snapshot,
      beforeSha256,
      afterSha256: readBackSha256,
      size: readBack.length,
      diff: before.buffer
        ? `Binary content changed: ${before.buffer.length} -> ${readBack.length} bytes`
        : `Binary file created: ${readBack.length} bytes`,
      validation,
    };
    publishAgentWorkspaceMutation(fullPath, before.existed ? 'change' : 'add');
    await recordAgentFileChangeAudit(result, operation);
    return result;
  });
}

function collaborativeFileRequestFingerprint(input: {
  operation: 'edit_file' | 'apply_patch';
  path: string;
  expectedSha256: string | null;
  edits: AgentPatchFileInput['edits'];
}): string {
  return sha256Text(JSON.stringify({
    version: 1,
    operation: input.operation,
    path: input.path,
    expectedSha256: input.expectedSha256,
    edits: input.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText,
      expectedOccurrences: edit.expectedOccurrences ?? (edit.replaceAll ? null : 1), replaceAll: edit.replaceAll === true })),
  }));
}

async function reusedCollaborativeFileEdit(input: {
  inputPath: string;
  fullPath: string;
  collaboration: NonNullable<Awaited<ReturnType<typeof collaborativeAgentFileContext>>>;
  idempotencyKey: string | undefined;
  fingerprint: string;
}): Promise<AgentFileChangeResult | null> {
  if (!input.idempotencyKey) return null;
  const { documentId, workspace, executionContext, relativePath } = input.collaboration;
  let found: Awaited<ReturnType<typeof findAgentFileEditOperation>>;
  try {
    found = await findAgentFileEditOperation({ documentId, workspace, userId: executionContext.userId,
      actorId: executionContext.agentId || DEFAULT_MANAGED_AGENT_ID, actorSessionId: executionContext.sessionId,
      idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint });
  } catch (error) {
    if (error instanceof AgentFileEditOperationScopeError) throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, error.operation);
    throw error;
  }
  if (!found) return null;
  const { operation, request } = found;
  const persisted = operation.durability === 'persisted_yjs' || operation.durability === 'checkpointed_file';
  const reviewRequired = operation.operationStatus === 'needs_review' || operation.operationStatus === 'partially_applied'
    || operation.operationStatus === 'semantic_conflict';
  if (!persisted && !reviewRequired) throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, operation);
  let current: CollaborationTextSnapshot;
  try {
    current = await readCurrentCollaborationTextSnapshot({ documentId, workspace });
    if (current.documentId !== documentId || current.path !== relativePath || current.path !== found.identity.path
      || current.representation !== found.identity.representation || current.lifecycleGeneration !== found.identity.lifecycleGeneration
      || current.schemaVersion !== found.identity.schemaVersion) {
      throw new Error('The document moved after the recorded operation was read.');
    }
  } catch {
    throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, operation);
  }
  return {
    path: input.inputPath, resolvedPath: input.fullPath,
    changed: persisted && operation.appliedTargetIds.length > 0 && request.beforeSha256 !== request.proposedSha256,
    snapshot: null, beforeSha256: request.beforeSha256, afterSha256: current.sha256,
    size: Buffer.byteLength(current.content, 'utf8'),
    diff: 'Existing collaboration operation returned. This retry did not prepare or apply another edit.',
    validation: validateAgentFileContent(input.inputPath, current.content),
    collaboration: { operationId: operation.operationId, operationStatus: operation.operationStatus,
      durability: operation.durability, reviewRequired, proposedSha256: request.proposedSha256 },
  };
}

async function prepareOrReuseCollaborativeFileEdit(input: {
  retry: Parameters<typeof reusedCollaborativeFileEdit>[0];
  prepare: () => Promise<PreparedCollaborationTextEdit>;
}): Promise<{ prepared: PreparedCollaborationTextEdit } | { reused: AgentFileChangeResult }> {
  try { return { prepared: await input.prepare() }; }
  catch (error) {
    // Another first delivery may have removed oldText after our initial lookup.
    // Re-read its receipt; never attempt a second edit to reconstruct the result.
    const reused = await reusedCollaborativeFileEdit(input.retry);
    if (reused) return { reused };
    throw error;
  }
}

async function applyPreparedCollaborativeFileEdit(input: {
  inputPath: string;
  fullPath: string;
  prepared: PreparedCollaborationTextEdit;
  workspace: WorkspaceContext;
  executionContext: AgentExecutionContext;
  idempotencyKey?: string;
  auditOperation: string;
  fingerprint: string;
}): Promise<AgentFileChangeResult> {
  const validation = validateAgentFileContent(input.inputPath, input.prepared.proposedContent);
  if (!validation.ok) {
    throw new Error(
      `Refusing to edit ${input.inputPath}: validation failed. ${validation.checks.map((check) => check.message).join(' ')}`,
    );
  }
  let operation: PersistedAgentApplyResult;
  try {
    operation = await executePreparedCollaborationTextEdit({
      prepared: input.prepared,
      workspace: input.workspace,
      identity: collaborationAgentIdentity(input.executionContext),
      idempotencyKey: input.idempotencyKey,
      fileEditRequest: { fingerprint: input.fingerprint, beforeSha256: input.prepared.sha256,
        proposedSha256: input.prepared.proposedSha256 },
    });
  } catch (error) {
    if (error instanceof AgentFileEditOperationScopeError) throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, error.operation);
    throw error;
  }
  if (operation.fileEditRequestReused) {
    const reused = await reusedCollaborativeFileEdit({ inputPath: input.inputPath, fullPath: input.fullPath,
      collaboration: { documentId: input.prepared.documentId, relativePath: input.prepared.path,
        workspace: input.workspace, executionContext: input.executionContext },
      idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint });
    if (!reused) throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, operation);
    return reused;
  }
  const persisted = operation.durability === 'persisted_yjs' || operation.durability === 'checkpointed_file';
  let current: CollaborationTextSnapshot = input.prepared;
  const reviewRequired = operation.operationStatus === 'needs_review'
    || operation.operationStatus === 'partially_applied' || operation.operationStatus === 'semantic_conflict';
  if (!persisted && !reviewRequired) throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, operation);
  if (persisted) {
    try {
      const snapshot = await readCurrentCollaborationTextSnapshot({
        documentId: input.prepared.documentId,
        workspace: input.workspace,
      });
      if (snapshot.documentId !== input.prepared.documentId || snapshot.path !== input.prepared.path
        || snapshot.lifecycleGeneration !== input.prepared.lifecycleGeneration || snapshot.representation !== input.prepared.representation
        || snapshot.schemaVersion !== input.prepared.schemaVersion) {
        throw new Error('The collaborative document changed identity after the operation completed.');
      }
      current = snapshot;
    } catch {
      throw new AgentFileOperationOutcomeUnavailableError(input.inputPath, operation);
    }
  }
  const changed = input.prepared.content !== current.content;
  const result: AgentFileChangeResult = {
    path: input.inputPath,
    resolvedPath: input.fullPath,
    changed,
    snapshot: null,
    beforeSha256: input.prepared.sha256,
    afterSha256: current.sha256,
    size: Buffer.byteLength(current.content, 'utf8'),
    diff: createUnifiedDiff(
      input.prepared.content,
      changed ? current.content : input.prepared.proposedContent,
      `${input.inputPath} (current)`,
      `${input.inputPath} (${changed ? 'applied' : 'proposed for review'})`,
    ),
    validation,
    collaboration: {
      operationId: operation.operationId,
      operationStatus: operation.operationStatus,
      durability: operation.durability,
      reviewRequired,
      proposedSha256: input.prepared.proposedSha256,
    },
  };
  if (changed) await recordAgentFileChangeAudit(result, input.auditOperation);
  return result;
}

export type AgentEditFileInput = {
  path: string;
  expectedOccurrences?: number;
  replaceAll?: boolean;
  expectedSha256?: string;
  idempotencyKey?: string;
} & ({
  operations: AgentBlockEditRequest[];
  document: CollaborationAgentDocumentReference;
  oldText?: never;
  newText?: never;
  blockId?: never;
} | {
  oldText: string;
  newText: string;
  operations?: never;
  blockId?: string;
  document?: CollaborationAgentDocumentReference;
});

export async function editAgentFile(params: AgentEditFileInput): Promise<AgentFileChangeResult> {
  const structured = params.operations !== undefined || params.blockId !== undefined;
  if (!structured && params.document !== undefined) {
    throw new Error('A document reference requires structured operations or a blockId text edit.');
  }
  if (params.operations !== undefined) {
    if (!Array.isArray(params.operations) || params.operations.length < 1 || params.operations.length > 32
      || params.oldText !== undefined || params.newText !== undefined || params.blockId !== undefined
      || params.expectedOccurrences !== undefined || params.replaceAll !== undefined) {
      throw new Error('Supply either 1–32 structured operations or an exact text edit.');
    }
  } else if (typeof params.oldText !== 'string' || typeof params.newText !== 'string') {
    throw new Error('An exact text edit requires oldText and newText.');
  }
  if (structured && (!params.document || typeof params.document.documentId !== 'string' || !params.document.documentId
    || !Number.isSafeInteger(params.document.lifecycleGeneration) || params.document.lifecycleGeneration < 1
    || !Number.isSafeInteger(params.document.schemaVersion) || params.document.schemaVersion < 1
    || (params.blockId !== undefined && (typeof params.blockId !== 'string' || !params.blockId)))) {
    throw new Error('Structured editing requires the documentId, lifecycleGeneration and schemaVersion from a current structure read.');
  }
  const fullPath = resolveAgentPath(params.path);
  await assertAgentWritablePathAllowed(fullPath);
  await assertExistingAgentFile(fullPath, params.path);
  const expectedSha256 = normalizeAgentExpectedSha256(params.expectedSha256);
  if (!structured) assertAgentSharedWorkspaceRevision({
    operation: 'edit_file',
    path: params.path,
    beforeExisted: true,
    expectedSha256,
  });

  const collaboration = await collaborativeAgentFileContext(fullPath);
  if (structured) {
    if (!collaboration || collaboration.documentId !== params.document!.documentId) {
      throw new Error('The structured document reference does not match this path. Read its current structure again.');
    }
    const fingerprint = hashAgentBlockJson({ version: 2, operation: 'edit_file', path: collaboration.relativePath,
      document: params.document, expectedSha256, operations: params.operations,
      textEdit: params.blockId ? { blockId: params.blockId, oldText: params.oldText, newText: params.newText,
        expectedOccurrences: params.expectedOccurrences ?? null, replaceAll: params.replaceAll === true } : undefined });
    const reused = await reusedCollaborativeFileEdit({ inputPath: params.path, fullPath, collaboration,
      idempotencyKey: params.idempotencyKey, fingerprint });
    if (reused) return reused;
    const preparation = await prepareOrReuseCollaborativeFileEdit({
      retry: { inputPath: params.path, fullPath, collaboration, idempotencyKey: params.idempotencyKey, fingerprint },
      prepare: () => prepareCollaborationBlockEdit({ document: params.document!, workspace: collaboration.workspace,
        path: collaboration.relativePath, operations: params.operations,
        textEdit: params.blockId ? { blockId: params.blockId, oldText: params.oldText!, newText: params.newText!,
          expectedOccurrences: params.expectedOccurrences, replaceAll: params.replaceAll } : undefined,
        expectedSha256, groupId: 'edit_file' }),
    });
    if ('reused' in preparation) return preparation.reused;
    const { prepared } = preparation;
    return applyPreparedCollaborativeFileEdit({ inputPath: params.path, fullPath, prepared,
      workspace: collaboration.workspace, executionContext: collaboration.executionContext,
      idempotencyKey: params.idempotencyKey || `edit-file:${randomUUID()}`,
      auditOperation: 'collaboration_edit_file', fingerprint });
  }
  // The structured branch above cannot fall back to writing a file projection.
  const oldText = params.oldText!;
  const newText = params.newText!;
  if (collaboration) {
    const edits = [{ oldText, newText,
      expectedOccurrences: params.expectedOccurrences, replaceAll: params.replaceAll }];
    const fingerprint = collaborativeFileRequestFingerprint({ operation: 'edit_file', path: collaboration.relativePath, expectedSha256, edits });
    const reused = await reusedCollaborativeFileEdit({ inputPath: params.path, fullPath, collaboration,
      idempotencyKey: params.idempotencyKey, fingerprint });
    if (reused) return reused;
    const preparation = await prepareOrReuseCollaborativeFileEdit({
      retry: { inputPath: params.path, fullPath, collaboration, idempotencyKey: params.idempotencyKey, fingerprint },
      prepare: () => prepareCollaborationTextEdit({
        documentId: collaboration.documentId,
        workspace: collaboration.workspace,
        path: collaboration.relativePath,
        edits,
        expectedSha256,
        groupId: 'edit_file',
      }),
    });
    if ('reused' in preparation) return preparation.reused;
    const { prepared } = preparation;
    return applyPreparedCollaborativeFileEdit({
      inputPath: params.path,
      fullPath,
      prepared,
      workspace: collaboration.workspace,
      executionContext: collaboration.executionContext,
      idempotencyKey: params.idempotencyKey || `edit-file:${randomUUID()}`,
      auditOperation: 'collaboration_edit_file',
      fingerprint,
    });
  }

  const before = await readExistingFile(fullPath);
  if (!before.existed || !before.buffer) throw new Error(`File does not exist: ${params.path}`);
  const beforeSha256 = sha256Buffer(before.buffer);
  const beforeContent = before.buffer.toString('utf8');
  if (expectedSha256 && beforeSha256 !== expectedSha256) {
    throwAgentFileRevisionConflict({ operation: 'edit_file', path: params.path, expectedSha256, currentSha256: beforeSha256 });
  }
  const nextContent = applyExactTextEdits(beforeContent, [{ ...params, oldText, newText }], params.path);
  return commitTextChange({
    inputPath: params.path,
    fullPath,
    beforeBuffer: before.buffer,
    beforeExisted: true,
    nextContent,
    operation: 'edit_file',
    enforceValidation: true,
  });
}

export async function applyAgentFilePatch(params: {
  files: AgentPatchFileInput[];
  idempotencyKeyPrefix?: string;
}): Promise<AgentFileChangeResult[]> {
  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new Error('apply_patch requires at least one file.');
  }

  const seen = new Set<string>();
  const prepared: Array<
    | {
        kind: 'file';
        inputPath: string;
        fullPath: string;
        beforeBuffer: Buffer;
        nextContent: string;
      }
    | {
        kind: 'recorded';
        result: AgentFileChangeResult;
      }
    | {
        kind: 'collaboration';
        inputPath: string;
        fullPath: string;
        prepared: PreparedCollaborationTextEdit;
        workspace: WorkspaceContext;
        executionContext: AgentExecutionContext;
        idempotencyKey: string;
        fingerprint: string;
      }
  > = [];

  for (const [fileIndex, file] of params.files.entries()) {
    if (!Array.isArray(file.edits) || file.edits.length === 0) {
      throw new Error(`No edits provided for ${file.path}.`);
    }

    const fullPath = resolveAgentPath(file.path);
    await assertAgentWritablePathAllowed(fullPath);
    const resolved = path.resolve(fullPath);
    if (seen.has(resolved)) {
      throw new Error(`Duplicate file in patch: ${file.path}`);
    }
    seen.add(resolved);

    await assertExistingAgentFile(fullPath, file.path);
    const expectedSha256 = normalizeAgentExpectedSha256(file.expectedSha256);
    assertAgentSharedWorkspaceRevision({
      operation: 'patch',
      path: file.path,
      beforeExisted: true,
      expectedSha256,
    });

    const collaboration = await collaborativeAgentFileContext(fullPath);
    if (collaboration) {
      const fingerprint = collaborativeFileRequestFingerprint({ operation: 'apply_patch', path: collaboration.relativePath,
        expectedSha256, edits: file.edits });
      const idempotencyKey = `${params.idempotencyKeyPrefix || `apply-patch:${randomUUID()}`}:${fileIndex}`;
      const reused = await reusedCollaborativeFileEdit({ inputPath: file.path, fullPath, collaboration,
        idempotencyKey: params.idempotencyKeyPrefix ? idempotencyKey : undefined, fingerprint });
      if (reused) { prepared.push({ kind: 'recorded', result: reused }); continue; }
      const preparation = await prepareOrReuseCollaborativeFileEdit({
        retry: { inputPath: file.path, fullPath, collaboration,
          idempotencyKey: params.idempotencyKeyPrefix ? idempotencyKey : undefined, fingerprint },
        prepare: () => prepareCollaborationTextEdit({
          documentId: collaboration.documentId,
          workspace: collaboration.workspace,
          path: collaboration.relativePath,
          edits: file.edits,
          expectedSha256,
          groupId: `apply_patch:${fileIndex}`,
        }),
      });
      if ('reused' in preparation) { prepared.push({ kind: 'recorded', result: preparation.reused }); continue; }
      const collaborationPrepared = preparation.prepared;
      const validation = validateAgentFileContent(file.path, collaborationPrepared.proposedContent);
      if (!validation.ok) {
        throw new Error(`Refusing to patch ${file.path}: validation failed. ${validation.checks.map((check) => check.message).join(' ')}`);
      }
      prepared.push({
        kind: 'collaboration',
        inputPath: file.path,
        fullPath,
        prepared: collaborationPrepared,
        workspace: collaboration.workspace,
        executionContext: collaboration.executionContext,
        idempotencyKey,
        fingerprint,
      });
      continue;
    }

    const before = await readExistingFile(fullPath);
    if (!before.existed || !before.buffer) throw new Error(`File does not exist: ${file.path}`);
    const beforeSha256 = sha256Buffer(before.buffer);
    if (expectedSha256 && beforeSha256 !== expectedSha256) {
      throwAgentFileRevisionConflict({ operation: 'apply_patch', path: file.path, expectedSha256, currentSha256: beforeSha256 });
    }
    const nextContent = applyExactTextEdits(before.buffer.toString('utf8'), file.edits, file.path);
    const validation = validateAgentFileContent(file.path, nextContent);
    if (!validation.ok) {
      throw new Error(`Refusing to patch ${file.path}: validation failed. ${validation.checks.map((check) => check.message).join(' ')}`);
    }

    prepared.push({
      kind: 'file',
      inputPath: file.path,
      fullPath,
      beforeBuffer: before.buffer,
      nextContent,
    });
  }

  const results: AgentFileChangeResult[] = [];
  for (const file of prepared) {
    if (file.kind === 'recorded') {
      results.push(file.result);
    } else if (file.kind === 'collaboration') {
      results.push(await applyPreparedCollaborativeFileEdit({
        inputPath: file.inputPath,
        fullPath: file.fullPath,
        prepared: file.prepared,
        workspace: file.workspace,
        executionContext: file.executionContext,
        idempotencyKey: file.idempotencyKey,
        auditOperation: 'collaboration_apply_patch',
        fingerprint: file.fingerprint,
      }));
    } else {
      // Preflight is intentionally separate from commit for multi-file patches.
      // Re-read at the authoritative write boundary so a file changed after
      // preflight is never overwritten from the stale buffer.
      const current = await readExistingFile(file.fullPath);
      const preflightSha256 = sha256Buffer(file.beforeBuffer);
      const currentSha256 = current.buffer ? sha256Buffer(current.buffer) : null;
      if (!current.existed || !current.buffer || currentSha256 !== preflightSha256) {
        throwAgentFileRevisionConflict({
          operation: 'apply_patch',
          path: file.inputPath,
          expectedSha256: preflightSha256,
          currentSha256,
        });
      }
      results.push(await commitTextChange({
        inputPath: file.inputPath,
        fullPath: file.fullPath,
        beforeBuffer: file.beforeBuffer,
        beforeExisted: true,
        nextContent: file.nextContent,
        operation: 'apply_patch',
        enforceValidation: true,
      }));
    }
  }

  return results;
}

export async function listAgentFileSnapshots(params: { path?: string; limit?: number } = {}): Promise<AgentFileSnapshotMetadata[]> {
  const limit = Math.max(1, Math.min(Math.trunc(params.limit ?? 20), 100));
  const resolvedFilterPath = params.path ? path.resolve(resolveAgentPath(params.path)) : null;
  if (resolvedFilterPath) {
    await assertAgentPathAllowed(resolvedFilterPath);
  }

  const snapshots = await listAllSnapshotMetadata();
  return snapshots
    .filter((snapshot) => !resolvedFilterPath || path.resolve(snapshot.resolvedPath) === resolvedFilterPath)
    .slice(0, limit);
}

export async function restoreAgentFileSnapshot(params: { snapshotId: string }): Promise<AgentFileChangeResult> {
  const snapshot = await readSnapshotMetadata(params.snapshotId);
  const fullPath = path.resolve(snapshot.resolvedPath);
  await assertAgentWritablePathAllowed(fullPath);

  const before = await readExistingFile(fullPath);
  const mutationState: AgentPathMutationState = {
    inputPath: snapshot.path,
    fullPath,
    existed: before.existed,
    type: before.existed ? 'file' : 'missing',
    sha256: before.buffer ? sha256Buffer(before.buffer) : null,
  };

  return withAgentWorkspaceMutationLocks([fullPath], async () => {
    await assertAgentPathMutationStatesUnchanged([mutationState], 'restore_file_snapshot');
    const workspaceContext = getAgentWorkspaceContext();
    if (workspaceContext) {
      await assertFileCollaborationWriteAllowed({
        workspace: workspaceContext,
        path: workspaceRelativeAgentPath(workspaceContext, fullPath),
        actorUserId: getAgentExecutionContext()?.userId ?? null,
        actorSessionId: getAgentExecutionContext()?.sessionId ?? null,
        actorType: 'agent',
      });
    }
    const undoSnapshot = await createSnapshotFromBuffer({
      inputPath: snapshot.path,
      fullPath,
      existed: before.existed,
      beforeBuffer: before.buffer,
      operation: 'restore_file_snapshot',
    });

    if (!snapshot.existed) {
      await fs.rm(fullPath, { force: true });
      await syncPublicSharesAfterDelete([fullPath]);
      const result: AgentFileChangeResult = {
        path: snapshot.path,
        resolvedPath: fullPath,
        changed: before.existed,
        snapshot: undoSnapshot,
        beforeSha256: before.buffer ? sha256Buffer(before.buffer) : null,
        afterSha256: sha256Text(''),
        size: 0,
        diff: before.buffer && !isProbablyBinary(before.buffer)
          ? createUnifiedDiff(before.buffer.toString('utf8'), '', `${snapshot.path} (before restore)`, `${snapshot.path} (after restore)`)
          : '(file removed; textual diff unavailable)',
        validation: { ok: true, checks: [{ name: 'restore', ok: true, message: 'Restored snapshot by removing file that did not exist before the original edit.' }] },
      };
      publishAgentWorkspaceMutation(fullPath, 'unlink');
      await recordAgentFileChangeAudit(result, 'restore_file_snapshot');
      return result;
    }

    const content = await fs.readFile(snapshotContentPath(snapshot.id));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    const readBack = await fs.readFile(fullPath);
    if (sha256Buffer(readBack) !== sha256Buffer(content)) {
      throw new Error(`Read-after-restore verification failed for ${snapshot.path}.`);
    }
    await syncPublicSharesAfterWrite([fullPath]);

    const beforeText = before.buffer && !isProbablyBinary(before.buffer) ? before.buffer.toString('utf8') : null;
    const afterText = !isProbablyBinary(readBack) ? readBack.toString('utf8') : null;

    const result: AgentFileChangeResult = {
      path: snapshot.path,
      resolvedPath: fullPath,
      changed: true,
      snapshot: undoSnapshot,
      beforeSha256: before.buffer ? sha256Buffer(before.buffer) : null,
      afterSha256: sha256Buffer(readBack),
      size: readBack.length,
      diff: beforeText !== null && afterText !== null
        ? createUnifiedDiff(beforeText, afterText, `${snapshot.path} (before restore)`, `${snapshot.path} (after restore)`)
        : '(binary file restored; textual diff unavailable)',
      validation: validateAgentFileContent(snapshot.path, readBack.toString('utf8')),
    };
    publishAgentWorkspaceMutation(fullPath, 'change');
    await recordAgentFileChangeAudit(result, 'restore_file_snapshot');
    return result;
  });
}

function getPathType(stats: Stats): AgentPathType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

async function summarizePath(fullPath: string): Promise<{
  type: AgentPathType;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
}> {
  const stats = await fs.stat(fullPath);
  const type = getPathType(stats);

  if (!stats.isDirectory()) {
    return {
      type,
      bytes: stats.size,
      files: stats.isFile() ? 1 : 0,
      directories: 0,
      truncated: false,
    };
  }

  let bytes = 0;
  let files = 0;
  let directories = 1;
  let entriesSeen = 0;
  let truncated = false;
  const pending = [fullPath];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_PATH_SUMMARY_ENTRIES) {
        truncated = true;
        pending.length = 0;
        break;
      }

      const entryPath = path.join(current, entry.name);
      const entryStats = await fs.stat(entryPath);
      if (entry.isDirectory()) {
        directories += 1;
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files += 1;
        bytes += entryStats.size;
      } else {
        bytes += entryStats.size;
      }
    }
  }

  return { type, bytes, files, directories, truncated };
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.stat(fullPath);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function assertDestinationIsNotInsideSource(sourcePath: string, destinationPath: string, sourceType: AgentPathOperationResult['type']): void {
  if (sourceType === 'directory' && isPathWithin(destinationPath, sourcePath)) {
    throw new Error('Destination must not be inside the source directory.');
  }
}

function normalizePathList(paths: string[], fieldName: string): string[] {
  const normalized = paths.map((pathValue) => pathValue.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must include at least one path.`);
  }
  return normalized;
}

function pathOperationSummary(
  operation: AgentPathOperationResult['operation'],
  entries: Array<AgentPathOperationEntry & { sourceSha256?: string | null }>,
  destinationPath?: string,
  destinationResolvedPath?: string,
): AgentPathOperationResult {
  if (entries.length === 0) {
    throw new Error('Path operation result must include at least one entry.');
  }

  const typeSet = new Set(entries.map((entry) => entry.type));
  const aggregateType: AgentPathType = typeSet.size === 1 ? entries[0].type : 'mixed';
  const sourcePath = entries.length === 1 ? entries[0].sourcePath : `${entries.length} paths`;
  const sourceResolvedPath = entries.length === 1 ? entries[0].sourceResolvedPath : `${entries.length} paths`;
  const publicEntries = entries.map(({ sourceSha256: _sourceSha256, ...entry }) => entry);

  return {
    operation,
    sourcePath,
    sourcePaths: entries.map((entry) => entry.sourcePath),
    destinationPath,
    sourceResolvedPath,
    sourceResolvedPaths: entries.map((entry) => entry.sourceResolvedPath),
    destinationResolvedPath,
    type: aggregateType,
    changed: entries.some((entry) => entry.changed),
    overwritten: entries.some((entry) => entry.overwritten),
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    files: entries.reduce((total, entry) => total + entry.files, 0),
    directories: entries.reduce((total, entry) => total + entry.directories, 0),
    truncated: entries.some((entry) => entry.truncated),
    verified: null,
    entries: publicEntries,
  };
}

async function sha256ForPath(fullPath: string, type: AgentPathType): Promise<string | null> {
  if (type !== 'file') return null;
  return sha256Buffer(await fs.readFile(fullPath));
}

async function verifyPathOperationEntries(input: {
  entries: PreparedPathOperationEntry[];
  sourceMustBeRemoved: boolean;
}): Promise<void> {
  for (const entry of input.entries) {
    if (!entry.destinationResolvedPath) {
      throw new Error(`Missing destination path while verifying ${entry.sourcePath}.`);
    }
    let destinationStats: Stats;
    try {
      destinationStats = await fs.stat(entry.destinationResolvedPath);
    } catch (error) {
      if (isEnoent(error)) {
        throw new Error(`Path operation verification failed: destination does not exist: ${entry.destinationPath}.`);
      }
      throw error;
    }
    const destinationTypeMatches = getPathType(destinationStats) === entry.type;
    if (!destinationTypeMatches) {
      throw new Error(`Path operation verification failed: destination type does not match source for ${entry.destinationPath}.`);
    }

    const destinationSummary = await summarizePath(entry.destinationResolvedPath);
    const summaryMatches = !entry.truncated
      && !destinationSummary.truncated
      && destinationSummary.bytes === entry.bytes
      && destinationSummary.files === entry.files
      && destinationSummary.directories === entry.directories;
    const destinationSha256 = await sha256ForPath(entry.destinationResolvedPath, entry.type);
    const contentVerified = entry.type === 'file'
      ? destinationSha256 === entry.sourceSha256
      : summaryMatches;
    if (!contentVerified) {
      throw new Error(`Path operation verification failed: destination content differs from source for ${entry.destinationPath}.`);
    }

    let sourceRemoved: boolean | null = null;
    if (input.sourceMustBeRemoved) {
      sourceRemoved = !(await pathExists(entry.sourceResolvedPath));
      if (!sourceRemoved) {
        throw new Error(`Path operation verification failed: source still exists after move: ${entry.sourcePath}.`);
      }
    }
    entry.verification = {
      destinationExists: true,
      destinationTypeMatches,
      sourceRemoved,
      contentVerified,
    };
  }
}

function getDestinationPathForSource(destinationDirectoryPath: string, sourcePath: string): string {
  const baseName = path.basename(path.resolve(sourcePath));
  if (!baseName || baseName === path.sep) {
    throw new Error(`Unable to derive destination name for ${sourcePath}.`);
  }
  return path.join(destinationDirectoryPath, baseName);
}

async function assertDestinationDirectoryAvailable(destinationFullPath: string, destinationPath: string): Promise<void> {
  if (await pathExists(destinationFullPath)) {
    const stats = await fs.stat(destinationFullPath);
    if (!stats.isDirectory()) {
      throw new Error(`Destination must be a directory when multiple sources are provided: ${destinationPath}`);
    }
  }
}

function assertNoDuplicateDestinations(entries: AgentPathOperationEntry[]): void {
  const destinations = new Set<string>();
  for (const entry of entries) {
    if (!entry.destinationResolvedPath) continue;
    if (destinations.has(entry.destinationResolvedPath)) {
      throw new Error(`Multiple sources resolve to the same destination: ${entry.destinationPath}`);
    }
    destinations.add(entry.destinationResolvedPath);
  }
}

function assertNoNestedCopyMoveSources(entries: AgentPathOperationEntry[]): void {
  for (const parentEntry of entries) {
    if (parentEntry.type !== 'directory') continue;
    for (const childEntry of entries) {
      if (parentEntry === childEntry) continue;
      if (isPathWithin(childEntry.sourceResolvedPath, parentEntry.sourceResolvedPath)) {
        throw new Error('Multiple sources must not include paths nested under another source directory.');
      }
    }
  }
}

async function assertRuntimeTempPathOperationQuota(
  entries: PreparedPathOperationEntry[],
  operation: 'copy' | 'move',
): Promise<void> {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return;
  let additionalBytes = 0;
  let additionalFiles = 0;
  let releasedBytes = 0;
  let releasedFiles = 0;

  for (const entry of entries) {
    if (!entry.destinationResolvedPath || !isAgentRuntimeTempPath(entry.destinationResolvedPath, executionContext)) {
      continue;
    }
    const sourceAlreadyInTemp = isAgentRuntimeTempPath(entry.sourceResolvedPath, executionContext);
    if (operation === 'copy' || !sourceAlreadyInTemp) {
      additionalBytes += entry.bytes;
      additionalFiles += entry.files;
    }
    if (entry.overwritten) {
      const destinationSummary = await summarizePath(entry.destinationResolvedPath);
      releasedBytes += destinationSummary.bytes;
      releasedFiles += destinationSummary.files;
    }
  }

  if (additionalBytes === 0 && additionalFiles === 0) return;
  await assertAgentRuntimeTempQuota(await ensureAgentRuntimeTempDir(executionContext), {
    additionalBytes,
    additionalFiles,
    releasedBytes,
    releasedFiles,
  });
}

export async function copyAgentPath(params: {
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
  recursive?: boolean;
}): Promise<AgentPathOperationResult> {
  return copyAgentPaths({
    sourcePaths: [params.sourcePath],
    destinationPath: params.destinationPath,
    overwrite: params.overwrite,
    recursive: params.recursive,
  });
}

export async function copyAgentPaths(params: {
  sourcePaths: string[];
  destinationPath: string;
  overwrite?: boolean;
  recursive?: boolean;
}): Promise<AgentPathOperationResult> {
  const sourcePaths = normalizePathList(params.sourcePaths, 'sourcePaths');
  const multipleSources = sourcePaths.length > 1;
  const destinationFullPath = resolveAgentPath(params.destinationPath);
  await assertAgentWritablePathAllowed(destinationFullPath);

  if (multipleSources) {
    await assertDestinationDirectoryAvailable(destinationFullPath, params.destinationPath);
  }

  const entries: PreparedPathOperationEntry[] = [];
  for (const sourcePath of sourcePaths) {
    const sourceFullPath = resolveAgentPath(sourcePath);
    await assertAgentPathAllowed(sourceFullPath);

    const summary = await summarizePath(sourceFullPath);
    if (summary.type === 'directory' && params.recursive === false) {
      throw new Error('Source is a directory. Set recursive to true to copy directories.');
    }

    const entryDestinationPath = multipleSources
      ? getDestinationPathForSource(params.destinationPath, sourcePath)
      : params.destinationPath;
    const entryDestinationFullPath = multipleSources
      ? getDestinationPathForSource(destinationFullPath, sourceFullPath)
      : destinationFullPath;
    await assertAgentWritablePathAllowed(entryDestinationFullPath);

    if (path.resolve(sourceFullPath) === path.resolve(entryDestinationFullPath)) {
      throw new Error('Source and destination must be different paths.');
    }
    assertDestinationIsNotInsideSource(sourceFullPath, entryDestinationFullPath, summary.type);

    const overwritten = await pathExists(entryDestinationFullPath);
    if (overwritten && !params.overwrite) {
      throw new Error(`Destination already exists: ${entryDestinationPath}`);
    }

    entries.push({
      sourcePath,
      destinationPath: entryDestinationPath,
      sourceResolvedPath: sourceFullPath,
      destinationResolvedPath: entryDestinationFullPath,
      changed: true,
      overwritten,
      sourceSha256: await sha256ForPath(sourceFullPath, summary.type),
      ...summary,
    });
  }

  assertNoDuplicateDestinations(entries);
  assertNoNestedCopyMoveSources(entries);

  const mutationStates = await Promise.all(entries.flatMap((entry) => [
    captureAgentPathMutationState(entry.sourcePath, entry.sourceResolvedPath),
    captureAgentPathMutationState(entry.destinationPath!, entry.destinationResolvedPath!),
  ]));
  return withAgentWorkspaceMutationLocks(
    mutationStates.map((state) => state.fullPath),
    async () => {
      await assertAgentPathMutationStatesUnchanged(mutationStates, 'copy_path');
      await assertRuntimeTempPathOperationQuota(entries, 'copy');
      const copyWorkspace = getAgentWorkspaceContext();
      if (copyWorkspace) {
        const overwrittenPaths: string[] = [];
        for (const entry of entries) {
          if (!entry.overwritten || !entry.destinationResolvedPath) continue;
          const destinationPath = workspaceRelativeAgentPathIfWithin(copyWorkspace, entry.destinationResolvedPath);
          if (!destinationPath) continue;
          await assertFileCollaborationWriteAllowed({
            workspace: copyWorkspace,
            path: destinationPath,
            actorUserId: getAgentExecutionContext()?.userId ?? null,
            actorSessionId: getAgentExecutionContext()?.sessionId ?? null,
            actorType: 'agent',
          });
          overwrittenPaths.push(destinationPath);
        }
        if (overwrittenPaths.length > 0) {
          await archiveFileCollaborationPaths({ workspace: copyWorkspace, paths: overwrittenPaths.map((path) => ({ path })) });
        }
      }

      for (const entry of entries) {
        if (!entry.destinationResolvedPath) continue;
        await fs.mkdir(path.dirname(entry.destinationResolvedPath), { recursive: true });
        if (entry.overwritten && params.overwrite) {
          await fs.rm(entry.destinationResolvedPath, { recursive: true, force: true });
        }
        await fs.cp(entry.sourceResolvedPath, entry.destinationResolvedPath, {
          recursive: entry.type === 'directory',
          force: params.overwrite === true,
          errorOnExist: params.overwrite !== true,
        });
      }
      await verifyPathOperationEntries({ entries, sourceMustBeRemoved: false });
      if (copyWorkspace) {
        const workspaceDestinations = entries
          .map((entry) => entry.destinationResolvedPath
            ? workspaceRelativeAgentPathIfWithin(copyWorkspace, entry.destinationResolvedPath)
            : null)
          .filter((value): value is string => Boolean(value));
        await initializeCopiedFileCollaborationPaths({
          workspace: copyWorkspace,
          paths: workspaceDestinations,
        });
        await syncPublicSharesAfterWrite(workspaceDestinations, copyWorkspace);
      }
      for (const entry of entries) {
        if (entry.destinationResolvedPath) {
          publishAgentWorkspaceMutation(
            entry.destinationResolvedPath,
            entry.overwritten ? 'change' : entry.type === 'directory' ? 'addDir' : 'add',
          );
        }
      }

      const result = pathOperationSummary('copy_path', entries, params.destinationPath, destinationFullPath);
      result.verified = entries.every((entry) => entry.verification?.contentVerified === true);
      await recordAgentPathOperationAudit(result);
      return result;
    },
  );
}

export async function moveAgentPath(params: {
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}): Promise<AgentPathOperationResult> {
  return moveAgentPaths({
    sourcePaths: [params.sourcePath],
    destinationPath: params.destinationPath,
    overwrite: params.overwrite,
  });
}

export async function moveAgentPaths(params: {
  sourcePaths: string[];
  destinationPath: string;
  overwrite?: boolean;
}): Promise<AgentPathOperationResult> {
  const sourcePaths = normalizePathList(params.sourcePaths, 'sourcePaths');
  const multipleSources = sourcePaths.length > 1;
  const destinationFullPath = resolveAgentPath(params.destinationPath);
  await assertAgentWritablePathAllowed(destinationFullPath);

  if (multipleSources) {
    await assertDestinationDirectoryAvailable(destinationFullPath, params.destinationPath);
  }

  const entries: PreparedPathOperationEntry[] = [];
  for (const sourcePath of sourcePaths) {
    const sourceFullPath = resolveAgentPath(sourcePath);
    await assertAgentDeletablePathAllowed(sourceFullPath);

    const summary = await summarizePath(sourceFullPath);
    const entryDestinationPath = multipleSources
      ? getDestinationPathForSource(params.destinationPath, sourcePath)
      : params.destinationPath;
    const entryDestinationFullPath = multipleSources
      ? getDestinationPathForSource(destinationFullPath, sourceFullPath)
      : destinationFullPath;
    await assertAgentWritablePathAllowed(entryDestinationFullPath);

    if (path.resolve(sourceFullPath) === path.resolve(entryDestinationFullPath)) {
      throw new Error('Source and destination must be different paths.');
    }
    assertDestinationIsNotInsideSource(sourceFullPath, entryDestinationFullPath, summary.type);

    const overwritten = await pathExists(entryDestinationFullPath);
    if (overwritten && !params.overwrite) {
      throw new Error(`Destination already exists: ${entryDestinationPath}`);
    }

    entries.push({
      sourcePath,
      destinationPath: entryDestinationPath,
      sourceResolvedPath: sourceFullPath,
      destinationResolvedPath: entryDestinationFullPath,
      changed: true,
      overwritten,
      sourceSha256: await sha256ForPath(sourceFullPath, summary.type),
      ...summary,
    });
  }

  assertNoDuplicateDestinations(entries);
  assertNoNestedCopyMoveSources(entries);

  const mutationStates = await Promise.all(entries.flatMap((entry) => [
    captureAgentPathMutationState(entry.sourcePath, entry.sourceResolvedPath),
    captureAgentPathMutationState(entry.destinationPath!, entry.destinationResolvedPath!),
  ]));
  return withAgentWorkspaceMutationLocks(
    mutationStates.map((state) => state.fullPath),
    async () => {
      await assertAgentPathMutationStatesUnchanged(mutationStates, 'move_path');
      await assertRuntimeTempPathOperationQuota(entries, 'move');
      const moveWorkspace = getAgentWorkspaceContext();
      if (moveWorkspace) {
        const overwrittenPaths = entries
          .filter((entry) => entry.overwritten && entry.destinationResolvedPath)
          .map((entry) => workspaceRelativeAgentPathIfWithin(moveWorkspace, entry.destinationResolvedPath!))
          .filter((value): value is string => Boolean(value));
        if (overwrittenPaths.length > 0) {
          await archiveFileCollaborationPaths({ workspace: moveWorkspace, paths: overwrittenPaths.map((path) => ({ path })) });
        }
      }

      for (const entry of entries) {
        const destination = entry.destinationResolvedPath;
        if (!destination) continue;
        const oldPath = moveWorkspace ? workspaceRelativeAgentPathIfWithin(moveWorkspace, entry.sourceResolvedPath) : null;
        const newPath = moveWorkspace ? workspaceRelativeAgentPathIfWithin(moveWorkspace, destination) : null;
        const moveEntry = async () => {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          if (entry.overwritten && params.overwrite) {
            await fs.rm(destination, { recursive: true, force: true });
          }
          await fs.cp(entry.sourceResolvedPath, destination, { recursive: entry.type === 'directory', force: true });
          await fs.rm(entry.sourceResolvedPath, { recursive: entry.type === 'directory', force: true });
        };
        if (moveWorkspace && oldPath && newPath) {
          await withWorkspacePathRenameEvent(moveWorkspace, {
            type: 'rename', operationId: randomUUID(), workspaceId: moveWorkspace.workspaceId, oldPath, newPath,
          }, moveEntry);
        } else {
          await moveEntry();
        }
      }
      await verifyPathOperationEntries({ entries, sourceMustBeRemoved: true });
      const copiedIntoWorkspace: string[] = [];
      const removedFromWorkspace: string[] = [];
      for (const entry of entries) {
        if (!entry.destinationResolvedPath) continue;
        const oldPath = moveWorkspace ? workspaceRelativeAgentPathIfWithin(moveWorkspace, entry.sourceResolvedPath) : null;
        const newPath = moveWorkspace ? workspaceRelativeAgentPathIfWithin(moveWorkspace, entry.destinationResolvedPath) : null;
        if (moveWorkspace) {
          if (oldPath && newPath) {
            await moveFileCollaborationPath({ workspace: moveWorkspace, oldPath, newPath });
            await syncPublicSharesAfterMove(oldPath, newPath, moveWorkspace);
          } else if (oldPath) {
            removedFromWorkspace.push(oldPath);
          } else if (newPath) {
            copiedIntoWorkspace.push(newPath);
          }
        }
        if (!(oldPath && newPath)) {
          publishAgentWorkspaceMutation(entry.sourceResolvedPath, entry.type === 'directory' ? 'unlinkDir' : 'unlink');
          publishAgentWorkspaceMutation(
            entry.destinationResolvedPath,
            entry.overwritten ? 'change' : entry.type === 'directory' ? 'addDir' : 'add',
          );
        }
      }
      if (moveWorkspace && copiedIntoWorkspace.length > 0) {
        await initializeCopiedFileCollaborationPaths({ workspace: moveWorkspace, paths: copiedIntoWorkspace });
        await syncPublicSharesAfterWrite(copiedIntoWorkspace, moveWorkspace);
      }
      if (moveWorkspace && removedFromWorkspace.length > 0) {
        await archiveFileCollaborationPaths({
          workspace: moveWorkspace,
          paths: removedFromWorkspace.map((path) => ({ path })),
        });
        await syncPublicSharesAfterDelete(removedFromWorkspace, moveWorkspace);
      }

      const result = pathOperationSummary('move_path', entries, params.destinationPath, destinationFullPath);
      result.verified = entries.every((entry) => entry.verification?.contentVerified === true && entry.verification.sourceRemoved === true);
      await recordAgentPathOperationAudit(result);
      return result;
    },
  );
}

export async function deleteAgentPath(params: {
  path: string;
  recursive?: boolean;
  ignoreMissing?: boolean;
}): Promise<AgentPathOperationResult> {
  return deleteAgentPaths({
    paths: [params.path],
    recursive: params.recursive,
    ignoreMissing: params.ignoreMissing,
  });
}

export async function deleteAgentPaths(params: {
  paths: string[];
  recursive?: boolean;
  ignoreMissing?: boolean;
}): Promise<AgentPathOperationResult> {
  const requestedPaths = normalizePathList(params.paths, 'paths');
  const seenResolvedPaths = new Set<string>();
  const entries: AgentPathOperationEntry[] = [];

  for (const requestedPath of requestedPaths) {
    const fullPath = resolveAgentPath(requestedPath);
    await assertAgentDeletablePathAllowed(fullPath);
    const resolvedFullPath = path.resolve(fullPath);
    if (seenResolvedPaths.has(resolvedFullPath)) continue;
    seenResolvedPaths.add(resolvedFullPath);

    if (!(await pathExists(fullPath))) {
      if (!params.ignoreMissing) {
        throw new Error(`Path does not exist: ${requestedPath}`);
      }
      entries.push({
        sourcePath: requestedPath,
        sourceResolvedPath: fullPath,
        type: 'missing',
        changed: false,
        overwritten: false,
        bytes: 0,
        files: 0,
        directories: 0,
        truncated: false,
      });
      continue;
    }

    const summary = await summarizePath(fullPath);
    if (summary.type === 'directory' && params.recursive !== true) {
      throw new Error('Path is a directory. Set recursive to true to delete directories.');
    }

    entries.push({
      sourcePath: requestedPath,
      sourceResolvedPath: fullPath,
      changed: true,
      overwritten: false,
      ...summary,
    });
  }

  const deletableEntries = entries
    .filter((entry) => entry.changed)
    .sort((a, b) => b.sourceResolvedPath.length - a.sourceResolvedPath.length);

  const mutationStates = await Promise.all(
    deletableEntries.map((entry) => captureAgentPathMutationState(entry.sourcePath, entry.sourceResolvedPath)),
  );
  return withAgentWorkspaceMutationLocks(
    mutationStates.map((state) => state.fullPath),
    async () => {
      await assertAgentPathMutationStatesUnchanged(mutationStates, 'delete_path');
      for (const entry of deletableEntries) {
        await fs.rm(entry.sourceResolvedPath, {
          recursive: entry.type === 'directory',
          force: false,
        });
      }
      const deleteWorkspace = getAgentWorkspaceContext();
      const workspaceDeletions = deleteWorkspace
        ? deletableEntries.filter((entry) => isPathWithin(entry.sourceResolvedPath, deleteWorkspace.rootPath))
        : [];
      if (deleteWorkspace && workspaceDeletions.length > 0) {
        const deletedPaths = workspaceDeletions.map((entry) => workspaceRelativeAgentPath(deleteWorkspace, entry.sourceResolvedPath));
        await archiveFileCollaborationPaths({ workspace: deleteWorkspace, paths: deletedPaths.map((path) => ({ path })) });
      }
      await syncPublicSharesAfterDelete(deletableEntries.map((entry) => entry.sourceResolvedPath));
      for (const entry of deletableEntries) {
        publishAgentWorkspaceMutation(entry.sourceResolvedPath, entry.type === 'directory' ? 'unlinkDir' : 'unlink');
      }

      const result = pathOperationSummary('delete_path', entries);
      await recordAgentPathOperationAudit(result);
      return result;
    },
  );
}

function isManagedDataPath(target: string): boolean {
  const normalized = path.isAbsolute(target) ? path.resolve(target) : target;
  if (/^\/data\/(?:workspace|workspaces|agents)(?:\/|$)/.test(normalized)) {
    return true;
  }
  if (!path.isAbsolute(normalized)) {
    return false;
  }

  const dataRoot = getAgentDataRoot();
  const candidateRoots = [
    getAgentWorkspaceRoot(),
    path.join(dataRoot, 'workspaces'),
    path.join(dataRoot, 'agents'),
  ];
  return candidateRoots.some((candidateRoot) => isPathWithin(normalized, candidateRoot));
}

function findShellDataPathMentions(command: string): string[] {
  const mentions = new Set<string>();
  const pathPattern = /(?:^|[\s"'`=(:])((?:\/data|[^\s"'`;&|()]*\/data)\/(?:workspaces|workspace|agents|user-uploads|studio)(?:\/[^\s"'`;&|()]*)?)/g;

  for (const match of command.matchAll(pathPattern)) {
    const mention = stripShellTokenQuotes(match[1] || '').trim();
    if (mention) {
      mentions.add(mention);
    }
  }

  const executionContext = getAgentExecutionContext();
  if (executionContext?.workspaceRoot) {
    const escapedWorkspaceRoot = executionContext.workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const workspaceRootPattern = new RegExp(`(?:^|[\\s"'\\\`=(:])(${escapedWorkspaceRoot}(?:\\/[^\\s"'\\\`;&|()]*)?)`, 'g');
    for (const match of command.matchAll(workspaceRootPattern)) {
      const mention = stripShellTokenQuotes(match[1] || '').trim();
      if (mention) {
        mentions.add(mention);
      }
    }
  }

  return [...mentions];
}

function shellDataPathMentionViolatesContext(command: string): boolean {
  const executionContext = getAgentExecutionContext();
  if (!executionContext) return false;

  const workspaceRootVariants = rootPathVariants(executionContext.workspaceRoot);
  return findShellDataPathMentions(command).some((mention) => {
    const resolvedMention = path.resolve(mention);
    try {
      if (existsSync(resolvedMention)) {
        const realMention = realpathSync(resolvedMention);
        if (workspaceRootVariants.some((rootVariant) => isPathWithin(realMention, rootVariant))) {
          return false;
        }
        return true;
      }
    } catch {
      return true;
    }

    if (workspaceRootVariants.some((rootVariant) => isPathWithin(resolvedMention, rootVariant))) return false;
    if (resolveLegacyWorkspaceAlias(resolvedMention)) return false;
    return true;
  });
}

function stripShellTokenQuotes(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function findShellWriteRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const redirectPattern = /(?:^|[^<])(?:\d*|&)?>>?\s*(?![&(])(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(redirectPattern)) {
    const target = stripShellTokenQuotes(match[1] || match[2] || match[3] || '');
    if (!target || /^&\d+$/.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

function shellRedirectWritesManagedPath(
  command: string,
  cdsIntoManagedPath: boolean,
  workingDirectory?: 'temp' | 'workspace',
): boolean {
  const targets = findShellWriteRedirectTargets(command);
  if (targets.length === 0) return false;

  return targets.some((target) => {
    if (isManagedDataPath(target)) return true;
    if (path.isAbsolute(target)) return false;
    return cdsIntoManagedPath || workingDirectory === 'workspace';
  });
}

function shellUsesDirectFileMutationCommand(command: string): boolean {
  const directMutationCommandPattern = /(?:^|[;&|]\s*|\$\(\s*|`\s*|\b(?:then|do)\s+)(?:sudo\s+)?(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|truncate|dd|rsync|install)\b/i;
  return directMutationCommandPattern.test(command);
}

function shellUsesMutatingGitCommand(command: string): boolean {
  const gitMutationPattern = /(?:^|[;&|]\s*|\$\(\s*|`\s*|\b(?:then|do)\s+)(?:sudo\s+)?git\s+(?:clean|reset|checkout|restore|switch|merge|rebase|apply|am)\b/i;
  return gitMutationPattern.test(command);
}

export function detectUnsafeBashCommand(
  command: string,
  options: { workingDirectory?: 'temp' | 'workspace'; sandboxed?: boolean } = {},
): string | null {
  const secretPatterns = [
    /\b(?:env|printenv)\b/i,
    /\bdeclare\s+-x\b/i,
    /\bset\b\s*(?:[;&|]|$)/i,
    /\bexport\b\s*(?:[;&|]|$)/i,
    /\/proc\/[^;&|`$()\s]*\/environ/i,
    /\/data\/secrets(?:\/|$)/i,
    /\/run\/secrets(?:\/|$)/i,
    /\/sys\/firmware(?:\/|$)/i,
    /Canvas-(?:Integrations|Agents)\.env/i,
    /agent-file-snapshots/i,
  ];

  if (secretPatterns.some((pattern) => pattern.test(command))) {
    return 'Commands that expose environment variables or restricted secret paths are not allowed.';
  }

  const normalized = command.replace(/\s+/g, ' ').trim();
  if (shellDataPathMentionViolatesContext(normalized)) {
    return 'Shell commands are limited to the workspace bound to this chat session. Use dedicated file tools for allowed non-workspace inputs.';
  }

  const executionContext = getAgentExecutionContext();
  const mentionsManagedPath = /\/data\/(?:workspace|workspaces|agents)(?:\/|$)/.test(normalized) ||
    Boolean(executionContext?.workspaceRoot && normalized.includes(executionContext.workspaceRoot));
  const cdsIntoManagedPath = /\bcd\s+\/data\/(?:workspace|workspaces|agents)(?:\/|$|\s)/.test(normalized);

  const isolatedTempExecution = options.sandboxed === true && options.workingDirectory === 'temp';

  if (shellUsesDirectFileMutationCommand(normalized) && !isolatedTempExecution) {
    return 'Direct shell file mutations are blocked. Use write, edit_file, apply_patch, copy_path, move_path, or delete_path so workspace permissions, revisions, and audit logs are enforced.';
  }

  if (shellUsesMutatingGitCommand(normalized)) {
    return 'Mutating git commands are blocked in bash. Use dedicated file tools or ask the user before changing repository state.';
  }

  if (!isolatedTempExecution && /\bsed\b(?=[^;&|]*\s-[A-Za-z]*i(?:\b|\.|['"]|$))/.test(normalized)) {
    return 'Unsafe in-place file edits with sed are blocked. Use edit_file or apply_patch instead.';
  }

  if (!isolatedTempExecution && /\bperl\b(?=[^;&|]*\s-[A-Za-z0-9]*p?i(?:\b|\.|['"]|$))/.test(normalized)) {
    return 'Unsafe in-place file edits with perl are blocked. Use edit_file or apply_patch instead.';
  }

  if ((mentionsManagedPath || cdsIntoManagedPath || options.workingDirectory === 'workspace') && /\btee\b/.test(normalized)) {
    return 'Shell file writes with tee in workspace or agent paths are blocked. Use write, edit_file, or apply_patch instead.';
  }

  if (
    (mentionsManagedPath || cdsIntoManagedPath || options.workingDirectory === 'workspace')
    && shellRedirectWritesManagedPath(normalized, cdsIntoManagedPath, options.workingDirectory)
  ) {
    return 'Shell redirects that write workspace or agent files are blocked. Use write, edit_file, or apply_patch instead.';
  }

  return null;
}
