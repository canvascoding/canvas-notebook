import 'server-only';

import { constants, promises as fs } from 'node:fs';
import { types } from 'node:util';
import { getSchema } from '@tiptap/core';
import { openDb, type SqlConnection } from '../db';
import { filesystemFileVersion } from '../filesystem/file-version';
import { resolveExistingWorkspacePath } from '../filesystem/workspace-files';
import type { WorkspaceContext } from '../workspaces/types';
import { readNativeCollaborationDocument, type NativeCollaborationContent } from './document-snapshot';
import { richMarkdownSchemaExtensions } from './markdown-state';
import { loadCollaborationStateOnConnection } from './persistence';
import { collaborationAdmissionLockKey, isCanonicalAdmissionPath } from './room-admission-contract';
import { readWorkspaceDocumentCatalogue } from './workspace-document-catalogue';
import { DocumentReadError } from '../documents/contracts';
import { assertNativeSearchContentWithinBudget } from './native-search-budget';

export class WorkspaceSearchReadError extends Error {
  constructor(readonly code: 'SOURCE_UNAVAILABLE' | 'SOURCE_TOO_LARGE' | 'SOURCE_BINARY') {
    super('The current workspace search source is unavailable.');
    this.name = 'WorkspaceSearchReadError';
  }
}

type Dependencies = {
  openConnection?: () => Promise<SqlConnection>;
  readCatalogue?: typeof readWorkspaceDocumentCatalogue;
  readNative?: typeof readNativeCollaborationDocument;
  loadState?: typeof loadCollaborationStateOnConnection;
  readPhysical?: typeof readPhysicalSearchText;
};
export type WorkspaceSearchText = {
  content: string;
  /** Milliseconds since Unix epoch; null for newer, not-yet-durable room edits. */
  modifiedAt: number | null;
  source: 'file' | 'live_yjs' | 'persisted_yjs';
  /** Identity belongs to this native content read, never a later path lookup. */
  nativeIdentity: Readonly<{ documentId: string; lineageId: string | null; path: string }> | null;
};

/** Semantic text for retrieval. This is deliberately not a Markdown export. */
export function nativeCollaborationSearchText(content: NativeCollaborationContent, options?: Readonly<{ maxBytes: number }>): string {
  if (options !== undefined) {
    if (!options || typeof options !== 'object' || types.isProxy(options)
      || Object.getPrototypeOf(options) !== Object.prototype) throw new DocumentReadError('INVALID_REQUEST');
    const descriptor = options && typeof options === 'object' ? Object.getOwnPropertyDescriptor(options, 'maxBytes') : undefined;
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 1 || descriptor.value > 256 * 1024
      || Reflect.ownKeys(options).length !== 1) throw new DocumentReadError('INVALID_REQUEST');
    const maxBytes = descriptor.value as number, pieces: string[] = [];
    let bytes = 0;
    const append = (value: string) => {
      if (value.length > maxBytes - bytes) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > maxBytes) throw new DocumentReadError('DOCUMENT_TOO_LARGE');
      pieces.push(value);
    };
    assertNativeSearchContentWithinBudget(content);
    if (content.kind === 'plain_text') { append(content.text); return pieces.join(''); }
    const document = getSchema(richMarkdownSchemaExtensions()).nodeFromJSON(content.document);
    document.check();
    append(content.frontmatter);
    let first = true;
    document.nodesBetween(0, document.content.size, node => {
      let text = node.isText ? node.text! : '';
      if (!node.isText && node.isLeaf) {
        if (node.type.name === 'hardBreak') text = '\n';
        else if (node.type.name === 'markdownMention') text = `@${node.attrs.label ?? ''}`;
        else for (const key of ['label', 'alt', 'target', 'latex']) {
          if (typeof node.attrs[key] === 'string' && node.attrs[key]) { text = node.attrs[key]; break; }
        }
      }
      if (node.isBlock && (node.isLeaf && text || node.isTextblock)) {
        if (first) first = false; else append('\n');
      }
      append(text);
    });
    return pieces.join('');
  }
  if (content.kind === 'plain_text') return content.text;
  const document = getSchema(richMarkdownSchemaExtensions()).nodeFromJSON(content.document);
  document.check();
  const text = document.textBetween(0, document.content.size, '\n', (leaf) => {
    if (leaf.type.name === 'hardBreak') return '\n';
    if (leaf.type.name === 'markdownMention') return `@${leaf.attrs.label ?? ''}`;
    for (const key of ['label', 'alt', 'target', 'latex']) {
      if (typeof leaf.attrs[key] === 'string' && leaf.attrs[key]) return leaf.attrs[key];
    }
    return '';
  });
  return content.frontmatter + text;
}

async function readPhysicalSearchText(workspace: WorkspaceContext, filePath: string, maxBytes: number): Promise<WorkspaceSearchText> {
  const fullPath = await resolveExistingWorkspacePath(filePath, { workspace });
  const handle = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
    if (before.size > maxBytes) throw new WorkspaceSearchReadError('SOURCE_TOO_LARGE');
    // Bound the allocation even if an external writer grows this open file.
    const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (filesystemFileVersion(before) !== filesystemFileVersion(after) || count !== before.size) {
      throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
    }
    if (count > maxBytes) throw new WorkspaceSearchReadError('SOURCE_TOO_LARGE');
    const captured = bytes.subarray(0, count);
    if (captured.includes(0)) throw new WorkspaceSearchReadError('SOURCE_BINARY');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured); }
    catch { throw new WorkspaceSearchReadError('SOURCE_BINARY'); }
    return { content, modifiedAt: after.mtimeMs, source: 'file', nativeIdentity: null };
  } finally { await handle.close(); }
}

function assertReadable(workspace: WorkspaceContext): void {
  if (!workspace.workspaceId || !workspace.permissions.canRead
    || workspace.status !== undefined && workspace.status !== 'active') throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
}

/** Registry-only documents must be discoverable even when their projection is absent. */
export async function listWorkspaceSearchDocuments(workspace: WorkspaceContext, scope: string,
  dependencies: Pick<Dependencies, 'openConnection' | 'readCatalogue'> = {}): Promise<string[]> {
  assertReadable(workspace);
  if (scope !== '.' && !isCanonicalAdmissionPath(scope)) throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
  const connection = await (dependencies.openConnection ?? openDb)();
  let transaction = false;
  let discard: Error | undefined;
  try {
    await connection.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const documents = await (dependencies.readCatalogue ?? readWorkspaceDocumentCatalogue)(connection, workspace, { paths: [scope] });
    await connection.run('COMMIT'); transaction = false;
    return documents.map(document => document.path);
  } finally {
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved workspace search catalogue transaction.'); }
    await connection.close(discard);
  }
}

/** No initialization, revision creation, license gate or projection fallback for initialized documents. */
export async function readWorkspaceSearchText(workspace: WorkspaceContext, filePath: string, maxBytes: number,
  dependencies: Dependencies = {}): Promise<WorkspaceSearchText> {
  assertReadable(workspace);
  if (!isCanonicalAdmissionPath(filePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) {
    throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
  }
  workspace = structuredClone(workspace);
  const connection = await (dependencies.openConnection ?? openDb)();
  let transaction = false;
  let discard: Error | undefined;
  try {
    await connection.run('BEGIN'); transaction = true;
    await connection.run("SET LOCAL statement_timeout='5s'");
    await connection.run("SET LOCAL lock_timeout='4s'");
    // Share the workspace lifecycle kernel fence while choosing authority and
    // reading it. Ordinary room edits remain possible; move/import cannot race
    // a pristine physical read into a fallback for an initialized document.
    await connection.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
    const catalogue = await (dependencies.readCatalogue ?? readWorkspaceDocumentCatalogue)(connection, workspace, { paths: [filePath] });
    const document = catalogue.find(entry => entry.path === filePath);
    let result: WorkspaceSearchText;
    if (document?.authority === 'missing-state') throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
    if (document?.authority === 'initialized') {
      if (document.lifecycle_generation === null) throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
      const read = await (dependencies.readNative ?? readNativeCollaborationDocument)({
        workspace, path: filePath, documentId: document.id, lifecycleGeneration: document.lifecycle_generation,
        loadState: documentId => (dependencies.loadState ?? loadCollaborationStateOnConnection)(connection, documentId),
      });
      if (read.documentId !== document.id || read.path !== filePath || read.workspaceId !== workspace.workspaceId
        || read.organizationId !== (workspace.organizationId ?? null)
        || read.lifecycleGeneration !== document.lifecycle_generation) {
        throw new WorkspaceSearchReadError('SOURCE_UNAVAILABLE');
      }
      result = { content: nativeCollaborationSearchText(read.observed.content), source: read.source,
        modifiedAt: read.observed.durable ? read.durable.persistedAt : null,
        nativeIdentity: Object.freeze({ documentId: read.documentId, lineageId: document.lineage_id, path: read.path }) };
    } else result = await (dependencies.readPhysical ?? readPhysicalSearchText)(workspace, filePath, maxBytes);
    if (Buffer.byteLength(result.content, 'utf8') > maxBytes) throw new WorkspaceSearchReadError('SOURCE_TOO_LARGE');
    await connection.run('COMMIT'); transaction = false;
    return result;
  } finally {
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved workspace search source transaction.'); }
    await connection.close(discard);
  }
}
