import 'server-only';

import path from 'node:path';
import { decodeLegacySearchCursor, encodeLegacySearchCursor, legacySearchFingerprint, LegacyPaginationError } from './legacy-pagination';
import { directMcpFileLinkFields, readDirectMcpFileLinks } from '@/app/lib/mcp/server/file-links';
import { formatWorkspaceTreePage, readWorkspaceTreePage, WorkspaceTreeError } from '@/app/lib/files/workspace-tree';

import {
  ProtocolError,
  ProtocolErrorCode,
  type AuthInfo,
  type CallToolResult,
} from '@modelcontextprotocol/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { DocumentReadError } from '@/app/lib/documents/contracts';
import { readDocumentForDirectMcp, searchDocumentsForDirectMcp } from '@/app/lib/documents/service';
import { DocumentSearchError } from '@/app/lib/documents/search-contract';
import { DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1, DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1 } from '@/app/lib/documents/search-json-schema';
import { decodeDirectMcpDocumentSearchSelection, DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES } from './document-search-tool-contract';
import { DOCUMENT_READ_ERROR_JSON_SCHEMA_V1, DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } from '@/app/lib/documents/read-json-schema';
import { decodeDirectMcpDocumentReadSelection, DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } from './document-read-tool-contract';
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
import { applyExactTextEdits, ExactTextPatchError, type ExactTextEdit } from '@/app/lib/files/exact-text-patch';
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
  prepareCollaborationContentEditInDocument,
  prepareCollaborationTextEdit,
  prepareCollaborationWrite,
  readCurrentCollaborationTextSnapshot,
} from '@/app/lib/collaboration/agent-file-edits';
import { confirmCollaborativeFileCheckpoint, CollaborationFileCheckpointUnavailableError } from '@/app/lib/collaboration/agent-file-checkpoint';
import { AgentFileEditOperationScopeError, AgentFileReviewDisabledConflictError,
  findAgentFileEditOperation, linkStandaloneAgentCheckpoint } from '@/app/lib/collaboration/agent-operations';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { Y } from '@/app/lib/collaboration/server-runtime';
import { listWorkspaceSearchDocuments, readWorkspaceSearchText, WorkspaceSearchReadError,
  type WorkspaceSearchText } from '@/app/lib/collaboration/workspace-search-reader';
import {
  resolveTextCollaborationState,
  selectInitialTextCollaborationRepresentation,
} from '@/app/lib/collaboration/document-state-service';
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
  directMcpBinaryUploadErrorCode,
  readDirectMcpBinaryUploadStatus,
  DirectMcpBinaryUploadError,
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
import {
  buildDirectMcpReviewUrl,
  createDirectMcpEditIdentity,
  parseDirectMcpEditIdempotencyKey,
} from '@/app/lib/mcp/server/document-edit-contract';
import { directMcpToolAuthorizationError } from '@/app/lib/mcp/server/tool-auth';
import { editDocumentForDirectMcp, readDocumentEditStatusForDirectMcp } from '@/app/lib/documents/edit-public-service';
import { decodeDirectMcpNativeDocumentEditSelection, directMcpDocumentEditInputSchema, directMcpDocumentEditOutputSchema,
  formatDirectMcpNativeDocumentEditResult, formatDirectMcpNativeDocumentEditError } from './document-edit-tool-contract';
import { createDirectMcpEditAuthority, DirectMcpEditAuthorityError } from '@/app/lib/mcp/server/direct-edit-authority';
import type { DirectMcpToolDescriptor } from '@/app/lib/mcp/server/tool-descriptor';
import {
  isDirectMcpReadableWorkspace,
  listDirectMcpAllowedWorkspaceIds,
  listDirectMcpEnabledWorkspaceIds,
  loadDirectMcpWorkspaceListingForUser,
} from '@/app/lib/mcp/server/workspace-access-policy';
import { decodeDirectMcpWorkspaceCopyRequestV1, formatDirectMcpWorkspaceCopyResult, formatDirectMcpWorkspaceCopyError,
  DIRECT_MCP_WORKSPACE_COPY_INPUT_SCHEMA_V1, DIRECT_MCP_WORKSPACE_COPY_OUTPUT_SCHEMA_V1 } from './workspace-copy-tool-contract';
import { decodeDirectMcpWorkspaceMoveRequestV1, decodeDirectMcpWorkspaceDeleteRequestV1,
  formatDirectMcpWorkspacePathResult, formatDirectMcpWorkspacePathError,
  DIRECT_MCP_WORKSPACE_MOVE_INPUT_SCHEMA_V1, DIRECT_MCP_WORKSPACE_MOVE_OUTPUT_SCHEMA_V1,
  DIRECT_MCP_WORKSPACE_DELETE_INPUT_SCHEMA_V1, DIRECT_MCP_WORKSPACE_DELETE_OUTPUT_SCHEMA_V1 } from './workspace-path-tool-contract';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { createOrdinaryAgentProposal, type OrdinaryAgentProposalResult } from '@/app/lib/file-version-center/ordinary-agent-proposal';
import { ProposalGraphContractError } from '@/app/lib/file-version-center/contracts/proposal-graph-v1';
import { proposalReviewWritesEnabled } from '@/app/lib/file-version-center/proposal-review-capability';

export const DIRECT_MCP_WORKSPACE_TOOL_IDS = [
  'list_workspaces',
  'get_workspace_overview',
  'list_knowledge_tree',
  'search_knowledge',
  'read_knowledge_source',
  'edit_knowledge_source',
  'replace_knowledge_source',
  'copy_knowledge_source',
  'move_knowledge_source',
  'delete_knowledge_source',
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
  '.csv', '.html', '.json', '.markdown', '.md', '.mdx', '.rst', '.text', '.toml', '.tsv', '.txt', '.xml', '.yaml', '.yml',
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
  if (tool === 'move_knowledge_source' || tool === 'delete_knowledge_source') {
    const move = tool === 'move_knowledge_source';
    return {
      name: tool, title: move ? 'Move workspace files and documents' : 'Delete a workspace document',
      ...getToolSecurity('knowledge:write'),
      description: 'Explicit api_version:1 path operation through the central document owner. Use action:preview with workspace_id and '
        + (move ? 'selections of source_path and destination_path, preserving their order. Existing destinations are hard conflicts; no automatic collision naming. '
          : 'one Markdown document path. Apply archives the document and removes its file annotations. ')
        + 'Preview never imports or changes files. A native-path-import-preparation preview has executionReady:false: apply is permitted only for readiness:requires-import-rebinding and centrally imports the listed originals before the action; blocked previews cannot be applied. '
        + 'Retain the preview planId, exact original paths and a caller-selected operation_id for apply. The resulting operation.planId is the actual native plan; preparation.previewPlanId retains the original preview mapping. Recover is one explicit existing-operation attempt with the same operation_id, plan_id and original paths; it never creates a new job. Status uses workspace_id and operation_id only and publishes no file events. A missing recorded status is separate from a missing recoverable operation. Journal status and historical receipt-confirmed completion are separate facts. Preserve the same request and ID after uncertainty; never automatically replay or generate a replacement ID. Requires knowledge:write and current read/write/delete/agent permission in the same workspace. Preview/apply/recover require native mutations enabled; historical status remains available under current rights when that gate is off. No Undo or legacy Markdown fallback. Results do not invent native document IDs.',
      inputSchema: { ...(move ? DIRECT_MCP_WORKSPACE_MOVE_INPUT_SCHEMA_V1 : DIRECT_MCP_WORKSPACE_DELETE_INPUT_SCHEMA_V1), type: 'object' },
      outputSchema: { ...(move ? DIRECT_MCP_WORKSPACE_MOVE_OUTPUT_SCHEMA_V1 : DIRECT_MCP_WORKSPACE_DELETE_OUTPUT_SCHEMA_V1), type: 'object' },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    };
  }
  if (tool === 'copy_knowledge_source') {
    return {
      name: tool,
      title: 'Copy workspace files and documents',
      ...getToolSecurity('knowledge:write'),
      description: 'Explicit api_version:1 Copy through the central native file owner. Use action:preview with both workspace IDs and selections; retain its planId. For each original selection, take its resolved root destination from preview.pathMappings and preserve the original selection order; mappings also contain descendants. Apply and recover require the same caller-selected operation_id, plan_id and retained resolved selections, with rename_on_collision omitted or false. Collision naming is selected during preview only. Status only observes recorded historical operation facts; COPY_STATUS_NOT_FOUND does not prove that no work has begun. Preserve the original ID and request after uncertainty, and request recover explicitly; never create a replacement key or automatically replay. Requires knowledge:write, current source read permission and destination write permission. Native mutations must be enabled. Preview and status publish no file events. Results contain copied paths, not invented document IDs.',
      inputSchema: { ...DIRECT_MCP_WORKSPACE_COPY_INPUT_SCHEMA_V1, type: 'object' },
      outputSchema: { ...DIRECT_MCP_WORKSPACE_COPY_OUTPUT_SCHEMA_V1, type: 'object' },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    };
  }
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
      description: 'Returns a bounded workspace tree preview as text and structured entries. Use path to expand a child folder at any depth; max_depth is relative to path (0 lists direct children). Use next_cursor with the same workspace_id, path and max_depth to fetch later entries. Directory children_state distinguishes complete, pending, depth_limited and unavailable; unloaded folders are never empty. Hidden paths are never returned.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'Optional workspace-relative starting path. Defaults to the workspace root.' },
          max_depth: { type: 'integer', minimum: 0, maximum: MAX_TREE_DEPTH, description: 'Relative folder expansion depth: 0 lists direct children. Defaults to 2.' },
          max_entries: { type: 'integer', minimum: 1, maximum: MAX_TREE_ENTRIES, description: 'Maximum returned files and folders. Defaults to 200.' },
          cursor: { type: 'string', maxLength: 20000, description: 'Opaque next_cursor from the previous page. Keep workspace_id, path and max_depth unchanged.' },
        },
        required: ['workspace_id'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          entries: { type: 'array', items: { type: 'object' } },
          truncated: { type: 'boolean' },
          workspace_id: { type: 'string' },
          path: { type: 'string' },
          max_depth: { type: 'integer' },
          directories: { type: 'array', items: { type: 'object' } },
          truncated_by_depth: { type: 'boolean' },
          has_more: { type: 'boolean' },
          next_cursor: { type: ['string', 'null'] },
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
      description: 'Use api_version:1 to search visible initialized native text documents with stable IDs, full versions, bounded snippets, explicit coverage and continuation. Read a selected hit with read_knowledge_source using document_id and expected_version; knowledge:read is independently required. Ranking is within each bounded scan window; remote live coverage remains unknown. Physical files, Scenes and PDF bodies are outside V1. Omit native-only fields for legacy path excerpts; pass next_legacy_cursor back as legacy_cursor. Legacy coverage explicitly reports bounded discovery and skipped sources; narrow path when discovery is incomplete.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          query: { type: 'string', minLength: 2, description: 'Text to search for.' },
          path: { type: 'string', description: 'Workspace-relative starting scope. Defaults to ".".' },
          max_results: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Maximum whole hits. Defaults to 8 for native V1, 10 for legacy excerpts.' },
          legacy_cursor: { type: 'string', minLength: 1, maxLength: 1024, description: 'Legacy search only: exact next_legacy_cursor. Keep workspace, query and path unchanged. Native V1 uses cursor instead.' },
          ...DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES,
        },
        required: ['workspace_id', 'query'],
        // Hosts may project oneOf branches without their parent properties.
        // Keep the transport flat; the strict decoder owns native selection.
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        oneOf: [
          { type: 'object', additionalProperties: false,
            properties: { workspace_id: { type: 'string' }, query: { type: 'string' },
              results: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' },
              next_legacy_cursor: { type: ['string', 'null'] }, coverage: { type: 'object' } },
            required: ['workspace_id', 'query', 'results', 'truncated'] },
          DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1,
          DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1,
        ],
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

  if (tool === 'replace_knowledge_source') {
    return {
      name: tool,
      title: 'Replace Markdown document',
      description: 'Replace the complete content of an existing authoritative Markdown document. Read it first and supply its SHA-256 plus a stable idempotency_key. Uses the same live Yjs, revision, permission and review safeguards as editing. Inspect status and authoritative_updated; a review proposal is not an applied change. Unsupported structural or metadata changes fail closed. Create new documents with create_knowledge_source.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string' },
          path: { type: 'string', description: 'Existing workspace-relative .md or .markdown path.' },
          content: { type: 'string', maxLength: MAX_EDIT_TEXT_LENGTH, description: 'Complete replacement Markdown, including any existing frontmatter.' },
          expected_sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
        },
        required: ['workspace_id', 'path', 'content', 'expected_sha256', 'idempotency_key'],
        additionalProperties: false,
      },
      outputSchema: getDirectMcpWorkspaceToolDescriptor('edit_knowledge_source').outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      ...getToolSecurity('knowledge:write'),
    };
  }

  if (tool === 'edit_knowledge_source') {
    return {
      name: tool,
      title: 'Edit workspace document',
      description: 'Use api_version:1 and action:edit for a native documentId/full-version patch with a stable caller idempotency_key; native edits do not require Markdown export or a file projection. Native block patches require tiptap_blocks IDs and their exact local guards. Only state:confirmed confirms persistence; pending or uncertain outcomes require action:status with workspace_id and operation_id through this same tool, never an automatic replay or a new key. Legacy path forms apply one exact SHA-protected text replacement. Document Review Center is off by default: legacy direct edits succeed only after the live Yjs change reaches the physical file; unsafe edits return a conflict. When review is enabled, a proposal may require user action. For legacy forms read the file first, pass its current SHA-256 hash, and inspect status, review_required, requires_user_action, and review_url before reporting success.',
      inputSchema: directMcpDocumentEditInputSchema({
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'Workspace-relative path of an existing visible text file.' },
          old_text: { type: 'string', minLength: 1, description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'Replacement text. May be empty to remove the matched text.' },
          expected_sha256: { type: 'string', description: 'Required SHA-256 returned by read_knowledge_source.' },
          expected_occurrences: { type: 'integer', minimum: 1, maximum: MAX_EDIT_OCCURRENCES, description: 'Expected number of old_text matches. Defaults to 1.' },
          replace_all: { type: 'boolean', description: 'Replace every matching occurrence. Cannot be combined with expected_occurrences.' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$', description: 'Stable caller-generated retry key. Reuse only for the exact same edit request.' },
        },
        required: ['workspace_id', 'path', 'old_text', 'new_text', 'expected_sha256'],
        additionalProperties: false,
      }),
      outputSchema: directMcpDocumentEditOutputSchema({
        type: 'object' as const,
        properties: {
          workspace_id: { type: 'string' },
          path: { type: 'string' },
          changed: { type: 'boolean' },
          status: { type: 'string', enum: ['no_change', 'applied', 'review_created', 'review_reused'] },
          review_required: { type: 'boolean' },
          authoritative_updated: { type: 'boolean' },
          requires_user_action: { type: 'boolean' },
          before_sha256: { type: 'string' },
          after_sha256: { type: 'string' },
          current_sha256: { type: 'string' },
          proposed_sha256: { type: ['string', 'null'] },
          operation_id: { type: ['string', 'null'] },
          proposal_id: { type: ['string', 'null'] },
          proposal_lifecycle: { type: ['string', 'null'] },
          review_url: { type: ['string', 'null'] },
          document_url: { type: 'string' },
          document_id: { type: ['string', 'null'] },
          lineage_id: { type: ['string', 'null'] },
          idempotency_key: { type: 'string' },
          message: { type: 'string' },
          size: { type: 'integer' },
          modified_at: { type: ['string', 'null'] },
        },
        required: ['workspace_id', 'path', 'changed', 'status', 'review_required', 'authoritative_updated',
          'requires_user_action', 'before_sha256', 'after_sha256', 'current_sha256', 'proposed_sha256',
          'operation_id', 'proposal_id', 'proposal_lifecycle', 'review_url', 'document_url', 'idempotency_key',
          'message', 'size', 'modified_at', 'document_id', 'lineage_id'],
        additionalProperties: false,
      }),
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
          document_url: { type: 'string' },
          document_id: { type: ['string', 'null'] },
          lineage_id: { type: ['string', 'null'] },
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
      description: 'Uploads one binary file in a short-lived, conflict-protected session. Call begin with a stable idempotency_key, send ordered Base64 chunks, then complete; status returns the durable next_offset, and abort discards unfinished bytes. Reuse a key only for identical requests. Expired or unconfirmed sessions must be inspected before starting another upload. Completion verifies the original SHA-256 before and after publication.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          operation: { type: 'string', enum: ['begin', 'chunk', 'complete', 'abort', 'status'], description: 'Upload operation to perform.' },
          workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
          path: { type: 'string', description: 'For begin, the visible workspace-relative destination path.' },
          size: { type: 'integer', minimum: 1, maximum: DIRECT_MCP_UPLOAD_MAX_BYTES, description: 'For begin, exact file size in bytes.' },
          mime_type: { type: 'string', description: 'For begin, MIME type without parameters. Defaults to application/octet-stream.' },
          sha256: { type: 'string', description: 'For begin, lowercase SHA-256 of the complete file.' },
          overwrite: { type: 'boolean', description: 'For begin, allow replacing an existing file. Defaults to false.' },
          expected_sha256: { type: 'string', description: 'For overwrite, the current destination SHA-256 returned by a read tool.' },
          idempotency_key: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$', description: 'For begin: stable retry key. Identical retries reuse the original durable session; changed requests conflict. Omitting it retains legacy non-idempotent begin behavior.' },
          chunk_sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'For chunk: optional SHA-256 of exactly the decoded chunk bytes.' },
          upload_id: { type: 'string', description: 'Short-lived opaque upload handle returned by begin.' },
          offset: { type: 'integer', minimum: 0, description: 'For chunk, zero-based byte offset. Chunks must be sent in order.' },
          data_base64: { type: 'string', maxLength: DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS, description: `For chunk, canonical standard Base64 encoding of 1 to ${DIRECT_MCP_UPLOAD_MAX_CHUNK_BYTES} bytes.` },
        },
        required: ['operation', 'workspace_id'],
        // Keep every argument at the top level. Some hosts project oneOf
        // branches without their parent properties and lose the file inputs.
        // executeUploadKnowledgeAsset validates each operation's requirements.
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object' as const,
        properties: {
          operation: { type: 'string', enum: ['begin', 'chunk', 'complete', 'abort', 'status'] },
          workspace_id: { type: 'string' },
          document_url: { type: 'string' },
          document_id: { type: ['string', 'null'] },
          lineage_id: { type: ['string', 'null'] },
          path: { type: 'string' },
          upload_id: { type: 'string' },
          next_offset: { type: 'integer' },
          total_size: { type: 'integer' },
          max_chunk_bytes: { type: 'integer' },
          expires_at: { type: 'string' },
          already_started: { type: 'boolean' },
          state: { type: 'string' },
          sha256: { type: 'string' },
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
    description: 'Reads a visible native document by stable document_id with a full version and UTF-8 continuation pages, or preserves the legacy path-based text excerpt and SHA-256 contract. Supply exactly one selector. Native pages contain the full document/currency/projection envelope; follow nextCursor until complete before treating the body as complete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID from list_workspaces.' },
        path: { type: 'string', description: 'Legacy workspace-relative file path. Cannot be combined with document_id or native page fields.' },
        offset: { type: 'integer', minimum: 0, description: 'Legacy path mode only: UTF-16 character offset. Defaults to 0.' },
        max_characters: { type: 'integer', minimum: 1, maximum: MAX_READ_CHARACTERS, description: 'Legacy path mode only: maximum returned characters. Defaults to 12000.' },
        expected_sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'Legacy path mode only: hash from the first page. Required when offset > 0; changed content returns FILE_REVISION_CONFLICT.' },
        ...DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES,
      },
      required: ['workspace_id'],
      // Do not put selectors in oneOf: host projection can discard workspace,
      // format, limits and even expected_version. The handler validates exactly
      // one selector before any authorization or I/O.
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      oneOf: [
        {
          type: 'object', additionalProperties: false,
          properties: {
            workspace_id: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' },
            document_url: { type: 'string' }, document_id: { type: ['string', 'null'] }, lineage_id: { type: ['string', 'null'] },
            sha256: { type: 'string' }, source: { type: 'string' }, truncated: { type: 'boolean' },
            next_offset: { type: ['integer', 'null'] }, size: { type: 'integer' }, modified_at: { type: ['string', 'null'] },
          },
          required: ['workspace_id', 'path', 'content', 'sha256', 'source', 'truncated', 'next_offset', 'size', 'modified_at'],
        },
        DOCUMENT_READ_PAGE_JSON_SCHEMA_V1,
        DOCUMENT_READ_ERROR_JSON_SCHEMA_V1,
      ],
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
  nativeIdentity: WorkspaceSearchText['nativeIdentity'];
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
    nativeIdentity: null,
  };
  const collaboration = await getFileCollaborationState({
    workspace: input.workspace,
    path: input.path,
    ensureDocument: true,
  });
  if (!collaboration.crdtCapable || !collaboration.document) return fallback;

  // The physical projection may lag or be empty. Reading it must never create
  // a revision of an already authoritative Yjs document.
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
    path: input.path,
  });
  if (snapshot.documentId !== collaboration.document.id || snapshot.path !== input.path) {
    throw new Error('The native text snapshot identity changed.');
  }
  return {
    content: snapshot.content,
    sha256: snapshot.sha256,
    source: 'live_yjs',
    documentId: snapshot.documentId,
    // This legacy snapshot proves document identity, but carries no lineage.
    nativeIdentity: Object.freeze({ documentId: snapshot.documentId, lineageId: null, path: snapshot.path }),
  };
}

async function listBoundedWorkspaceTree(input: {
  workspace: WorkspaceContext;
  path: string;
  maxDepth: number;
  maxEntries: number;
}): Promise<{ entries: WorkspaceTreeEntry[]; truncated: boolean }> {
  return readWorkspaceTreePage({
    workspaceId: input.workspace.workspaceId, rootPath: input.workspace.rootPath,
    path: input.path, maxDepth: input.maxDepth, maxEntries: input.maxEntries,
  });
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
    content: [{ type: 'text', text: typeof content.document_url === 'string'
      ? `${text}\nOpen file: ${content.document_url}` : text }],
    structuredContent: content,
  };
}

function structuredErrorResult(code: string, message: string): CallToolResult {
  return { isError: true, structuredContent: { code, message }, content: [{ type: 'text', text: `${code}: ${message}` }] };
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
  return { content: typeof structuredContent.document_url === 'string'
    ? [...content, { type: 'text', text: `Open file: ${structuredContent.document_url}` }] : content, structuredContent };
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
  uploadOperation?: 'begin' | 'chunk' | 'complete' | 'abort' | 'status';
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
  const cursor = optionalString(parsed, 'cursor', '', 20000) || null;
  const authorization = await authenticateForTool(authInfo, 'knowledge:tree');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await readableWorkspace(authorization.principal, workspaceId);
    const tree = await readWorkspaceTreePage({
      workspaceId: workspace.workspaceId, rootPath: workspace.rootPath,
      path: startPath,
      maxDepth,
      maxEntries,
      cursor,
    });
    const links = await readDirectMcpFileLinks(workspace.workspaceId, tree.entries.filter(entry => entry.type === 'file').map(entry => entry.path));
    const entries = tree.entries.map(entry => ({ ...entry, ...links.get(entry.path) }));
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      ...tree,
      entries,
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'list_knowledge_tree',
      workspace,
      resultCount: tree.entries.length,
    });
    return result(structuredContent, [formatWorkspaceTreePage(tree), ...[...links].map(([path, link]) => `${JSON.stringify(path)}: ${link.document_url}`)].join('\n'));
  } catch (error) {
    if (error instanceof WorkspaceTreeError) return { isError: true,
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      structuredContent: { code: error.code, message: error.message } };
    return errorResult('Could not browse the Canvas workspace.');
  }
}

async function executeSearchKnowledge(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  let nativeSelection: ReturnType<typeof decodeDirectMcpDocumentSearchSelection>;
  try { nativeSelection = decodeDirectMcpDocumentSearchSelection(args); }
  catch { invalidParams('Native search V1 requires api_version:1 and only workspace_id, query, path, max_results and cursor with valid values. Invalid native fields never fall back to legacy file search.'); }
  if (nativeSelection) {
    const authorization = await authenticateForTool(authInfo, 'knowledge:search');
    if ('result' in authorization) return authorization.result;
    if (!authInfo) return directMcpToolAuthorizationError(undefined, 'knowledge:search');
    try {
      const page = await searchDocumentsForDirectMcp(authInfo, nativeSelection);
      // Audit identity only: the service independently validated actual B and
      // completed its transaction. Preserve the exact already budgeted page.
      const workspace = await readableWorkspace(authorization.principal, nativeSelection.workspaceId);
      await auditWorkspaceToolCall({ principal: authorization.principal, tool: 'search_knowledge',
        workspace, resultCount: page.hits.length });
      return { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page };
    } catch (error) {
      if (error instanceof DirectMcpAuthorizationError) return directMcpToolAuthorizationError(error, 'knowledge:search');
      if (error instanceof DocumentSearchError || error instanceof DocumentReadError) {
        const failure = { apiVersion: 1, success: false, code: error.code };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
      }
      return errorResult('Could not search the Canvas native documents.');
    }
  }
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const query = requiredString(parsed, 'query', 200);
  if (Object.keys(parsed).some(key => !['workspace_id', 'query', 'path', 'max_results', 'legacy_cursor'].includes(key))) {
    invalidParams('Legacy search accepts only workspace_id, query, path, max_results and legacy_cursor.');
  }
  if (query.length < 2) invalidParams('query must contain at least 2 characters.');
  const startPath = optionalString(parsed, 'path', '.', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(startPath);
  const maxResults = optionalInteger(parsed, 'max_results', DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
  const legacyCursor = optionalString(parsed, 'legacy_cursor', '', 1024);
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
    } & ReturnType<typeof directMcpFileLinkFields>> = [];

    const nativePaths = await listWorkspaceSearchDocuments(workspace, startPath);
    const candidates = [...new Set([
      ...nativePaths,
      ...tree.entries.filter(entry => entry.type === 'file').map(entry => entry.path),
    ])].filter(filePath => isVisibleWorkspaceNode({ path: filePath, name: path.posix.basename(filePath), type: 'file' })
      && isSearchableTextFile(filePath)).sort((left, right) => left.localeCompare(right));
    const bounded = candidates.slice(0, MAX_SEARCH_CANDIDATES);
    const scope = legacySearchFingerprint([workspace.workspaceId, workspace.rootPath, startPath, query]);
    const snapshot = legacySearchFingerprint([bounded, tree.entries, tree.truncated]);
    const previous = decodeLegacySearchCursor(legacyCursor, scope, snapshot, bounded.length);
    let index = previous.index, skipped = previous.skipped;
    while (index < bounded.length && results.length < maxResults) {
      const filePath = bounded[index++];
      let current;
      try { current = await readWorkspaceSearchText(workspace, filePath, MAX_SEARCH_FILE_BYTES); }
      catch (error) {
        if (error instanceof WorkspaceSearchReadError && ['SOURCE_TOO_LARGE', 'SOURCE_BINARY'].includes(error.code)) {
          skipped += 1;
          continue;
        }
        throw error;
      }
      const excerpt = matchingExcerpt(current.content, query);
      if (!excerpt) continue;
      results.push({
        ...directMcpFileLinkFields({ workspaceId: workspace.workspaceId,
          path: current.nativeIdentity?.path ?? filePath,
          documentId: current.nativeIdentity?.documentId ?? null, lineageId: current.nativeIdentity?.lineageId ?? null }),
        path: filePath,
        excerpt,
        modified_at: toIsoDate(current.modifiedAt === null ? undefined : current.modifiedAt / 1000),
      });
    }

    const nextCursor = index < bounded.length ? encodeLegacySearchCursor(scope, snapshot, index, skipped) : null;
    const discoveryIncomplete = tree.truncated || candidates.length > MAX_SEARCH_CANDIDATES;
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      query,
      results,
      truncated: nextCursor !== null || discoveryIncomplete || skipped > 0,
      next_legacy_cursor: nextCursor,
      coverage: { discovery_complete: !discoveryIncomplete, candidate_limit: MAX_SEARCH_CANDIDATES,
        candidates: bounded.length, scanned: index, skipped, max_depth: MAX_TREE_DEPTH,
        max_file_bytes: MAX_SEARCH_FILE_BYTES, consistency: 'current_per_page',
        complete: !nextCursor && !discoveryIncomplete && skipped === 0 },
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool: 'search_knowledge',
      workspace,
      resultCount: results.length,
    });
    return result(structuredContent, [`${results.length} matching workspace document(s) found.`, ...results.map(entry => `${JSON.stringify(entry.path)}: ${entry.document_url}`)].join('\n'));
  } catch (error) {
    if (error instanceof LegacyPaginationError) return { isError: true, structuredContent: { code: error.code, message: error.message }, content: [{ type: 'text', text: error.message }] };
    return errorResult('Could not search the Canvas workspace.');
  }
}

async function executeReadKnowledgeSource(
  args: unknown,
  authInfo?: AuthInfo,
): Promise<CallToolResult> {
  let nativeSelection: ReturnType<typeof decodeDirectMcpDocumentReadSelection>;
  try { nativeSelection = decodeDirectMcpDocumentReadSelection(args); }
  catch { invalidParams('Native document selection must use only workspace_id, document_id, format, expected_version, max_bytes and cursor with valid values. Do not mix path or character offsets with native pages.'); }
  if (nativeSelection) {
    const authorization = await authenticateForTool(authInfo, 'knowledge:read');
    if ('result' in authorization) return authorization.result;
    if (!authInfo) return directMcpToolAuthorizationError(undefined, 'knowledge:read');
    try {
      const page = await readDocumentForDirectMcp(authInfo, nativeSelection);
      try { assertVisibleWorkspacePath(page.document.path); }
      catch { throw new DocumentReadError('ACCESS_DENIED'); }
      // This genuine workspace read supplies audit identity only; the central
      // service already performed its own current authorization on actual B.
      const workspace = await readableWorkspace(authorization.principal, nativeSelection.workspaceId);
      await auditWorkspaceToolCall({ principal: authorization.principal, tool: 'read_knowledge_source',
        workspace, resultCount: page.byteLength, path: page.document.path });
      return { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page };
    } catch (error) {
      if (error instanceof DirectMcpAuthorizationError) return directMcpToolAuthorizationError(error, 'knowledge:read');
      if (error instanceof DocumentReadError) {
        const failure = { apiVersion: 1, success: false, code: error.code };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
      }
      return errorResult('Could not read the Canvas native document.');
    }
  }
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const filePath = requiredString(parsed, 'path', MAX_PATH_LENGTH);
  if (Object.keys(parsed).some(key => !['workspace_id', 'path', 'offset', 'max_characters', 'expected_sha256'].includes(key))) {
    invalidParams('Legacy read accepts only workspace_id, path, offset, max_characters and expected_sha256.');
  }
  assertVisibleWorkspacePath(filePath);
  const offset = optionalInteger(parsed, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const expectedSha256 = normalizeExpectedSha256(parsed.expected_sha256);
  if ((parsed.expected_sha256 !== undefined || offset > 0) && !expectedSha256) {
    invalidParams('Legacy continuation requires expected_sha256 from the first page.');
  }
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
    if (expectedSha256 && expectedSha256 !== text.sha256) {
      return { isError: true, structuredContent: { code: 'FILE_REVISION_CONFLICT', message: 'Content changed. Restart reading at offset 0.' },
        content: [{ type: 'text', text: 'FILE_REVISION_CONFLICT: Content changed. Restart reading at offset 0.' }] };
    }
    const content = text.content.slice(offset, offset + maxCharacters);
    const nextOffset = offset + content.length < text.content.length ? offset + content.length : null;
    const fileLink = directMcpFileLinkFields({ workspaceId: workspace.workspaceId,
      path: text.nativeIdentity?.path ?? filePath,
      documentId: text.nativeIdentity?.documentId ?? null, lineageId: text.nativeIdentity?.lineageId ?? null });
    const structuredContent = {
      ...fileLink,
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
    const fileLink = (await readDirectMcpFileLinks(workspace.workspaceId, [filePath])).get(filePath)!;
    const structuredContent = {
      ...fileLink,
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
  if (!['begin', 'chunk', 'complete', 'abort', 'status'].includes(operation)) {
    invalidParams('operation must be begin, chunk, complete, abort, or status.');
  }
  const uploadOperation = operation as 'begin' | 'chunk' | 'complete' | 'abort' | 'status';
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
        ...(parsed.idempotency_key !== undefined ? { idempotencyKey: requiredString(parsed, 'idempotency_key', 128) } : {}),
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
        already_started: upload.alreadyStarted,
        state: upload.state,
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
      return result(structuredContent, `Binary upload ${upload.state} for ${filePath}. Continue at byte ${upload.nextOffset}; inspect status before completing or retrying.`);
    }

    const uploadId = requiredString(parsed, 'upload_id', 4096);
    if (uploadOperation === 'status') {
      const upload = await readDirectMcpBinaryUploadStatus({ principal: authorization.principal, workspace, uploadId });
      await auditWorkspaceToolCall({ principal: authorization.principal, tool: 'upload_knowledge_asset', workspace,
        path: upload.path, changed: false, uploadOperation });
      return result({ operation: uploadOperation, workspace_id: workspace.workspaceId, path: upload.path,
        state: upload.state, next_offset: upload.nextOffset, total_size: upload.size, sha256: upload.sha256,
        before_sha256: upload.beforeSha256, expires_at: upload.expiresAt }, `Upload ${upload.state}; next offset ${upload.nextOffset}.`);
    }
    if (uploadOperation === 'chunk') {
      const offset = requiredInteger(parsed, 'offset', 0, DIRECT_MCP_UPLOAD_MAX_BYTES);
      const encodedData = requiredText(
        parsed,
        'data_base64',
        DIRECT_MCP_UPLOAD_MAX_BASE64_CHARACTERS,
      );
      const buffer = decodeDirectMcpUploadChunk(encodedData);
      if (parsed.chunk_sha256 !== undefined) {
        const chunkSha256 = normalizeExpectedSha256(parsed.chunk_sha256);
        if (!chunkSha256) invalidParams('chunk_sha256 must be a SHA-256 hash.');
        if (chunkSha256 !== sha256Buffer(buffer)) throw new DirectMcpBinaryUploadError('Chunk bytes do not match chunk_sha256.', 'UPLOAD_CHUNK_CHECKSUM_MISMATCH');
      }
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
      const fileLink = (await readDirectMcpFileLinks(workspace.workspaceId, [upload.path])).get(upload.path)!;
      const structuredContent = {
        ...fileLink,
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
    if (error instanceof ProtocolError) throw error;
    const message = directMcpBinaryUploadErrorMessage(error), code = directMcpBinaryUploadErrorCode(error);
    return { isError: true, structuredContent: { code, message }, content: [{ type: 'text', text: `${code}: ${message}` }] };
  }
}

function editErrorResult(error: unknown): CallToolResult {
  if (error instanceof DirectMcpEditAuthorityError
    || (error instanceof Error && 'code' in error && error.code === 'MCP_DIRECT_EDIT_AUTHORITY_CHANGED')) {
    return errorResult(`MCP_DIRECT_EDIT_AUTHORITY_CHANGED: ${error.message}`);
  }
  if (error instanceof AgentFileReviewDisabledConflictError
    || error instanceof CollaborationFileCheckpointUnavailableError
    || error instanceof ProposalGraphContractError) {
    return errorResult(`${error.code}: ${error.message}`);
  }
  if (error instanceof AgentFileEditOperationScopeError) {
    return errorResult(`COLLABORATION_OPERATION_OUTCOME_UNAVAILABLE: Recorded operation ${error.operation.operationId} cannot be reused for this request or document lifecycle. Inspect it before retrying.`);
  }
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
  mode: 'edit' | 'replace' = 'edit',
): Promise<CallToolResult> {
  const fullReplace = mode === 'replace';
  const tool = fullReplace ? 'replace_knowledge_source' : 'edit_knowledge_source';
  let nativeSelection: ReturnType<typeof decodeDirectMcpNativeDocumentEditSelection>;
  try { nativeSelection = fullReplace ? null : decodeDirectMcpNativeDocumentEditSelection(args); }
  catch (error) { return formatDirectMcpNativeDocumentEditError(error); }
  if (nativeSelection) {
    try {
      if (!authInfo) throw new DirectMcpAuthorizationError('invalid_token', 401, 'Authentication is required.', { challengeError: 'invalid_token' });
      const value = nativeSelection.action === 'edit'
        ? await editDocumentForDirectMcp(authInfo, nativeSelection.request)
        : await readDocumentEditStatusForDirectMcp(authInfo, nativeSelection.request);
      return formatDirectMcpNativeDocumentEditResult(value);
    } catch (error) { return formatDirectMcpNativeDocumentEditError(error); }
  }
  const parsed = parseArgs(args);
  const workspaceId = requiredString(parsed, 'workspace_id', MAX_WORKSPACE_ID_LENGTH);
  const filePath = requiredString(parsed, 'path', MAX_PATH_LENGTH);
  assertVisibleWorkspacePath(filePath);
  if (fullReplace) {
    const allowed = new Set(['workspace_id', 'path', 'content', 'expected_sha256', 'idempotency_key']);
    if (Object.keys(parsed).some(key => !allowed.has(key))) invalidParams('Unsupported replacement argument.');
    if (!/\.m(?:d|arkdown)$/iu.test(filePath)) invalidParams('Replacement requires a Markdown document.');
    if (parsed.idempotency_key === undefined) invalidParams('idempotency_key is required.');
  }
  const replacement = fullReplace ? requiredText(parsed, 'content', MAX_EDIT_TEXT_LENGTH, true) : null;
  const oldText = fullReplace ? '' : requiredText(parsed, 'old_text', MAX_EDIT_TEXT_LENGTH);
  const newText = fullReplace ? replacement! : requiredText(parsed, 'new_text', MAX_EDIT_TEXT_LENGTH, true);
  const expectedSha256 = normalizeExpectedSha256(requiredString(parsed, 'expected_sha256', 80));
  if (!expectedSha256) invalidParams('expected_sha256 must be a SHA-256 hash returned by read_knowledge_source.');
  const replaceAll = optionalBoolean(parsed, 'replace_all');
  const expectedOccurrences = replaceAll
    ? (parsed.expected_occurrences === undefined
      ? undefined
      : optionalInteger(parsed, 'expected_occurrences', 1, 1, MAX_EDIT_OCCURRENCES))
    : optionalInteger(parsed, 'expected_occurrences', 1, 1, MAX_EDIT_OCCURRENCES);
  let suppliedIdempotencyKey: string | null;
  try {
    suppliedIdempotencyKey = parseDirectMcpEditIdempotencyKey(parsed.idempotency_key);
  } catch (error) {
    invalidParams(error instanceof Error ? error.message : 'Invalid idempotency_key.');
  }
  const authorization = await authenticateForTool(authInfo, 'knowledge:write');
  if ('result' in authorization) return authorization.result;

  try {
    const workspace = await writableWorkspace(authorization.principal, workspaceId);
    const editIdentity = createDirectMcpEditIdentity({
      clientId: authorization.principal.clientId,
      userId: authorization.principal.userId,
      idempotencyKey: suppliedIdempotencyKey,
    });
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
    if (fullReplace && (current.source !== 'live_yjs' || !current.documentId)) {
      return structuredErrorResult('REPLACE_REQUIRES_NATIVE_DOCUMENT', 'Full replacement requires an authoritative live Markdown document.');
    }
    const fileLink = directMcpFileLinkFields({ workspaceId: workspace.workspaceId,
      path: current.nativeIdentity?.path ?? filePath,
      documentId: current.nativeIdentity?.documentId ?? null, lineageId: current.nativeIdentity?.lineageId ?? null });
    const documentUrl = fileLink.document_url;
    const authorityForSnapshot = (snapshot: { documentId: string; lifecycleGeneration: number }) =>
      createDirectMcpEditAuthority({
        token: authInfo!.token,
        tool,
        scope: {
          userId: authorization.principal.userId,
          clientId: authorization.principal.clientId,
          sessionId: authorization.principal.sessionId,
          actorId: editIdentity.actorId,
          workspaceId: workspace.workspaceId,
          documentId: snapshot.documentId,
          path: filePath,
          lifecycleGeneration: snapshot.lifecycleGeneration,
        },
      });
    if (Buffer.byteLength(current.content, 'utf8') > MAX_READ_FILE_BYTES) {
      return errorResult(`The requested file is larger than the ${MAX_READ_FILE_BYTES / 1024} KB MCP edit limit.`);
    }
    const edits: ExactTextEdit[] = [{
      oldText: fullReplace ? current.content : oldText,
      newText,
      expectedOccurrences,
      replaceAll,
    }];
    const mutation = fullReplace ? { operation: tool, workspaceId: workspace.workspaceId, path: filePath,
      expectedSha256, content: replacement } : {
      operation: 'edit_knowledge_source',
      workspaceId: workspace.workspaceId,
      path: filePath,
      expectedSha256,
      oldText,
      newText,
      expectedOccurrences: expectedOccurrences ?? null,
      replaceAll: replaceAll === true,
    };
    const fingerprint = sha256Buffer(Buffer.from(JSON.stringify(mutation), 'utf8'));
    const createReviewProposal = current.source === 'live_yjs' && current.documentId
      ? (options: { lookupOnly?: boolean; forceReview?: boolean }) => createOrdinaryAgentProposal({
        workspace,
        documentId: current.documentId!,
        path: filePath,
        identity: {
          initiatedByUserId: authorization.principal.userId,
          actorId: editIdentity.actorId,
        },
        idempotencyKey: editIdentity.proposalIdempotencyKey,
        retryRequested: editIdentity.retryRequested,
        mutation,
        lookupOnly: options.lookupOnly,
        forceReview: options.forceReview,
        buildTargets: ({ state, source }) => {
          if (source.representation !== state.representation) {
            throw new ProposalGraphContractError(
              'PROPOSAL_STALE_LIFECYCLE',
              'The proposal representation changed.',
            );
          }
          const doc = new Y.Doc({ gc: false });
          try {
            Y.applyUpdate(doc, source.update);
            const prepared = prepareCollaborationContentEditInDocument({
              documentId: current.documentId!,
              workspace,
              path: filePath,
              state,
              doc,
              expectedSha256,
              groupId: 'direct_mcp_edit',
              plan: (content) => ({
                proposedContent: fullReplace ? replacement! : applyExactTextEdits(content, edits, filePath),
                edits,
                richMode: fullReplace ? 'markdown_structure' : 'exact_text',
              }),
            });
            const preparedValidation = validateTextFileContent(filePath, prepared.proposedContent);
            if (!preparedValidation.ok) {
              throw new ProposalGraphContractError(
                'PROPOSAL_INVALID_REQUEST',
                'The requested edit would leave the file in an invalid state.',
              );
            }
            return prepared.targets;
          } finally {
            doc.destroy();
          }
        },
      })
      : null;
    const reviewResult = async (proposal: OrdinaryAgentProposalResult): Promise<CallToolResult> => {
      if (!readDocumentReviewAvailability().documentReviewEnabled) {
        throw new AgentFileReviewDisabledConflictError(
          'Document Review Center is disabled. The recorded proposal was not applied.',
          proposal.node.operationId,
        );
      }
      const requiresUserAction = proposal.node.lifecycle === 'open';
      const reviewUrl = buildDirectMcpReviewUrl({
        workspaceId: workspace.workspaceId,
        lineageId: proposal.proposal.scope.lineageId,
        operationId: proposal.node.operationId,
      });
      const message = requiresUserAction
        ? `The edit to ${filePath} was saved as a proposal and was not applied. The user must review it at ${reviewUrl}`
        : `The existing proposal for ${filePath} is ${proposal.node.lifecycle}. Its review record is available at ${reviewUrl}`;
      const currentStats = await getFileStats(filePath, { workspace });
      const structuredContent = {
        workspace_id: workspace.workspaceId,
        path: filePath,
        changed: false,
        status: proposal.reused ? 'review_reused' : 'review_created',
        review_required: requiresUserAction,
        authoritative_updated: false,
        requires_user_action: requiresUserAction,
        before_sha256: proposal.authoringPreview.beforeSha256,
        after_sha256: current.sha256,
        current_sha256: current.sha256,
        proposed_sha256: proposal.authoringPreview.proposedSha256,
        operation_id: proposal.node.operationId,
        proposal_id: proposal.node.proposalId,
        proposal_lifecycle: proposal.node.lifecycle,
        review_url: reviewUrl,
        ...fileLink,
        idempotency_key: editIdentity.publicIdempotencyKey,
        message,
        size: Buffer.byteLength(current.content, 'utf8'),
        modified_at: toIsoDate(currentStats.modified),
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool,
        workspace,
        resultCount: 1,
        path: filePath,
        beforeSha256: proposal.authoringPreview.beforeSha256,
        afterSha256: current.sha256,
        changed: false,
        reviewRequired: requiresUserAction,
      });
      return result(structuredContent, message);
    };

    if (createReviewProposal && editIdentity.retryRequested) {
      const existingProposal = await createReviewProposal({ lookupOnly: true });
      if (existingProposal) return reviewResult(existingProposal);
    }
    if (current.source === 'live_yjs' && current.documentId && editIdentity.retryRequested) {
      const found = await findAgentFileEditOperation({
        documentId: current.documentId,
        workspace,
        userId: authorization.principal.userId,
        actorId: editIdentity.actorId,
        actorSessionId: authorization.principal.sessionId,
        idempotencyKey: editIdentity.operationIdempotencyKey,
        fingerprint,
      });
      if (found) {
        const { operation, request } = found;
        const reviewRequired = ['needs_review', 'partially_applied', 'semantic_conflict'].includes(operation.operationStatus);
        if (reviewRequired && !readDocumentReviewAvailability().documentReviewEnabled) {
          throw new AgentFileReviewDisabledConflictError(
            'This earlier operation still requires review or conflict resolution. Document Review Center is disabled; the retry did not apply it.',
            operation.operationId,
          );
        }
        const persisted = operation.durability === 'persisted_yjs' || operation.durability === 'checkpointed_file';
        if (!persisted && !reviewRequired) {
          return errorResult(`COLLABORATION_OPERATION_OUTCOME_UNAVAILABLE: Recorded operation ${operation.operationId} is not confirmed. Inspect it before retrying.`);
        }
        const after = await readCurrentCollaborationTextSnapshot({ documentId: current.documentId, workspace });
        if (after.documentId !== current.documentId || after.path !== filePath
          || after.lifecycleGeneration !== found.identity.lifecycleGeneration
          || after.schemaVersion !== found.identity.schemaVersion || after.representation !== found.identity.representation) {
          return errorResult(`COLLABORATION_OPERATION_OUTCOME_UNAVAILABLE: Recorded operation ${operation.operationId} belongs to an old document lifecycle. Inspect it before retrying.`);
        }
        const mcpAuthority = await authorityForSnapshot(after);
        if (persisted) await confirmCollaborativeFileCheckpoint({
          path: filePath,
          fullPath: validatePath(filePath, { workspace }),
          documentId: current.documentId,
          workspace,
          snapshot: after,
          actorSessionId: authorization.principal.sessionId,
          beforeMaterialize: () => mcpAuthority.verifyCurrent().then(() => undefined),
          onConfirmed: async checkpoint => {
            await linkStandaloneAgentCheckpoint({ operationId: operation.operationId,
              documentId: current.documentId!, workspace, userId: authorization.principal.userId,
              actorSessionId: authorization.principal.sessionId, checkpoint });
          },
        });
        const changed = persisted && request.beforeSha256 !== request.proposedSha256
          && operation.appliedTargetIds.length > 0;
        const afterStats = await getFileStats(filePath, { workspace });
        const message = reviewRequired
          ? `The earlier edit to ${filePath} still requires review at ${documentUrl}. No edit was applied by this retry.`
          : `The existing edit to ${filePath} was confirmed. This retry did not apply it again.`;
        const structuredContent = {
          workspace_id: workspace.workspaceId,
          path: filePath,
          changed,
          status: reviewRequired ? 'review_reused' : changed ? 'applied' : 'no_change',
          review_required: reviewRequired,
          authoritative_updated: changed,
          requires_user_action: reviewRequired,
          before_sha256: request.beforeSha256,
          after_sha256: after.sha256,
          current_sha256: after.sha256,
          proposed_sha256: request.proposedSha256,
          operation_id: operation.operationId,
          proposal_id: null,
          proposal_lifecycle: null,
          review_url: reviewRequired ? documentUrl : null,
          ...fileLink,
          idempotency_key: editIdentity.publicIdempotencyKey,
          message,
          size: Buffer.byteLength(after.content, 'utf8'),
          modified_at: toIsoDate(afterStats.modified),
        };
        await auditWorkspaceToolCall({ principal: authorization.principal, tool,
          workspace, resultCount: 0, path: filePath, beforeSha256: request.beforeSha256,
          afterSha256: after.sha256, changed: false, reviewRequired });
        return result(structuredContent, message);
      }
    }
    if (current.sha256 !== expectedSha256) {
      return fullReplace
        ? structuredErrorResult('FILE_REVISION_CONFLICT', 'The document changed. Read its current content before retrying.')
        : errorResult('The workspace file changed since it was read. Read the current file content again before retrying.');
    }

    const proposedContent = fullReplace ? replacement! : applyExactTextEdits(current.content, edits, filePath);
    if (Buffer.byteLength(proposedContent, 'utf8') > MAX_READ_FILE_BYTES) {
      return errorResult(`The updated file would exceed the ${MAX_READ_FILE_BYTES / 1024} KB MCP edit limit.`);
    }
    const validation = validateTextFileContent(filePath, proposedContent);
    if (!validation.ok) {
      return errorResult('The requested edit would leave the file in an invalid state.');
    }
    if (proposedContent === current.content) {
      if (current.source === 'live_yjs' && current.documentId) {
        const unchanged = await readCurrentCollaborationTextSnapshot({
          documentId: current.documentId,
          workspace,
        });
        if (unchanged.sha256 !== current.sha256) {
          return errorResult('The live document changed during this edit. Read its current content and retry.');
        }
        const mcpAuthority = await authorityForSnapshot(unchanged);
        await confirmCollaborativeFileCheckpoint({
          path: filePath,
          fullPath: validatePath(filePath, { workspace }),
          documentId: current.documentId,
          workspace,
          snapshot: unchanged,
          actorSessionId: authorization.principal.sessionId,
          beforeMaterialize: () => mcpAuthority.verifyCurrent().then(() => undefined),
        });
      }
      const message = `No change was needed for ${filePath}.`;
      const structuredContent = {
        workspace_id: workspace.workspaceId,
        path: filePath,
        changed: false,
        status: 'no_change',
        review_required: false,
        authoritative_updated: false,
        requires_user_action: false,
        before_sha256: current.sha256,
        after_sha256: current.sha256,
        current_sha256: current.sha256,
        proposed_sha256: current.sha256,
        operation_id: null,
        proposal_id: null,
        proposal_lifecycle: null,
        review_url: null,
        ...fileLink,
        idempotency_key: editIdentity.publicIdempotencyKey,
        message,
        size: Buffer.byteLength(current.content, 'utf8'),
        modified_at: toIsoDate(stats.modified),
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool,
        workspace,
        resultCount: 0,
        path: filePath,
        beforeSha256: current.sha256,
        afterSha256: current.sha256,
        changed: false,
        reviewRequired: false,
      });
      return result(structuredContent, message);
    }

    if (current.source === 'live_yjs' && current.documentId) {
      const policyProposal = await createReviewProposal!({});
      if (policyProposal) return reviewResult(policyProposal);

      const prepared = fullReplace ? await prepareCollaborationWrite({
        documentId: current.documentId, workspace, path: filePath, content: replacement!,
        expectedSha256, groupId: 'direct_mcp_replace',
      }) : await prepareCollaborationTextEdit({
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
      if (prepared.requestedMode === 'review') {
        const structuralProposal = await createReviewProposal!({ forceReview: true });
        if (structuralProposal) return reviewResult(structuralProposal);
      }
      const mcpAuthority = await authorityForSnapshot(prepared);
      let operation;
      try {
        operation = await executePreparedCollaborationTextEdit({
          prepared,
          workspace,
          identity: {
            initiatedByUserId: authorization.principal.userId,
            actorId: editIdentity.actorId,
            actorDisplayName: 'External MCP client',
            actorSessionId: authorization.principal.sessionId,
            mcpAuthority,
          },
          idempotencyKey: editIdentity.operationIdempotencyKey,
          fileEditRequest: {
            fingerprint,
            beforeSha256: prepared.sha256,
            proposedSha256: prepared.proposedSha256,
          },
          disallowLegacyReview: proposalReviewWritesEnabled({ workspaceId: workspace.workspaceId }),
        });
      } catch (error) {
        if (error instanceof ProposalGraphContractError && error.code === 'PROPOSAL_UPGRADE_REQUIRED') {
          const reroutedProposal = await createReviewProposal!({ forceReview: true });
          if (reroutedProposal) return reviewResult(reroutedProposal);
        }
        throw error;
      }
      const after = await readCurrentCollaborationTextSnapshot({
        documentId: prepared.documentId,
        workspace,
      });
      const reviewRequired = operation.operationStatus === 'needs_review'
        || operation.operationStatus === 'partially_applied'
        || operation.operationStatus === 'semantic_conflict';
      if (reviewRequired && !readDocumentReviewAvailability().documentReviewEnabled) {
        throw new AgentFileReviewDisabledConflictError(
          'The edit could not be applied directly. Document Review Center is disabled; inspect the recorded operation and retry with a precise target.',
          operation.operationId,
        );
      }
      const persisted = operation.durability === 'persisted_yjs'
        || operation.durability === 'checkpointed_file';
      if (!persisted && !reviewRequired) {
        return errorResult(`The live edit outcome ${operation.operationId} could not be confirmed. Inspect it before retrying.`);
      }
      if (persisted) await confirmCollaborativeFileCheckpoint({
        path: filePath,
        fullPath: validatePath(filePath, { workspace }),
        documentId: prepared.documentId,
        workspace,
        snapshot: after,
        actorSessionId: authorization.principal.sessionId,
        beforeMaterialize: () => mcpAuthority.verifyCurrent().then(() => undefined),
        onConfirmed: async checkpoint => {
          await linkStandaloneAgentCheckpoint({ operationId: operation.operationId,
            documentId: prepared.documentId, workspace, userId: authorization.principal.userId,
            actorSessionId: authorization.principal.sessionId, checkpoint });
        },
      });
      const changed = after.sha256 !== prepared.sha256;
      const afterStats = await getFileStats(filePath, { workspace });
      const message = reviewRequired
        ? `The edit to ${filePath} requires review and was not applied. Open the document workspace at ${documentUrl}`
        : changed
          ? `Updated ${filePath}.`
          : `No change was applied to ${filePath}.`;
      const structuredContent = {
        workspace_id: workspace.workspaceId,
        path: filePath,
        changed,
        status: reviewRequired ? 'review_created' : changed ? 'applied' : 'no_change',
        review_required: reviewRequired,
        authoritative_updated: changed,
        requires_user_action: reviewRequired,
        before_sha256: prepared.sha256,
        after_sha256: after.sha256,
        current_sha256: after.sha256,
        proposed_sha256: prepared.proposedSha256,
        operation_id: operation.operationId,
        proposal_id: null,
        proposal_lifecycle: null,
        review_url: reviewRequired ? documentUrl : null,
        ...fileLink,
        idempotency_key: editIdentity.publicIdempotencyKey,
        message,
        size: Buffer.byteLength(after.content, 'utf8'),
        modified_at: toIsoDate(afterStats.modified),
      };
      await auditWorkspaceToolCall({
        principal: authorization.principal,
        tool,
        workspace,
        resultCount: changed ? 1 : 0,
        path: filePath,
        beforeSha256: prepared.sha256,
        afterSha256: after.sha256,
        changed,
        reviewRequired,
      });
      return result(structuredContent, message);
    }

    const beforeRevision = await getWorkspaceFileRevision(filePath, { workspace });
    if (!beforeRevision || beforeRevision.sha256 !== expectedSha256) {
      return errorResult('The workspace file changed since it was read. Read the current file content again before retrying.');
    }
    const baseRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: filePath,
      contentHash: beforeRevision.sha256,
      sizeBytes: beforeRevision.stats.size,
      actorUserId: authorization.principal.userId,
      actorType: 'agent',
      sourceSessionId: authorization.principal.sessionId,
    });
    await assertFileCollaborationWriteAllowed({
      workspace,
      path: filePath,
      actorUserId: authorization.principal.userId,
      actorSessionId: authorization.principal.sessionId,
      actorType: 'agent',
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
    const afterRevision = await ensureFileRevisionForCurrentContent({
      workspace,
      path: filePath,
      contentHash: afterSha256,
      sizeBytes: afterBuffer.length,
      actorUserId: authorization.principal.userId,
      actorType: 'agent',
      sourceSessionId: authorization.principal.sessionId,
      baseRevisionId: baseRevision.id,
    });
    await syncPublicSharesAfterWrite([validatePath(filePath, { workspace })], workspace);
    publishWorkspaceFileMutation({ workspace, type: 'change', relativePath: filePath });
    const afterStats = await getFileStats(filePath, { workspace });
    const message = `Updated ${filePath}.`;
    const structuredContent = {
      workspace_id: workspace.workspaceId,
      path: filePath,
      changed: true,
      status: 'applied',
      review_required: false,
      authoritative_updated: true,
      requires_user_action: false,
      before_sha256: beforeRevision.sha256,
      after_sha256: afterRevision.contentHash,
      current_sha256: afterRevision.contentHash,
      proposed_sha256: afterRevision.contentHash,
      operation_id: null,
      proposal_id: null,
      proposal_lifecycle: null,
      review_url: null,
      ...fileLink,
      idempotency_key: editIdentity.publicIdempotencyKey,
      message,
      size: afterBuffer.length,
      modified_at: toIsoDate(afterStats.modified),
    };
    await auditWorkspaceToolCall({
      principal: authorization.principal,
      tool,
      workspace,
      resultCount: 1,
      path: filePath,
      beforeSha256: beforeRevision.sha256,
      afterSha256: afterRevision.contentHash,
      changed: true,
      reviewRequired: false,
    });
    return result(structuredContent, message);
  } catch (error) {
    return editErrorResult(error);
  }
}

async function executeCopyKnowledgeSource(args: unknown, authInfo?: AuthInfo): Promise<CallToolResult> {
  let selectedOperationId: string | undefined;
  try {
    // Capture the complete request before awaiting or entering any authority.
    const input = decodeDirectMcpWorkspaceCopyRequestV1(args);
    selectedOperationId = input.action === 'preview' ? undefined : input.operationId;
    if (!authInfo) throw new DirectMcpAuthorizationError('invalid_token', 401, 'Authentication is required.', { challengeError: 'invalid_token' });
    const { runDirectMcpWorkspaceCopyService } = await import('../../files/workspace-file-operation-service');
    const result = await runDirectMcpWorkspaceCopyService(input, authInfo);
    return formatDirectMcpWorkspaceCopyResult(result, selectedOperationId);
  } catch (error) {
    // A hard formatting failure here propagates. In particular, never catch
    // an oversized genuine OAuth challenge to return a challenge-free result.
    return formatDirectMcpWorkspaceCopyError(error, selectedOperationId);
  }
}

async function executeMoveKnowledgeSource(args: unknown, authInfo?: AuthInfo): Promise<CallToolResult> {
  let selectedOperationId: string | undefined;
  try {
    const input = decodeDirectMcpWorkspaceMoveRequestV1(args);
    selectedOperationId = input.action === 'preview' ? undefined : input.operationId;
    if (!authInfo) throw new DirectMcpAuthorizationError('invalid_token', 401, 'Authentication is required.', { challengeError: 'invalid_token' });
    const { runDirectMcpWorkspaceMoveService } = await import('../../files/workspace-file-operation-service');
    return formatDirectMcpWorkspacePathResult(await runDirectMcpWorkspaceMoveService(input, authInfo), selectedOperationId);
  } catch (error) { return formatDirectMcpWorkspacePathError(error, selectedOperationId); }
}
async function executeDeleteKnowledgeSource(args: unknown, authInfo?: AuthInfo): Promise<CallToolResult> {
  let selectedOperationId: string | undefined;
  try {
    const input = decodeDirectMcpWorkspaceDeleteRequestV1(args);
    selectedOperationId = input.action === 'preview' ? undefined : input.operationId;
    if (!authInfo) throw new DirectMcpAuthorizationError('invalid_token', 401, 'Authentication is required.', { challengeError: 'invalid_token' });
    const { runDirectMcpWorkspaceDeleteService } = await import('../../files/workspace-file-operation-service');
    return formatDirectMcpWorkspacePathResult(await runDirectMcpWorkspaceDeleteService(input, authInfo), selectedOperationId);
  } catch (error) { return formatDirectMcpWorkspacePathError(error, selectedOperationId); }
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
      id: 'replace_knowledge_source',
      descriptor: getDirectMcpWorkspaceToolDescriptor('replace_knowledge_source'),
      execute: (args, authInfo) => executeEditKnowledgeSource(args, authInfo, 'replace'),
    },
    {
      id: 'copy_knowledge_source',
      descriptor: getDirectMcpWorkspaceToolDescriptor('copy_knowledge_source'),
      execute: executeCopyKnowledgeSource,
    },
    { id: 'move_knowledge_source', descriptor: getDirectMcpWorkspaceToolDescriptor('move_knowledge_source'), execute: executeMoveKnowledgeSource },
    { id: 'delete_knowledge_source', descriptor: getDirectMcpWorkspaceToolDescriptor('delete_knowledge_source'), execute: executeDeleteKnowledgeSource },
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
