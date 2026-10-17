import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { buildFileChangeReviewCenterHref } from '@/app/lib/file-version-center/notification-contract';

import { resolveDirectMcpOrigin } from './config';
import { workspaceFileLinkHref } from '@/app/lib/files/file-link-target';

const PUBLIC_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseDirectMcpEditIdempotencyKey(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !PUBLIC_IDEMPOTENCY_KEY.test(value)) {
    throw new Error('idempotency_key must be 8 to 128 safe identifier characters.');
  }
  return value;
}

export function createDirectMcpEditIdentity(input: {
  clientId: string;
  userId: string;
  idempotencyKey: string | null;
}): {
  actorId: string;
  publicIdempotencyKey: string;
  operationIdempotencyKey: string;
  proposalIdempotencyKey: string;
  retryRequested: boolean;
} {
  const publicIdempotencyKey = input.idempotencyKey ?? randomUUID();
  const scopeHash = sha256(JSON.stringify({
    clientId: input.clientId,
    userId: input.userId,
    key: publicIdempotencyKey,
  }));
  return {
    actorId: `direct-mcp:${sha256(input.clientId).slice(0, 32)}`,
    publicIdempotencyKey,
    operationIdempotencyKey: `direct-mcp-apply:${scopeHash}`,
    proposalIdempotencyKey: `direct-mcp-review:${scopeHash}`,
    retryRequested: input.idempotencyKey !== null,
  };
}

export function buildDirectMcpDocumentUrl(input: {
  workspaceId: string;
  path: string;
  documentId?: string | null;
  lineageId?: string | null;
  origin?: string;
}): string {
  return new URL(workspaceFileLinkHref({ ...input, documentId: input.documentId ?? null,
    lineageId: input.lineageId ?? null }), input.origin ?? resolveDirectMcpOrigin()).toString();
}

export function buildDirectMcpReviewUrl(input: {
  workspaceId: string;
  lineageId: string;
  operationId: string;
  origin?: string;
}): string {
  const href = buildFileChangeReviewCenterHref({
    kind: 'file_change',
    workspaceId: input.workspaceId,
    lineageId: input.lineageId,
    operationId: input.operationId,
  });
  return new URL(href, input.origin ?? resolveDirectMcpOrigin()).toString();
}
