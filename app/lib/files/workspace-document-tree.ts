import 'server-only';

import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeWorkspaceFilesRead } from '../collaboration/workspace-native-file-read';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import type { WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import { buildFileTree } from '../filesystem/workspace-files';
import { assertWorkspacePathHasNoAliases, normalizeWorkspaceRelativePath, resolveWorkspacePath } from '../workspaces/path-guard';
import type { WorkspaceContext } from '../workspaces/types';
import { isInternalWorkspaceStagingPath } from './internal-staging-path';
import type { FileNode } from './types';

const MAX_CATALOGUE_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 64;
// These are the same visibility rules as the physical listing. A native-only
// descendant must not make private implementation directories visible again.
const IGNORED_DIRECTORIES = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', '.canvas-brand', '.canvas-copy-backups']);
const HIDDEN_FILES = new Set(['.gitkeep', '.keep']);
type CatalogueDocument = Readonly<WorkspaceDocumentCatalogueEntry>;

export type WorkspaceDocumentTreeDependencies = NonNullable<Parameters<typeof withNativeWorkspaceFilesRead>[2]> & {
  /** May return cached physical nodes; the merge never mutates that cache. */
  buildPhysicalTree?: typeof buildFileTree;
};
export type WorkspaceDocumentTreeOptions = { includeMetadata?: boolean };

export class WorkspaceDocumentTreeError extends Error {
  constructor(readonly code: 'TREE_NAME_CONFLICT' | 'TREE_SOURCE_CHANGED' | 'TREE_INVALID_PATH' | 'TREE_DIRECTORY_NOT_FOUND', message: string, readonly status = 409) {
    super(message); this.name = 'WorkspaceDocumentTreeError';
  }
}

function invalid(message = 'Invalid workspace tree path.'): never {
  throw new WorkspaceDocumentTreeError('TREE_INVALID_PATH', message, 400);
}
function conflict(): never {
  throw new WorkspaceDocumentTreeError('TREE_NAME_CONFLICT', 'A native document conflicts with the workspace directory namespace.');
}
function canonicalDirectory(directory: string): string {
  const normalized = normalizeWorkspaceRelativePath(directory);
  if (normalized !== '.' && !isCanonicalAdmissionPath(normalized)) invalid();
  return normalized;
}
function assertDepth(depth: number): void {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_TREE_DEPTH) invalid('Invalid workspace tree depth.');
}
function inScope(filePath: string, directory: string): boolean {
  return directory === '.' || filePath === directory || filePath.startsWith(`${directory}/`);
}
function visible(filePath: string, type: FileNode['type']): boolean {
  const parts = filePath.split('/');
  if (parts[0] === '.canvas-skill-drafts' && (type === 'directory' || parts.length > 1)) return false;
  const directories = type === 'directory' ? parts : parts.slice(0, -1);
  if (directories.some(part => IGNORED_DIRECTORIES.has(part))) return false;
  return type !== 'file' || !HIDDEN_FILES.has(parts.at(-1)!) && !isInternalWorkspaceStagingPath(filePath);
}
function unavailable(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

/** Namespace-only union. No native content is decoded/exported, and an absent
 * initialized or lost-state projection is never evidence of a deleted file.
 * `depth=0` returns immediate children, matching buildFileTree's contract. */
export function mergeWorkspaceDocumentTree(
  physicalNodes: readonly FileNode[], catalogueDocuments: readonly CatalogueDocument[], directory: string, depth: number,
): FileNode[] {
  directory = canonicalDirectory(directory); assertDepth(depth);
  if (catalogueDocuments.length > MAX_CATALOGUE_ENTRIES) {
    throw Object.assign(new Error('Too many native documents in this tree scope.'), { status: 413, code: 'NATIVE_CATALOGUE_TOO_LARGE' });
  }
  // Detach every nested annotation as well as children: callers may enrich the
  // returned view while retaining their original physical cache unchanged.
  const physical = structuredClone([...physicalNodes]);
  const entries = new Map<string, FileNode>(), names = new Map<string, string>();
  const relative = (filePath: string) => directory === '.' ? filePath : filePath.slice(directory.length + 1);
  const register = (node: FileNode) => {
    const existing = entries.get(node.path);
    if (existing && existing.type !== node.type) conflict();
    const key = node.path.normalize('NFC').toLocaleLowerCase('en-US'), prior = names.get(key);
    if (prior !== undefined && prior !== node.path) conflict();
    names.set(key, node.path); entries.set(node.path, node);
  };
  const visit = (nodes: FileNode[], parent: string) => {
    for (const node of nodes) {
      if (!isCanonicalAdmissionPath(node.path) || node.name !== path.posix.basename(node.path)
        || path.posix.dirname(node.path) !== parent || !inScope(node.path, directory)
        || !['file', 'directory'].includes(node.type) || node.type === 'file' && node.children !== undefined) invalid();
      if (!visible(node.path, node.type)) continue;
      if (entries.has(node.path)) conflict();
      register(node);
      if (node.children) visit(node.children, node.path);
    }
  };
  visit(physical, directory);
  const cataloguePaths = new Set<string>(), ids = new Set<string>();
  let catalogueScope: string | undefined;
  for (const document of catalogueDocuments) {
    const scope = JSON.stringify([document.workspace_id, document.organization_id]);
    if (!document.id || !isCanonicalAdmissionPath(document.path) || !inScope(document.path, directory)
      || document.status !== 'active' || !['initialized', 'pristine', 'missing-state'].includes(document.authority)
      || !Number.isSafeInteger(document.state_version) || document.state_version < 0
      || cataloguePaths.has(document.path) || ids.has(document.id)
      || catalogueScope !== undefined && catalogueScope !== scope) {
      throw new WorkspaceDocumentTreeError('TREE_SOURCE_CHANGED', 'The native tree catalogue is inconsistent.');
    }
    catalogueScope = scope; cataloguePaths.add(document.path); ids.add(document.id);
  }
  for (const document of catalogueDocuments) {
    if (!visible(document.path, 'file')) continue;
    if (document.path === directory) conflict();
    const parts = relative(document.path).split('/');
    for (let index = 1; index <= parts.length; index++) {
      const filePath = directory === '.' ? parts.slice(0, index).join('/') : `${directory}/${parts.slice(0, index).join('/')}`;
      const leaf = index === parts.length, current = entries.get(filePath);
      if (current && current.type !== (leaf ? 'file' : 'directory') || !leaf && cataloguePaths.has(filePath)) conflict();
      // A pristine registration alone does not establish either the file or
      // virtual parents. Existing physical nodes keep their actual metadata.
      if (document.authority === 'pristine' || index - 1 > depth) continue;
      const node: FileNode = current ?? { name: parts[index - 1], path: filePath, type: leaf ? 'file' : 'directory' };
      if (leaf) {
        // Projection stats describe a cache, including when native state is
        // missing. This namespace read makes no content-size/time/mode claim.
        delete node.size; delete node.modified; delete node.created; delete node.permissions; delete node.metadataTarget;
      }
      register(node);
    }
  }
  const byParent = new Map<string, FileNode[]>();
  for (const node of entries.values()) {
    if (relative(node.path).split('/').length - 1 > depth) continue;
    const parent = path.posix.dirname(node.path), siblings = byParent.get(parent) ?? [];
    siblings.push(node); byParent.set(parent, siblings);
  }
  const materialize = (parent: string, level: number): FileNode[] => (byParent.get(parent) ?? [])
    .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) || a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1)
    .map(node => {
      const result = { ...node }; delete result.children;
      if (result.type === 'directory' && level < depth) result.children = materialize(result.path, level + 1);
      return result;
    });
  return materialize(directory, 0);
}

/** Read an authenticated workspace's visible namespace under the existing
 * shared lifecycle admission fence and final catalogue comparison. This never
 * calls scope.readFile, initializes state, or reads projection content. */
export async function readWorkspaceDocumentTree(
  workspace: WorkspaceContext, directory = '.', depth = 4, options: WorkspaceDocumentTreeOptions = {},
  dependencies: WorkspaceDocumentTreeDependencies = {},
): Promise<FileNode[]> {
  workspace = structuredClone(workspace); directory = canonicalDirectory(directory); assertDepth(depth);
  return withNativeWorkspaceFilesRead({ workspace, paths: [directory], maxEntries: MAX_CATALOGUE_ENTRIES }, async scope => {
    for (const document of scope.documents) {
      if (document.workspace_id !== workspace.workspaceId || document.organization_id !== (workspace.organizationId ?? null)) {
        throw new WorkspaceDocumentTreeError('TREE_SOURCE_CHANGED', 'The native tree catalogue belongs to another workspace.');
      }
    }
    // buildFileTree's physical primitive may create a missing root. A read of
    // a logical folder must instead prove that the real workspace already exists.
    const root = await fs.realpath(resolveWorkspacePath(workspace, '.').absolutePath).catch(() => {
      throw new WorkspaceDocumentTreeError('TREE_SOURCE_CHANGED', 'The workspace root is unavailable.');
    });
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory()) conflict();
    const assertRoot = async () => {
      const current = await fs.lstat(root);
      if (await fs.realpath(workspace.rootPath) !== root || !current.isDirectory()
        || current.dev !== rootStat.dev || current.ino !== rootStat.ino) {
        throw new WorkspaceDocumentTreeError('TREE_SOURCE_CHANGED', 'The workspace root changed while reading its tree.');
      }
    };
    const nativeChildren = scope.documents.some(document => document.authority !== 'pristine'
      && document.path !== directory && inScope(document.path, directory) && visible(document.path, 'file'));
    if (scope.documents.some(document => document.path === directory && document.authority !== 'pristine')) conflict();
    let logicalDirectory = false;
    try {
      await assertWorkspacePathHasNoAliases(workspace, directory, { readOnly: true });
      const selected = await fs.lstat(directory === '.' ? root : resolveWorkspacePath(workspace, directory).absolutePath);
      if (!selected.isDirectory()) conflict();
    } catch (error) {
      if (unavailable(error, 'ENOTDIR')) conflict();
      if (directory === '.' || !unavailable(error, 'ENOENT')) throw error;
      if (!nativeChildren) {
        await assertRoot();
        throw new WorkspaceDocumentTreeError('TREE_DIRECTORY_NOT_FOUND', 'The selected workspace directory does not exist.', 404);
      }
      logicalDirectory = true;
    }
    // A missing suffix is valid; an actual file/alias in a native parent's
    // location is not. These are path/type observations, never text reads.
    for (const document of scope.documents) {
      if (!visible(document.path, 'file')) continue;
      try {
        await assertWorkspacePathHasNoAliases(workspace, document.path, { readOnly: true });
        const projection = await fs.lstat(resolveWorkspacePath(workspace, document.path).absolutePath);
        if (!projection.isFile()) conflict();
      } catch (error) {
        if (unavailable(error, 'ENOTDIR')) conflict();
        if (!unavailable(error, 'ENOENT')) throw error;
      }
    }
    const physical = logicalDirectory ? [] : await (dependencies.buildPhysicalTree ?? buildFileTree)(directory, depth, 0, {
      workspace, includeMetadata: options.includeMetadata ?? true, includeSymlinks: false, strictMetadata: true,
    }).catch(error => {
      if (unavailable(error, 'ENOENT')) {
        throw new WorkspaceDocumentTreeError('TREE_SOURCE_CHANGED', 'The workspace directory changed while reading its tree.');
      }
      throw error;
    });
    const merged = mergeWorkspaceDocumentTree(physical, scope.documents, directory, depth);
    await assertRoot();
    return merged;
  }, dependencies);
}
