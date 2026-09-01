import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  buildFileTree,
  getFileStats,
  listDirectory,
  readFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  getPublicShareAnnotations,
  getPublicShareMimeType,
  type PublicShareAnnotation,
} from '@/app/lib/public-sharing/public-file-shares';
import { enrichWorkspaceFileNodes } from '@/app/lib/files/workspace-file-metadata';
import { sortFileNodes } from '@/app/lib/files/sort';
import type { FileNode } from '@/app/lib/files/types';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { hasMarpFileName, isMarpMarkdown } from '@/app/lib/marp/detect';

const MAX_LIST_LIMIT = 80;
const MAX_SEARCH_ENTRIES = 10_000;
const MAX_TREE_DEPTH = 12;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mkv', 'mov', 'mp4', 'webm']);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav']);
const MARKDOWN_EXTENSIONS = new Set(['markdown', 'md']);
const WORD_EXTENSIONS = new Set(['doc', 'docx', 'rtf']);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'ods', 'tsv', 'xls', 'xlsx']);
const PRESENTATION_EXTENSIONS = new Set(['odp', 'ppt', 'pptx']);
const DOCUMENT_EXTENSIONS = new Set([
  'csv', 'doc', 'docx', 'htm', 'html', 'json', 'log', 'markdown', 'md', 'odp', 'ods', 'pdf', 'ppt', 'pptx', 'rtf', 'text',
  'tsv', 'txt', 'xls', 'xlsx', 'xml', 'yaml', 'yml',
]);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'zip']);
const TEXT_EXTENSIONS = new Set([
  'css', 'csv', 'htm', 'html', 'ini', 'js', 'json', 'jsx', 'log', 'markdown', 'md', 'mjs', 'py', 'sh', 'toml', 'ts', 'tsx',
  'tsv', 'txt', 'xml', 'yaml', 'yml',
]);

export type MobileFileCategory = 'folder' | 'document' | 'image' | 'video' | 'audio' | 'archive' | 'other';
export type MobileFileFilter = 'all' | Exclude<MobileFileCategory, 'folder'>;
export type MobileFileSort = 'name' | 'modified' | 'size';
export type MobileFileSortOrder = 'asc' | 'desc';
export type MobileFileOpenKind =
  | 'folder'
  | 'markdown'
  | 'text'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'video'
  | 'audio'
  | 'excalidraw'
  | 'archive'
  | 'external';

export type MobileFileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  category: MobileFileCategory;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
  openKind: MobileFileOpenKind;
  renderKind: 'marp' | null;
  canPreview: boolean;
  /** @deprecated Mobile clients should route Markdown through openKind. */
  canOpenInNotebook: boolean;
  publicShare: {
    id: string;
    status: 'active';
    url: string;
    expiresAt: string | null;
    accessCount: number;
  } | null;
  /** Optional custom title shared across the user's clients. */
  title: string | null;
  /** Human-readable file or folder format. */
  format: string;
  createdAt: string | null;
  isFavorite: boolean;
  pinnedAt: string | null;
};

export type MobileFileDetail = MobileFileEntry & {
  previewMode: 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'download';
  content: string | null;
  contentTruncated: boolean;
};

export class MobileFilesError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MobileFilesError';
  }
}

export function normalizeMobileFilePath(value: unknown, allowRoot = true): string {
  if (value === undefined || value === null || value === '') {
    if (allowRoot) return '.';
    throw new MobileFilesError('A file path is required.', 400, 'INVALID_FILE_PATH');
  }
  if (typeof value !== 'string') throw new MobileFilesError('The file path is invalid.', 400, 'INVALID_FILE_PATH');
  const normalized = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (allowRoot && normalized === '.') return '.';
  if (
    !normalized
    || normalized.length > 500
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new MobileFilesError('The file path is invalid.', 400, 'INVALID_FILE_PATH');
  }
  return normalized;
}

function normalizeQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new MobileFilesError('Search is invalid.', 400, 'INVALID_SEARCH');
  const query = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (query.length > 120) throw new MobileFilesError('Search is too long.', 400, 'INVALID_SEARCH');
  return query;
}

function normalizeFilter(value: unknown): MobileFileFilter {
  const filter = typeof value === 'string' ? value : 'all';
  if (['all', 'document', 'image', 'video', 'audio', 'archive', 'other'].includes(filter)) {
    return filter as MobileFileFilter;
  }
  throw new MobileFilesError('File filter is invalid.', 400, 'INVALID_FILTER');
}

function normalizeSort(value: unknown): MobileFileSort | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && ['name', 'modified', 'size'].includes(value)) {
    return value as MobileFileSort;
  }
  throw new MobileFilesError('File sort is invalid.', 400, 'INVALID_SORT');
}

function normalizeSortOrder(value: unknown, sort: MobileFileSort | null): MobileFileSortOrder | null {
  if (!sort) {
    if (value === undefined || value === null || value === '') return null;
    throw new MobileFilesError('File sort order requires a sort field.', 400, 'INVALID_SORT_ORDER');
  }
  if (value === undefined || value === null || value === '') return sort === 'name' ? 'asc' : 'desc';
  if (value === 'asc' || value === 'desc') return value;
  throw new MobileFilesError('File sort order is invalid.', 400, 'INVALID_SORT_ORDER');
}

function extensionFor(filePath: string): string {
  return path.posix.extname(filePath).slice(1).toLowerCase();
}

export function mobileFileCategory(filePath: string, type: FileNode['type']): MobileFileCategory {
  if (type === 'directory') return 'folder';
  const extension = extensionFor(filePath);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'other';
}

function previewMode(filePath: string, category: MobileFileCategory): MobileFileDetail['previewMode'] {
  const extension = extensionFor(filePath);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (extension === 'pdf') return 'pdf';
  if (category === 'image') return 'image';
  if (category === 'video') return 'video';
  if (category === 'audio') return 'audio';
  return 'download';
}

export function mobileFileOpenKind(filePath: string, type: FileNode['type']): MobileFileOpenKind {
  if (type === 'directory') return 'folder';
  const extension = extensionFor(filePath);
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (extension === 'excalidraw') return 'excalidraw';
  if (extension === 'pdf') return 'pdf';
  if (WORD_EXTENSIONS.has(extension)) return 'word';
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (PRESENTATION_EXTENSIONS.has(extension)) return 'presentation';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  const category = mobileFileCategory(filePath, type);
  if (category === 'image') return 'image';
  if (category === 'video') return 'video';
  if (category === 'audio') return 'audio';
  if (category === 'archive') return 'archive';
  return 'external';
}

function modifiedAt(seconds: number | undefined): string {
  return new Date(Math.max(0, seconds || 0) * 1_000).toISOString();
}

function timestampAt(milliseconds: number | null | undefined): string | null {
  return typeof milliseconds === 'number' && milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

function publicShareValue(annotation: PublicShareAnnotation | undefined): MobileFileEntry['publicShare'] {
  if (!annotation) return null;
  return {
    id: annotation.id,
    status: 'active',
    url: annotation.shortUrl || annotation.publicUrl,
    expiresAt: annotation.expiresAt,
    accessCount: annotation.accessCount,
  };
}

function entryFor(node: FileNode, share?: PublicShareAnnotation): MobileFileEntry {
  const category = mobileFileCategory(node.path, node.type);
  const extension = node.type === 'file' ? extensionFor(node.path) : '';
  const mode = previewMode(node.path, category);
  const openKind = mobileFileOpenKind(node.path, node.type);
  return {
    name: node.name,
    path: node.path,
    type: node.type,
    category,
    extension,
    mimeType: node.type === 'file' ? getPublicShareMimeType(node.path) : 'inode/directory',
    sizeBytes: node.size || 0,
    modifiedAt: modifiedAt(node.modified),
    openKind,
    renderKind: node.type === 'file' && hasMarpFileName(node.path) ? 'marp' : null,
    canPreview: node.type === 'file' && mode !== 'download',
    canOpenInNotebook: openKind === 'markdown',
    publicShare: publicShareValue(share),
    title: node.title ?? null,
    format: node.format || (node.type === 'directory' ? 'Folder' : 'File'),
    createdAt: node.created ? modifiedAt(node.created) : null,
    isFavorite: Boolean(node.isFavorite),
    pinnedAt: timestampAt(node.pinnedAt),
  };
}

function collectEntries(nodes: FileNode[], output: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (output.length >= MAX_SEARCH_ENTRIES) break;
    output.push(node);
    if (node.type === 'directory' && node.children) collectEntries(node.children, output);
  }
  return output;
}

function cursorSignature(input: {
  directory: string;
  query: string;
  filter: MobileFileFilter;
  sort: MobileFileSort | null;
  sortOrder: MobileFileSortOrder | null;
}): string {
  return createHash('sha256')
    .update([
      input.directory,
      input.query.toLowerCase(),
      input.filter,
      input.sort || 'default',
      input.sortOrder || 'default',
    ].join('\u001f'))
    .digest('hex')
    .slice(0, 12);
}

function cursorFor(offset: number, signature: string): string {
  return Buffer.from(JSON.stringify({ offset, signature })).toString('base64url');
}

function offsetFromCursor(value: unknown, signature: string): number {
  if (!value) return 0;
  if (typeof value !== 'string' || value.length > 200) {
    throw new MobileFilesError('File cursor is invalid.', 400, 'INVALID_CURSOR');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || parsed.signature !== signature) throw new Error('invalid');
    return Number(parsed.offset);
  } catch {
    throw new MobileFilesError('File cursor is invalid.', 400, 'INVALID_CURSOR');
  }
}

function breadcrumbs(directory: string): { name: string; path: string }[] {
  const result = [{ name: 'Workspace', path: '.' }];
  if (directory === '.') return result;
  const parts = directory.split('/');
  parts.forEach((name, index) => result.push({ name, path: parts.slice(0, index + 1).join('/') }));
  return result;
}

function searchRank(node: FileNode, needle: string): number {
  const name = node.name.toLowerCase();
  const candidatePath = node.path.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if (candidatePath.includes(needle)) return 3;
  return Number.POSITIVE_INFINITY;
}

export async function listMobileFiles(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  directory?: unknown;
  query?: unknown;
  filter?: unknown;
  sort?: unknown;
  sortOrder?: unknown;
  cursor?: unknown;
  limit?: unknown;
  baseUrl?: string | null;
}) {
  const directory = normalizeMobileFilePath(input.directory, true);
  const query = normalizeQuery(input.query);
  const filter = normalizeFilter(input.filter);
  const sort = normalizeSort(input.sort);
  const sortOrder = normalizeSortOrder(input.sortOrder, sort);
  const requestedLimit = typeof input.limit === 'number' ? input.limit : Number(input.limit || 40);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_LIST_LIMIT) {
    throw new MobileFilesError(`limit must be between 1 and ${MAX_LIST_LIMIT}.`, 400, 'INVALID_LIMIT');
  }
  const signature = cursorSignature({ directory, query, filter, sort, sortOrder });
  const offset = offsetFromCursor(input.cursor, signature);

  let nodes: FileNode[];
  if (query) {
    const tree = await buildFileTree('.', MAX_TREE_DEPTH, 0, { ...input.fileOptions, includeMetadata: true });
    const needle = query.toLowerCase();
    nodes = collectEntries(tree)
      .map((node) => ({ node, rank: searchRank(node, needle) }))
      .filter((candidate) => Number.isFinite(candidate.rank))
      .sort((left, right) => left.rank - right.rank || left.node.path.localeCompare(right.node.path))
      .map((candidate) => candidate.node);
    if (sort && sortOrder) nodes = sortFileNodes(nodes, sort, sortOrder);
  } else {
    try {
      nodes = await listDirectory(directory, { ...input.fileOptions, includeMetadata: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new MobileFilesError('Folder was not found.', 404, 'FOLDER_NOT_FOUND');
      }
      throw error;
    }
    nodes = sortFileNodes(nodes, sort || 'name', sortOrder || 'asc');
  }

  const filtered = nodes.filter((node) => filter === 'all' || mobileFileCategory(node.path, node.type) === filter);
  const page = filtered.slice(offset, offset + requestedLimit);
  const annotations = await getPublicShareAnnotations(
    page.filter((node) => node.type === 'file').map((node) => node.path),
    input.baseUrl,
    input.workspace,
  );
  const enrichedPage = await enrichWorkspaceFileNodes({
    nodes: page,
    workspace: input.workspace,
    userId: input.workspace.actor?.userId,
  });
  const nextOffset = offset + page.length;
  return {
    directory,
    breadcrumbs: breadcrumbs(directory),
    items: enrichedPage.map((node) => entryFor(node, annotations.get(node.path))),
    nextCursor: nextOffset < filtered.length ? cursorFor(nextOffset, signature) : null,
    total: filtered.length,
    actions: {
      canCreate: input.workspace.permissions.canWrite,
      canUpload: input.workspace.permissions.canWrite,
      canMove: input.workspace.permissions.canWrite && input.workspace.permissions.canDelete,
      canCopy: input.workspace.permissions.canRead,
      canExport: input.workspace.permissions.canRead,
      canDelete: input.workspace.permissions.canDelete,
      canCreatePublicLinks: input.workspace.permissions.canCreatePublicLinks,
    },
  };
}

export async function readMobileFileDetail(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  path: unknown;
  baseUrl?: string | null;
}): Promise<MobileFileDetail> {
  const filePath = normalizeMobileFilePath(input.path, false);
  let stats;
  try {
    stats = await getFileStats(filePath, input.fileOptions);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new MobileFilesError('File was not found.', 404, 'FILE_NOT_FOUND');
    }
    throw error;
  }
  if (!stats.isFile) throw new MobileFilesError('The selected path is not a file.', 400, 'NOT_A_FILE');
  const node: FileNode = {
    name: path.posix.basename(filePath),
    path: filePath,
    type: 'file',
    size: stats.size,
    modified: stats.modified,
    created: stats.created,
  };
  const annotations = await getPublicShareAnnotations([filePath], input.baseUrl, input.workspace);
  const [enrichedNode] = await enrichWorkspaceFileNodes({
    nodes: [node],
    workspace: input.workspace,
    userId: input.workspace.actor?.userId,
  });
  const entry = entryFor(enrichedNode, annotations.get(filePath));
  const mode = previewMode(filePath, entry.category);
  let content: string | null = null;
  let contentTruncated = false;
  if (mode === 'text') {
    if (stats.size <= MAX_TEXT_PREVIEW_BYTES) {
      content = (await readFile(filePath, input.fileOptions)).toString('utf8');
    } else {
      contentTruncated = true;
    }
  }
  return {
    ...entry,
    renderKind: entry.renderKind || (content && isMarpMarkdown(filePath, content) ? 'marp' : null),
    previewMode: mode,
    content,
    contentTruncated,
  };
}
