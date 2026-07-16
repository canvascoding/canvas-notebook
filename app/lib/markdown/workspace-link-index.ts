import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import {
  readFile,
  writeFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import { AsyncSemaphore } from '@/app/lib/utils/async-semaphore';
import { remapDescendantPath } from '@/app/lib/files/path-utils';

import {
  buildWorkspaceLinkIndexFromDocuments,
  rewriteWorkspaceWikiLinksForRename,
  type WorkspaceLinkIndex,
} from './workspace-link-index-core';

const LINK_INDEX_READ_CONCURRENCY = 10;
const MAX_INDEXED_MARKDOWN_BYTES = 4 * 1024 * 1024;

export type WorkspaceLinkRenameResult = {
  updatedFiles: string[];
  updatedLinks: number;
  warnings: string[];
};

export type WorkspaceLinkIndexBuildOptions = {
  contentOverrides?: ReadonlyMap<string, string>;
};

function isMarkdownPath(filePath: string): boolean {
  return /\.(?:md|markdown)$/i.test(filePath);
}

function isSameOrDescendant(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export async function buildWorkspaceLinkIndex(
  options?: WorkspaceFileOperationOptions,
  buildOptions: WorkspaceLinkIndexBuildOptions = {},
): Promise<WorkspaceLinkIndex> {
  const entries = await getCachedFileReferenceEntries(false, options);
  const markdownEntries = entries.filter((entry) => entry.type === 'file' && isMarkdownPath(entry.path));
  const omittedDocuments: WorkspaceLinkIndex['omittedDocuments'] = markdownEntries
    .filter((entry) => entry.size !== undefined && entry.size > MAX_INDEXED_MARKDOWN_BYTES)
    .map((entry) => ({ path: entry.path, reason: 'too-large' as const }));
  const markdownFiles = markdownEntries.filter((entry) => (
    entry.size === undefined || entry.size <= MAX_INDEXED_MARKDOWN_BYTES
  ));
  const semaphore = new AsyncSemaphore(LINK_INDEX_READ_CONCURRENCY);
  const sources = await Promise.all(markdownFiles.map((entry) => semaphore.run(async () => {
    try {
      const contentOverride = buildOptions.contentOverrides?.get(entry.path);
      if (contentOverride !== undefined) {
        if (Buffer.byteLength(contentOverride, 'utf8') > MAX_INDEXED_MARKDOWN_BYTES) {
          omittedDocuments.push({ path: entry.path, reason: 'too-large' });
          return null;
        }
        return { content: contentOverride, path: entry.path };
      }
      const content = await readFile(entry.path, options);
      if (content.byteLength > MAX_INDEXED_MARKDOWN_BYTES) {
        omittedDocuments.push({ path: entry.path, reason: 'too-large' });
        return null;
      }
      return { content: content.toString('utf8'), path: entry.path };
    } catch (error) {
      console.warn(`[WorkspaceLinkIndex] Skipping unreadable Markdown file: ${entry.path}`, error);
      omittedDocuments.push({ path: entry.path, reason: 'unreadable' });
      return null;
    }
  })));

  const index = buildWorkspaceLinkIndexFromDocuments(
    sources.filter((source): source is NonNullable<typeof source> => source !== null),
  );
  return {
    ...index,
    omittedDocuments: omittedDocuments
      .filter((entry, entryIndex, all) => (
        all.findIndex((candidate) => candidate.path === entry.path) === entryIndex
      ))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function applyWorkspaceLinkRename(
  index: WorkspaceLinkIndex,
  oldPath: string,
  newPath: string,
  options?: WorkspaceFileOperationOptions,
): Promise<WorkspaceLinkRenameResult> {
  const affectedEdges = index.edges.filter((edge) => (
    edge.kind === 'wiki'
    && edge.status === 'resolved'
    && edge.targetPath
    && isSameOrDescendant(edge.targetPath, oldPath)
  ));
  const edgesBySource = new Map<string, typeof affectedEdges>();
  for (const edge of affectedEdges) {
    const sourceEdges = edgesBySource.get(edge.sourcePath) ?? [];
    sourceEdges.push(edge);
    edgesBySource.set(edge.sourcePath, sourceEdges);
  }

  const result: WorkspaceLinkRenameResult = {
    updatedFiles: [],
    updatedLinks: 0,
    warnings: [],
  };
  const semaphore = new AsyncSemaphore(LINK_INDEX_READ_CONCURRENCY);
  await Promise.all(Array.from(edgesBySource.entries()).map(([originalSourcePath, edges]) => (
    semaphore.run(async () => {
      const sourcePath = isSameOrDescendant(originalSourcePath, oldPath)
        ? remapDescendantPath(originalSourcePath, oldPath, newPath)
        : originalSourcePath;
      try {
        const currentContent = (await readFile(sourcePath, options)).toString('utf8');
        const rewritten = rewriteWorkspaceWikiLinksForRename(
          currentContent,
          edges,
          oldPath,
          newPath,
        );
        if (rewritten.updatedLinks === 0 || rewritten.content === currentContent) return;
        await writeFile(sourcePath, rewritten.content, options);
        result.updatedFiles.push(sourcePath);
        result.updatedLinks += rewritten.updatedLinks;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(`${sourcePath}: ${message}`);
      }
    })
  )));

  result.updatedFiles.sort((left, right) => left.localeCompare(right));
  result.warnings.sort((left, right) => left.localeCompare(right));
  return result;
}
