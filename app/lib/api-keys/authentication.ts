import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { types } from 'node:util';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { quotePostgresIdentifier } from '@/app/lib/db/postgres';
import { getCanvasSessionCookie } from '@/app/lib/auth-cookie';
import { getLicenseInstanceId } from '@/app/lib/license/instance';
import { publicRateLimit } from '@/app/lib/security/public-rate-limit';
import { createPublicRateLimitStore } from '@/app/lib/security/public-rate-limit-store';
import { ApiKeyAccessError, type ApiKeyAction } from './contracts';
import { storedGrant } from './grants';
import { hashApiKeySecret, parseApiKey } from './secret';

declare const credentialBrand: unique symbol;
/** A genuine server-side credential proof, never a document permission or session. */
export type ApiKeyCredential = Readonly<{ [credentialBrand]: never }>;
export type ApiKeyCredentialRealm = Readonly<{
  schema: string; schemaOid: number; databaseOid: number; searchPath: string;
  credentialRelationOid: number; integrationRelationOid: number; userRelationOid: number;
}>;
export type CurrentApiKeyIdentity = Readonly<{
  workspaceIds: readonly string[]; actions: readonly ApiKeyAction[];
  credentialId: string; integrationId: string; userId: string; instanceId: string;
  integrationName: string; revision: number; expiresAt: number; realm: ApiKeyCredentialRealm;
}>;
type Capture = { credentialId: string; secretHash: string; integrationId: string; userId: string;
  instanceId: string; realm: ApiKeyCredentialRealm };
export type ApiKeyCredentialBinding = Readonly<Omit<Capture, 'secretHash'>>;
type CredentialRow = {
  id: string; secret_hash: string; expires_at: number; revoked_at: number | null;
  integration_id: string; owner_user_id: string; instance_id: string; name: string; revision: number;
  workspace_ids_json: string; actions_json: string; account_banned: number | string | boolean | null;
  account_email: string | null; account_role: string | null;
  schema_name: string; schema_oid: string; database_oid: string; search_path: string;
  credential_relation_oid: string; integration_relation_oid: string; user_relation_oid: string;
  relations_match: boolean;
};
function credentialRegistry(): WeakMap<ApiKeyCredential, Capture> {
  // Compiled Next routes and the standalone service must recognize the same
  // genuine handles; serialized copies still have no entry in this map.
  const key = Symbol.for('canvas.api-key-credentials.v1');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (!descriptor) {
    const registry = new WeakMap<ApiKeyCredential, Capture>();
    Object.defineProperty(globalThis, key, { value: registry });
    return registry;
  }
  if (!Object.hasOwn(descriptor, 'value') || !types.isWeakMap(descriptor.value) || types.isProxy(descriptor.value)) {
    throw new ApiKeyAccessError('API_KEY_STATE_INVALID', 'The credential registry is unavailable.', 503);
  }
  return descriptor.value as WeakMap<ApiKeyCredential, Capture>;
}
const captures = credentialRegistry();
const consumeKnownBudget = createPublicRateLimitStore(openDb);
/** Catalog/credential data for a joint phase snapshot; this SQL grants nothing. */
export function apiKeyCredentialSnapshotSql(credentialParameter = 1, schema?: string): string {
  if (!Number.isInteger(credentialParameter) || credentialParameter < 1 || credentialParameter > 32
    || schema !== undefined && (typeof schema !== 'string' || !schema || schema.length > 63)) {
    throw new RangeError('Invalid credential snapshot selection.');
  }
  const table = (name: string) => `${schema === undefined ? '' : quotePostgresIdentifier(schema) + '.'}${quotePostgresIdentifier(name)}`;
  return `SELECT k.id,k.secret_hash,k.expires_at,k.revoked_at,
    i.id AS integration_id,i.owner_user_id,i.instance_id,i.name,i.revision,i.workspace_ids_json,i.actions_json,
    u.banned AS account_banned,u.email AS account_email,u.role AS account_role,pg_catalog.current_schema() AS schema_name,
    (SELECT oid::text FROM pg_catalog.pg_namespace WHERE nspname=pg_catalog.current_schema()) AS schema_oid,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
    pg_catalog.current_setting('search_path') AS search_path,
    k.tableoid::text AS credential_relation_oid,i.tableoid::text AS integration_relation_oid,u.tableoid::text AS user_relation_oid,
    k.tableoid=pg_catalog.to_regclass(pg_catalog.format('%I.canvas_api_keys',pg_catalog.current_schema()))::oid
      AND i.tableoid=pg_catalog.to_regclass(pg_catalog.format('%I.canvas_api_integrations',pg_catalog.current_schema()))::oid
      AND u.tableoid=pg_catalog.to_regclass(pg_catalog.format('%I.user',pg_catalog.current_schema()))::oid AS relations_match
  FROM ${table('canvas_api_keys')} k JOIN ${table('canvas_api_integrations')} i ON i.id=k.integration_id
    JOIN ${table('user')} u ON u.id=i.owner_user_id WHERE k.id=$${credentialParameter}`;
}
const lookupSql = apiKeyCredentialSnapshotSql();

function invalid(): never { throw new ApiKeyAccessError('API_KEY_INVALID', 'The API key is invalid or has expired.', 401); }
function positive(value: unknown): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9][0-9]*$/u.test(value))) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) invalid();
  return number;
}
function sameHash(actual: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/u.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function identity(row: CredentialRow | undefined, hash: string): CurrentApiKeyIdentity {
  if (!row || !sameHash(row.secret_hash, hash) || row.revoked_at !== null
    || positive(row.expires_at) <= Date.now() || row.instance_id !== getLicenseInstanceId()) invalid();
  if (row.relations_match !== true || !row.schema_name || row.schema_name.length > 63
    || !row.search_path || row.search_path.length > 4096) {
    throw new ApiKeyAccessError('API_KEY_STATE_INVALID', 'The credential storage realm is invalid.', 503);
  }
  if (![null, 0, '0', false].includes(row.account_banned as never)) {
    throw new ApiKeyAccessError('API_KEY_ACCOUNT_INACTIVE', 'The account is not active.', 403);
  }
  const grant = storedGrant(row);
  const realm = Object.freeze({ schema: row.schema_name, schemaOid: positive(row.schema_oid), databaseOid: positive(row.database_oid),
    searchPath: row.search_path, credentialRelationOid: positive(row.credential_relation_oid),
    integrationRelationOid: positive(row.integration_relation_oid), userRelationOid: positive(row.user_relation_oid) });
  return Object.freeze({ credentialId: row.id, integrationId: row.integration_id, userId: row.owner_user_id,
    instanceId: row.instance_id, integrationName: row.name, revision: positive(row.revision), expiresAt: positive(row.expires_at),
    workspaceIds: Object.freeze([...grant.workspaceIds]), actions: Object.freeze([...grant.actions]), realm });
}

/** Explicit selection: an invalid key must never fall back to a session cookie. */
export function hasApiKeyCredential(request: Request): boolean {
  return request.headers.has('x-canvas-api-key');
}

/** Entry-point authentication only. Seats, workspaces, action/tool policy and
 * transaction fences must still be checked by each real document phase. */
export async function authenticateApiKeyRequest(request: Request): Promise<ApiKeyCredential> {
  if (!request || types.isProxy(request) || !(request instanceof Request)) invalid();
  const headers = new Headers(request.headers);
  const anonymous = await publicRateLimit({ keyPrefix: 'document-api-key', limit: 300, globalLimit: 6000, windowMs: 60_000 });
  if (!anonymous.ok) throw new ApiKeyAccessError(anonymous.response.status === 429 ? 'API_KEY_RATE_LIMITED' : 'API_KEY_UNAVAILABLE',
    anonymous.response.status === 429 ? 'Too many requests.' : 'Authentication is temporarily unavailable.', anonymous.response.status,
    { retryAfter: Number(anonymous.response.headers.get('Retry-After') ?? 5) });
  if (headers.has('authorization') || getCanvasSessionCookie(headers)) {
    throw new ApiKeyAccessError('API_KEY_CREDENTIALS_CONFLICT', 'Use only one authentication method.', 401);
  }
  const parsed = parseApiKey(headers.get('x-canvas-api-key') ?? '');
  if (!parsed) invalid();
  const hash = hashApiKeySecret(parsed.secret), database = await openDb();
  let current: CurrentApiKeyIdentity;
  try {
    const now = Date.now();
    // One statement observes the credential and conditionally updates its
    // statistic. Inner document phases use the read-only lookup instead.
    const observed = await database.get(`WITH selected_credential AS MATERIALIZED (${lookupSql}),
      usage AS (UPDATE canvas_api_keys key SET last_used_at=$2 FROM selected_credential selected
        WHERE key.id=selected.id AND key.secret_hash=$3 AND key.revoked_at IS NULL AND key.expires_at>$2
          AND selected.relations_match IS TRUE AND selected.instance_id=$5
          AND COALESCE(selected.account_banned,0)=0 AND COALESCE(key.last_used_at,0)<$4
        RETURNING key.id)
      SELECT * FROM selected_credential`, [parsed.id, now, hash, now - 60_000, getLicenseInstanceId()]) as CredentialRow | undefined;
    current = identity(observed, hash);
  }
  finally { await database.close(); }
  const budget = await consumeKnownBudget([
    { key: `document-api-key:key:${current.credentialId}`, limit: 240, windowMs: 60_000 },
    { key: `document-api-key:user:${createHash('sha256').update(current.userId).digest('hex')}`, limit: 600, windowMs: 60_000 },
  ]);
  if (!budget.ok) throw new ApiKeyAccessError('API_KEY_RATE_LIMITED', 'Too many requests.', 429, { retryAfter: budget.retryAfter });
  const proof: ApiKeyCredential = Object.freeze({}) as ApiKeyCredential;
  captures.set(proof, { credentialId: current.credentialId, secretHash: hash, integrationId: current.integrationId,
    userId: current.userId, instanceId: current.instanceId, realm: current.realm });
  return proof;
}

/** Fresh credential facts on the consumer's held connection. This result is
 * data only: it does not admit a workspace or create/extend a transaction. */
export async function readCurrentApiKeyIdentityOnConnection(database: Pick<SqlConnection, 'get'>,
  credential: ApiKeyCredential): Promise<CurrentApiKeyIdentity> {
  const binding = apiKeyCredentialBinding(credential);
  return currentApiKeyIdentityFromSnapshot(credential, await database.get(lookupSql, [binding.credentialId]));
}

/** Routing/binding metadata only. No grant is retained from authentication. */
export function apiKeyCredentialBinding(credential: ApiKeyCredential): ApiKeyCredentialBinding {
  if (!credential || typeof credential !== 'object' || types.isProxy(credential)) invalid();
  const capture = captures.get(credential);
  if (!capture || capture.instanceId !== getLicenseInstanceId()) invalid();
  return Object.freeze({ credentialId: capture.credentialId, integrationId: capture.integrationId,
    userId: capture.userId, instanceId: capture.instanceId, realm: capture.realm });
}

/** Pure validation of a real query reply. The returned data is not a Principal. */
export function currentApiKeyIdentityFromSnapshot(credential: ApiKeyCredential, snapshot: unknown): CurrentApiKeyIdentity {
  apiKeyCredentialBinding(credential);
  if (snapshot != null && (typeof snapshot !== 'object' || types.isProxy(snapshot) || Object.getPrototypeOf(snapshot) !== Object.prototype)) {
    throw new ApiKeyAccessError('API_KEY_STATE_INVALID', 'Invalid credential snapshot.', 503);
  }
  const capture = captures.get(credential)!;
  const current = identity(snapshot as CredentialRow | undefined, capture.secretHash);
  if (current.integrationId !== capture.integrationId || current.userId !== capture.userId || current.instanceId !== capture.instanceId
    || Object.entries(capture.realm).some(([name, value]) => current.realm[name as keyof ApiKeyCredentialRealm] !== value)) invalid();
  return current;
}
