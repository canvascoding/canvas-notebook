import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  buildFileTree,
  getFileStats,
  readFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  getWorkspaceFileRevision,
  sha256Buffer,
  WorkspaceFileRevisionError,
} from '@/app/lib/files/revision-guard';
import {
  ensureFileRevisionForCurrentContent,
  FileCollaborationPolicyError,
  getFileCollaborationState,
} from '@/app/lib/files/collaboration-policy';
import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from '@/app/lib/collaboration/agent-durability';
import { collaborationStateProof } from '@/app/lib/collaboration/state-proof';
import { mobileNotebookOperationIdentity, readMobileNotebookOperation, prepareMobileNotebookOperation, compactMobileNotebookOperation, type MobileNotebookOperation } from './notebook-operations';
import { runCollaborationDirectConnection } from '@/app/lib/collaboration/direct-connection';
import { readCurrentCollaborationTextSnapshot } from '@/app/lib/collaboration/agent-file-edits';
import {
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownFromYDoc,
  validateRichMarkdownYDoc,
} from '@/app/lib/collaboration/markdown-state';
import {
  loadCollaborationState,
  sha256Text,
} from '@/app/lib/collaboration/persistence';
import {
  resolveTextCollaborationState,
  selectInitialTextCollaborationRepresentation,
} from '@/app/lib/collaboration/document-state-service';
import { Y } from '@/app/lib/collaboration/server-runtime';
import type { Doc as YDoc } from 'yjs';
import { isRichTextCollaborationRepresentation, type TextCollaborationRepresentation } from '@/app/lib/collaboration/types';
import type { FileNode } from '@/app/lib/files/types';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MOBILE_TEXT_DOCUMENT_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, '.txt']);
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_INDEXED_DOCUMENTS = 5_000;
const MAX_CONTENT_SEARCH_DOCUMENTS = 200;
const MAX_CONTENT_SEARCH_BYTES = 512 * 1024;
const MAX_LIST_LIMIT = 50;

export type MobileNotebookSummary = {
  path: string;
  title: string;
  folder: string;
  excerpt: string;
  sizeBytes: number;
  modifiedAt: string;
  match: 'title' | 'path' | 'content' | null;
};

export type MobileNotebookDocument = MobileNotebookSummary & {
  content: string;
  sha256: string;
  revisionId: string;
  saveReceipt?: { operationId: string; applied: true; durable: true; projectionPending: boolean; documentSequence: number };
  canEdit: boolean;
  editBlockReason: 'READ_ONLY' | 'LIVE_COLLABORATION_ACTIVE' | null;
  collaboration: {
    strategy: string;
    requiresRevisionCheck: boolean;
    active: boolean;
  };
};

class MobileCollaborationRevisionConflict extends Error {
  constructor(public readonly currentSha256: string) {
    super('The live collaborative document changed while the mobile save was being applied.');
    this.name = 'MobileCollaborationRevisionConflict';
  }
}

type NotebookFile = {
  path: string;
  size: number;
  modified: number;
};

type ScoredNotebookFile = NotebookFile & {
  match: MobileNotebookSummary['match'];
  score: number;
};

export class MobileNotebookError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MobileNotebookError';
  }
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function isMobileTextDocumentPath(filePath: string): boolean {
  return MOBILE_TEXT_DOCUMENT_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

export function selectMobileCollaborationRepresentation(
  filePath: string,
  content: string,
): TextCollaborationRepresentation {
  return selectInitialTextCollaborationRepresentation(filePath, content);
}

export function shouldReadMobileCollaborationSnapshot(
  requestedRepresentation: TextCollaborationRepresentation,
  persistedRepresentation: TextCollaborationRepresentation,
): boolean {
  return isRichTextCollaborationRepresentation(requestedRepresentation) || persistedRepresentation === 'plain_text';
}

export function normalizeMobileNotebookPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MobileNotebookError('A Markdown or plain-text path is required.', 400, 'INVALID_NOTEBOOK_PATH');
  }
  const normalized = value.trim().replace(/\\/gu, '/');
  if (
    !normalized
    || normalized.length > 500
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || !isMobileTextDocumentPath(normalized)
  ) {
    throw new MobileNotebookError('The Markdown or plain-text path is invalid.', 400, 'INVALID_NOTEBOOK_PATH');
  }
  return normalized;
}

function normalizeQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new MobileNotebookError('Search is invalid.', 400, 'INVALID_SEARCH');
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (normalized.length > 120) throw new MobileNotebookError('Search is too long.', 400, 'INVALID_SEARCH');
  return normalized;
}

function queryHash(query: string): string {
  return createHash('sha256').update(query.toLowerCase()).digest('hex').slice(0, 12);
}

function cursorFor(offset: number, query: string): string {
  return Buffer.from(JSON.stringify({ offset, query: queryHash(query) })).toString('base64url');
}

function offsetFromCursor(cursor: unknown, query: string): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  if (typeof cursor !== 'string' || cursor.length > 200) {
    throw new MobileNotebookError('Notebook cursor is invalid.', 400, 'INVALID_CURSOR');
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || parsed.query !== queryHash(query)) {
      throw new Error('invalid');
    }
    return Number(parsed.offset);
  } catch {
    throw new MobileNotebookError('Notebook cursor is invalid.', 400, 'INVALID_CURSOR');
  }
}

function collectMarkdownFiles(nodes: FileNode[], result: NotebookFile[] = []): NotebookFile[] {
  for (const node of nodes) {
    if (result.length >= MAX_INDEXED_DOCUMENTS) break;
    if (node.type === 'file' && isMarkdownPath(node.path)) {
      result.push({ path: node.path, size: node.size || 0, modified: node.modified || 0 });
    } else if (node.type === 'directory' && node.children) {
      collectMarkdownFiles(node.children, result);
    }
  }
  return result;
}

function contentTitle(content: string, filePath: string): string {
  const heading = content.match(/^\s*#\s+(.+?)\s*$/mu)?.[1]
    ?.replace(/[*_`~[\]]/gu, '')
    .trim();
  if (heading) return heading.slice(0, 160);
  return path.posix.basename(filePath, path.posix.extname(filePath)).slice(0, 160);
}

function contentExcerpt(content: string): string {
  const withoutFrontmatter = content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, '');
  return withoutFrontmatter
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`>|~-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 220);
}

function modifiedAt(seconds: number): string {
  return new Date(Math.max(0, seconds) * 1_000).toISOString();
}

async function readSearchableContent(file: NotebookFile, options: WorkspaceFileOperationOptions): Promise<string | null> {
  if (file.size > MAX_CONTENT_SEARCH_BYTES) return null;
  try {
    return (await readFile(file.path, options)).toString('utf8');
  } catch {
    return null;
  }
}

function summaryFor(file: NotebookFile, content: string | null, match: MobileNotebookSummary['match']): MobileNotebookSummary {
  return {
    path: file.path,
    title: contentTitle(content || '', file.path),
    folder: path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path),
    excerpt: content ? contentExcerpt(content) : '',
    sizeBytes: file.size,
    modifiedAt: modifiedAt(file.modified),
    match,
  };
}

export async function listMobileNotebookDocuments(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  query?: unknown;
  cursor?: unknown;
  limit?: unknown;
}) {
  const query = normalizeQuery(input.query);
  const offset = offsetFromCursor(input.cursor, query);
  const requestedLimit = typeof input.limit === 'number' ? input.limit : Number(input.limit || 30);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_LIST_LIMIT) {
    throw new MobileNotebookError(`limit must be between 1 and ${MAX_LIST_LIMIT}.`, 400, 'INVALID_LIMIT');
  }
  const tree = await buildFileTree('.', 12, 0, { ...input.fileOptions, includeMetadata: true });
  const files = collectMarkdownFiles(tree).sort(
    (left, right) => right.modified - left.modified || left.path.localeCompare(right.path),
  );
  const contentCache = new Map<string, string>();
  let matches: ScoredNotebookFile[];

  if (query) {
    const needle = query.toLowerCase();
    const pathMatches: ScoredNotebookFile[] = [];
    for (const file of files) {
      const basename = path.posix.basename(file.path, path.posix.extname(file.path)).toLowerCase();
      if (basename.includes(needle)) pathMatches.push({ ...file, match: 'title', score: 3 });
      else if (file.path.toLowerCase().includes(needle)) pathMatches.push({ ...file, match: 'path', score: 2 });
    }
    const matchedPaths = new Set(pathMatches.map((file) => file.path));
    const searchCandidates = files.filter((file) => !matchedPaths.has(file.path)).slice(0, MAX_CONTENT_SEARCH_DOCUMENTS);
    const contentMatches = (await Promise.all(searchCandidates.map(async (file) => {
      const content = await readSearchableContent(file, input.fileOptions);
      if (!content || !content.toLowerCase().includes(needle)) return null;
      contentCache.set(file.path, content);
      return { ...file, match: 'content' as const, score: 1 };
    }))).filter((file): file is NonNullable<typeof file> => file !== null);
    matches = [...pathMatches, ...contentMatches].sort(
      (left, right) => right.score - left.score || right.modified - left.modified || left.path.localeCompare(right.path),
    );
  } else {
    matches = files.map((file) => ({ ...file, match: null, score: 0 }));
  }

  const page = matches.slice(offset, offset + requestedLimit);
  const items = await Promise.all(page.map(async (file) => {
    const cached = contentCache.get(file.path);
    const content = cached ?? await readSearchableContent(file, input.fileOptions);
    return summaryFor(file, content, file.match);
  }));
  const nextOffset = offset + page.length;
  return {
    items,
    nextCursor: nextOffset < matches.length ? cursorFor(nextOffset, query) : null,
  };
}

export async function readMobileNotebookDocument(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  path: unknown;
}): Promise<MobileNotebookDocument> {
  const filePath = normalizeMobileNotebookPath(input.path);
  let stats;
  try {
    stats = await getFileStats(filePath, input.fileOptions);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new MobileNotebookError('Notebook document was not found.', 404, 'DOCUMENT_NOT_FOUND');
    }
    throw error;
  }
  if (stats.size > MAX_DOCUMENT_BYTES) {
    throw new MobileNotebookError('Notebook documents may be at most 2 MiB.', 413, 'DOCUMENT_TOO_LARGE');
  }
  const buffer = await readFile(filePath, input.fileOptions);
  const sourceContent = buffer.toString('utf8');
  const requestedRepresentation = selectMobileCollaborationRepresentation(filePath, sourceContent);
  const sha256 = sha256Buffer(buffer);
  const revision = await ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: filePath,
    contentHash: sha256,
    sizeBytes: stats.size,
    actorUserId: input.actorUserId,
    actorType: 'user',
    sourceSessionId: null,
  });
  const collaboration = await getFileCollaborationState({
    workspace: input.workspace,
    path: filePath,
    ensureDocument: false,
  });
  let collaborationSnapshot: Awaited<ReturnType<typeof readCurrentCollaborationTextSnapshot>> | null = null;
  if (collaboration.document) {
    const { state } = await resolveTextCollaborationState({
      document: collaboration.document,
      workspace: input.workspace,
      path: filePath,
      initialRepresentation: requestedRepresentation,
      initialContent: sourceContent,
    });
    if (state.workspaceId !== input.workspace.workspaceId || state.path !== filePath) {
      throw new MobileNotebookError(
        'The collaborative document identity is stale. Reload the workspace before editing.',
        409,
        'COLLABORATION_STATE_STALE',
      );
    }
    if (shouldReadMobileCollaborationSnapshot(requestedRepresentation, state.representation)) {
      collaborationSnapshot = await readCurrentCollaborationTextSnapshot({
        documentId: collaboration.document.id,
        workspace: input.workspace,
      });
    }
  }
  const content = collaborationSnapshot?.content ?? sourceContent;
  const contentBytes = Buffer.byteLength(content, 'utf8');
  const collaborationDocumentExists = Boolean(collaboration.document);
  const canWrite = input.workspace.permissions.canWrite;
  return {
    ...summaryFor({ path: filePath, size: contentBytes, modified: stats.modified }, content, null),
    content,
    sha256: collaborationSnapshot?.sha256 ?? sha256,
    revisionId: revision.id,
    canEdit: canWrite,
    editBlockReason: !canWrite ? 'READ_ONLY' : null,
    collaboration: {
      strategy: collaboration.strategy,
      requiresRevisionCheck: collaboration.requiresRevisionCheck,
      active: collaborationDocumentExists,
    },
  };
}

function mobileOperationIncluded(doc: YDoc, expected: Uint8Array): boolean {
  const actual = captureAgentStateSnapshot(doc, Y);
  // Exact empty documents are also valid receipts; the agent containment helper
  // intentionally excludes empty snapshots as agent operation evidence.
  return Boolean(actual && Buffer.from(actual).equals(Buffer.from(expected)))
    || persistedUpdateIncludesAgentSnapshot(Y.encodeStateAsUpdate(doc), expected, Y);
}

async function waitForMobileCollaborationDurability(operation: MobileNotebookOperation) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await loadCollaborationState(operation.document_id);
    if (!state || state.status !== 'active' || state.lifecycleGeneration !== Number(operation.lifecycle_generation)
      || state.workspaceId !== operation.workspace_id || state.path !== operation.document_path
      || state.representation !== operation.representation) {
      throw new MobileNotebookError('The collaborative document lifecycle changed. Reload the note.', 409, 'COLLABORATION_STATE_STALE');
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state.yjsState);
      if (mobileOperationIncluded(doc, operation.resulting_state_snapshot)) return state;
    } finally { doc.destroy(); }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new MobileNotebookError(
    'The edit is prepared for recovery but its Yjs persistence is not confirmed. Retry the same request.',
    503, 'COLLABORATION_YJS_PENDING',
  );
}

async function saveMobileCollaborativeNotebookDocument(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId: string;
  path: string;
  content: string;
  expectedSha256: string;
  baseRevisionId: string;
  idempotencyKey?: string;
  documentId: string;
  currentRevisionId: string | null;
}): Promise<MobileNotebookDocument> {
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    const persistedState = await loadCollaborationState(input.documentId);
    if (!persistedState || persistedState.workspaceId !== input.workspace.workspaceId || persistedState.path !== input.path) {
      throw new MobileNotebookError('The collaborative document is unavailable. Reload the note.', 409, 'COLLABORATION_STATE_STALE');
    }
    const identity = mobileNotebookOperationIdentity({ ...input, workspaceId: input.workspace.workspaceId, userId: input.actorUserId });
    const origin = { actorType: 'user' as const, actorId: input.actorUserId, sessionId: input.actorSessionId, operationId: identity.operationId };
    const connection = {
      documentId: input.documentId, documentPath: persistedState.path,
      documentRepresentation: persistedState.representation, documentLifecycleGeneration: persistedState.lifecycleGeneration,
      documentSchemaVersion: persistedState.schemaVersion, requiresFileCheckpointIdentity: false,
      workspace: input.workspace, actorId: input.actorUserId, actorDisplayName: 'Mobile editor',
      initiatedByUserId: input.actorUserId, operationId: identity.operationId, actorType: 'user' as const,
      actorSessionId: input.actorSessionId,
    };
    let operation = await readMobileNotebookOperation(identity.operationId);
    if (operation && (operation.fingerprint !== identity.fingerprint || operation.user_id !== input.actorUserId
      || operation.document_id !== input.documentId || operation.workspace_id !== input.workspace.workspaceId
      || Number(operation.lifecycle_generation) !== persistedState.lifecycleGeneration
      || operation.representation !== persistedState.representation || operation.document_path !== input.path)) {
      throw new MobileNotebookError('The operation key belongs to a different edit or document lifecycle.', 409, 'IDEMPOTENCY_CONFLICT');
    }
    try {
      if (!operation) {
        if (input.currentRevisionId && input.currentRevisionId !== input.baseRevisionId) {
          throw new FileCollaborationPolicyError({ code: 'FILE_REVISION_ID_CONFLICT', status: 409,
            message: 'File revision conflict: reload the latest version before saving.', path: input.path,
            currentRevisionId: input.currentRevisionId, baseRevisionId: input.baseRevisionId });
        }
        operation = await runCollaborationDirectConnection(connection, (doc): MobileNotebookOperation => {
          const currentContent = isRichTextCollaborationRepresentation(persistedState.representation)
            ? richMarkdownFromYDoc(doc) : doc.getText('content').toString();
          if (sha256Text(currentContent) !== input.expectedSha256) throw new MobileCollaborationRevisionConflict(sha256Text(currentContent));
          const baseProof = collaborationStateProof(doc, Y);
          if (!baseProof) throw new MobileNotebookError('The document is waiting for missing updates.', 409, 'COLLABORATION_STATE_STALE');
          const planned = new Y.Doc();
          try {
            Y.applyUpdate(planned, Y.encodeStateAsUpdate(doc));
            if (isRichTextCollaborationRepresentation(persistedState.representation)) {
              const candidate = createRichMarkdownYDoc(input.content);
              let normalized: string;
              try { normalized = richMarkdownFromYDoc(candidate); } finally { candidate.destroy(); }
              if (normalized !== input.content && normalized !== input.content.replace(/\n$/u, '')) {
                throw new MobileNotebookError('This source cannot be represented losslessly by the live editor.', 422, 'COLLABORATION_MARKDOWN_UNSUPPORTED');
              }
              replaceRichMarkdownInYDoc(planned, normalized, origin);
              const validation = validateRichMarkdownYDoc(planned);
              if (!validation.valid || validation.markdown !== normalized) {
                throw new MobileNotebookError('This source cannot be represented losslessly by the live editor.', 422, 'COLLABORATION_MARKDOWN_UNSUPPORTED');
              }
            } else {
              planned.transact(() => {
                const text = planned.getText('content');
                if (text.length) text.delete(0, text.length);
                if (input.content) text.insert(0, input.content);
              }, origin);
            }
            const snapshot = captureAgentStateSnapshot(planned, Y);
            if (!snapshot) throw new MobileNotebookError('The prepared edit is incomplete.', 409, 'COLLABORATION_STATE_STALE');
            return { operation_id: identity.operationId, document_id: input.documentId, workspace_id: input.workspace.workspaceId,
              user_id: input.actorUserId, lifecycle_generation: persistedState.lifecycleGeneration,
              representation: persistedState.representation, document_path: input.path, fingerprint: identity.fingerprint,
              base_state_proof: baseProof, resulting_state_snapshot: snapshot,
              yjs_update: Y.encodeStateAsUpdate(planned, Y.encodeStateVector(doc)) };
          } finally { planned.destroy(); }
        });
        await prepareMobileNotebookOperation(operation);
      }
      const prepared = operation;
      await runCollaborationDirectConnection(connection, (doc) => {
        if (mobileOperationIncluded(doc, prepared.resulting_state_snapshot)) return;
        if (!prepared.yjs_update || collaborationStateProof(doc, Y) !== prepared.base_state_proof) {
          const content = isRichTextCollaborationRepresentation(persistedState.representation)
            ? richMarkdownFromYDoc(doc) : doc.getText('content').toString();
          throw new MobileCollaborationRevisionConflict(sha256Text(content));
        }
        // Replaying the exact server-prepared delta is idempotent, including
        // after response loss and subsequent peer changes to its text.
        doc.transact(() => Y.applyUpdate(doc, prepared.yjs_update!, origin), origin);
      });
    } catch (error) {
      if (error instanceof MobileCollaborationRevisionConflict) {
        throw new WorkspaceFileRevisionError({ code: 'FILE_REVISION_CONFLICT', status: 409,
          message: 'File revision conflict: the live document changed. Reload before saving.', path: input.path,
          expectedSha256: input.expectedSha256, currentSha256: error.currentSha256,
          currentStats: (await getWorkspaceFileRevision(input.path, input.fileOptions))?.stats ?? null });
      }
      throw error;
    }
    const durable = await waitForMobileCollaborationDurability(operation);
    // This is only compaction; the retained prepared delta remains safe if it fails.
    await compactMobileNotebookOperation(operation.operation_id).catch(() => undefined);
    return { ...await readMobileNotebookDocument(input), saveReceipt: {
      operationId: operation.operation_id, applied: true, durable: true,
      projectionPending: durable.checkpointSequence < durable.documentSequence,
      documentSequence: durable.documentSequence,
    } };
  });
}

export async function saveMobileNotebookDocument(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId: string;
  path: unknown;
  content: unknown;
  expectedSha256: unknown;
  baseRevisionId: unknown;
  idempotencyKey?: unknown;
}): Promise<MobileNotebookDocument> {
  const filePath = normalizeMobileNotebookPath(input.path);
  if (typeof input.content !== 'string') {
    throw new MobileNotebookError('Markdown content is required.', 400, 'INVALID_CONTENT');
  }
  if (Buffer.byteLength(input.content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new MobileNotebookError('Notebook documents may be at most 2 MiB.', 413, 'DOCUMENT_TOO_LARGE');
  }
  if (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new MobileNotebookError('A current document hash is required.', 428, 'FILE_REVISION_REQUIRED');
  }
  if (typeof input.baseRevisionId !== 'string' || !input.baseRevisionId.trim()) {
    throw new MobileNotebookError('A current document revision is required.', 428, 'FILE_REVISION_REQUIRED');
  }
  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9:_-]{8,200}$/u.test(input.idempotencyKey))) {
    throw new MobileNotebookError('A valid operation key is required.', 400, 'INVALID_OPERATION_KEY');
  }
  const collaboration = await getFileCollaborationState({
    workspace: input.workspace,
    path: filePath,
    ensureDocument: false,
  });
  if (collaboration.document) {
    return saveMobileCollaborativeNotebookDocument({
      ...input,
      path: filePath,
      content: input.content,
      expectedSha256: input.expectedSha256,
      baseRevisionId: input.baseRevisionId.trim(),
      idempotencyKey: input.idempotencyKey as string | undefined,
      documentId: collaboration.document.id,
      currentRevisionId: collaboration.latestRevision?.id ?? null,
    });
  }
  await writeWorkspaceFileContent({
    workspace: input.workspace,
    fileOptions: input.fileOptions,
    actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId,
    path: filePath,
    content: input.content,
    expectedSha256: input.expectedSha256,
    requireExpectedRevision: true,
    baseRevisionId: input.baseRevisionId.trim(),
    ensureCollaborationDocument: false,
  });
  return readMobileNotebookDocument({ ...input, path: filePath });
}

function noteName(value: unknown): string {
  if (typeof value !== 'string') throw new MobileNotebookError('A note title is required.', 400, 'INVALID_TITLE');
  const normalized = value.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!normalized) throw new MobileNotebookError('A note title is required.', 400, 'INVALID_TITLE');
  return normalized.slice(0, 100);
}

function noteFolder(value: unknown): string {
  if (value === undefined || value === null || value === '' || value === '.') return '';
  if (typeof value !== 'string') throw new MobileNotebookError('The note folder is invalid.', 400, 'INVALID_FOLDER');
  const normalized = value.trim().replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized.length > 380 || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new MobileNotebookError('The note folder is invalid.', 400, 'INVALID_FOLDER');
  }
  return normalized;
}

export async function createMobileNotebookDocument(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  actorSessionId: string;
  title: unknown;
  folder?: unknown;
}): Promise<MobileNotebookDocument> {
  const title = noteName(input.title);
  const folder = noteFolder(input.folder);
  const basename = title.slice(0, 80);
  let createdPath = '';
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const filename = `${basename}${suffix === 1 ? '' : ` (${suffix})`}.md`;
    const candidate = normalizeMobileNotebookPath(folder ? path.posix.join(folder, filename) : filename);
    try {
      await writeWorkspaceFileContent({
        workspace: input.workspace,
        fileOptions: input.fileOptions,
        actorUserId: input.actorUserId,
        actorSessionId: input.actorSessionId,
        path: candidate,
        content: `# ${title}\n\n`,
        createOnly: true,
        ensureCollaborationDocument: false,
      });
      createdPath = candidate;
      break;
    } catch (error) {
      if (
        error && typeof error === 'object' && 'code' in error
        && error.code === 'FILE_REVISION_CONFLICT'
      ) continue;
      throw error;
    }
  }
  if (!createdPath) throw new MobileNotebookError('Could not allocate a unique note name.', 409, 'NOTE_NAME_CONFLICT');
  return readMobileNotebookDocument({ ...input, path: createdPath });
}
