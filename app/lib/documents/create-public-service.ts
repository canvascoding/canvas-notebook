import 'server-only';

import { types } from 'node:util';
import type { ApiKeyCredential } from '../api-keys/authentication';
import { apiKeyDocumentFailureV1 } from '../api-keys/error-result';
import { persistAndProjectApiKeyMarkdownCreate } from '../collaboration/markdown-file-import-persistence';
import { decodeDocumentCreateRequestV1, DocumentCreateError, type DocumentCreateAction } from './create-contract';

export function documentCreateFailureV1(error: unknown) {
  const key = apiKeyDocumentFailureV1(error);
  if (key) return key;
  const inspectable = error && typeof error === 'object' && !types.isProxy(error);
  let failure: DocumentCreateError;
  if (inspectable && error instanceof DocumentCreateError) failure = error;
  else {
    const descriptor = inspectable ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const code: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    switch (code) {
      case 'MARKDOWN_IMPORT_INVALID_INPUT': case 'MCP_INGEST_INVALID_PATH': case 'invalid_utf8': case 'invalid_file_reference':
      case 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED': case 'invalid_text': case 'invalid_mime_type': case 'mime_type_mismatch':
      case 'invalid_frontmatter': case 'markdown_parse_failed': case 'unsafe_slash_run':
        failure = new DocumentCreateError('INVALID_REQUEST'); break;
      case 'content_too_large': case 'download_too_large': failure = new DocumentCreateError('DOCUMENT_TOO_LARGE'); break;
      case 'MCP_INGEST_NATIVE_DOCUMENT_REQUIRED': case 'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED':
        failure = new DocumentCreateError('DOCUMENT_CREATE_UNSUPPORTED'); break;
      case 'MCP_INGEST_TARGET_EXISTS': case 'MCP_INGEST_IDEMPOTENCY_CONFLICT': case 'MARKDOWN_IMPORT_TARGET_CHANGED':
      case 'MARKDOWN_IMPORT_TARGET_NOT_EMPTY': case 'MARKDOWN_IMPORT_REQUEST_CONFLICT': case 'MARKDOWN_CREATE_BIRTH_TARGET_CHANGED':
        failure = new DocumentCreateError('DOCUMENT_CREATE_CONFLICT'); break;
      case 'MARKDOWN_IMPORT_BUSY': case 'FILE_MUTATION_LOCK_TIMEOUT': case 'FILE_MUTATION_LOCK_BUSY': case 'COLLABORATION_FILE_LIFECYCLE_BUSY':
        failure = new DocumentCreateError('DOCUMENT_BUSY'); break;
      case 'unsafe_download_url': failure = new DocumentCreateError('DOCUMENT_IMPORT_URL_REJECTED'); break;
      case 'download_failed': case 'download_timeout': failure = new DocumentCreateError('DOCUMENT_IMPORT_FAILED'); break;
      case 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED': case 'MARKDOWN_CREATE_BIRTH_COMMIT_UNCONFIRMED': case 'download_cancelled':
        failure = new DocumentCreateError('CREATE_OUTCOME_UNCONFIRMED'); break;
      default: failure = new DocumentCreateError('DOCUMENT_CREATE_UNAVAILABLE');
    }
  }
  return Object.freeze({ body: Object.freeze({ apiVersion: 1 as const, success: false as const, code: failure.code }), status: failure.status });
}

/** Exact data decoder followed by the actual shared key writer. No Session,
 * OAuth authority, legacy file writer or mutation retry is manufactured. */
export async function createDocumentForApiKey(credential: ApiKeyCredential, value: unknown, action: DocumentCreateAction,
  source: 'request' | 'mcp', signal?: AbortSignal) {
  return persistAndProjectApiKeyMarkdownCreate(credential, decodeDocumentCreateRequestV1(value, action, source), source, signal);
}
