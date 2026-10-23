import 'server-only';

import { types } from 'node:util';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { NativeDocumentEditOperationError } from '../collaboration/native-document-edit-operation-contract';
import { DirectMcpAuthorizationError } from '../mcp/server/access-token-verifier';
import { decodeDocumentEditRequestV1, DocumentEditError, type DecodedDocumentEditRequestV1 } from './edit-contracts';
import { withNativeDocumentEditRequestAuthority, withNativeDocumentEditMcpAuthority,
  withNativeDocumentEditPiAuthority, type NativeDocumentEditWriteAuthority } from './edit-principal';
import { decodeDocumentEditStatusRequestV1, type DocumentEditOperationResultV1 } from './edit-result-contract';
import { readNativeDocumentEditOperationStatus } from './edit-operation-status';
import { applyNativeDocumentEdit } from './edit-service';

type EditCode = ConstructorParameters<typeof DocumentEditError>[0];
type Recovery = { operationId?: string };
const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function operationId(value: unknown): string | undefined {
  return typeof value === 'string' && operationIdPattern.test(value) ? value : undefined;
}
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined;
}

/** Keeps the genuine OAuth error, including its exact challenge, unchanged.
 * The bounded reference is recovery data only; neither field grants access.
 * Adapters must encode public fields, never serialize this error object. */
export class NativeDocumentEditAuthorizationError extends Error {
  readonly authorization: DirectMcpAuthorizationError;
  readonly operationId: string;
  constructor(authorization: DirectMcpAuthorizationError, knownOperationId: string) {
    super('The document edit requires authorization; retain its recovery reference.');
    if (!authorization || types.isProxy(authorization) || !(authorization instanceof DirectMcpAuthorizationError)) {
      throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED');
    }
    const selected = operationId(knownOperationId);
    if (!selected) throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED');
    this.name = 'NativeDocumentEditAuthorizationError';
    this.authorization = authorization;
    this.operationId = selected;
  }
}

function knownCode(code: unknown): EditCode {
  switch (code) {
    case 'INVALID_REQUEST': case 'AUTHENTICATION_REQUIRED': case 'ACCESS_DENIED': case 'DOCUMENT_NOT_FOUND':
    case 'DOCUMENT_VERSION_CONFLICT': case 'DOCUMENT_SCOPE_CHANGED': case 'DOCUMENT_STATE_MISSING':
    case 'DOCUMENT_STATE_INVALID': case 'DOCUMENT_BUSY': case 'DOCUMENT_IDEMPOTENCY_CONFLICT':
    case 'DOCUMENT_EDIT_CONFLICT': case 'DOCUMENT_EDIT_UNSUPPORTED': case 'DOCUMENT_TOO_LARGE':
    case 'EDIT_OUTCOME_UNCONFIRMED': case 'DOCUMENT_EDIT_UNAVAILABLE': return code;
    case 'PRINCIPAL_REQUIRED': case 'PRINCIPAL_AUTH_REVOKED': case 'MCP_READ_PRINCIPAL_REQUIRED':
    case 'AGENT_TOOL_INVOCATION_REQUIRED': case 'AGENT_TOOL_INVOCATION_INVALID': return 'AUTHENTICATION_REQUIRED';
    case 'PRINCIPAL_INVALID': case 'MCP_READ_PRINCIPAL_INVALID': return 'INVALID_REQUEST';
    case 'PRINCIPAL_ACCESS_DENIED': case 'MCP_READ_PRINCIPAL_ACCESS_DENIED': case 'TOOL_POLICY_DENIED':
    case 'SEAT_ACCESS_INACTIVE': case 'SEAT_MEMBERSHIP_REQUIRED': case 'SEAT_LIMIT_EXCEEDED':
    case 'SEAT_ACTIVATION_STALE': case 'LICENSE_REQUIRED': case 'LICENSE_TEAM_REQUIRED':
    case 'LICENSE_FEATURE_REQUIRED': case 'LICENSE_PLAN_REQUIRED': case 'LICENSE_QUOTA_REQUIRED': return 'ACCESS_DENIED';
    case 'PRINCIPAL_BUSY': case 'PRINCIPAL_EXPIRED': case 'MCP_READ_PRINCIPAL_BUSY': case 'MCP_READ_PRINCIPAL_EXPIRED':
    case 'NATIVE_SESSION_BUSY': case 'ADMISSION_CONFLICT': case '55P03': return 'DOCUMENT_BUSY';
    case 'PRINCIPAL_TOO_LARGE': case 'NATIVE_SESSION_TOO_LARGE': return 'DOCUMENT_TOO_LARGE';
    case 'PRINCIPAL_SCOPE_CHANGED': case 'PRINCIPAL_DETACHED': case 'PRINCIPAL_REENTRANT':
    case 'MCP_READ_PRINCIPAL_SCOPE_CHANGED': case 'MCP_READ_PRINCIPAL_DETACHED': case 'MCP_READ_PRINCIPAL_REENTRANT':
    case 'AGENT_TOOL_INVOCATION_CLOSED': case 'AGENT_TOOL_INVOCATION_ABORTED': case 'AGENT_TOOL_INVOCATION_DETACHED':
    case 'AGENT_TOOL_INVOCATION_ORIGIN_CHANGED': case 'TOOL_POLICY_CHANGED': case 'NATIVE_SESSION_SCOPE_CHANGED':
    case 'NATIVE_SESSION_REENTRANT': case 'NATIVE_SESSION_DETACHED': case 'COLLABORATION_STATE_INACTIVE':
    case 'COLLABORATION_STATE_STALE': case 'ADMISSION_SCOPE_CHANGED': case 'ADMISSION_STATE_CHANGED': return 'DOCUMENT_SCOPE_CHANGED';
    case 'NATIVE_SESSION_STATE_MISSING': return 'DOCUMENT_STATE_MISSING';
    case 'DOCUMENT_QUARANTINED': case 'NATIVE_SESSION_STATE_INVALID': case 'NATIVE_SESSION_QUARANTINED':
    case 'NATIVE_SESSION_QUARANTINE_REQUIRED': return 'DOCUMENT_STATE_INVALID';
    case 'DOCUMENT_FORMAT_UNAVAILABLE': return 'DOCUMENT_EDIT_UNSUPPORTED';
    case 'ADMISSION_REQUEST_CHANGED': return 'DOCUMENT_IDEMPOTENCY_CONFLICT';
    case 'READ_OUTCOME_UNCONFIRMED': case 'ADMISSION_RECOVERY_REQUIRED': return 'EDIT_OUTCOME_UNCONFIRMED';
    default: return 'DOCUMENT_EDIT_UNAVAILABLE';
  }
}

/** Fixed public error vocabulary only. Own scalar codes also survive the
 * standalone/Next bundle boundary; names, messages, causes and stacks do not.
 * Aggregate cleanup failures remain terminal, rather than adopting a nested
 * optimistic Busy or success. Error data never mints a transport authority. */
export function normalizeDocumentEditPublicError(error: unknown): Error {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return new DocumentEditError('DOCUMENT_EDIT_UNAVAILABLE');
  if (error instanceof NativeDocumentEditAuthorizationError || error instanceof DirectMcpAuthorizationError) return error;
  const code = knownCode(ownData(error, 'code'));
  const retained = operationId(ownData(error, 'operationId'));
  return retained ? new NativeDocumentEditOperationError(code, retained) : new DocumentEditError(code);
}

function recoveryError(error: unknown, recovery: Recovery): Error {
  const normalized = normalizeDocumentEditPublicError(error), retained = recovery.operationId;
  if (!retained) return normalized;
  if (normalized instanceof NativeDocumentEditAuthorizationError) {
    return normalized.operationId === retained ? normalized
      : new NativeDocumentEditAuthorizationError(normalized.authorization, retained);
  }
  if (normalized instanceof DirectMcpAuthorizationError) return new NativeDocumentEditAuthorizationError(normalized, retained);
  // The normalizer returns only the two authorization variants or a safe
  // DocumentEditError. A known actual operation always keeps its own ID.
  return new NativeDocumentEditOperationError(normalized instanceof DocumentEditError
    ? normalized.code : 'DOCUMENT_EDIT_UNAVAILABLE', retained);
}

async function editAndReadStatus(authority: NativeDocumentEditWriteAuthority,
  request: DecodedDocumentEditRequestV1, recovery: Recovery): Promise<DocumentEditOperationResultV1> {
  const actual = await applyNativeDocumentEdit(authority, request);
  const issued = operationId(actual.operation.operationId);
  if (!issued) throw new DocumentEditError('EDIT_OUTCOME_UNCONFIRMED');
  // Set once, only after the actual service returns. The internal original,
  // targets, snapshots and After never cross this public service boundary.
  recovery.operationId = issued;
  return readNativeDocumentEditOperationStatus(authority,
    { apiVersion: 1, workspaceId: request.workspaceId, operationId: issued });
}

/** Genuine member Request, including its actual cookie/session Bearer. */
export async function editDocumentForRequest(request: Request, value: unknown): Promise<DocumentEditOperationResultV1> {
  const recovery: Recovery = {};
  try {
    const selected = decodeDocumentEditRequestV1(value);
    return await withNativeDocumentEditRequestAuthority(request, { workspaceId: selected.workspaceId },
      authority => editAndReadStatus(authority, selected, recovery));
  } catch (error) { throw recoveryError(error, recovery); }
}

/** Genuine OAuth client and fixed edit_knowledge_source write policy. */
export async function editDocumentForDirectMcp(authInfo: AuthInfo, value: unknown): Promise<DocumentEditOperationResultV1> {
  const recovery: Recovery = {};
  try {
    const selected = decodeDocumentEditRequestV1(value);
    return await withNativeDocumentEditMcpAuthority(authInfo, { workspaceId: selected.workspaceId },
      authority => editAndReadStatus(authority, selected, recovery));
  } catch (error) { throw recoveryError(error, recovery); }
}

/** Actual wrapped edit_file invocation; no caller execution context accepted. */
export async function editDocumentForAgentTool(value: unknown): Promise<DocumentEditOperationResultV1> {
  const recovery: Recovery = {};
  try {
    const selected = decodeDocumentEditRequestV1(value);
    return await withNativeDocumentEditPiAuthority({ workspaceId: selected.workspaceId },
      authority => editAndReadStatus(authority, selected, recovery));
  } catch (error) { throw recoveryError(error, recovery); }
}

/** Status uses the same current WRITE policy and the separate pure reader.
 * A caller-supplied operation ID is not a successful mutation receipt. */
export async function readDocumentEditStatusForRequest(request: Request, value: unknown): Promise<DocumentEditOperationResultV1> {
  try {
    const selected = decodeDocumentEditStatusRequestV1(value);
    return await withNativeDocumentEditRequestAuthority(request, { workspaceId: selected.workspaceId },
      authority => readNativeDocumentEditOperationStatus(authority, selected));
  } catch (error) { throw normalizeDocumentEditPublicError(error); }
}

export async function readDocumentEditStatusForDirectMcp(authInfo: AuthInfo, value: unknown): Promise<DocumentEditOperationResultV1> {
  try {
    const selected = decodeDocumentEditStatusRequestV1(value);
    return await withNativeDocumentEditMcpAuthority(authInfo, { workspaceId: selected.workspaceId },
      authority => readNativeDocumentEditOperationStatus(authority, selected));
  } catch (error) { throw normalizeDocumentEditPublicError(error); }
}

export async function readDocumentEditStatusForAgentTool(value: unknown): Promise<DocumentEditOperationResultV1> {
  try {
    const selected = decodeDocumentEditStatusRequestV1(value);
    return await withNativeDocumentEditPiAuthority({ workspaceId: selected.workspaceId },
      authority => readNativeDocumentEditOperationStatus(authority, selected));
  } catch (error) { throw normalizeDocumentEditPublicError(error); }
}
