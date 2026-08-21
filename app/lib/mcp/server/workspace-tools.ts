import 'server-only';

import path from 'node:path';

import {
  ProtocolError,
  ProtocolErrorCode,
  type AuthInfo,
  type CallToolResult,
} from '@modelcontextprotocol/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { openDb } from '@/app/lib/db';
import {
  getFileStats,
  listDirectory,
  readFile,
  type FileNode,
} from '@/app/lib/filesystem/workspace-files';
import {
  DirectMcpAuthorizationError,
  verifyDirectMcpAccessToken,
  type DirectMcpAccessPrincipal,
} from '@/app/lib/mcp/server/access-token-verifier';
import {
  type DirectMcpResourceScope,
  type DirectMcpToolId,
} from '@/app/lib/mcp/server/config';
import { directMcpToolAuthorizationError } from '@/app/lib/mcp/server/tool-auth';
import type { DirectMcpToolDescriptor } from '@/app/lib/mcp/server/tool-descriptor';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import {
  loadWorkspaceListingForActor,
  type WorkspaceListing,
} from '@/app/lib/workspaces/listing-action';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const DIRECT_MCP_WORKSPACE_TOOL_IDS = [
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
] as const satisfies readonly DirectMcpToolId[];

const MAX_WORKSPACE_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;
const DEFAULT_TREE_DEPTH = 2;
const MAX_TREE_DEPTH = 6;
const DEFAULT_TREE_ENTRIES = 200;
const MAX_TREE_ENTRIES = 500;
const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 25;
const MAX_SEARCH_CANDIDATES = 400;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_READ_FILE_BYTES = 512 * 1024;
const DEFAULT_READ_CHARACTERS = 12_000;
const MAX_READ_CHARACTERS = 24_000;
const TEXT_FILE_EXTENSIONS = new Set([
  '.csv', '.html', '.json', '.md', '.mdx', '.rst', '.text', '.toml', '.tsv', '.txt', '.xml', '.yaml', '.yml',
]);
const BINARY_FILE_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.doc', '.docx', '.gif', '.gz', '.heic', '.ico', '.jpeg', '.jpg', '.mov', '.mp3',
  '.mp4', '.odp', '.ods', '.odt', '.pdf', '.png', '.ppt', '.pptx', '.rar', '.tar', '.tif', '.tiff', '.wav',
  '.webm', '.webp', '.xls', '.xlsx', '.zip',
]);

type JsonObject = Record<string, unknown>;
type WorkspaceToolName = (typeof DIRECT_MCP_WORKSPACE_TOOL_IDS)[number];

type WorkspaceTreeEntry = {
  path: string;
  type: 'file' | 'directory';
  size: number | null;
  modified_at: string | null;
};

type DirectMcpWorkspaceToolDefinition = {
  id: WorkspaceToolName;
  descriptor: ReturnType<typeof getDirectMcpWorkspaceToolDescriptor>;
  execute: (args: unknown, authInfo?: AuthInfo) => Promise<CallToolResult>;
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidParams(message: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

function parseArgs(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (!isRecord(value)) invalidParams('Tool arguments must be an object.');
  return value;
}

function requiredString(args: JsonObject, name: string, maxLength: number): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    invalidParams(`${name} must be a non-empty string up to ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalString(args: JsonObject, name: string, defaultValue: string, maxLength: number): string {
  const value = args[name];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    invalidParams(`${name} must be a string up to ${maxLength} characters.`);
  }
  return value.trim() || defaultValue;
}

function optionalInteger(
  args: JsonObject,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[name];
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidParams(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function assertVisibleWorkspacePath(value: string): void {
  if (value === '.') return;
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.'))) {
    invalidParams('Hidden workspace paths are not available through MCP.');
  }
}

function isVisibleWorkspaceNode(node: FileNode): boolean {
  return node.path.split('/').every((segment) => segment !== '.' && !segment.startsWith('.'));
}

function isReadableWorkspace(workspace: WorkspaceContext): boolean {
  return workspace.permissions.canRead
    && workspace.status !== 'archived'
    && workspace.status !== 'disabled'
    && workspace.status !== 'recovery_locked';
}

function workspaceSummary(workspace: WorkspaceContext) {
  return {
    id: workspace.workspaceId,
    name: workspace.displayName || 'Workspace',
    description: workspace.description || null,
    type: workspace.workspaceType,
    is_default: Boolean(workspace.isDefault),
  };
}

function toIsoDate(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function toTreeEntry(node: FileNode): WorkspaceTreeEntry {
  return {
    path: node.path,
    type: node.type,
    size: typeof node.size === 'number' ? node.size : null,
    modified_at: toIsoDate(node.modified),
  };
}

function securitySchemes(scope: DirectMcpResourceScope) {
  return [{ type: 'oauth2' as const, scopes: [scope] }];
}

function getToolSecurity(scope: DirectMcpResourceScope) {
  const schemes = securitySchemes(scope);
  return {
    securitySchemes: schemes,
    _meta: { securitySchemes: schemes },
  };
}

export function getDirectMcpWorkspaceToolDescriptor(tool: WorkspaceToolName): DirectMcpToolDescriptor {
  if (tool === 'list_workspaces') {
    return {
      name: tool,
      title: 'List available workspaces',
      description: 'Lists the Canvas workspaces that the signed-in user can currently access.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          workspaces: { type: 'array', items: { type: 'object' } },
        },
        required: ['workspaces'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...getToolSecurity('workspace:list'),
    };
  }

  if (tool === 'get_workspace_overview') {
    return {
      name: tool,
      title: 'Get workspace overview',
      description: 'Shows a compact overview of one accessible Canvas workspace and its top-level contents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
        },
        required: ['workspace_id'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          workspace: { type: 'object' },
          contents: { type: 'object' },
        },
        required: ['workspace', 'contents'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...getToolSecurity('workspace:list'),
    };
  }

  if (tool === 'list_knowledge_tree') {
    return {
      name: tool,
      title: 'Browse workspace files',
      description: 'Lists visible files and folders in an accessible workspace. Hidden paths are never returned.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'Optional workspace-relative starting path. Defaults to the workspace root.' },
          max_depth: { type: 'integer', minimum: 0, maximum: MAX_TREE_DEPTH, description: 'Maximum folder depth. Defaults to 2.' },
          max_entries: { type: 'integer', minimum: 1, maximum: MAX_TREE_ENTRIES, description: 'Maximum returned files and folders. Defaults to 200.' },
        },
        required: ['workspace_id'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          entries: { type: 'array', items: { type: 'object' } },
          truncated: { type: 'boolean' },
        },
        required: ['entries', 'truncated'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...getToolSecurity('knowledge:tree'),
    };
  }

  if (tool === 'search_knowledge') {
    return {
      name: tool,
      title: 'Search workspace files',
      description: 'Searches text files in an accessible workspace and returns short matching excerpts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          query: { type: 'string', minLength: 2, description: 'Text to search for.' },
          path: { type: 'string', description: 'Optional workspace-relative starting path. Defaults to the workspace root.' },
          max_results: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum matches. Defaults to 10.' },
        },
        required: ['workspace_id', 'query'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          results: { type: 'array', items: { type: 'object' } },
          truncated: { type: 'boolean' },
        },
        required: ['results', 'truncated'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...getToolSecurity('knowledge:search'),
    };
  }

  return {
    name: tool,
    title: 'Read workspace document',
    description: 'Reads a bounded text excerpt from a visible file in an accessible workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
        path: { type: 'string', description: 'Workspace-relative file path.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset. Defaults to 0.' },
        max_characters: { type: 'integer', minimum: 1, maximum: MAX_READ_CHARACTERS, description: 'Maximum returned characters. Defaults to 12000.' },
      },
      required: ['workspace_id', 'path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
        next_offset: { type: ['integer', 'null'] },
      },
      required: ['path', 'content', 'truncated', 'next_offset'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    ...getToolSecurity('knowledge:read'),
  };
}

async function loadWorkspaceListing(principal: DirectMcpAccessPrincipal): Promise<WorkspaceListing> {
  const database = await openDb();
  try {
    const identity = await database.get(
      'SELECT email, role FROM "user" WHERE id = ? LIMIT 1',
      [principal.userId],
    ) as { email?: unknown; role?: unknown } | undefined;
    if (!identity || typeof identity.email !== 'string') {
      throw new Error('The signed-in Canvas user is no longer available.');
    }
    return await loadWorkspaceListingForActor(resolveWorkspaceActor({
      id: principal.userId,
      email: identity.email,
      role: typeof identity.role === 'string' ? identity.role : null,
    }));
  } finally {
    await database.close();
  }
}

async function authenticateForTool(
  authInfo: AuthInfo | undefined,
  scope: DirectMcpResourceScope,
): Promise<{ principal: DirectMcpAccessPrincipal } | { result: CallToolResult }> {
  if (!authInfo?.token) return { result: directMcpToolAuthorizationError() };
  try {
    return { principal: await verifyDirectMcpAccessToken(authInfo.token, [scope]) };
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) {
      return { result: directMcpToolAuthorizationError(error) };
    }
    throw error;
  }
}

async function readableWorkspace(
  principal: DirectMcpAccessPrincipal,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const listing = await loadWorkspaceListing(principal);
  const workspace = listing.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace || !isReadableWorkspace(workspace)) {
    throw new Error('The requested workspace is not available to this Canvas user.');
  }
  return workspace;
}

async function listBoundedWorkspaceTree(input: {
  workspace: WorkspaceContext;
  path: string;
  maxDepth: number;
  maxEntries: number;
}): Promise<{ entries: WorkspaceTreeEntry[]; truncated: boolean }> {
  const entries: WorkspaceTreeEntry[] = [];
  const pending = [{ path: input.path, depth: 0 }];
  let truncated = false;

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    const children = await listDirectory(current.path, {
      workspace: input.workspace,
      includeMetadata: true,
      includeSymlinks: false,
    });
    const visibleChildren = children
      .filter(isVisibleWorkspaceNode)
      .sort((left, right) => (
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type === 'directory' ? -1 : 1
      ));

    for (const child of visibleChildren) {
      if (entries.length >= input.maxEntries) {
        truncated = true;
        break;
      }
      entries.push(toTreeEntry(child));
      if (child.type === 'directory' && current.depth < input.maxDepth) {
        pending.push({ path: child.path, depth: current.depth + 1 });
      }
    }
    if (truncated) break;
  }

  if (pending.length > 0) truncated = true;
  return { entries, truncated };
}

function isLikelyBinary(pathValue: string, content?: Buffer): boolean {
  const extension = path.extname(pathValue).toLowerCase();
  if (BINARY_FILE_EXTENSIONS.has(extension)) return true;
  return Boolean(content?.subarray(0, 8192).includes(0));
}

function isSearchableTextFile(pathValue: string): boolean {
  const extension = path.extname(pathValue).toLowerCase();
  return extension.length === 0 || TEXT_FILE_EXTENSIONS.has(extension);
}

function matchingExcerpt(content: string, query: string): string | null {
  const matchIndex = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchIndex < 0) return null;
  const start = Math.max(0, matchIndex - 160);
  const end = Math.min(content.length, matchIndex + query.length + 320);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${content.slice(start, end).replace(/\s+/gu, ' ').trim()}${suffix}`;
}

function result(content: Record<string, unknown>, text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: content,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function auditWorkspaceToolCall(input: {
  principal: DirectMcpAccessPrincipal;
  tool: WorkspaceToolName;
  workspace?: WorkspaceContext;
  resultCount?: number;
}): Promise<void> {
  await recordAuditEvent({
    organizationId: input.workspace?.organizationId ?? null,
    workspaceId: input.workspace?.workspaceId ?? null,
    userId: input.principal.userId,
    source: 'mcp',
    eventType: 'tool',
    entityType: 'mcp_tool',
    entityId: input.tool,
    action: 'mcp_server.tool.call',
    status: 'success',
    summary: `Direct MCP tool ${input.tool} completed.`,
    metadata: {
      tool: input.tool,
      resultCount: input.resultCount ?? null,
    },
  });
}

async function executeListWorkspaces(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  if (Object.keys(parsed).length > 0) invalidParams('list_workspaces does not accept arguments.');
  const authorization = await authenticateForTool(authInfo, 'workspace:list');
  if ('result' in authorization) return authorization.result;

  try {
    const listing = await loadWorkspaceListing(authorization.principal);
    const workspaces = listing.workspaces
      .filter(isReadableWorkspace)
      .map(workspaceSummary);
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'list_workspaces',
      resultCount: workspaces.length,
    });
    return result({ workspaces }, `${workspaces.length} Canvas workspace(s) available.`);
  } catch {
    return errorResult('Could not list Canvas workspaces.');
  }
}

async function executeGetWorkspaceOverview(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const authorization = await authenticateForTool(authInfo, 'workspace:list');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await readableWorkspace(authorization.principal, workspaceId);
    const topLevel = (await listDirectory('.', {
      workspace,
      includeMetadata: true,
      includeSymlinks: false,
    })).filter(isVisibleWorkspaceNode);
    const folders = topLevel.filter((entry) => entry.type === 'directory').length;
    const files = topLevel.filter((entry) => entry.type === 'file');
    const fileTypes = [...new Set(files
      .map((entry) => path.extname(entry.name).replace(/^\./u, '').toLowerCase())
      .filter(Boolean))]
      .sort()
      .slice(0, 20);
    const structuredContent = {
      workspace: workspaceSummary(workspace),
      contents: {
        top_level_files: files.length,
        top_level_folders: folders,
        file_types: fileTypes,
      },
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'get_workspace_overview',
      workspace,
      resultCount: topLevel.length,
    });
    return result(structuredContent, `Overview for ${workspace.displayName || 'workspace'} loaded.`);
  } catch {
    return errorResult('Could not load the Canvas workspace overview.');
  }
}

async function executeListKnowledgeTree(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const startPath = optionalString(parsed, 'path', '.', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(startPath);
  const maxDepth = optionalInteger(parsed, 'max_depth', DEFAULT_TREE_DEPTH, 0, MAX_TREE_DEPTH);
  const maxEntries = optionalInteger(parsed, 'max_entries', DEFAULT_TREE_ENTRIES, 1, MAX_TREE_ENTRIES);
  const authorization = await authenticateForTool(authInfo, 'knowledge:tree');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await readableWorkspace(authorization.principal, workspaceId);
    const tree = await listBoundedWorkspaceTree({
      workspace,
      path: startPath,
      maxDepth,
      maxEntries,
    });
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      path: startPath,
      entries: tree.entries,
      truncated: tree.truncated,
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'list_knowledge_tree',
      workspace,
      resultCount: tree.entries.length,
    });
    return result(structuredContent, `${tree.entries.length} workspace file(s) and folder(s) found.`);
  } catch {
    return errorResult('Could not browse the Canvas workspace.');
  }
}

async function executeSearchKnowledge(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const query = requiredString(parsed, 'query', 200);
  if (query.length < 2) invalidParams('query must contain at least 2 characters.');
  const startPath = optionalString(parsed, 'path', '.', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(startPath);
  const maxResults = optionalInteger(parsed, 'max_results', DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const authorization = await authenticateForTool(authInfo, 'knowledge:search');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await readableWorkspace(authorization.principal, workspaceId);
    const tree = await listBoundedWorkspaceTree({
      workspace,
      path: startPath,
      maxDepth: MAX_TREE_DEPTH,
      maxEntries: MAX_SEARCH_CANDIDATES,
    });
    const results: Array<{
      path: string;
      excerpt: string;
      modified_at: string | null;
    }> = [];
    let truncated = tree.truncated;

    for (const entry of tree.entries) {
      if (entry.type !== 'file' || !isSearchableTextFile(entry.path)) continue;
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }
      const stats = await getFileStats(entry.path, { workspace });
      if (!stats.isFile || stats.size > MAX_SEARCH_FILE_BYTES) continue;
      const content = await readFile(entry.path, { workspace });
      if (isLikelyBinary(entry.path, content)) continue;
      const excerpt = matchingExcerpt(content.toString('utf8'), query);
      if (!excerpt) continue;
      results.push({
        path: entry.path,
        excerpt,
        modified_at: toIsoDate(stats.modified),
      });
    }

    const structuredContent = {
      workspace_id: workspace.workspaceId,
      query,
      results,
      truncated,
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'search_knowledge',
      workspace,
      resultCount: results.length,
    });
    return result(structuredContent, `${results.length} matching workspace document(s) found.`);
  } catch {
    return errorResult('Could not search the Canvas workspace.');
  }
}

async function executeReadKnowledgeSource(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const filePath = requiredString(parsed, 'path', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(filePath);
  const offset = optionalInteger(parsed, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const maxCharacters = optionalInteger(
    parsed,
    'max_characters',
    DEFAULT_READ_CHARACTERS,
    1,
    MAX_READ_CHARACTERS,
  );
  const authorization = await authenticateForTool(authInfo, 'knowledge:read');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await readableWorkspace(authorization.principal, workspaceId);
    const stats = await getFileStats(filePath, { workspace });
    if (!stats.isFile) return errorResult('The requested path is a folder, not a file.');
    if (stats.size > MAX_READ_FILE_BYTES) {
      return errorResult(`The requested file is larger than the ${MAX_READ_FILE_BYTES / 1024} KB MCP read limit.`);
    }
    const buffer = await readFile(filePath, { workspace });
    if (isLikelyBinary(filePath, buffer)) {
      return errorResult('Only text files can be read through this MCP tool.');
    }
    const text = buffer.toString('utf8');
    const content = text.slice(offset, offset + maxCharacters);
    const nextOffset = offset + content.length < text.length ? offset + content.length : null;
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      path: filePath,
      content,
      truncated: nextOffset !== null,
      next_offset: nextOffset,
      size: stats.size,
      modified_at: toIsoDate(stats.modified),
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'read_knowledge_source',
      workspace,
      resultCount: content.length,
    });
    return result(structuredContent, `Read ${content.length} characters from ${filePath}.`);
  } catch {
    return errorResult('Could not read the Canvas workspace file.');
  }
}

export function getDirectMcpWorkspaceToolDefinitions(): DirectMcpWorkspaceToolDefinition[] {
  return [
    {
      id: 'list_workspaces',
      descriptor: getDirectMcpWorkspaceToolDescriptor('list_workspaces'),
      execute: executeListWorkspaces,
    },
    {
      id: 'get_workspace_overview',
      descriptor: getDirectMcpWorkspaceToolDescriptor('get_workspace_overview'),
      execute: executeGetWorkspaceOverview,
    },
    {
      id: 'list_knowledge_tree',
      descriptor: getDirectMcpWorkspaceToolDescriptor('list_knowledge_tree'),
      execute: executeListKnowledgeTree,
    },
    {
      id: 'search_knowledge',
      descriptor: getDirectMcpWorkspaceToolDescriptor('search_knowledge'),
      execute: executeSearchKnowledge,
    },
    {
      id: 'read_knowledge_source',
      descriptor: getDirectMcpWorkspaceToolDescriptor('read_knowledge_source'),
      execute: executeReadKnowledgeSource,
    },
  ];
}
