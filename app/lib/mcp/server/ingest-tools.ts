import 'server-only';

import { ProtocolError, ProtocolErrorCode, type AuthInfo, type CallToolResult } from '@modelcontextprotocol/server';

import { DirectMcpAuthorizationError } from './access-token-verifier';
import { createDirectMcpIngestAuthority } from './ingest-authority';
import { downloadDirectMcpFile, type DirectMcpFileReference, DirectMcpIngestDownloadError } from './ingest-download';
import { createDirectMcpWorkspaceFile, directMcpIngestFingerprint, DirectMcpFileIngestError, normalizeDirectMcpIngestPath } from './file-ingest';
import { DirectMcpIngestValidationError, encodeDirectMcpTextContent, isDirectMcpTextPath, validateDirectMcpIngestContent } from './ingest-validation';
import { parseDirectMcpEditIdempotencyKey } from './document-edit-contract';
import { directMcpToolAuthorizationError } from './tool-auth';
import type { DirectMcpToolDescriptor } from './tool-descriptor';

type IngestTool = 'create_knowledge_source' | 'import_knowledge_file';
const securitySchemes = [{ type: 'oauth2' as const, scopes: ['knowledge:write'] }];
const commonProperties = {
  workspace_id: { type: 'string', minLength: 1, maxLength: 200, description: 'An explicitly allowed, writable Canvas workspace.' },
  path: { type: 'string', minLength: 1, maxLength: 1024, description: 'New workspace-relative file path. Existing files are never overwritten.' },
  idempotency_key: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$', description: 'Use the same key and identical content/file_id when retrying this creation.' },
};

export function getDirectMcpIngestToolDefinitions() {
  return (['create_knowledge_source', 'import_knowledge_file'] as const).map(id => ({
    id,
    descriptor: getDirectMcpIngestToolDescriptor(id),
    execute: (args: unknown, authInfo?: AuthInfo, signal?: AbortSignal) => executeDirectMcpIngestTool(id, args, authInfo, signal),
  }));
}

export function getDirectMcpIngestToolDescriptor(id: IngestTool): DirectMcpToolDescriptor {
  const isImport = id === 'import_knowledge_file';
  const meta = { securitySchemes, ...(isImport ? { 'openai/fileParams': ['file'] } : {}) };
  return {
    name: id,
    title: isImport ? 'Import a complete file' : 'Create a complete text document',
    description: isImport
      ? 'Save an uploaded or generated file into Canvas. Pass its bare host file reference as file; the host converts it to a temporary HTTPS download reference. No public hosting is required. Originals are preserved byte for byte. UTF-8 text is limited to 512 KiB, other files to 25 MiB. Markdown compatibility is reported without rewriting the original. Creates a new file only; does not overwrite existing documents.'
      : 'Create a new complete UTF-8 text file, up to 512 KiB. Supply actual Markdown content, not a local file path. Use valid YAML frontmatter when present, a blank line before lists/tables, matching table headers and separators, and fenced code blocks. Canvas checks with its editor parser. Unsupported rich-editor syntax is preserved with warnings. Never overwrites an existing document; use edit_knowledge_source for subsequent edits.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['workspace_id', 'path', 'idempotency_key', isImport ? 'file' : 'content'],
      properties: {
        ...commonProperties,
        ...(isImport ? { file: {
          type: 'object', additionalProperties: false, required: ['download_url', 'file_id'],
          properties: {
            download_url: { type: 'string', maxLength: 8192, description: 'Temporary HTTPS download URL provided by the host, never constructed by the model.' },
            file_id: { type: 'string', minLength: 1, maxLength: 200 },
            mime_type: { type: 'string', maxLength: 200 },
            file_name: { type: 'string', maxLength: 1024 },
          },
        } } : { content: { type: 'string', maxLength: 524288, description: 'The complete text to save, preserving intended newlines.' } }),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: isImport },
    securitySchemes, _meta: meta,
  };
}

function invalid(message: string): never { throw new ProtocolError(ProtocolErrorCode.InvalidParams, message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Tool arguments must be an object.');
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid(`${name} must be a non-empty string up to ${max} characters.`);
  return value;
}

export async function executeDirectMcpIngestTool(id: IngestTool, raw: unknown, authInfo?: AuthInfo, signal?: AbortSignal): Promise<CallToolResult> {
  const args = record(raw);
  const isImport = id === 'import_knowledge_file';
  if (Object.keys(args).some(name => !['workspace_id', 'path', 'idempotency_key', isImport ? 'file' : 'content'].includes(name))) {
    invalid('The request contains unsupported arguments.');
  }
  const workspaceId = string(args.workspace_id, 'workspace_id', 200);
  const destination = normalizeDirectMcpIngestPath(string(args.path, 'path', 1024));
  let key: string | null;
  try { key = parseDirectMcpEditIdempotencyKey(args.idempotency_key); }
  catch { invalid('idempotency_key must contain 8–128 safe identifier characters.'); }
  if (!key) invalid('idempotency_key is required.');
  let file: DirectMcpFileReference | undefined;
  let text: string | undefined;
  if (isImport) {
    const reference = record(args.file);
    if (Object.keys(reference).some(name => !['download_url', 'file_id', 'mime_type', 'file_name'].includes(name))) {
      invalid('file contains unsupported fields. Pass the host-provided file reference.');
    }
    file = {
      download_url: string(reference.download_url, 'file.download_url', 8192),
      file_id: string(reference.file_id, 'file.file_id', 200),
      ...(reference.mime_type === undefined ? {} : { mime_type: string(reference.mime_type, 'file.mime_type', 200) }),
      ...(reference.file_name === undefined ? {} : { file_name: string(reference.file_name, 'file.file_name', 1024) }),
    };
  } else {
    if (!isDirectMcpTextPath(destination)) invalid('Use a supported text extension, or import_knowledge_file for binary files.');
    if (typeof args.content !== 'string' || args.content.length > 524288) invalid('content must be a complete text string of at most 512 KiB.');
    text = args.content;
  }
  if (!authInfo?.token) return directMcpToolAuthorizationError(undefined, 'knowledge:write');
  try {
    const authority = await createDirectMcpIngestAuthority({ token: authInfo.token, tool: id, workspaceId });
    // A fresh temporary URL may replace an expired one for the same host file.
    // Never persist a download URL, bearer token, or submitted content in the receipt journal.
    const fingerprint = directMcpIngestFingerprint([id, destination, file ? [file.file_id, file.mime_type ?? null] : text]);
    const receipt = await createDirectMcpWorkspaceFile({
      ...authority, path: destination, idempotencyKey: key, fingerprint, signal,
      loadContent: async () => {
        signal?.throwIfAborted();
        const downloaded = file ? await downloadDirectMcpFile(file, signal) : null;
        const content = downloaded?.content ?? encodeDirectMcpTextContent(text!);
        const validation = await validateDirectMcpIngestContent({ path: destination, content,
          source: isImport ? 'uploaded' : 'generated', mimeType: downloaded?.mimeType });
        return { content, validation };
      },
    });
    return { content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt };
  } catch (error) {
    if (error instanceof DirectMcpAuthorizationError) return directMcpToolAuthorizationError(error, 'knowledge:write');
    const known = error instanceof DirectMcpFileIngestError || error instanceof DirectMcpIngestValidationError
      || error instanceof DirectMcpIngestDownloadError;
    const detail = { code: known ? error.code : 'MCP_INGEST_FAILED',
      message: known ? error.message : 'The file could not be imported. The destination may require inspection before retrying.' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: detail };
  }
}
