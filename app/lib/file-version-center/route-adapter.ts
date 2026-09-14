import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { dualRateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  type FileVersionCenterErrorCode,
} from './contracts/v1';
import {
  observeFileVersionCenter,
  type FileVersionCenterOperation,
} from './observability';
import type { FileVersionCenterAccess } from './query-service';

export const FILE_VERSION_CENTER_PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
});

type WorkspaceAuthorizer = typeof requireRequestWorkspace;
type AuthorizedRequest = {
  authorized: true;
  session: NonNullable<Awaited<ReturnType<WorkspaceAuthorizer>>['session']>;
  workspace: WorkspaceContext;
  access: FileVersionCenterAccess;
};
type DeniedRequest = { authorized: false; response: NextResponse };
type FileVersionCenterRateLimit = Readonly<{
  perUserPerMinute: number;
  perIpPerMinute: number;
}>;

function privateResponse(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(FILE_VERSION_CENTER_PRIVATE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export function withFileVersionCenterPrivateHeaders(response: NextResponse): NextResponse {
  return privateResponse(response);
}

export function fileVersionCenterErrorResponse(
  code: FileVersionCenterErrorCode,
  message: string,
  status: number,
  retryable = false,
): NextResponse {
  return NextResponse.json({
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    success: false,
    error: { code, message, retryable },
  }, { status, headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
}

export async function readFileVersionCenterJson(request: NextRequest): Promise<unknown> {
  const parsed = await readBoundedJson(request, FILE_VERSION_CENTER_CONTRACT_LIMITS.payloadBytes);
  if (parsed.response) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge,
      'The file version center request exceeds the transport limit.',
    );
  }
  if (parsed.body === null) {
    throw new FileVersionCenterContractError(
      FILE_VERSION_CENTER_ERROR_CODES.invalidRequest,
      'A valid JSON request body is required.',
    );
  }
  return parsed.body;
}

export function applyFileVersionCenterRateLimit(
  request: NextRequest,
  input: {
    operation: FileVersionCenterOperation;
    verifiedUserId: string;
    rate: FileVersionCenterRateLimit;
    startedAt?: number;
  },
): NextResponse | null {
  const limited = dualRateLimit(request, {
    perUserLimit: input.rate.perUserPerMinute,
    perIpLimit: input.rate.perIpPerMinute,
    windowMs: 60_000,
    keyPrefix: `file-version-center:${input.operation}`,
    verifiedUserId: input.verifiedUserId,
  });
  if (limited.ok) return null;
  observeFileVersionCenter({
    operation: input.operation,
    outcome: 'rate_limited',
    startedAt: input.startedAt,
    errorCode: FILE_VERSION_CENTER_ERROR_CODES.rateLimited,
  });
  const response = fileVersionCenterErrorResponse(
    FILE_VERSION_CENTER_ERROR_CODES.rateLimited,
    'Too many file version requests. Try again shortly.',
    429,
    true,
  );
  const retryAfter = limited.response.headers.get('Retry-After');
  if (retryAfter) response.headers.set('Retry-After', retryAfter);
  return response;
}

function errorStatus(code: FileVersionCenterErrorCode): { status: number; retryable: boolean } {
  if (code === FILE_VERSION_CENTER_ERROR_CODES.accessDenied) return { status: 403, retryable: false };
  if (code === FILE_VERSION_CENTER_ERROR_CODES.notFound) return { status: 404, retryable: false };
  if (code === FILE_VERSION_CENTER_ERROR_CODES.payloadTooLarge) return { status: 413, retryable: false };
  if (code === FILE_VERSION_CENTER_ERROR_CODES.rateLimited) return { status: 429, retryable: true };
  if (code === FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable) return { status: 503, retryable: true };
  if (code === FILE_VERSION_CENTER_ERROR_CODES.internal) return { status: 500, retryable: true };
  if (([
    FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
    FILE_VERSION_CENTER_ERROR_CODES.conflict,
    FILE_VERSION_CENTER_ERROR_CODES.policyConflict,
  ] as FileVersionCenterErrorCode[]).includes(code)) return { status: 409, retryable: false };
  return { status: 400, retryable: false };
}

export function fileVersionCenterCaughtError(
  error: unknown,
  observation?: { operation: FileVersionCenterOperation; startedAt?: number },
): NextResponse {
  if (error instanceof FileVersionCenterContractError) {
    const mapped = errorStatus(error.code);
    if (observation) {
      observeFileVersionCenter({
        ...observation,
        outcome: mapped.status === 403 ? 'denied'
          : mapped.status === 409 ? 'conflict'
            : mapped.status >= 500 ? 'failure' : 'invalid',
        errorCode: error.code,
      });
    }
    return fileVersionCenterErrorResponse(error.code, error.message, mapped.status, mapped.retryable);
  }
  if (observation) {
    observeFileVersionCenter({
      ...observation,
      outcome: 'failure',
      errorCode: FILE_VERSION_CENTER_ERROR_CODES.internal,
    });
  }
  return fileVersionCenterErrorResponse(
    FILE_VERSION_CENTER_ERROR_CODES.internal,
    'The version center request could not be completed.',
    500,
    true,
  );
}

export function createFileVersionCenterRouteAuthorizer(
  authorizeWorkspace: WorkspaceAuthorizer = requireRequestWorkspace,
) {
  return async (
    request: NextRequest,
    requestedWorkspaceId: string,
    permission: 'canRead' | 'canWrite',
  ): Promise<AuthorizedRequest | DeniedRequest> => {
    const result = await authorizeWorkspace(request, {
      workspaceId: requestedWorkspaceId,
      permissions: permission,
    });
    if (result.response) return { authorized: false, response: privateResponse(result.response) };
    if (result.workspace.workspaceId !== requestedWorkspaceId) {
      return {
        authorized: false,
        response: fileVersionCenterErrorResponse(
          FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
          'The document is not available in the requested workspace.',
          403,
        ),
      };
    }
    const workspace = result.workspace;
    const activeMembership = !workspace.status || workspace.status === 'active';
    const access: FileVersionCenterAccess = {
      userId: result.session.user.id,
      authenticatedWorkspaceId: workspace.workspaceId,
      requestedWorkspaceId,
      membership: activeMembership ? 'active' : 'revoked',
      permissionsResolved: true,
      canRead: workspace.permissions.canRead,
      canWrite: workspace.permissions.canWrite,
      canRunAgent: workspace.permissions.canRunAgent,
      canManageWorkspace: workspace.permissions.canManageWorkspace,
    };
    if (!activeMembership) {
      return {
        authorized: false,
        response: fileVersionCenterErrorResponse(
          FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
          'The document is no longer available in this workspace.',
          403,
        ),
      };
    }
    return { authorized: true, session: result.session, workspace, access };
  };
}

export const authorizeFileVersionCenterRequest = createFileVersionCenterRouteAuthorizer();
