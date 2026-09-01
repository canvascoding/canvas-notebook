import 'server-only';

import path from 'node:path';

import {
  ProtocolError,
  ProtocolErrorCode,
  type AuthInfo,
  type CallToolResult,
} from '@modelcontextprotocol/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  getFileStats,
  listDirectory,
  readFile,
  validatePath,
  writeFile,
  type FileNode,
} from '@/app/lib/filesystem/workspace-files';
import {
  assertWorkspaceFileRevisionUnchanged,
  getWorkspaceFileRevision,
  normalizeExpectedSha256,
  sha256Buffer,
  WorkspaceFileRevisionError,
} from '@/app/lib/files/revision-guard';
import { applyExactTextEdits, ExactTextPatchError } from '@/app/lib/files/exact-text-patch';
import { validateTextFileContent } from '@/app/lib/files/text-content-validation';
import {
  assertFileCollaborationWriteAllowed,
  ensureFileRevisionForCurrentContent,
  getFileCollaborationState,
} from '@/app/lib/files/collaboration-policy';
import { publishWorkspaceFileMutation } from '@/app/lib/filesystem/file-watcher';
import { syncPublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import {
  executePreparedCollaborationTextEdit,
  prepareCollaborationTextEdit,
  readCurrentCollaborationTextSnapshot,
} from '@/app/lib/collaboration/agent-file-edits';
import {
  resolveTextCollaborationState,
  selectInitialTextCollaborationRepresentation,
} from '@/app/lib/collaboration/document-state-service';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import {
  DirectMcpAuthorizationError,
  verifyDirectMcpAccessToken,
  type DirectMcpAccessPrincipal,
} from '@/app/lib/mcp/server/access-token-verifier';
import {
  DIRECT_MCP_ASSET_DEFAULT_MAX_CHARACTERS,
  DIRECT_MCP_ASSET_DEFAULT_MAX_PDF_IMAGES,
  DIRECT_MCP_ASSET_DEFAULT_MAX_PDF_TEXT_PAGES,
  DIRECT_MCP_ASSET_MAX_BYTES,
  DIRECT_MCP_ASSET_MAX_CHARACTERS,
  DIRECT_MCP_ASSET_MAX_PDF_IMAGES,
  DIRECT_MCP_ASSET_MAX_PDF_TEXT_PAGES,
  DirectMcpAssetReadError,
  readDirectMcpAsset,
} from '@/app/lib/mcp/server/asset-reader';
import {
  abortDirectMcpBinaryUpload,
  beginDirectMcpBinaryUpload,
  completeDirectMcpBinaryUpload,
  decodeDirectMcpUploadChunk,
  directMcpBinaryUploadErrorMessage,
  DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS,
  DIRECT_MCP_UPLOAD_MAX_BYTES,
  DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES,
  normalizeDirectMcpUploadMimeType,
  writeDirectMcpBinaryUploadChunk,
} from '@/app/lib/mcp/server/binary-upload';
import {
  type DirectMcpResourceScope,
  type DirectMcpToolId,
} from '@/app/lib/mcp/server/config';
import { directMcpToolAuthorizationError } from '@/app/lib/mcp/server/tool-auth';
import type { DirectMcpToolDescriptor } from '@/app/lib/mcp/server/tool-descriptor';
import {
  isDirectMcpReadableWorkspace,
  listDirectMcpAllowedWorkspaceIds,
  listDirectMcpEnabledWorkspaceIds,
  loadDirectMcpWorkspaceListingForUser,
} from '@/app/lib/mcp/server/workspace-access-policy';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export const DIRECT_MCP_WORKSPACE_TOOL_IDS = [
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
  'edit_knowledge_source',
  'read_knowledge_asset',
  'upload_knowledge_asset',
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
const MAX_EDIT_TEXT_LENGTH = 256 * 1024;
const MAX_EDIT_OCCURRENCES = 10_000;
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

function requiredInteger(args: JsonObject, name: string, minimum: number, maximum: number): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidParams(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function optionalBoolean(args: JsonObject, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalidParams(`${name} must be a boolean.`);
  return value;
}

function optionalPositiveIntegerArray(
  args: JsonObject,
  name: string,
  maximumLength: number,
): number[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumLength) {
    invalidParams(`${name} must be an array of at most ${maximumLength} positive integers.`);
  }
  if (value.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    invalidParams(`${name} must contain only positive integers.`);
  }
  return value;
}

function requiredText(args: JsonObject, name: string, maxLength: number, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    invalidParams(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'} up to ${maxLength} characters.`);
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
      description: 'Lists the Canvas workspaces that the signed-in user has explicitly allowed for this MCP connection.',
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

  if (tool === 'edit_knowledge_source') {
    return {
      name: tool,
      title: 'Edit workspace document',
      description: 'Applies one exact, conflict-protected text replacement to an existing visible workspace file. Read the file first and pass its current SHA-256 hash.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'Workspace-relative path of an existing visible text file.' },
          old_text: { type: 'string', minLength: 1, description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'Replacement text. May be empty to remove the matched text.' },
          expected_sha256: { type: 'string', description: 'Required SHA-256 returned by read_knowledge_source.' },
          expected_occurrences: { type: 'integer', minimum: 1, maximum: MAX_EDIT_OCCURRENCES, description: 'Expected number of old_text matches. Defaults to 1.' },
          replace_all: { type: 'boolean', description: 'Replace every matching occurrence. Cannot be combined with expected_occurrences.' },
        },
        required: ['workspace_id', 'path', 'old_text', 'new_text', 'expected_sha256'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string' },
          path: { type: 'string' },
          changed: { type: 'boolean' },
          review_required: { type: 'boolean' },
          before_sha256: { type: 'string' },
          after_sha256: { type: 'string' },
          size: { type: 'integer' },
          modified_at: { type: ['string', 'null'] },
        },
        required: ['workspace_id', 'path', 'changed', 'review_required', 'before_sha256', 'after_sha256', 'size', 'modified_at'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...getToolSecurity('knowledge:write'),
    };
  }

  if (tool === 'read_knowledge_asset') {
    return {
      name: tool,
      title: 'Read workspace image or PDF',
      description: 'Returns bounded visual context for an image, or bounded text and selected rendered pages for a PDF, from a visible workspace file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'Workspace-relative path of a visible PNG, JPEG, GIF, WebP, or PDF file.' },
          max_characters: { type: 'integer', minimum: 1, maximum: DIRECT_MCP_ASSET_MAX_CHARACTERS, description: 'For PDFs, maximum extracted text characters. Defaults to 24000.' },
          max_pdf_text_pages: { type: 'integer', minimum: 1, maximum: DIRECT_MCP_ASSET_MAX_PDF_TEXT_PAGES, description: 'For PDFs, maximum pages to parse for text unless pdf_text_pages is provided. Defaults to 20.' },
          pdf_text_pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: DIRECT_MCP_ASSET_MAX_PDF_TEXT_PAGES, description: 'For PDFs, specific 1-based pages to parse for text.' },
          include_pdf_images: { type: 'boolean', description: 'For PDFs, include rendered page images for visual analysis. Defaults to automatic inclusion for bounded PDFs.' },
          pdf_image_pages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: DIRECT_MCP_ASSET_MAX_PDF_IMAGES, description: 'For PDFs, specific 1-based pages to render as images.' },
          max_pdf_images: { type: 'integer', minimum: 1, maximum: DIRECT_MCP_ASSET_MAX_PDF_IMAGES, description: 'For PDFs, maximum rendered page images. Defaults to 2.' },
        },
        required: ['workspace_id', 'path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string', enum: ['image', 'pdf'] },
          mime_type: { type: 'string' },
          sha256: { type: 'string' },
          size: { type: 'integer' },
          modified_at: { type: ['string', 'null'] },
          pages: { type: 'integer' },
          text_pages_read: { type: 'array', items: { type: 'integer' } },
          text_page_limited: { type: 'boolean' },
          truncated: { type: 'boolean' },
          rendered_pages: { type: 'array', items: { type: 'object' } },
          skipped_rendered_page_count: { type: 'integer' },
        },
        required: ['workspace_id', 'path', 'type', 'mime_type', 'sha256', 'size', 'modified_at'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...getToolSecurity('knowledge:assets'),
    };
  }

  if (tool === 'upload_knowledge_asset') {
    return {
      name: tool,
      title: 'Upload a binary workspace file',
      description: 'Uploads one binary file in a short-lived, conflict-protected session. Call begin, send ordered Base64 chunks, then call complete; call abort to discard an unfinished upload.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          operation: { type: 'string', enum: ['begin', 'chunk', 'complete', 'abort'], description: 'Upload operation to perform.' },
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'For begin, the visible workspace-relative destination path.' },
          size: { type: 'integer', minimum: 1, maximum: DIRECT_MCP_UPLOAD_MAX_BYTES, description: 'For begin, exact file size in bytes.' },
          mime_type: { type: 'string', description: 'For begin, MIME type without parameters. Defaults to application/octet-stream.' },
          sha256: { type: 'string', description: 'For begin, lowercase SHA-256 of the complete file.' },
          overwrite: { type: 'boolean', description: 'For begin, allow replacing an existing file. Defaults to false.' },
          expected_sha256: { type: 'string', description: 'For overwrite, the current destination SHA-256 returned by a read tool.' },
          upload_id: { type: 'string', description: 'Short-lived opaque upload handle returned by begin.' },
          offset: { type: 'integer', minimum: 0, description: 'For chunk, zero-based byte offset. Chunks must be sent in order.' },
          data_base64: { type: 'string', maxLength: DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS, description: `For chunk, canonical standard Base64 encoding of 1 to ${DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES} bytes.` },
        },
        required: ['operation', 'workspace_id'],
        oneOf: [
          {
            properties: { operation: { const: 'begin' } },
            required: ['path', 'size', 'sha256'],
          },
          {
            properties: { operation: { const: 'chunk' } },
            required: ['upload_id', 'offset', 'data_base64'],
          },
          {
            properties: { operation: { const: 'complete' } },
            required: ['upload_id'],
          },
          {
            properties: { operation: { const: 'abort' } },
            required: ['upload_id'],
          },
        ],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          operation: { type: 'string', enum: ['begin', 'chunk', 'complete', 'abort'] },
          workspace_id: { type: 'string' },
          path: { type: 'string' },
          upload_id: { type: 'string' },
          next_offset: { type: 'integer' },
          total_size: { type: 'integer' },
          max_chunk_bytes: { type: 'integer' },
          expires_at: { type: 'string' },
          already_received: { type: 'boolean' },
          already_completed: { type: 'boolean' },
          mime_type: { type: 'string' },
          detected_mime_type: { type: ['string', 'null'] },
          before_sha256: { type: ['string', 'null'] },
          after_sha256: { type: 'string' },
          modified_at: { type: ['string', 'null'] },
        },
        required: ['operation', 'workspace_id', 'path'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      ...getToolSecurity('knowledge:write'),
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
        sha256: { type: 'string' },
        source: { type: 'string' },
        truncated: { type: 'boolean' },
        next_offset: { type: ['integer', 'null'] },
      },
      required: ['path', 'content', 'sha256', 'source', 'truncated', 'next_offset'],
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

async function authenticateForTool(
  authInfo: AuthInfo | undefined,
  scope: DirectMcpResourceScope,
): Promise<{ principal: DirectMcpAccessPrincipal } | { result: CallToolResult }> {
  if (!authInfo?.token) return { result: directMcpToolAuthorizationError(undefined, scope) };
  try {
    return { principal: await verifyDirectMcpAccessToken(authInfo.token, [scope]) };
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) {
      return { result: directMcpToolAuthorizationError(error, scope) };
    }
    throw error;
  }
}

async function readableWorkspace(
  principal: DirectMcpAccessPrincipal,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const [listing, allowedWorkspaceIds, enabledWorkspaceIds] = await Promise.all([
    loadDirectMcpWorkspaceListingForUser(principal.userId),
    listDirectMcpAllowedWorkspaceIds(principal),
    listDirectMcpEnabledWorkspaceIds(),
  ]);
  const workspace = listing.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (
    !workspace
    || !isDirectMcpReadableWorkspace(workspace)
    || !enabledWorkspaceIds.has(workspaceId)
    || !allowedWorkspaceIds.has(workspaceId)
  ) {
    throw new Error('The requested workspace is not available to this Canvas user.');
  }
  return workspace;
}

async function writableWorkspace(
  principal: DirectMcpAccessPrincipal,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const workspace = await readableWorkspace(principal, workspaceId);
  if (!workspace.permissions.canWrite) {
    throw new Error('The requested workspace is not writable by this Canvas user.');
  }
  return workspace;
}

type DirectMcpTextContent = {
  content: string;
  sha256: string;
  source: 'file' | 'live_yjs';
  documentId?: string;
};

async function readDirectMcpTextContent(input: {
  workspace: WorkspaceContext;
  path: string;
  buffer: Buffer;
  principal: DirectMcpAccessPrincipal;
}): Promise<DirectMcpTextContent> {
  const fallback = {
    content: input.buffer.toString('utf8'),
    sha256: sha256Buffer(input.buffer),
    source: 'file' as const,
  };
  if (getDatabaseProvider() !== 'postgres') return fallback;

  const collaboration = getFileCollaborationState({
    workspace: input.workspace,
    path: input.path,
    ensureDocument: true,
  });
  if (!collaboration.crdtCapable || !collaboration.document) return fallback;

  ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.path,
    contentHash: fallback.sha256,
    sizeBytes: input.buffer.length,
    actorUserId: input.principal.userId,
    actorType: 'user',
    sourceSessionId: input.principal.sessionId,
  });
  await resolveTextCollaborationState({
    document: collaboration.document,
    workspace: input.workspace,
    path: input.path,
    initialRepresentation: selectInitialTextCollaborationRepresentation(input.path, fallback.content),
    initialContent: fallback.content,
  });
  const snapshot = await readCurrentCollaborationTextSnapshot({
    documentId: collaboration.document.id,
    workspace: input.workspace,
  });
  return {
    content: snapshot.content,
    sha256: snapshot.sha256,
    source: 'live_yjs',
    documentId: snapshot.documentId,
  };
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

function assetResult(
  structuredContent: Record<string, unknown>,
  content: CallToolResult['content'],
): CallToolResult {
  return { content, structuredContent };
}

async function auditWorkspaceToolCall(input: {
  principal: DirectMcpAccessPrincipal;
  tool: WorkspaceToolName;
  workspace?: WorkspaceContext;
  resultCount?: number;
  path?: string;
  beforeSha256?: string;
  afterSha256?: string;
  changed?: boolean;
  reviewRequired?: boolean;
  assetType?: 'image' | 'pdf';
  mimeType?: string;
  sizeBytes?: number;
  pageCount?: number;
  uploadOperation?: 'begin' | 'chunk' | 'complete' | 'abort';
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
      clientId: input.principal.clientId,
      resultCount: input.resultCount ?? null,
      path: input.path ?? null,
      beforeSha256: input.beforeSha256 ?? null,
      afterSha256: input.afterSha256 ?? null,
      changed: input.changed ?? null,
      reviewRequired: input.reviewRequired ?? null,
      assetType: input.assetType ?? null,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      pageCount: input.pageCount ?? null,
      uploadOperation: input.uploadOperation ?? null,
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
    const [listing, allowedWorkspaceIds, enabledWorkspaceIds] = await Promise.all([
      loadDirectMcpWorkspaceListingForUser(authorization.principal.userId),
      listDirectMcpAllowedWorkspaceIds(authorization.principal),
      listDirectMcpEnabledWorkspaceIds(),
    ]);
    const workspaces = listing.workspaces
      .filter((workspace) => (
        isDirectMcpReadableWorkspace(workspace)
        && enabledWorkspaceIds.has(workspace.workspaceId)
        && allowedWorkspaceIds.has(workspace.workspaceId)
      ))
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
    const text = await readDirectMcpTextContent({
      workspace,
      path: filePath,
      buffer,
      principal: authorization.principal,
    });
    if (Buffer.byteLength(text.content, 'utf8') > MAX_READ_FILE_BYTES) {
      return errorResult(`The requested file is larger than the ${MAX_READ_FILE_BYTES / 1024} KB MCP read limit.`);
    }
    const content = text.content.slice(offset, offset + maxCharacters);
    const nextOffset = offset + content.length < text.content.length ? offset + content.length : null;
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      path: filePath,
      content,
      sha256: text.sha256,
      source: text.source,
      truncated: nextOffset !== null,
      next_offset: nextOffset,
      size: Buffer.byteLength(text.content, 'utf8'),
      modified_at: toIsoDate(stats.modified),
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'read_knowledge_source',
      workspace,
      resultCount: content.length,
      path: filePath,
      afterSha256: text.sha256,
    });
    return result(structuredContent, `Read ${content.length} characters from ${filePath}.`);
  } catch {
    return errorResult('Could not read the Canvas workspace file.');
  }
}

function assetErrorResult(error: unknown): CallToolResult {
  if (error instanceof DirectMcpAssetReadError) return errorResult(error.message);
  return errorResult('Could not read the Canvas workspace asset.');
}

async function executeReadKnowledgeAsset(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const filePath = requiredString(parsed, 'path', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(filePath);
  const maxCharacters = optionalInteger(
    parsed,
    'max_characters',
    DIRECT_MCP_ASSET_DEFAULT_MAX_CHARACTERS,
    1,
    DIRECT_MCP_ASSET_MAX_CHARACTERS,
  );
  const maxPdfTextPages = optionalInteger(
    parsed,
    'max_pdf_text_pages',
    DIRECT_MCP_ASSET_DEFAULT_MAX_PDF_TEXT_PAGES,
    1,
    DIRECT_MCP_ASSET_MAX_PDF_TEXT_PAGES,
  );
  const pdfTextPages = optionalPositiveIntegerArray(
    parsed,
    'pdf_text_pages',
    DIRECT_MCP_ASSET_MAX_PDF_TEXT_PAGES,
  );
  const includePdfImages = optionalBoolean(parsed, 'include_pdf_images');
  const pdfImagePages = optionalPositiveIntegerArray(
    parsed,
    'pdf_image_pages',
    DIRECT_MCP_ASSET_MAX_PDF_IMAGES,
  );
  const maxPdfImages = optionalInteger(
    parsed,
    'max_pdf_images',
    DIRECT_MCP_ASSET_DEFAULT_MAX_PDF_IMAGES,
    1,
    DIRECT_MCP_ASSET_MAX_PDF_IMAGES,
  );
  const authorization = await authenticateForTool(authInfo, 'knowledge:assets');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await readableWorkspace(authorization.principal, workspaceId);
    const stats = await getFileStats(filePath, { workspace });
    if (!stats.isFile) return errorResult('The requested path is a folder, not a file.');
    if (stats.size > DIRECT_MCP_ASSET_MAX_BYTES) {
      return errorResult(`The requested asset is larger than the ${DIRECT_MCP_ASSET_MAX_BYTES / (1024 * 1024)} MB MCP asset limit.`);
    }
    const buffer = await readFile(filePath, { workspace });
    const asset = await readDirectMcpAsset({
      path: filePath,
      buffer,
      options: {
        maxCharacters,
        maxPdfTextPages,
        pdfTextPages,
        includePdfImages,
        pdfImagePages,
        maxPdfImages,
      },
    });
    const sha256 = sha256Buffer(buffer);
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      path: filePath,
      type: asset.kind.type,
      mime_type: asset.kind.mimeType,
      sha256,
      size: buffer.length,
      modified_at: toIsoDate(stats.modified),
      ...(asset.kind.type === 'pdf' ? {
        pages: asset.pages ?? 0,
        text_pages_read: asset.textPagesRead ?? [],
        text_page_limited: asset.textPageLimited ?? false,
        truncated: asset.truncated ?? false,
        rendered_pages: asset.images ?? [],
        skipped_rendered_page_count: asset.skippedImageCount ?? 0,
      } : {}),
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'read_knowledge_asset',
      workspace,
      resultCount: asset.content.filter((part) => part.type === 'image').length,
      path: filePath,
      afterSha256: sha256,
      assetType: asset.kind.type,
      mimeType: asset.kind.mimeType,
      sizeBytes: buffer.length,
      pageCount: asset.pages,
    });
    return assetResult(structuredContent, asset.content);
  } catch (error) {
    return assetErrorResult(error);
  }
}

async function executeUploadKnowledgeAsset(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const operation = requiredString(parsed, 'operation', 20);
  if (!['begin', 'chunk', 'complete', 'abort'].includes(operation)) {
    invalidParams('operation must be begin, chunk, complete, or abort.');
  }
  const uploadOperation = operation as 'begin' | 'chunk' | 'complete' | 'abort';
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const authorization = await authenticateForTool(authInfo, 'knowledge:write');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await writableWorkspace(authorization.principal, workspaceId);

    if (uploadOperation === 'begin') {
      const filePath = requiredString(parsed, 'path', MAX_PATH_LENGTH);
      assertVisibleWorkspacePath(filePath);
      const size = requiredInteger(parsed, 'size', 1, DIRECT_MCP_UPLOAD_MAX_BYTES);
      const contentSha256 = normalizeExpectedSha256(requiredString(parsed, 'sha256', 80));
      if (!contentSha256) invalidParams('sha256 must be a valid SHA-256 hash of the complete file.');
      const expectedSha256 = parsed.expected_sha256 === undefined
        ? null
        : normalizeExpectedSha256(requiredString(parsed, 'expected_sha256', 80));
      if (parsed.expected_sha256 !== undefined && !expectedSha256) {
        invalidParams('expected_sha256 must be a valid SHA-256 hash returned by a read tool.');
      }
      const mimeType = normalizeDirectMcpUploadMimeType(
        optionalString(parsed, 'mime_type', 'application/octet-stream', 200),
      );
      const upload = await beginDirectMcpBinaryUpload({
        principal: authorization.principal,
        workspace,
        path: filePath,
        size,
        mimeType,
        contentSha256,
        overwrite: optionalBoolean(parsed, 'overwrite') ?? false,
        expectedSha256,
      });
      const structuredContent = {
        operation: uploadOperation,
        workspace_id: workspace.workspaceId,
        path: filePath,
        upload_id: upload.uploadId,
        next_offset: upload.nextOffset,
        total_size: size,
        max_chunk_bytes: upload.maxChunkBytes,
        expires_at: upload.expiresAt,
        mime_type: mimeType,
        before_sha256: upload.beforeSha256,
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool: 'upload_knowledge_asset',
        workspace,
        path: filePath,
        beforeSha256: upload.beforeSha256 ?? undefined,
        changed: false,
        mimeType,
        sizeBytes: size,
        uploadOperation,
      });
      return result(structuredContent, `Binary upload started for ${filePath}. Send chunks beginning at byte 0.`);
    }

    const uploadId = requiredString(parsed, 'upload_id', 4096);
    if (uploadOperation === 'chunk') {
      const offset = requiredInteger(parsed, 'offset', 0, DIRECT_MCP_UPLOAD_MAX_BYTES);
      const encodedData = requiredText(
        parsed,
        'data_base64',
        DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS,
      );
      const buffer = decodeDirectMcpUploadChunk(encodedData);
      const upload = await writeDirectMcpBinaryUploadChunk({
        principal: authorization.principal,
        workspace,
        uploadId,
        offset,
        buffer,
      });
      const structuredContent = {
        operation: uploadOperation,
        workspace_id: workspace.workspaceId,
        path: upload.path,
        next_offset: upload.nextOffset,
        total_size: upload.totalBytes,
        already_received: upload.alreadyReceived,
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool: 'upload_knowledge_asset',
        workspace,
        path: upload.path,
        resultCount: buffer.length,
        changed: false,
        sizeBytes: buffer.length,
        uploadOperation,
      });
      return result(
        structuredContent,
        upload.nextOffset === upload.totalBytes
          ? `All bytes for ${upload.path} were received. Call complete to verify and save the file.`
          : `Received ${buffer.length} bytes for ${upload.path}. Continue at byte ${upload.nextOffset}.`,
      );
    }

    if (uploadOperation === 'complete') {
      const upload = await completeDirectMcpBinaryUpload({
        principal: authorization.principal,
        workspace,
        uploadId,
      });
      const structuredContent = {
        operation: uploadOperation,
        workspace_id: workspace.workspaceId,
        path: upload.path,
        total_size: upload.size,
        already_completed: upload.alreadyCompleted,
        mime_type: upload.mimeType,
        detected_mime_type: upload.detectedMimeType,
        before_sha256: upload.beforeSha256,
        after_sha256: upload.afterSha256,
        modified_at: toIsoDate(upload.modifiedAt),
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool: 'upload_knowledge_asset',
        workspace,
        path: upload.path,
        beforeSha256: upload.beforeSha256 ?? undefined,
        afterSha256: upload.afterSha256,
        changed: !upload.alreadyCompleted,
        mimeType: upload.mimeType,
        sizeBytes: upload.size,
        uploadOperation,
      });
      return result(
        structuredContent,
        upload.alreadyCompleted
          ? `The binary upload for ${upload.path} was already completed.`
          : `Uploaded ${upload.path} and verified its SHA-256 hash.`,
      );
    }

    const upload = await abortDirectMcpBinaryUpload({
      principal: authorization.principal,
      workspace,
      uploadId,
    });
    const structuredContent = {
      operation: uploadOperation,
      workspace_id: workspace.workspaceId,
      path: upload.path,
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'upload_knowledge_asset',
      workspace,
      path: upload.path,
      changed: false,
      uploadOperation,
    });
    return result(structuredContent, `Discarded the unfinished binary upload for ${upload.path}.`);
  } catch (error) {
    return errorResult(directMcpBinaryUploadErrorMessage(error));
  }
}

function editErrorResult(error: unknown): CallToolResult {
  if (error instanceof WorkspaceFileRevisionError) {
    return errorResult('The workspace file changed since it was read. Read the current file content again before retrying.');
  }
  if (error instanceof ExactTextPatchError) {
    return errorResult('The requested exact text replacement no longer matches the current file content. Read the file again and retry with a precise replacement.');
  }
  return errorResult('Could not safely update the Canvas workspace file.');
}

async function executeEditKnowledgeSource(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const filePath = requiredString(parsed, 'path', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(filePath);
  const oldText = requiredText(parsed, 'old_text', MAX_EDIT_TEXT_LENGTH);
  const newText = requiredText(parsed, 'new_text', MAX_EDIT_TEXT_LENGTH, true);
  const expectedSha256 = normalizeExpectedSha256(requiredString(parsed, 'expected_sha256', 80));
  if (!expectedSha256) invalidParams('expected_sha256 must be a SHA-256 hash returned by read_knowledge_source.');
  const replaceAll = optionalBoolean(parsed, 'replace_all');
  const expectedOccurrences = replaceAll
    ? (parsed.expected_occurrences === undefined
      ? undefined
      : optionalInteger(parsed, 'expected_occurrences', 1, 1, MAX_EDIT_OCCURRENCES))
    : optionalInteger(parsed, 'expected_occurrences', 1, 1, MAX_EDIT_OCCURRENCES);
  const authorization = await authenticateForTool(authInfo, 'knowledge:write');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await writableWorkspace(authorization.principal, workspaceId);
    const stats = await getFileStats(filePath, { workspace });
    if (!stats.isFile) return errorResult('The requested path is a folder, not a file.');
    if (stats.size > MAX_READ_FILE_BYTES) {
      return errorResult(`The requested file is larger than the ${MAX_READ_FILE_BYTES / 1024} KB MCP edit limit.`);
    }
    const buffer = await readFile(filePath, { workspace });
    if (isLikelyBinary(filePath, buffer)) {
      return errorResult('Only text files can be edited through this MCP tool.');
    }
    const current = await readDirectMcpTextContent({
      workspace,
      path: filePath,
      buffer,
      principal: authorization.principal,
    });
    if (Buffer.byteLength(current.content, 'utf8') > MAX_READ_FILE_BYTES) {
      return errorResult(`The requested file is larger than the ${MAX_READ_FILE_BYTES / 1024} KB MCP edit limit.`);
    }
    if (current.sha256 !== expectedSha256) {
      return errorResult('The workspace file changed since it was read. Read the current file content again before retrying.');
    }

    const edits = [{
      oldText,
      newText,
      expectedOccurrences,
      replaceAll,
    }];
    const proposedContent = applyExactTextEdits(current.content, edits, filePath);
    if (Buffer.byteLength(proposedContent, 'utf8') > MAX_READ_FILE_BYTES) {
      return errorResult(`The updated file would exceed the ${MAX_READ_FILE_BYTES / 1024} KB MCP edit limit.`);
    }
    const validation = validateTextFileContent(filePath, proposedContent);
    if (!validation.ok) {
      return errorResult('The requested edit would leave the file in an invalid state.');
    }
    if (proposedContent === current.content) {
      const structuredContent = {
        workspace_id: workspace.workspaceId,
        path: filePath,
        changed: false,
        review_required: false,
        before_sha256: current.sha256,
        after_sha256: current.sha256,
        size: Buffer.byteLength(current.content, 'utf8'),
        modified_at: toIsoDate(stats.modified),
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool: 'edit_knowledge_source',
        workspace,
        resultCount: 0,
        path: filePath,
        beforeSha256: current.sha256,
        afterSha256: current.sha256,
        changed: false,
        reviewRequired: false,
      });
      return result(structuredContent, `No change was needed for ${filePath}.`);
    }

    if (current.source === 'live_yjs' && current.documentId) {
      const prepared = await prepareCollaborationTextEdit({
        documentId: current.documentId,
        workspace,
        path: filePath,
        edits,
        expectedSha256,
        groupId: 'direct_mcp_edit',
      });
      const preparedValidation = validateTextFileContent(filePath, prepared.proposedContent);
      if (!preparedValidation.ok) {
        return errorResult('The requested edit would leave the file in an invalid state.');
      }
      const operation = await executePreparedCollaborationTextEdit({
        prepared,
        workspace,
        identity: {
          initiatedByUserId: authorization.principal.userId,
          actorId: `direct-mcp:${authorization.principal.clientId}`,
          actorDisplayName: 'External MCP client',
          actorSessionId: authorization.principal.sessionId,
        },
      });
      const after = await readCurrentCollaborationTextSnapshot({
        documentId: prepared.documentId,
        workspace,
      });
      const reviewRequired = operation.operationStatus === 'needs_review'
        || operation.operationStatus === 'partially_applied'
        || operation.operationStatus === 'semantic_conflict';
      const changed = after.sha256 !== prepared.sha256;
      const afterStats = await getFileStats(filePath, { workspace });
      const structuredContent = {
        workspace_id: workspace.workspaceId,
        path: filePath,
        changed,
        review_required: reviewRequired,
        before_sha256: prepared.sha256,
        after_sha256: after.sha256,
        size: Buffer.byteLength(after.content, 'utf8'),
        modified_at: toIsoDate(afterStats.modified),
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool: 'edit_knowledge_source',
        workspace,
        resultCount: changed ? 1 : 0,
        path: filePath,
        beforeSha256: prepared.sha256,
        afterSha256: after.sha256,
        changed,
        reviewRequired,
      });
      return result(
        structuredContent,
        reviewRequired
          ? `A collaboration review was created for ${filePath}.`
          : changed
            ? `Updated ${filePath}.`
            : `No change was applied to ${filePath}.`,
      );
    }

    const beforeRevision = await getWorkspaceFileRevision(filePath, { workspace });
    if (!beforeRevision || beforeRevision.sha256 !== expectedSha256) {
      return errorResult('The workspace file changed since it was read. Read the current file content again before retrying.');
    }
    const baseRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: filePath,
      contentHash: beforeRevision.sha256,
      sizeBytes: beforeRevision.stats.size,
      actorUserId: authorization.principal.userId,
      actorType: 'user',
      sourceSessionId: authorization.principal.sessionId,
    });
    assertFileCollaborationWriteAllowed({
      workspace,
      path: filePath,
      actorUserId: authorization.principal.userId,
      actorSessionId: authorization.principal.sessionId,
      actorType: 'user',
      baseRevisionId: baseRevision.id,
    });
    await writeFile(filePath, proposedContent, { workspace }, async () => {
      await assertWorkspaceFileRevisionUnchanged({
        path: filePath,
        expectedRevision: beforeRevision,
        options: { workspace },
      });
    });
    const afterBuffer = await readFile(filePath, { workspace });
    const afterSha256 = sha256Buffer(afterBuffer);
    if (afterBuffer.toString('utf8') !== proposedContent) {
      throw new Error('Read-after-write verification failed.');
    }
    const afterRevision = ensureFileRevisionForCurrentContent({
      workspace,
      path: filePath,
      contentHash: afterSha256,
      sizeBytes: afterBuffer.length,
      actorUserId: authorization.principal.userId,
      actorType: 'user',
      sourceSessionId: authorization.principal.sessionId,
      baseRevisionId: baseRevision.id,
    });
    await syncPublicSharesAfterWrite([validatePath(filePath, { workspace })]);
    publishWorkspaceFileMutation({ workspace, type: 'change', relativePath: filePath });
    const afterStats = await getFileStats(filePath, { workspace });
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      path: filePath,
      changed: true,
      review_required: false,
      before_sha256: beforeRevision.sha256,
      after_sha256: afterRevision.contentHash,
      size: afterBuffer.length,
      modified_at: toIsoDate(afterStats.modified),
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'edit_knowledge_source',
      workspace,
      resultCount: 1,
      path: filePath,
      beforeSha256: beforeRevision.sha256,
      afterSha256: afterRevision.contentHash,
      changed: true,
      reviewRequired: false,
    });
    return result(structuredContent, `Updated ${filePath}.`);
  } catch (error) {
    return editErrorResult(error);
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
    {
      id: 'edit_knowledge_source',
      descriptor: getDirectMcpWorkspaceToolDescriptor('edit_knowledge_source'),
      execute: executeEditKnowledgeSource,
    },
    {
      id: 'read_knowledge_asset',
      descriptor: getDirectMcpWorkspaceToolDescriptor('read_knowledge_asset'),
      execute: executeReadKnowledgeAsset,
    },
    {
      id: 'upload_knowledge_asset',
      descriptor: getDirectMcpWorkspaceToolDescriptor('upload_knowledge_asset'),
      execute: executeUploadKnowledgeAsset,
    },
  ];
}
