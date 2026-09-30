import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildWorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index';
import { buildWorkspaceLinkIndexFromDocuments, type WorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index-core';
import { diagnoseWorkspaceLinks, type WorkspaceLinkDiagnostics } from '@/app/lib/markdown/workspace-link-diagnostics';
import { MAX_INDEXED_MARKDOWN_BYTES } from '@/app/lib/markdown/workspace-link-limits';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { getAgentWorkspaceContext, type AgentFileChangeResult } from './agent-file-operations';
import { getAgentFileLinkSource, type AgentFileLinkSource } from './agent-file-link-sources';

type Dependencies = {
  getWorkspace: () => WorkspaceContext | null;
  buildIndex: typeof buildWorkspaceLinkIndex;
  timeoutMs: number;
};

type ScopedResult = { result: AgentFileChangeResult; sourcePath: string; source?: AgentFileLinkSource };

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function scopedPath(result: AgentFileChangeResult, workspace: WorkspaceContext): string | null {
  const relative = path.relative(path.resolve(workspace.rootPath), path.resolve(result.resolvedPath));
  return !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? null : relative.split(path.sep).join('/');
}

/** Reuse the resolver with known source contents and minimal target alias metadata. */
function overlayIndex(index: WorkspaceLinkIndex, overrides: ReadonlyMap<string, string>): WorkspaceLinkIndex {
  const omissions = index.omittedDocuments.filter((entry) => !overrides.has(entry.path));
  for (const entry of index.coverage.omittedSources) {
    if (!overrides.has(entry.path) && !omissions.some((omission) => omission.path === entry.path)) {
      omissions.push({ path: entry.path, reason: entry.reason === 'source-too-large' ? 'too-large' : 'unreadable' });
    }
  }
  const sources = index.documents.filter((document) => !overrides.has(document.path)).map((document) => ({
    path: document.path, content: `---\naliases: ${JSON.stringify(document.aliases)}\n---\n`,
  }));
  for (const [sourcePath, content] of overrides) {
    if (Buffer.byteLength(content, 'utf8') > MAX_INDEXED_MARKDOWN_BYTES) {
      omissions.push({ path: sourcePath, reason: 'too-large' });
    } else sources.push({ path: sourcePath, content });
  }
  return buildWorkspaceLinkIndexFromDocuments(sources, new Date(index.generatedAt),
    new Set([...index.targetPaths, ...overrides.keys()]), omissions);
}

function unavailable(sourcePath: string, result: AgentFileChangeResult, source?: AgentFileLinkSource): WorkspaceLinkDiagnostics {
  return {
    contractVersion: 1, scope: 'workspace-local', sourcePath,
    basis: source?.basis ?? 'current', contentSha256: source ? sha256(source.content) : result.afterSha256,
    status: 'unavailable', counts: { checked: 0, resolved: 0, missing: 0, ambiguous: 0, unverified: 1 },
    issues: [], truncated: false, notices: ['Local link diagnostics are unavailable. The file operation result remains valid.'],
    anchorsChecked: false, externalChecked: false,
  };
}

async function boundedIndexBuild(dependencies: Dependencies, workspace: WorkspaceContext,
  overrides: ReadonlyMap<string, string>): Promise<WorkspaceLinkIndex> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dependencies.buildIndex({ workspace }, { contentOverrides: overrides }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Link index build timed out.')), dependencies.timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Diagnostics run after mutation and cannot turn its durable success into a retry. */
export function createAgentFileLinkDiagnostics(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    getWorkspace: getAgentWorkspaceContext, buildIndex: buildWorkspaceLinkIndex, timeoutMs: 10_000, ...overrides,
  };
  return async (results: AgentFileChangeResult[]): Promise<AgentFileChangeResult[]> => {
    let scoped: ScopedResult[] = [];
    try {
      const workspace = dependencies.getWorkspace();
      if (!workspace) return results;
      scoped = results.flatMap((result) => {
        const sourcePath = scopedPath(result, workspace);
        return sourcePath && /\.(?:md|markdown|mdx)$/iu.test(sourcePath)
          ? [{ result, sourcePath, source: getAgentFileLinkSource(result) }] : [];
      });
      if (scoped.length === 0) return results;
      const currentOverrides = new Map(scoped.filter((entry) => entry.source && entry.source.basis !== 'proposed'
        && /\.(?:md|markdown)$/iu.test(entry.sourcePath)).map((entry) => [entry.sourcePath, entry.source!.content]));
      const needsIndex = scoped.some((entry) => entry.source && /\.(?:md|markdown)$/iu.test(entry.sourcePath)
        && Buffer.byteLength(entry.source.content, 'utf8') <= MAX_INDEXED_MARKDOWN_BYTES);
      const emptyIndex = buildWorkspaceLinkIndexFromDocuments([]);
      const base = needsIndex ? await boundedIndexBuild(dependencies, workspace, currentOverrides) : emptyIndex;
      const current = overlayIndex(base, currentOverrides);
      const beforeOverrides = new Map(scoped.filter((entry) => entry.source?.beforeContent !== undefined
        && entry.source.basis !== 'proposed' && /\.(?:md|markdown)$/iu.test(entry.sourcePath))
        .map((entry) => [entry.sourcePath, entry.source!.beforeContent!]));
      const beforeIndex = overlayIndex(current, beforeOverrides);
      const diagnostics = new Map<AgentFileChangeResult, WorkspaceLinkDiagnostics>();
      for (const entry of scoped) {
        const { result, sourcePath, source } = entry;
        if (!source) { diagnostics.set(result, unavailable(sourcePath, result)); continue; }
        const proposed = source.basis === 'proposed';
        const sourceIndex = proposed ? overlayIndex(current, new Map([[sourcePath, source.content]])) : current;
        const knownBefore = source.beforeContent !== undefined
          && Buffer.byteLength(source.beforeContent, 'utf8') <= MAX_INDEXED_MARKDOWN_BYTES;
        const diagnosis = diagnoseWorkspaceLinks({
          index: sourceIndex, path: sourcePath, content: source.content, contentSha256: sha256(source.content), basis: source.basis,
          ...(knownBefore ? { beforeIndex: proposed
            ? overlayIndex(beforeIndex, new Map([[sourcePath, source.beforeContent!]])) : beforeIndex } : {}),
        });
        if (result.collaboration?.reviewRequired && !proposed) {
          diagnosis.notices.push('This check covers saved/current content only; pending review changes were not reconstructed.');
        }
        diagnostics.set(result, diagnosis);
      }
      return results.map((result) => diagnostics.has(result) ? { ...result, linkDiagnostics: diagnostics.get(result)! } : result);
    } catch {
      // Keep diagnostics generic: index errors can contain host paths or secrets.
      const failures = new Map(scoped.map((entry) => [entry.result, unavailable(entry.sourcePath, entry.result, entry.source)]));
      if (scoped.length === 0) {
        for (const result of results) {
          if (!/\.(?:md|markdown|mdx)$/iu.test(result.path)) continue;
          const sourcePath = path.isAbsolute(result.path) ? path.basename(result.path) : result.path;
          failures.set(result, unavailable(sourcePath, result, getAgentFileLinkSource(result)));
        }
      }
      return results.map((result) => failures.has(result) ? { ...result, linkDiagnostics: failures.get(result)! } : result);
    }
  };
}

export const addAgentFileLinkDiagnostics = createAgentFileLinkDiagnostics();
