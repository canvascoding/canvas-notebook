import 'server-only';

import { NativeDocumentEditOperationError } from '../collaboration/native-document-edit-operation-contract';
import { DirectMcpAuthorizationError } from '../mcp/server/access-token-verifier';
import { DocumentEditError } from './edit-contracts';
import { NativeDocumentEditAuthorizationError, normalizeDocumentEditPublicError } from './edit-public-service';

export const DOCUMENT_EDIT_ERROR_CODES_V1 = Object.freeze([
  'INVALID_REQUEST', 'AUTHENTICATION_REQUIRED', 'ACCESS_DENIED', 'DOCUMENT_NOT_FOUND',
  'DOCUMENT_VERSION_CONFLICT', 'DOCUMENT_SCOPE_CHANGED', 'DOCUMENT_STATE_MISSING',
  'DOCUMENT_STATE_INVALID', 'DOCUMENT_BUSY', 'DOCUMENT_IDEMPOTENCY_CONFLICT',
  'DOCUMENT_EDIT_CONFLICT', 'DOCUMENT_EDIT_UNSUPPORTED', 'DOCUMENT_TOO_LARGE',
  'EDIT_OUTCOME_UNCONFIRMED', 'DOCUMENT_EDIT_UNAVAILABLE',
] as const satisfies readonly DocumentEditError['code'][]);

export type DocumentEditFailureV1 = Readonly<{
  apiVersion: 1; success: false; code: DocumentEditError['code']; operationId?: string;
}>;

/** Public data only. MCP retains the original authorization error separately
 * for its challenge; no error message, token, source text or origin is emitted. */
export function documentEditFailureV1(error: unknown): Readonly<{ body: DocumentEditFailureV1; status: number }> {
  const normalized = normalizeDocumentEditPublicError(error);
  const authorization = normalized instanceof NativeDocumentEditAuthorizationError
    ? normalized.authorization : normalized instanceof DirectMcpAuthorizationError ? normalized : null;
  const failure = authorization ? new DocumentEditError(authorization.status === 401 ? 'AUTHENTICATION_REQUIRED'
    : authorization.status === 403 ? 'ACCESS_DENIED' : 'DOCUMENT_EDIT_UNAVAILABLE')
    : normalized instanceof DocumentEditError ? normalized : new DocumentEditError('DOCUMENT_EDIT_UNAVAILABLE');
  const operationId = normalized instanceof NativeDocumentEditAuthorizationError
    || normalized instanceof NativeDocumentEditOperationError ? normalized.operationId : undefined;
  return Object.freeze({ body: Object.freeze({ apiVersion: 1, success: false, code: failure.code,
    ...(operationId === undefined ? {} : { operationId }) }), status: failure.status });
}
