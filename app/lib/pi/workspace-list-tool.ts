import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { openDb } from '../db';
import { readWorkspaceDocumentTreePage } from '../files/workspace-document-tree';
import { readWorkspaceTreePage, formatWorkspaceTreePage, normalizeVisibleWorkspaceTreePath } from '../files/workspace-tree';
import type { FileNode } from '../files/types';
import type { WorkspaceContext } from '../workspaces/types';
import { withWorkspaceAgentToolPrincipal, withWorkspaceAgentToolPrincipalOnConnection,
  type WorkspaceAgentToolPrincipal } from '../workspaces/request-principal';
import { getAgentExecutionContext } from './agent-execution-context';
import { assertAgentPathAllowed, resolveAgentPath } from './agent-file-operations';

const parameters = Type.Object({
  path: Type.Optional(Type.String({ maxLength: 4096, description: 'Workspace-relative directory or a separately authorized absolute skill/temp directory. Defaults to the active workspace root.' })),
  max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
  max_entries: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(Type.String({ maxLength: 20000 })),
}, { additionalProperties: false });
type Selection = Static<typeof parameters>;

function contained(relative: string): boolean {
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve root aliases even when a logical native descendant has no projection.
 * Aliases inside a workspace are left to the native namespace's stricter guard. */
async function canonicalNearest(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let current = candidate;
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      suffix.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}

function scopeIdentity(workspace: WorkspaceContext): string {
  return JSON.stringify([workspace.workspaceId, workspace.workspaceType, workspace.rootPath, workspace.rootRelativePath ?? null,
    workspace.organizationId ?? null, workspace.customerId ?? null, workspace.projectId ?? null, workspace.legacy]);
}

/** Genuine invocation policy on a short owned transaction, never an actor DTO.
 * The native namespace owns its separate read fence between these two checks. */
async function currentWorkspace(principal: WorkspaceAgentToolPrincipal): Promise<WorkspaceContext> {
  const connection = await openDb();
  let transaction = false, discard: Error | undefined;
  try {
    await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); transaction = true;
    const workspace = await withWorkspaceAgentToolPrincipalOnConnection(connection, principal,
      async access => structuredClone(access.workspace));
    await connection.run('COMMIT'); transaction = false;
    return workspace;
  } finally {
    if (transaction) try { await connection.run('ROLLBACK'); }
    catch { discard = new Error('Discarding unresolved agent directory authorization transaction.'); }
    await connection.close(discard);
  }
}

/** Physical ancillary/legacy listing only. No workspace metadata or synthetic
 * personal WorkspaceContext is attached to these separately guarded roots. */
async function physicalDirectory(root: string, directory: string): Promise<FileNode[]> {
  const relative = normalizeVisibleWorkspaceTreePath(directory);
  const full = relative === '.' ? root : path.join(root, relative);
  await assertAgentPathAllowed(full);
  const entries = await fs.readdir(full, { withFileTypes: true });
  const result: FileNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'Thumbs.db' || entry.isSymbolicLink()) continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const file = path.join(full, entry.name);
    await assertAgentPathAllowed(file);
    const stats = await fs.lstat(file);
    if (stats.isSymbolicLink()) throw new Error('The directory changed while listing.');
    result.push({ name: entry.name, path: relative === '.' ? entry.name : `${relative}/${entry.name}`,
      type: stats.isDirectory() ? 'directory' : 'file', size: stats.size, modified: Math.floor(stats.mtimeMs / 1000) });
  }
  return result;
}

async function list(selection: Selection) {
  const context = getAgentExecutionContext();
  if (!context) throw new Error('Directory listing requires an active agent workspace.');
  const selectedPath = selection.path || '.', full = resolveAgentPath(selectedPath);
  let checkedPath = full;
  const read = async (workspace?: WorkspaceContext) => {
    const workspaceRoot = workspace?.rootPath ?? context.workspaceRoot;
    let relative = path.relative(workspaceRoot, full);
    if (!contained(relative)) {
      const root = await fs.realpath(workspaceRoot);
      // Only a proven alias into the genuine authorized workspace is rebound.
      // Other paths still have to pass the independent ancillary-root guard.
      const canonical = await canonicalNearest(full).catch(() => null);
      if (canonical !== null) {
        const canonicalRelative = path.relative(root, canonical);
        if (contained(canonicalRelative)) {
          relative = canonicalRelative; checkedPath = path.join(workspaceRoot, relative);
        }
      }
    }
    await assertAgentPathAllowed(checkedPath);
    const workspacePath = contained(relative);
    const pageSelection = { path: workspacePath ? relative.split(path.sep).join('/') || '.' : '.',
      maxDepth: selection.max_depth ?? 0, maxEntries: selection.max_entries ?? 200, cursor: selection.cursor };
    if (workspace && workspacePath) return readWorkspaceDocumentTreePage(workspace, pageSelection, { includeMetadata: false });
    const root = workspacePath ? workspaceRoot : full;
    return readWorkspaceTreePage({ workspaceId: context.workspaceId, rootPath: root, ...pageSelection },
      { readDirectory: directory => physicalDirectory(root, directory) });
  };
  if (context.legacy) return read();
  return withWorkspaceAgentToolPrincipal({ workspaceId: context.workspaceId, permission: 'canRead' }, async principal => {
    const before = await currentWorkspace(principal);
    const page = await read(before);
    const after = await currentWorkspace(principal);
    if (scopeIdentity(before) !== scopeIdentity(after)) throw new Error('The workspace identity changed while listing.');
    await assertAgentPathAllowed(checkedPath);
    return page;
  });
}

export function createWorkspaceListTool(): AgentTool {
  return {
    name: 'ls', label: 'Listing directory',
    description: 'Lists the active workspace namespace, including native documents without a physical projection. Defaults to a bounded direct-child page. Supply max_depth for a bounded tree (0 lists direct children), max_entries for page size, and the exact cursor to continue with the same path and depth. Unloaded or unavailable folders are not empty. Separately authorized skill/temp directories retain their own path guards.',
    parameters,
    execute: async (_toolCallId, input) => {
      try {
        if (!Value.Check(parameters, input)) throw new Error('Invalid directory listing request.');
        const page = await list(input);
        return { content: [{ type: 'text', text: formatWorkspaceTreePage(page) }], details: { ...page,
          files: page.entries.map(entry => ({ path: entry.path, name: path.posix.basename(entry.path), type: entry.type,
            size: entry.size, modified: entry.modified_at === null ? null : Math.floor(Date.parse(entry.modified_at) / 1000) })) } };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Directory listing is unavailable.';
        return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
      }
    },
  };
}
