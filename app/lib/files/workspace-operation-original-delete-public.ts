import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';
import type { NativeFileArchiveExpected } from '../collaboration/native-file-archive-transition';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';
import type { WorkspaceContext } from '../workspaces/types';
import type { PublicShareRow } from '../public-sharing/public-file-shares';
import { readActivePublicShareAtPathOnConnection, readPublicShareOnConnection,
  revokePublicShareOnConnection } from '../public-sharing/repository';

type Namespace = Readonly<{
  workspaceId: string; workspaceType: WorkspaceContext['workspaceType']; organizationId: string | null;
  customerId: string | null; projectId: string | null; workspaceRootRelativePath: string | null; workspacePath: string;
}>;
type TargetPins = Readonly<{ documentId: string | null; lineageId: string | null; lifecycleGeneration: number | null }>;
/** Historical S1 data, not a capability. The caller must recover this value from
 * its immutable original intent, never manufacture it from today's pathname. */
export type OriginalDeletePublicShare = Readonly<{
  version: 1; id: string; namespace: Namespace; target: TargetPins; tokenHash: string;
  policyRevision: number; createdAtMs: number; stableDigest: string; immutableOriginDigest: string;
}>;
type ObservedShare = Readonly<{ id: string; status: string; policyRevision: number; revokedAtMs: number | null;
  revokedReason: string | null; stableDigest: string; immutableOriginDigest: string }>;
export type OriginalDeletePublicShareObservation = Readonly<{ kind: 'none' }>
  | Readonly<ObservedShare & { kind: 'active' | 'observed_terminal' }>;
export type OriginalDeletePublicShareResult = Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'revoked' | 'observed_terminal'; id: string; status: string; policyRevision: number;
    revokedAtMs: number | null; revokedReason: string | null; stableDigest: string; immutableOriginDigest: string }>;
type CaptureInput = Readonly<{ schema: string; workspace: WorkspaceContext; path: string; nativeExpected?: NativeFileArchiveExpected }>;
type ApplyInput = Readonly<{ schema: string; workspace: WorkspaceContext; original: OriginalDeletePublicShare | null; nowMs: number }>;
type Row = Record<string, unknown>;
type CanonicalRow = Record<keyof PublicShareRow, string | number | null>;
type Field = 'text' | 'nullableText' | 'integer' | 'time' | 'nullableTime';
// Exhaustive against PublicShareRow: added schema fields require a deliberate
// preservation/budget decision. No token/password text escapes the row digest.
const fields = {
  id: 'text', token: 'text', tokenHash: 'text', tokenPreview: 'text', shortCode: 'nullableText',
  organizationId: 'nullableText', customerId: 'nullableText', projectId: 'nullableText', workspaceId: 'nullableText',
  workspaceType: 'nullableText', workspaceRootRelativePath: 'nullableText', workspacePath: 'text',
  documentId: 'nullableText', lineageId: 'nullableText', lifecycleGeneration: 'integer', fileName: 'text',
  fileIdentity: 'text', targetRevisionPolicy: 'text', lastKnownRevision: 'nullableText', mimeType: 'text', sizeBytes: 'integer',
  status: 'text', createdByUserId: 'text', createdByAgentId: 'nullableText', sourceSessionId: 'nullableText', source: 'text',
  securityMode: 'text', reason: 'nullableText', createdAt: 'time', updatedAt: 'time', expiresAt: 'nullableTime',
  revokedAt: 'nullableTime', revokedReason: 'nullableText', passwordEnabled: 'integer', passwordHash: 'nullableText',
  lastAccessedAt: 'nullableTime', accessCount: 'integer', policyRevision: 'integer',
} as const satisfies Record<keyof PublicShareRow, Field>;
const rowKeys = (Object.keys(fields) as (keyof PublicShareRow)[]).sort();
const namespaceKeys = ['workspaceId', 'workspaceType', 'organizationId', 'customerId', 'projectId', 'workspaceRootRelativePath', 'workspacePath'] as const;
const targetKeys = ['documentId', 'lineageId', 'lifecycleGeneration'] as const;
const dynamic = new Set<keyof PublicShareRow>(['accessCount', 'lastAccessedAt', 'updatedAt']);
const terminal = new Set<keyof PublicShareRow>([...dynamic, 'status', 'policyRevision', 'revokedAt', 'revokedReason']);
const statuses = ['active', 'revoked', 'missing', 'stale', 'expired'];
const MAX_TEXT_BYTES = 4096;
const MAX_CANONICAL_BYTES = 128 * 1024;
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function invalid(): never { throw Object.assign(new Error('ORIGINAL_DELETE_PUBLIC_INVALID'), { code: 'ORIGINAL_DELETE_PUBLIC_INVALID' }); }
function changed(): never { throw Object.assign(new Error('ORIGINAL_DELETE_PUBLIC_CHANGED'), { code: 'ORIGINAL_DELETE_PUBLIC_CHANGED' }); }
function data(input: unknown, allowed: readonly string[], exact = false): Row {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype
    || exact && Reflect.ownKeys(input).length !== allowed.length) invalid();
  const result: Row = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function own(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor && (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) invalid();
  return descriptor?.value;
}
function text(input: unknown, max = MAX_TEXT_BYTES): string {
  if (typeof input !== 'string' || input.length > max || input.includes('\0')
    || Buffer.byteLength(input, 'utf8') > max || Buffer.from(input, 'utf8').toString('utf8') !== input) invalid();
  return input;
}
function id(input: unknown): string {
  const value = text(input, 256);
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
function nullableId(input: unknown): string | null { return input === null ? null : id(input); }
function integer(input: unknown, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) invalid();
  return input;
}
function digest(input: unknown): string { if (typeof input !== 'string' || !/^[a-f0-9]{64}$/u.test(input)) invalid(); return input; }
function timestamp(input: unknown): number {
  const value = integer(input);
  if (!Number.isFinite(new Date(value).getTime())) invalid();
  return value;
}
function captureWorkspace(input: unknown): Omit<Namespace, 'workspacePath'> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const workspaceType = own(input, 'workspaceType'), root = own(input, 'rootRelativePath') ?? null;
  if (typeof workspaceType !== 'string' || !['personal', 'organization', 'team', 'project'].includes(workspaceType)
    || root !== null && !isCanonicalWorkspacePath(root, true)) invalid();
  return Object.freeze({ workspaceId: id(own(input, 'workspaceId')), workspaceType: workspaceType as WorkspaceContext['workspaceType'],
    organizationId: nullableId(own(input, 'organizationId') ?? null), customerId: nullableId(own(input, 'customerId') ?? null),
    projectId: nullableId(own(input, 'projectId') ?? null), workspaceRootRelativePath: root });
}
function tableName(input: unknown): string {
  const schema = text(input, 63);
  if (!schema || /[\u0000-\u001f\u007f]/u.test(schema)) invalid();
  return `"${schema.replaceAll('"', '""')}"."public_file_shares"`;
}
function captureNamespace(input: unknown): Namespace {
  const raw = data(input, namespaceKeys, true);
  const scope = captureWorkspace({ ...raw, rootRelativePath: raw.workspaceRootRelativePath });
  if (!isCanonicalWorkspacePath(raw.workspacePath)) invalid();
  return Object.freeze({ ...scope, workspacePath: raw.workspacePath });
}
function captureTarget(input: unknown): TargetPins {
  const raw = data(input, targetKeys, true);
  if (targetKeys.every(key => raw[key] === null)) return Object.freeze({ documentId: null, lineageId: null, lifecycleGeneration: null });
  const generation = integer(raw.lifecycleGeneration, 1);
  if (generation >= Number.MAX_SAFE_INTEGER) invalid();
  return Object.freeze({ documentId: id(raw.documentId), lineageId: id(raw.lineageId), lifecycleGeneration: generation });
}
function canonicalRow(input: PublicShareRow): CanonicalRow {
  const raw = data(input, rowKeys, true), result: Partial<CanonicalRow> = {}; let bytes = 0;
  for (const key of rowKeys) {
    const value = raw[key], type = fields[key]; let captured: string | number | null;
    if (value === null && (type === 'nullableText' || type === 'nullableTime' || key === 'lifecycleGeneration')) captured = null;
    else if (type === 'time' || type === 'nullableTime') {
      let millis: number;
      try { millis = Date.prototype.getTime.call(value); } catch { return invalid(); }
      captured = timestamp(millis);
    } else if (type === 'integer') captured = integer(value);
    else captured = text(value);
    // Six is the worst JSON escaping expansion. Count before JSON.stringify.
    bytes += key.length + (typeof captured === 'string' ? Buffer.byteLength(captured) * 6 : 32) + 8;
    if (bytes > MAX_CANONICAL_BYTES) invalid();
    result[key] = captured;
  }
  const row = result as CanonicalRow;
  if (!statuses.includes(row.status as string) || !['latest', 'fixed'].includes(row.targetRevisionPolicy as string)
    || !['ui', 'agent'].includes(row.source as string) || !['strict', 'interactive'].includes(row.securityMode as string)
    || ![0, 1].includes(row.passwordEnabled as number) || (row.policyRevision as number) < 1) invalid();
  id(row.id); id(row.createdByUserId); digest(row.tokenHash);
  captureNamespace(Object.fromEntries(namespaceKeys.map(key => [key, row[key]])));
  captureTarget(Object.fromEntries(targetKeys.map(key => [key, row[key]])));
  return Object.freeze(row);
}
function proof(row: CanonicalRow, immutableOrigin = false): string {
  const excluded = immutableOrigin ? terminal : dynamic;
  const values = Object.fromEntries(rowKeys.filter(key => !excluded.has(key)).map(key => [key, row[key]]));
  return hash(`canvas.workspace.original-delete.public.${immutableOrigin ? 'origin' : 'stable'}.v1\0${JSON.stringify(values)}`);
}
function namespaceOf(row: CanonicalRow): Namespace { return captureNamespace(Object.fromEntries(namespaceKeys.map(key => [key, row[key]]))); }
function targetOf(row: CanonicalRow): TargetPins { return captureTarget(Object.fromEntries(targetKeys.map(key => [key, row[key]]))); }
function sameNamespace(scope: Omit<Namespace, 'workspacePath'>, namespace: Namespace): boolean {
  return namespaceKeys.every(key => key === 'workspacePath'
    || (key === 'customerId' || key === 'projectId') && namespace[key] === null
    || scope[key] === namespace[key]);
}
function samePins(a: TargetPins, b: TargetPins): boolean { return targetKeys.every(key => a[key] === b[key]); }
function captureOriginal(input: unknown): OriginalDeletePublicShare {
  const raw = data(input, ['version', 'id', 'namespace', 'target', 'tokenHash', 'policyRevision', 'createdAtMs', 'stableDigest', 'immutableOriginDigest'], true);
  if (raw.version !== 1) invalid();
  const policyRevision = integer(raw.policyRevision, 1);
  if (policyRevision >= Number.MAX_SAFE_INTEGER) invalid();
  return Object.freeze({ version: 1, id: id(raw.id), namespace: captureNamespace(raw.namespace), target: captureTarget(raw.target),
    tokenHash: digest(raw.tokenHash), policyRevision, createdAtMs: timestamp(raw.createdAtMs),
    stableDigest: digest(raw.stableDigest), immutableOriginDigest: digest(raw.immutableOriginDigest) });
}
function matchesOriginal(row: CanonicalRow, original: OriginalDeletePublicShare): boolean {
  return row.id === original.id && row.tokenHash === original.tokenHash && row.createdAt === original.createdAtMs
    && namespaceKeys.every(key => row[key] === original.namespace[key]) && samePins(targetOf(row), original.target);
}
function sameCompleteRow(a: CanonicalRow, b: CanonicalRow): boolean { return rowKeys.every(key => a[key] === b[key]); }
function result<K extends 'active' | 'revoked' | 'observed_terminal'>(kind: K, row: CanonicalRow): Readonly<ObservedShare & { kind: K }> {
  return Object.freeze({ kind, id: row.id as string, status: row.status as string, policyRevision: row.policyRevision as number,
    revokedAtMs: row.revokedAt as number | null, revokedReason: row.revokedReason as string | null,
    stableDigest: proof(row), immutableOriginDigest: proof(row, true) });
}

/** Single initial path selection under the caller's genuine Owner/held lease.
 * Borrowed actual B only: no pool, TX, rights, native/physical rebinding or grant.
 * All-null legacy document pins remain null, including for a native D1 target. */
export async function captureOriginalDeletePublicShareOnConnection(database: SqlConnection,
  input: CaptureInput): Promise<OriginalDeletePublicShare | null> {
  const selected = data(input, ['schema', 'workspace', 'path', 'nativeExpected']);
  const table = tableName(selected.schema), scope = captureWorkspace(selected.workspace), selectedPath = selected.path;
  if (!isCanonicalWorkspacePath(selectedPath)) invalid();
  let native: TargetPins | undefined;
  if (selected.nativeExpected !== undefined) {
    const expected = selected.nativeExpected;
    if (!expected || typeof expected !== 'object' || Object.getPrototypeOf(expected) !== Object.prototype
      || own(expected, 'workspaceId') !== scope.workspaceId || own(expected, 'organizationId') !== scope.organizationId
      || own(expected, 'path') !== selectedPath) invalid();
    native = captureTarget({ documentId: own(expected, 'documentId'), lineageId: own(expected, 'lineageId'),
      lifecycleGeneration: own(expected, 'lifecycleGeneration') });
    if (native.documentId === null) invalid();
  }
  const row = await readActivePublicShareAtPathOnConnection(database, { table, workspaceId: scope.workspaceId, path: selectedPath, forUpdate: true });
  if (!row) return null;
  const captured = canonicalRow(row), namespace = namespaceOf(captured), target = targetOf(captured);
  if (captured.status !== 'active' || namespace.workspacePath !== selectedPath || !sameNamespace(scope, namespace)
    || captured.revokedAt !== null || captured.revokedReason !== null || captured.policyRevision === Number.MAX_SAFE_INTEGER
    || target.documentId !== null && (!native || !samePins(target, native))) changed();
  return Object.freeze({ version: 1, id: captured.id as string, namespace, target, tokenHash: captured.tokenHash as string,
    policyRevision: captured.policyRevision as number, createdAtMs: captured.createdAt as number,
    stableDigest: proof(captured), immutableOriginDigest: proof(captured, true) });
}

type BoundOriginal = Readonly<{ kind: 'none' }> | Readonly<{ kind: 'active' | 'observed_terminal'; table: string;
  original: OriginalDeletePublicShare; now: number; row: PublicShareRow; canonical: CanonicalRow;
  selection: Readonly<{ table: string; workspaceId: string; id: string }> }>;

async function lockOriginal(database: SqlConnection, input: ApplyInput): Promise<BoundOriginal> {
  const selected = data(input, ['schema', 'workspace', 'original', 'nowMs'], true);
  const table = tableName(selected.schema), scope = captureWorkspace(selected.workspace), now = timestamp(selected.nowMs);
  const original = selected.original === null ? null : captureOriginal(selected.original);
  if (!original) return Object.freeze({ kind: 'none' });
  if (!sameNamespace(scope, original.namespace) || now < original.createdAtMs) invalid();
  const selection = Object.freeze({ table, workspaceId: scope.workspaceId, id: original.id });
  const locked = await readPublicShareOnConnection(database, { ...selection, forUpdate: true });
  if (!locked) changed();
  const before = canonicalRow(locked);
  if (!matchesOriginal(before, original)) changed();
  if (before.status !== 'active') {
    // Reconstruct the sole allowed active before-image as a consistency check
    // between BOTH historical digests. No terminal field is written/restored.
    const activeOrigin = { ...before, status: 'active', policyRevision: original.policyRevision, revokedAt: null, revokedReason: null };
    if (before.policyRevision !== original.policyRevision + 1 || proof(before, true) !== original.immutableOriginDigest
      || proof(activeOrigin) !== original.stableDigest) changed();
    return Object.freeze({ kind: 'observed_terminal', table, original, now, row: locked, canonical: before, selection });
  }
  if (before.policyRevision !== original.policyRevision || proof(before) !== original.stableDigest
    || proof(before, true) !== original.immutableOriginDigest) changed();
  return Object.freeze({ kind: 'active', table, original, now, row: locked, canonical: before, selection });
}

/** PRE-FS preflight of the immutable S1 capture. Locks only that original ID on
 * borrowed B. No write, path reselection, new share adoption or authority grant.
 * The caller repeats this validation in its later archive/public transaction. */
export async function assertOriginalDeletePublicShareOnConnection(database: SqlConnection,
  input: ApplyInput): Promise<OriginalDeletePublicShareObservation> {
  const current = await lockOriginal(database, input);
  return current.kind === 'none' ? Object.freeze({ kind: 'none' }) : result(current.kind, current.canonical);
}

/** Original ID only, never a fresh path query. The genuine Owner/current canDelete,
 * B/backend/realm/lease, immutable intent, final auth, rollback and COMMIT belong
 * to the caller. Any rejected postcondition requires rollback of this whole TX.
 * Already-terminal S1 preserves its reason/revision and never selects/revokes S2. */
export async function applyOriginalDeletePublicShareOnConnection(database: SqlConnection,
  input: ApplyInput): Promise<OriginalDeletePublicShareResult> {
  const current = await lockOriginal(database, input);
  if (current.kind === 'none') return Object.freeze({ kind: 'none' });
  if (current.kind === 'observed_terminal') return result('observed_terminal', current.canonical);
  const { table, row: locked, canonical: before, now, original, selection } = current;
  const updated = await revokePublicShareOnConnection(database, { table, expected: locked, nowMs: now, reason: 'target_deleted' });
  const expected = Object.freeze({ ...before, status: 'revoked', policyRevision: original.policyRevision + 1,
    revokedAt: now, revokedReason: 'target_deleted', updatedAt: now });
  if (!updated || !sameCompleteRow(expected, canonicalRow(updated))) changed();
  const reread = await readPublicShareOnConnection(database, selection);
  if (!reread) changed();
  const after = canonicalRow(reread);
  if (!sameCompleteRow(expected, after)) changed();
  return result('revoked', after);
}
