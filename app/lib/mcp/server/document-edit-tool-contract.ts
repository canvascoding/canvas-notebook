import type { CallToolResult } from '@modelcontextprotocol/server';
import { types } from 'node:util';
import { DirectMcpAuthorizationError } from './access-token-verifier';
import { directMcpToolAuthorizationError } from './tool-auth';
import { NativeDocumentEditAuthorizationError } from '../../documents/edit-public-service';
import { documentEditFailureV1 } from '../../documents/edit-error-result';
import { DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1, type DocumentEditOperationResultV1 } from '../../documents/edit-result-contract';
import { encodeNativeDocumentEditToolResult } from '../../documents/edit-tool-contract';
import { DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1 } from '../../documents/edit-tool-contract';
export { decodeDirectMcpNativeDocumentEditSelection, directMcpDocumentEditInputSchema,
  DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1 } from '../../documents/edit-tool-contract';
export { DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1 } from '../../documents/edit-result-contract';

export function directMcpDocumentEditOutputSchema<Schema extends { type: 'object' }>(legacy: Schema) {
  return { type: 'object' as const, oneOf: [legacy, DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1, DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1] };
}

export function formatDirectMcpNativeDocumentEditResult(value: DocumentEditOperationResultV1): CallToolResult {
  const body = encodeNativeDocumentEditToolResult(value);
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}
export function formatDirectMcpNativeDocumentEditError(error: unknown): CallToolResult {
  const { body } = documentEditFailureV1(error);
  const inspectable = !!error && typeof error === 'object' && !types.isProxy(error);
  const authorization = inspectable && error instanceof NativeDocumentEditAuthorizationError ? error.authorization
    : inspectable && error instanceof DirectMcpAuthorizationError ? error : null;
  // Keep the actual OAuth challenge object unchanged; only the model-safe
  // bounded body is encoded. The recovery ID is data, not an authority.
  return { ...(authorization ? directMcpToolAuthorizationError(authorization, 'knowledge:write') : {}),
    isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}
