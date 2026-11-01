import 'server-only';

import { types } from 'node:util';
import type { ApiKeyMarkdownCreateSelection } from '../collaboration/markdown-file-import-persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { isInternalWorkspaceStagingPath } from '../files/internal-staging-path';
import { DOCUMENT_CREATE_ERROR_CODES_V1 } from './create-json-schema';

export type DocumentCreateAction = 'create' | 'import';
export class DocumentCreateError extends Error {
  readonly status: number;
  constructor(readonly code: typeof DOCUMENT_CREATE_ERROR_CODES_V1[number]) {
    super(code); this.name = 'DocumentCreateError';
    this.status = code === 'DOCUMENT_TOO_LARGE' ? 413 : code === 'INVALID_REQUEST' || code === 'DOCUMENT_IMPORT_URL_REJECTED' ? 400
      : code === 'DOCUMENT_CREATE_UNSUPPORTED' ? 422 : code === 'DOCUMENT_CREATE_CONFLICT' || code === 'DOCUMENT_BUSY'
        || code === 'CREATE_OUTCOME_UNCONFIRMED' ? 409 : 503;
  }
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new DocumentCreateError('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors), row: Record<string, unknown> = {};
  if (required.some(key => !Object.hasOwn(descriptors, key)) || names.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) {
    throw new DocumentCreateError('INVALID_REQUEST');
  }
  for (const key of names as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new DocumentCreateError('INVALID_REQUEST');
    row[key] = descriptor.value as unknown;
  }
  return row;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.from(value).toString('utf8') !== value) throw new DocumentCreateError('INVALID_REQUEST');
  return value;
}

/** Data-only conversion. The genuine key Principal checks current rights later. */
export function decodeDocumentCreateRequestV1(value: unknown, action: DocumentCreateAction,
  transport: 'request' | 'mcp'): ApiKeyMarkdownCreateSelection {
  const version = transport === 'mcp' ? 'api_version' : 'apiVersion', workspace = transport === 'mcp' ? 'workspace_id' : 'workspaceId';
  const key = transport === 'mcp' ? 'idempotency_key' : 'idempotencyKey';
  const row = object(value, [version, workspace, 'path', key, action === 'create' ? 'content' : 'file']);
  if (row[version] !== 1) throw new DocumentCreateError('INVALID_REQUEST');
  const workspaceId = text(row[workspace], 200), path = text(row.path, 1024), idempotencyKey = text(row[key], 128);
  if (workspaceId !== workspaceId.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)
    || !isCanonicalAdmissionPath(path) || isInternalWorkspaceStagingPath(path)
    || transport === 'mcp' && path.split('/').some(segment => segment.startsWith('.'))) throw new DocumentCreateError('INVALID_REQUEST');
  if (!/\.(?:md|markdown)$/iu.test(path)) throw new DocumentCreateError('DOCUMENT_CREATE_UNSUPPORTED');
  if (action === 'create') {
    if (typeof row.content !== 'string' || Buffer.from(row.content).toString('utf8') !== row.content) throw new DocumentCreateError('INVALID_REQUEST');
    if (Buffer.byteLength(row.content) > 512 * 1024) throw new DocumentCreateError('DOCUMENT_TOO_LARGE');
    return Object.freeze({ tool: 'create_knowledge_source', workspaceId, path, idempotencyKey, content: row.content });
  }
  const file = object(row.file, ['download_url', 'file_id'], ['mime_type', 'file_name']);
  return Object.freeze({ tool: 'import_knowledge_file', workspaceId, path, idempotencyKey, file: Object.freeze({
    download_url: text(file.download_url, 8192), file_id: text(file.file_id, 200),
    ...(Object.hasOwn(file, 'mime_type') ? { mime_type: text(file.mime_type, 200) } : {}),
    ...(Object.hasOwn(file, 'file_name') ? { file_name: text(file.file_name, 1024) } : {}),
  }) });
}
