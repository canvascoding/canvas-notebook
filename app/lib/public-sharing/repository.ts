import 'server-only';

import type { SqlConnection } from '../db';
import { normalizeDatabaseTimestamp } from '../db/timestamps';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
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
  table: string; workspaceId: string; id: string; forUpdate?: true; forShare?: true;
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), workspaceId = input.workspaceId, id = input.id, forUpdate = input.forUpdate === true;
  if (forUpdate && input.forShare) throw new TypeError('Choose one public share row lock.');
  const lock = forUpdate ? ' FOR UPDATE NOWAIT' : input.forShare === true ? ' FOR SHARE NOWAIT' : '';
  const row = await database.get(`SELECT ${columns} FROM ${table} WHERE workspace_id=$1 AND id=$2${lock}`,
    [workspaceId, id]) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** The active unique slot includes expired rows. Caller classifies liveness
 * under its actual fence; this query never silently skips an occupied slot. */
export async function readActivePublicShareAtPathOnConnection(database: SqlConnection, input: {
  table: string; workspaceId: string; path: string; forUpdate?: true;
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), workspaceId = input.workspaceId, path = input.path, forUpdate = input.forUpdate;
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256 || workspaceId !== workspaceId.trim()
    || /[\u0000-\u001f\u007f]/u.test(workspaceId) || !isCanonicalAdmissionPath(path)
    || forUpdate !== undefined && forUpdate !== true) throw new TypeError('Invalid public share path selection.');
  const row = await database.get(`SELECT ${columns} FROM ${table} WHERE workspace_id=$1 AND workspace_path=$2
    AND status='active'${forUpdate ? ' FOR UPDATE NOWAIT' : ''}`, [workspaceId, path]) as Row | undefined;
  return row ? mapRow(row) : null;
}

const insertFields = [
  ['id','id'],['token','token'],['token_hash','tokenHash'],['token_preview','tokenPreview'],['short_code','shortCode'],
  ['organization_id','organizationId'],['customer_id','customerId'],['project_id','projectId'],['workspace_id','workspaceId'],
  ['workspace_type','workspaceType'],['workspace_root_relative_path','workspaceRootRelativePath'],['workspace_path','workspacePath'],
  ['document_id','documentId'],['lineage_id','lineageId'],['lifecycle_generation','lifecycleGeneration'],['file_name','fileName'],
  ['file_identity','fileIdentity'],['target_revision_policy','targetRevisionPolicy'],['last_known_revision','lastKnownRevision'],
  ['mime_type','mimeType'],['size_bytes','sizeBytes'],['status','status'],['created_by_user_id','createdByUserId'],
  ['created_by_agent_id','createdByAgentId'],['source_session_id','sourceSessionId'],['source','source'],['security_mode','securityMode'],
  ['reason','reason'],['created_at','createdAt'],['updated_at','updatedAt'],['expires_at','expiresAt'],['revoked_at','revokedAt'],
  ['revoked_reason','revokedReason'],['password_enabled','passwordEnabled'],['password_hash','passwordHash'],
  ['last_accessed_at','lastAccessedAt'],['access_count','accessCount'],['policy_revision','policyRevision'],
] as const satisfies readonly (readonly [string, keyof PublicShareRow])[];

function captureInsertRow(row: PublicShareRow): Row {
  const keys = insertFields.map(([, key]) => key);
  if (!row || Object.getPrototypeOf(row) !== Object.prototype || Reflect.ownKeys(row).length !== keys.length
    || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
    })) throw new TypeError('A complete public share row is required.');
  const captured: Row = Object.fromEntries(keys.map(key => [key, row[key]]));
  const strings = ['id','token','tokenHash','tokenPreview','workspacePath','fileName','fileIdentity','mimeType','createdByUserId',
    'status','targetRevisionPolicy','securityMode','source'];
  const nullable = ['shortCode','organizationId','customerId','projectId','workspaceId','workspaceType','workspaceRootRelativePath',
    'documentId','lineageId','lastKnownRevision','createdByAgentId','sourceSessionId','reason','revokedReason','passwordHash'];
  if (strings.some(key => typeof captured[key] !== 'string' || !(captured[key] as string))
    || nullable.some(key => captured[key] !== null && typeof captured[key] !== 'string')
    || !isCanonicalAdmissionPath(captured.workspacePath)
    || captured.workspaceRootRelativePath !== null && !isCanonicalAdmissionPath(captured.workspaceRootRelativePath, true)
    || captured.workspaceType !== null && !['personal','organization','team','project'].includes(String(captured.workspaceType))
    || !['active','revoked','missing','stale','expired'].includes(String(captured.status))
    || !['latest','fixed'].includes(String(captured.targetRevisionPolicy))
    || !['strict','interactive'].includes(String(captured.securityMode)) || !['ui','agent'].includes(String(captured.source))
    || captured.reason !== null && (captured.reason as string).length > 500) throw new TypeError('Invalid public share row values.');
  for (const key of ['id','createdByUserId','organizationId','customerId','projectId','workspaceId','documentId','lineageId','createdByAgentId','sourceSessionId']) {
    const value = captured[key];
    if (value !== null && (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim()
      || /[\u0000-\u001f\u007f]/u.test(value))) throw new TypeError('Invalid public share row identifier.');
  }
  for (const key of ['sizeBytes','accessCount','policyRevision','passwordEnabled']) {
    const value = captured[key], minimum = key === 'policyRevision' ? 1 : 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum
      || key === 'passwordEnabled' && value > 1) throw new TypeError('Invalid public share row integer.');
  }
  if (captured.lifecycleGeneration !== null && (typeof captured.lifecycleGeneration !== 'number'
    || !Number.isSafeInteger(captured.lifecycleGeneration) || captured.lifecycleGeneration < 1
    || captured.lifecycleGeneration >= Number.MAX_SAFE_INTEGER)) throw new TypeError('Invalid public share generation.');
  binding(captured);
  for (const key of ['createdAt','updatedAt','expiresAt','revokedAt','lastAccessedAt']) {
    if (captured[key] === null && key !== 'createdAt' && key !== 'updatedAt') continue;
    let value: number;
    try { value = Date.prototype.getTime.call(captured[key]); }
    catch { throw new TypeError('Invalid public share row timestamp.'); }
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid public share row timestamp.');
    captured[key] = value;
  }
  return captured;
}

/** Borrowed B only. A conflict returns null without aborting that transaction.
 * The writer must verify the complete returned row and its qualified reread. */
export async function insertPublicShareOnConnection(database: SqlConnection, input: {
  table: string; row: PublicShareRow;
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), captured = captureInsertRow(input.row);
  const values = insertFields.map(([, key]) => captured[key]);
  const inserted = await database.get(`INSERT INTO ${table} (${insertFields.map(([column]) => column).join(',')})
    VALUES (${values.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT DO NOTHING RETURNING ${columns}`, values) as Row | undefined;
  return inserted ? mapRow(inserted) : null;
}

/** Only the caller's bound actual short-code constraint names may turn a real
 * 23505 into a collision. Savepoint disposal must be confirmed before retry. */
export async function assignPublicShareShortCodeOnConnection(database: SqlConnection, input: {
  table: string; expected: PublicShareRow; shortCode: string; shortCodeConstraints: readonly string[];
}): Promise<{ kind: 'assigned'; row: PublicShareRow } | { kind: 'collision' } | { kind: 'changed' }> {
  const table = relation(input.table), shortCode = input.shortCode, expected = captureInsertRow(input.expected);
  const names = input.shortCodeConstraints;
  if (typeof shortCode !== 'string' || !/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{6}$/u.test(shortCode)
    || !Array.isArray(names) || !names.length || names.length > 16
    || names.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/u.test(name))
    || new Set(names).size !== names.length) throw new TypeError('Invalid bound public share short-code input.');
  const constraints = new Set(names);
  if (expected.shortCode !== null || expected.status !== 'active') return { kind: 'changed' };
  const values = [shortCode,expected.id,expected.workspaceId,expected.organizationId,expected.customerId,expected.projectId,
    expected.workspaceType,expected.workspaceRootRelativePath,expected.workspacePath,expected.tokenHash,expected.policyRevision,
    expected.documentId,expected.lineageId,expected.lifecycleGeneration,expected.fileIdentity,expected.targetRevisionPolicy,
    expected.createdByUserId,expected.expiresAt,expected.securityMode,expected.reason];
  await database.run('SAVEPOINT canvas_public_short_code_allocation');
  let updated: Row | undefined;
  try {
    updated = await database.get(`UPDATE ${table} SET short_code=$1 WHERE id=$2
      AND workspace_id IS NOT DISTINCT FROM $3 AND organization_id IS NOT DISTINCT FROM $4
      AND customer_id IS NOT DISTINCT FROM $5 AND project_id IS NOT DISTINCT FROM $6
      AND workspace_type IS NOT DISTINCT FROM $7 AND workspace_root_relative_path IS NOT DISTINCT FROM $8 AND workspace_path=$9
      AND token_hash=$10 AND policy_revision=$11 AND status='active' AND short_code IS NULL
      AND document_id IS NOT DISTINCT FROM $12 AND lineage_id IS NOT DISTINCT FROM $13
      AND lifecycle_generation IS NOT DISTINCT FROM $14 AND file_identity=$15 AND target_revision_policy=$16
      AND created_by_user_id=$17 AND expires_at IS NOT DISTINCT FROM $18 AND security_mode=$19
      AND reason IS NOT DISTINCT FROM $20 RETURNING ${columns}`,values) as Row | undefined;
  } catch (error) {
    const cleanup: unknown[] = [];
    try { await database.run('ROLLBACK TO SAVEPOINT canvas_public_short_code_allocation'); } catch (failure) { cleanup.push(failure); }
    try { await database.run('RELEASE SAVEPOINT canvas_public_short_code_allocation'); } catch (failure) { cleanup.push(failure); }
    if (cleanup.length) throw new AggregateError([error,...cleanup],'Public share short-code savepoint disposal could not be confirmed.');
    if (error && typeof error === 'object' && Reflect.get(error,'code') === '23505'
      && typeof Reflect.get(error,'constraint') === 'string' && constraints.has(Reflect.get(error,'constraint'))) return { kind: 'collision' };
    throw error;
  }
  // An ACK lost after an actual RELEASE must escape; never publish success or
  // retry that UPDATE based on an unconfirmed savepoint boundary.
  await database.run('RELEASE SAVEPOINT canvas_public_short_code_allocation');
  return updated ? { kind: 'assigned', row: mapRow(updated) } : { kind: 'changed' };
}

/** A monotone revoke needs no live native document or filesystem projection.
 * Compare the original stored pins (including all-null historical pins), never
 * fill them from a current path. A CAS miss is not a successful mutation. */
export async function revokePublicShareOnConnection(database: SqlConnection, input: {
  table: string; expected: PublicShareRow; nowMs: number;
  reason: 'manual' | 'republished_expired' | 'republished_stale' | 'republished_missing';
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), row = input.expected, now = integer(input.nowMs);
  if (!['manual','republished_expired','republished_stale','republished_missing'].includes(input.reason)) throw new TypeError('Invalid public share revocation reason.');
  if (!['active', 'missing', 'stale', 'expired'].includes(row.status)) return null;
  const revision = integer(row.policyRevision, 1);
  if (revision === Number.MAX_SAFE_INTEGER) throw new TypeError('Public share revision exhausted.');
  // Capture primitive CAS values before the first await. The surrounding real
  // writer keeps the original row and current authority locked through COMMIT.
  const values = [now, row.id, row.workspaceId, row.organizationId, row.customerId, row.projectId, row.workspaceType,
    row.workspaceRootRelativePath, row.workspacePath, row.tokenHash, revision, row.status, row.documentId, row.lineageId,
    row.lifecycleGeneration, row.fileIdentity, row.targetRevisionPolicy, row.createdByUserId, input.reason];
  const updated = await database.get(`UPDATE ${table} SET status='revoked',policy_revision=policy_revision+1,
    revoked_at=$1,revoked_reason=$19,updated_at=$1
    WHERE id=$2 AND workspace_id IS NOT DISTINCT FROM $3 AND organization_id IS NOT DISTINCT FROM $4
      AND customer_id IS NOT DISTINCT FROM $5 AND project_id IS NOT DISTINCT FROM $6
      AND workspace_type IS NOT DISTINCT FROM $7 AND workspace_root_relative_path IS NOT DISTINCT FROM $8 AND workspace_path=$9
      AND token_hash=$10 AND policy_revision=$11 AND status=$12 AND document_id IS NOT DISTINCT FROM $13
      AND lineage_id IS NOT DISTINCT FROM $14 AND lifecycle_generation IS NOT DISTINCT FROM $15
      AND file_identity=$16 AND target_revision_policy=$17 AND created_by_user_id=$18 RETURNING ${columns}`, values) as Row | undefined;
  return updated ? mapRow(updated) : null;
}

/** Borrowed B only. Caller owns normalized deltas, current authority, target
 * liveness and the locked original row; it handles no-op without calling here.
 * Policy edits preserve every original target pin, token and access field. */
export async function updatePublicSharePolicyOnConnection(database: SqlConnection, input: {
  table: string; expected: PublicShareRow; nowMs: number;
  changes: { expiresAtMs?: number | null; securityMode?: 'strict' | 'interactive'; reason?: string | null };
}): Promise<PublicShareRow | null> {
  const table = relation(input.table), row = input.expected, changes = input.changes;
  if (typeof input.nowMs !== 'number' || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || !Number.isFinite(new Date(input.nowMs).getTime()) || !changes || Object.getPrototypeOf(changes) !== Object.prototype
    || Reflect.ownKeys(changes).some(key => typeof key !== 'string' || !['expiresAtMs','securityMode','reason'].includes(key)
      || !Object.getOwnPropertyDescriptor(changes,key)?.enumerable
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(changes,key),'value'))) {
    throw new TypeError('Invalid public share policy input.');
  }
  const now = input.nowMs, revision = integer(row.policyRevision, 1);
  if (revision === Number.MAX_SAFE_INTEGER) throw new TypeError('Public share revision exhausted.');
  binding(row as Row);
  const oldExpiry = row.expiresAt === null ? null : row.expiresAt instanceof Date ? row.expiresAt.getTime() : NaN;
  const expiresAt = changes.expiresAtMs === undefined ? oldExpiry : changes.expiresAtMs;
  const securityMode = changes.securityMode === undefined ? row.securityMode : changes.securityMode;
  const reason = changes.reason === undefined ? row.reason : changes.reason;
  if (oldExpiry !== null && !Number.isSafeInteger(oldExpiry)
    || expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
      || !Number.isFinite(new Date(expiresAt).getTime()))
    || changes.expiresAtMs !== undefined && expiresAt !== null && expiresAt <= now
    || securityMode !== 'strict' && securityMode !== 'interactive'
    || reason !== null && typeof reason !== 'string'
    || changes.reason !== undefined && changes.reason !== null && changes.reason.length > 500) {
    throw new TypeError('Invalid public share policy values.');
  }
  if (row.status !== 'active') return null;
  // Capture only primitive expectations before yielding; no path lookup or
  // replacement binding can turn a failed original-row CAS into success.
  const values = [now, expiresAt, securityMode, reason, row.id, row.workspaceId, row.organizationId, row.customerId,
    row.projectId, row.workspaceType, row.workspaceRootRelativePath, row.workspacePath, row.tokenHash, revision,
    row.documentId, row.lineageId, row.lifecycleGeneration, row.fileIdentity, row.targetRevisionPolicy, row.createdByUserId,
    oldExpiry, row.securityMode, row.reason];
  const strings = [row.id,row.workspaceId,row.organizationId,row.customerId,row.projectId,row.workspaceType,
    row.workspaceRootRelativePath,row.workspacePath,row.tokenHash,row.documentId,row.lineageId,row.fileIdentity,
    row.targetRevisionPolicy,row.createdByUserId,row.securityMode,row.reason];
  if (strings.some(value => value !== null && typeof value !== 'string')) throw new TypeError('Invalid public share policy expectation.');
  const updated = await database.get(`UPDATE ${table} SET expires_at=$2,security_mode=$3,reason=$4,
    policy_revision=policy_revision+1,updated_at=$1
    WHERE id=$5 AND workspace_id IS NOT DISTINCT FROM $6 AND organization_id IS NOT DISTINCT FROM $7
      AND customer_id IS NOT DISTINCT FROM $8 AND project_id IS NOT DISTINCT FROM $9
      AND workspace_type IS NOT DISTINCT FROM $10 AND workspace_root_relative_path IS NOT DISTINCT FROM $11 AND workspace_path=$12
      AND token_hash=$13 AND policy_revision=$14 AND status='active' AND (expires_at IS NULL OR expires_at>$1)
      AND document_id IS NOT DISTINCT FROM $15 AND lineage_id IS NOT DISTINCT FROM $16
      AND lifecycle_generation IS NOT DISTINCT FROM $17 AND file_identity=$18 AND target_revision_policy=$19
      AND created_by_user_id=$20 AND expires_at IS NOT DISTINCT FROM $21 AND security_mode=$22
      AND reason IS NOT DISTINCT FROM $23 RETURNING ${columns}`, values) as Row | undefined;
  return updated ? mapRow(updated) : null;
}
