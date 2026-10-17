import 'server-only';

import { types } from 'node:util';
import type { WorkspaceDocumentCatalogueEntry } from '../collaboration/workspace-document-catalogue';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceNativeSourceBinding } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_NODES = 300_000;
const requiredKeys = ['id', 'lineage_id', 'path', 'workspace_id', 'organization_id', 'status', 'state_version',
  'has_persisted_state', 'has_state_history', 'lifecycle_generation', 'authority', 'state_status', 'state_path',
  'state_workspace_id', 'state_organization_id'] as const;
const optionalKey = 'yjs_state_lifecycle';
const allowedKeys = new Set<string>([...requiredKeys, optionalKey]);
type Primitive = string | number | boolean | null;
type Reject = (reason: 'invalid' | 'too-large') => never;
type Budget = { bytes: number; nodes: number };

function charge(budget: Budget, bytes: number, reject: Reject): void {
  budget.bytes -= bytes;
  if (budget.bytes < 0) reject('too-large');
}

/** Exact JSON UTF-8 size, including escapes, without allocating a JSON string. */
function stringBytes(value: string, reject: Reject): number {
  let bytes = Buffer.byteLength(value, 'utf8') + 2;
  if (bytes > MAX_BYTES) reject('too-large');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject('invalid');
    } else if (code >= 0xdc00 && code <= 0xdfff) reject('invalid');
    else if (code === 0x22 || code === 0x5c) bytes++;
    else if (code <= 0x1f) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
    if (bytes > MAX_BYTES) reject('too-large');
  }
  return bytes;
}

function primitive(value: unknown, budget: Budget, reject: Reject): Primitive {
  if (--budget.nodes < 0) return reject('too-large');
  if (value === null) { charge(budget, 4, reject); return null; }
  if (typeof value === 'boolean') { charge(budget, value ? 4 : 5, reject); return value; }
  if (typeof value === 'string') { charge(budget, stringBytes(value, reject), reject); return value; }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) {
    charge(budget, String(value).length, reject); return value;
  }
  return reject('invalid');
}

function identifier(value: Primitive): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function nullableIdentifier(value: Primitive): boolean {
  return value === null || identifier(value);
}

function captureEntry(input: unknown, scope: WorkspaceOperationJobScope, budget: Budget,
  reject: Reject): Readonly<WorkspaceDocumentCatalogueEntry> {
  if (--budget.nodes < 0) return reject('too-large');
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) return reject('invalid');
  const keys = Reflect.ownKeys(input);
  if (keys.length < requiredKeys.length || keys.length > allowedKeys.size
    || requiredKeys.some(key => !Object.hasOwn(input, key))) return reject('invalid');
  charge(budget, 2 + Math.max(keys.length - 1, 0), reject);
  const row: Record<string, Primitive> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) return reject('invalid');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject('invalid');
    charge(budget, stringBytes(key, reject) + 1, reject);
    row[key] = primitive(descriptor.value, budget, reject);
  }
  if (!identifier(row.id) || !nullableIdentifier(row.lineage_id)
    || !isCanonicalAdmissionPath(row.path) || row.workspace_id !== scope.workspaceId
    || !identifier(row.workspace_id) || row.organization_id !== scope.organizationId
    || !nullableIdentifier(row.organization_id) || row.status !== 'active'
    || typeof row.state_version !== 'number'
    || typeof row.has_persisted_state !== 'boolean' || typeof row.has_state_history !== 'boolean'
    || row.lifecycle_generation !== null && (typeof row.lifecycle_generation !== 'number' || row.lifecycle_generation < 1)
    || row.state_status !== null && !identifier(row.state_status)
    || row.state_path !== null && !isCanonicalAdmissionPath(row.state_path)
    || !nullableIdentifier(row.state_workspace_id) || !nullableIdentifier(row.state_organization_id)
    || Object.hasOwn(row, optionalKey) && row.yjs_state_lifecycle !== null
      && !['never_initialized', 'initialized', 'legacy_unknown'].includes(row.yjs_state_lifecycle as string)) {
    return reject('invalid');
  }
  if (row.has_persisted_state && (row.state_status !== 'active' || row.state_path !== row.path
    || row.state_workspace_id !== scope.workspaceId || row.state_organization_id !== scope.organizationId
    || row.lifecycle_generation === null)) return reject('invalid');
  const authority = row.has_persisted_state ? 'initialized'
    : row.yjs_state_lifecycle === 'never_initialized' && row.state_version === 0 && !row.has_state_history
      ? 'pristine' : 'missing-state';
  if (row.authority !== authority) return reject('invalid');
  return Object.freeze(row) as Readonly<WorkspaceDocumentCatalogueEntry>;
}

/** Private historical data capture only. Bindings and scope must already have
 * passed the source-evidence validator; this witness grants no current authority.
 * Its independent budget measures the catalogue array's JSON bytes and value
 * nodes, excluding scope, bindings and the returned wrapper. */
export function captureWorkspaceOperationNativeCatalogueWitness(input: unknown, scope: WorkspaceOperationJobScope,
  catalogueProof: string, nativeBindings: readonly WorkspaceNativeSourceBinding[],
  reject: (reason: 'invalid' | 'too-large') => never): Readonly<{
    entries: readonly Readonly<WorkspaceDocumentCatalogueEntry>[];
    semanticCatalogueProof: string;
  }> {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return reject('invalid');
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0) return reject('invalid');
  if (length > MAX_ENTRIES) return reject('too-large');
  if (Reflect.ownKeys(input).length !== length + 1) return reject('invalid');
  const budget: Budget = { bytes: MAX_BYTES, nodes: MAX_NODES - 1 };
  charge(budget, 2 + Math.max(length - 1, 0), reject);
  const entries: Readonly<WorkspaceDocumentCatalogueEntry>[] = [];
  const byId = new Map<string, Readonly<WorkspaceDocumentCatalogueEntry>>(), paths = new Set<string>();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject('invalid');
    const entry = captureEntry(descriptor.value, scope, budget, reject);
    if (byId.has(entry.id) || paths.has(entry.path)) return reject('invalid');
    byId.set(entry.id, entry); paths.add(entry.path); entries.push(entry);
  }
  if (typeof catalogueProof !== 'string' || !/^[a-f0-9]{64}$/u.test(catalogueProof)
    || nativeLinkJsonProof(entries) !== catalogueProof) return reject('invalid');
  const normalizedIds = new Set<string>();
  for (const binding of nativeBindings) {
    const { expected, registry, lineage } = binding, entry = byId.get(expected.documentId);
    if (!entry || normalizedIds.has(entry.id) || entry.authority !== 'initialized' || !entry.has_persisted_state
      || entry.id !== registry.documentId || entry.lineage_id !== expected.lineageId
      || entry.lineage_id !== registry.lineageId || entry.lineage_id !== lineage.lineageId
      || entry.path !== expected.path || entry.path !== registry.path || entry.path !== lineage.path
      || entry.workspace_id !== expected.workspaceId || entry.workspace_id !== registry.workspaceId
      || entry.workspace_id !== lineage.workspaceId || entry.organization_id !== expected.organizationId
      || entry.organization_id !== registry.organizationId || entry.organization_id !== lineage.organizationId
      || registry.workspaceType !== scope.workspaceType || lineage.workspaceType !== scope.workspaceType
      || entry.lifecycle_generation !== expected.lifecycleGeneration || entry.state_version !== expected.registryStateVersion
      || entry.state_version !== registry.stateVersion || entry.state_status !== 'active'
      || entry.state_path !== expected.path || entry.state_workspace_id !== expected.workspaceId
      || entry.state_organization_id !== expected.organizationId || entry.yjs_state_lifecycle !== 'initialized'
      || registry.stateLifecycle !== 'initialized' || registry.provider !== 'yjs' || registry.status !== 'active'
      || lineage.status !== 'active' || lineage.archivedAt !== null) return reject('invalid');
    normalizedIds.add(entry.id);
  }
  const semanticCatalogueProof = nativeLinkJsonProof(entries.map(entry => normalizedIds.has(entry.id)
    ? { ...entry, state_version: 0 } : entry));
  return Object.freeze({ entries: Object.freeze(entries), semanticCatalogueProof });
}
