import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  decodeDocumentReadRequestV1,
  DocumentReadError,
  type DecodedDocumentReadRequestV1,
  type DocumentReadErrorCodeV1,
  type DocumentReadPageV1,
} from '../documents/contracts';
import { TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS } from './tool-output-policy';

export const PI_DOCUMENT_READ_DEFAULT_MAX_BYTES = 1024;
export const PI_DOCUMENT_READ_MAX_BYTES = 1024;

export const piDocumentReadParameters = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 256, description: 'Workspace ID for this authenticated agent session.' }),
  documentId: Type.String({ minLength: 1, maxLength: 256, description: 'Stable native document ID, not a file path.' }),
  format: Type.Optional(Type.Union([Type.Literal('native'), Type.Literal('text'), Type.Literal('markdown')], {
    description: 'Representation to read. Defaults to native; Markdown export must be requested explicitly.',
  })),
  expectedVersion: Type.Optional(Type.String({ pattern: '^canvas-document-v1:[a-f0-9]{64}$',
    description: 'Complete native version token from an earlier document read. A conflict never refreshes this baseline automatically.' })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: PI_DOCUMENT_READ_MAX_BYTES,
    default: PI_DOCUMENT_READ_DEFAULT_MAX_BYTES, description: 'Maximum UTF-8 fragment bytes, default 1024. Smaller pages may help with the output budget; large metadata can still prevent delivery.' })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096,
    description: 'Exact opaque nextCursor from the previous page. Keep the same document, format and version. Every page checks current access again.' })),
}, { additionalProperties: false });

const selectionKeys = new Set(['workspaceId', 'documentId', 'format', 'expectedVersion', 'maxBytes', 'cursor']);

/** Pure selector decoding only; these arguments never establish agent authority. */
export function decodePiDocumentReadSelection(input: unknown): DecodedDocumentReadRequestV1 {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new DocumentReadError('INVALID_REQUEST');
  }
  const properties = Object.getOwnPropertyDescriptors(input);
  const request: Record<string, unknown> = { apiVersion: 1, maxBytes: PI_DOCUMENT_READ_DEFAULT_MAX_BYTES };
  for (const key of Reflect.ownKeys(properties)) {
    if (typeof key !== 'string' || !selectionKeys.has(key)) throw new DocumentReadError('INVALID_REQUEST');
    const descriptor = properties[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new DocumentReadError('INVALID_REQUEST');
    }
    request[key] = descriptor.value as unknown;
  }
  if (typeof request.maxBytes !== 'number' || !Number.isSafeInteger(request.maxBytes)
    || request.maxBytes < 4 || request.maxBytes > PI_DOCUMENT_READ_MAX_BYTES) throw new DocumentReadError('INVALID_REQUEST');
  return decodeDocumentReadRequestV1(request);
}

type PiDocumentReadFailureV1 = Readonly<{
  apiVersion: 1;
  success: false;
  code: DocumentReadErrorCodeV1 | 'DOCUMENT_READ_OUTPUT_BUDGET_EXCEEDED';
  error: string;
  safeToAutoRetry: false;
}>;
type PiDocumentReadResult = AgentToolResult<unknown> & { isError?: boolean };

function failure(code: PiDocumentReadFailureV1['code'], message: string): PiDocumentReadResult {
  const details: PiDocumentReadFailureV1 = { apiVersion: 1, success: false, code, error: message, safeToAutoRetry: false };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError: true };
}

/** Public service codes survive; SQL, credentials and unexpected messages do not. */
export function formatPiDocumentReadError(error: unknown): PiDocumentReadResult {
  const code = error instanceof DocumentReadError ? error.code : 'DOCUMENT_READ_UNAVAILABLE';
  return failure(code, code);
}

/** Preserve the complete page, or return a transport error with no partial page. */
export function formatPiDocumentReadPage(page: DocumentReadPageV1): PiDocumentReadResult {
  try {
    const text = JSON.stringify(page);
    const detailsJson = JSON.stringify(page);
    if (text.length > TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS || detailsJson.length > TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS) {
      return failure('DOCUMENT_READ_OUTPUT_BUDGET_EXCEEDED',
        'The complete document page exceeds this tool\'s output budget. A smaller maxBytes may help; large metadata can still prevent delivery. Retry only by a new explicit request using the original input cursor.');
    }
    return { content: [{ type: 'text', text }], details: page };
  } catch (error) {
    return formatPiDocumentReadError(error);
  }
}
