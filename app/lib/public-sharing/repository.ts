import 'server-only';

import type { SqlConnection } from '../db';
import { normalizeDatabaseTimestamp } from '../db/timestamps';
import type { PublicShareRow } from './public-file-shares';

type Row = Record<string, unknown>;
const columns = `id,token,token_hash AS "tokenHash",token_preview AS "tokenPreview",short_code AS "shortCode",
  organization_id AS "organizationId",customer_id AS "customerId",project_id AS "projectId",
  workspace_id AS "workspaceId",workspace_type AS "workspaceType",workspace_root_relative_path AS "workspaceRootRelativePath",
  workspace_path AS "workspacePath",document_id AS "documentId",lineage_id AS "lineageId",lifecycle_generation AS "lifecycleGeneration",
  file_name AS "fileName",file_identity AS "fileIdentity",target_revision_policy AS "targetRevisionPolicy",
  last_known_revision AS "lastKnownRevision",mime_type AS "mimeType",size_bytes AS "sizeBytes",status,
  created_by_user_id AS "createdByUserId",created_by_agent_id AS "createdByAgentId",source_session_id AS "sourceSessionId",
  source,security_mode AS "securityMode",reason,created_at AS "createdAt",updated_at AS "updatedAt",
  expires_at AS "expiresAt",revoked_at AS "revokedAt",revoked_reason AS "revokedReason",password_enabled AS "passwordEnabled",
  password_hash AS "passwordHash",last_accessed_at AS "lastAccessedAt",access_count AS "accessCount",policy_revision AS "policyRevision"`;

/** A quoted relation name is SQL plumbing, never proof of workspace authority.
 * The real writer must bind its schema/OID and hold that binding on this B. */
function relation(value: string): string {
  const match = typeof value === 'string' && /^"((?:[^"]|"")+)"\.(?:"public_file_shares"|public_file_shares)$/u.exec(value);
  if (!match) throw new TypeError('A qualified public share relation is required.');
  const schema = match[1].replaceAll('""', '"');
  if (Buffer.byteLength(schema) > 63 || /[\u0000-\u001f\u007f]/u.test(schema)) throw new TypeError('Invalid public share relation.');
  return `"${schema.replaceAll('"', '""')}"."public_file_shares"`;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new TypeError('Invalid persisted public share integer.');
  return Number(value);
}

function date(value: unknown): Date {
  if (value === null || value === undefined) throw new TypeError('Invalid persisted public share timestamp.');
  const result = new Date(normalizeDatabaseTimestamp(Number(value)));
  if (!Number.isFinite(result.getTime())) throw new TypeError('Invalid persisted public share timestamp.');
  return result;
}

function binding(row: Row): void {
  const pins = [row.documentId, row.lineageId, row.lifecycleGeneration];
  if (pins.every(value => value === null)) return;
  const id = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!id(row.workspaceId) || !id(row.documentId) || !id(row.lineageId) || row.lifecycleGeneration === null
    || integer(row.lifecycleGeneration, 1) >= Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid persisted public share binding.');
}

/** Match Drizzle's pgTimestamp (milliseconds -> Date) and bigint number fields.
 * The selected aliases retain the existing PublicShareRow/DTO contract. */
function mapRow(row: Row): PublicShareRow {
  binding(row);
  return { ...row,
    lifecycleGeneration: row.lifecycleGeneration === null ? null : integer(row.lifecycleGeneration, 1),
    sizeBytes: integer(row.sizeBytes), passwordEnabled: integer(row.passwordEnabled),
    accessCount: integer(row.accessCount), policyRevision: integer(row.policyRevision, 1),
    createdAt: date(row.createdAt), updatedAt: date(row.updatedAt),
    expiresAt: row.expiresAt === null ? null : date(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : date(row.revokedAt),
    lastAccessedAt: row.lastAccessedAt === null ? null : date(row.lastAccessedAt),
  } as PublicShareRow;
}

/** Borrowed B only. Caller owns current Principal, relation/schema binding,
 * lock order, final assertions and transaction/COMMIT/cleanup. */
export async function readPublicShareOnConnection(database: SqlConnection, input: {
  table: string; workspaceId: string; id: string; forUpdate?: true;
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), workspaceId = input.workspaceId, id = input.id, forUpdate = input.forUpdate === true;
  const row = await database.get(`SELECT ${columns} FROM ${table} WHERE workspace_id=$1 AND id=$2${forUpdate ? ' FOR UPDATE NOWAIT' : ''}`,
    [workspaceId, id]) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** A monotone revoke needs no live native document or filesystem projection.
 * Compare the original stored pins (including all-null historical pins), never
 * fill them from a current path. A CAS miss is not a successful mutation. */
export async function revokePublicShareOnConnection(database: SqlConnection, input: {
  table: string; expected: PublicShareRow; nowMs: number; reason: 'manual';
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), row = input.expected, now = integer(input.nowMs);
  if (input.reason !== 'manual') throw new TypeError('Invalid public share revocation reason.');
  if (!['active', 'missing', 'stale', 'expired'].includes(row.status)) return null;
  const revision = integer(row.policyRevision, 1);
  if (revision === Number.MAX_SAFE_INTEGER) throw new TypeError('Public share revision exhausted.');
  // Capture primitive CAS values before the first await. The surrounding real
  // writer keeps the original row and current authority locked through COMMIT.
  const values = [now, row.id, row.workspaceId, row.organizationId, row.customerId, row.projectId, row.workspaceType,
    row.workspaceRootRelativePath, row.workspacePath, row.tokenHash, revision, row.status, row.documentId, row.lineageId,
    row.lifecycleGeneration, row.fileIdentity, row.targetRevisionPolicy, row.createdByUserId];
  const updated = await database.get(`UPDATE ${table} SET status='revoked',policy_revision=policy_revision+1,
    revoked_at=$1,revoked_reason='manual',updated_at=$1
    WHERE id=$2 AND workspace_id IS NOT DISTINCT FROM $3 AND organization_id IS NOT DISTINCT FROM $4
      AND customer_id IS NOT DISTINCT FROM $5 AND project_id IS NOT DISTINCT FROM $6
      AND workspace_type IS NOT DISTINCT FROM $7 AND workspace_root_relative_path IS NOT DISTINCT FROM $8 AND workspace_path=$9
      AND token_hash=$10 AND policy_revision=$11 AND status=$12 AND document_id IS NOT DISTINCT FROM $13
      AND lineage_id IS NOT DISTINCT FROM $14 AND lifecycle_generation IS NOT DISTINCT FROM $15
      AND file_identity=$16 AND target_revision_policy=$17 AND created_by_user_id=$18 RETURNING ${columns}`, values) as Row | undefined;
  return updated ? mapRow(updated) : null;
}
