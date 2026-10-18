import 'server-only';

import { isDeepStrictEqual as equal, types } from 'node:util';
import type { SqlConnection } from '../db';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { decodePreparedWorkspacePathCopyOriginal } from '../filesystem/prepared-workspace-path-copy-contract';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationNativeCopyPlan, type WorkspaceOperationNativeCopyPlan } from './workspace-operation-native-copy-plan';
import { decodeWorkspaceOperationManagedCopyPlan, type WorkspaceOperationManagedCopyPlan } from './workspace-operation-managed-copy-plan';
import type { WorkspaceOperationNativeCopyPhysical, WorkspaceOperationNativeCopyStage } from './workspace-operation-native-copy-stage';

export type NativeCopyMetadataRow = Readonly<{ path: string; title: string | null; createdAt: number; updatedAt: number }>;
export type NativeCopyMetadataSnapshot = Readonly<{
  version: 1; kind: 'shared-title-copy'; planId: string; sourceWorkspaceId: string; destinationWorkspaceId: string;
  mappingsProof: string; vacancyScopes: readonly string[]; exactVacancyPaths: readonly string[]; sourceRows: readonly NativeCopyMetadataRow[];
}>;
export type NativeCopyMetadataWitness = Readonly<{
  version: 1; kind: 'shared-title-copy'; snapshotProof: string; sourceRowCount: number; copiedTitleCount: number;
}>;
export type NativeCopyMetadataCompletionWitness = NativeCopyMetadataWitness & Readonly<{ copyCreatedAt: number; afterIntentProof: string }>;
export type NativeCopyMetadataStage = Omit<WorkspaceOperationNativeCopyStage, 'version'> & Readonly<{
  version: 3; metadata: NativeCopyMetadataSnapshot; coreV2StageDigest: string;
}>;
type MetadataPlan = WorkspaceOperationNativeCopyPlan | WorkspaceOperationManagedCopyPlan;
type Input = Readonly<{ plan: MetadataPlan; physical: readonly WorkspaceOperationNativeCopyPhysical[] }>;
type Row = Record<string, unknown>;
const MAX_ROWS = 2048;
const MAX_BYTES = 1024 * 1024;
const MAX_CLOCK = Number.MAX_SAFE_INTEGER - 1;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const order = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const clock = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && !Object.is(value, -0) && value >= 0 && value <= MAX_CLOCK;

export class NativeCopyMetadataError extends Error {
  readonly status = 409;
  constructor(readonly code: 'NATIVE_COPY_METADATA_INVALID' | 'NATIVE_COPY_METADATA_TOO_LARGE' | 'NATIVE_COPY_METADATA_CHANGED') {
    super(code); this.name = 'NativeCopyMetadataError';
  }
}
function fail(code: NativeCopyMetadataError['code'] = 'NATIVE_COPY_METADATA_INVALID'): never { throw new NativeCopyMetadataError(code); }
function object(value: unknown, keys: readonly string[]): Row {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => { const item = Object.getOwnPropertyDescriptor(value, key);
      return !item?.enumerable || !Object.hasOwn(item, 'value'); })) fail();
  return value as Row;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail(value instanceof Array && value.length > maximum
    ? 'NATIVE_COPY_METADATA_TOO_LARGE' : 'NATIVE_COPY_METADATA_INVALID');
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) fail(); return item.value;
  });
}
function detached(value: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(value, reason => fail(reason === 'too-large'
    ? 'NATIVE_COPY_METADATA_TOO_LARGE' : 'NATIVE_COPY_METADATA_INVALID'));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalAdmissionPath(value) || Buffer.byteLength(value) > 4096
    || Buffer.from(value).toString('utf8') !== value || value.split('/').length > 33) fail();
  return value;
}
function title(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 160 || Buffer.byteLength(value) > 640
    || Buffer.from(value).toString('utf8') !== value || !value || value !== value.trim().replace(/\s+/gu, ' ')
    || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function context(input: Input) {
  const fields = object(input, ['plan', 'physical']), supplied = fields.plan;
  const managed = supplied !== null && typeof supplied === 'object' && !types.isProxy(supplied)
    && Object.getPrototypeOf(supplied) === Object.prototype
    && Object.getOwnPropertyDescriptor(supplied, 'version')?.value === 3;
  const plan = managed ? decodeWorkspaceOperationManagedCopyPlan(supplied) : decodeWorkspaceOperationNativeCopyPlan(supplied);
  const physical = list(fields.physical, 1000).map((value, index) => {
    const item = object(value, ['selectionIndex', 'original']), selected = plan.selections[index];
    const original = decodePreparedWorkspacePathCopyOriginal(item.original);
    if (!selected || item.selectionIndex !== index || original.sourcePath !== selected.sourcePath
      || original.destinationPath !== selected.destinationPath || !equal(original.sourceWorkspace, plan.sourceScope)
      || !equal(original.destinationWorkspace, plan.destinationScope)) fail();
    return { selectionIndex: index, original };
  });
  if (physical.length !== plan.selections.length) fail();
  const mappings = plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: path(mapping.source.path), destinationPath: path(mapping.destinationPath) }));
  const scopes = [...new Set([...plan.selections.map(selection => path(selection.destinationPath)),
    ...physical.flatMap(({ original }) => original.staging && original.filesystem.destinationParents.missingPrefix !== null
      ? [path(original.filesystem.destinationParents.missingPrefix)] : [])])].sort(order);
  const vacancyScopes = scopes.filter((scope, index) => !scopes.some((other, otherIndex) => otherIndex !== index && scope.startsWith(other + '/')));
  const originalPaths = new Set(plan.destinationEvidence.stage.namespace.map(entry => entry.path)), absent = new Set<string>();
  for (const mapping of mappings) {
    const parts = mapping.destinationPath.split('/').slice(0, -1);
    for (let length = 1; length <= parts.length; length++) {
      const parent = parts.slice(0, length).join('/');
      if (!originalPaths.has(parent) && !vacancyScopes.some(scope => parent === scope || parent.startsWith(scope + '/'))) absent.add(parent);
    }
  }
  return { plan, physical, mappings, sourcePaths: mappings.map(mapping => mapping.sourcePath), vacancyScopes,
    exactVacancyPaths: [...absent].sort(order),
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: plan.planId, mappings }) };
}
/** Original title data only. C1, current actor, SQL, filesystem and COMMIT
 * authority remain with the fixed Copy owner. */
export function decodeNativeCopyMetadataSnapshot(input: unknown, supplied: Input): NativeCopyMetadataSnapshot {
  const bound = context(supplied), value = object(detached(input), ['version', 'kind', 'planId', 'sourceWorkspaceId',
    'destinationWorkspaceId', 'mappingsProof', 'vacancyScopes', 'exactVacancyPaths', 'sourceRows']);
  if (value.version !== 1 || value.kind !== 'shared-title-copy' || value.planId !== bound.plan.planId
    || value.sourceWorkspaceId !== bound.plan.sourceScope.workspaceId || value.destinationWorkspaceId !== bound.plan.destinationScope.workspaceId
    || value.mappingsProof !== bound.mappingsProof || !equal(value.vacancyScopes, bound.vacancyScopes)
    || !equal(value.exactVacancyPaths, bound.exactVacancyPaths)) fail();
  const allowed = new Set(bound.sourcePaths);
  const sourceRows = list(value.sourceRows, MAX_ROWS).map((entry, index, rows) => {
    const row = object(entry, ['path', 'title', 'createdAt', 'updatedAt']), pathname = path(row.path);
    if (!allowed.has(pathname) || !clock(row.createdAt) || !clock(row.updatedAt)
      || index > 0 && order(String((rows[index - 1] as Row).path), pathname) >= 0) fail();
    return { path: pathname, title: title(row.title), createdAt: row.createdAt, updatedAt: row.updatedAt };
  });
  const result = { version: 1 as const, kind: 'shared-title-copy' as const, planId: bound.plan.planId,
    sourceWorkspaceId: bound.plan.sourceScope.workspaceId, destinationWorkspaceId: bound.plan.destinationScope.workspaceId,
    mappingsProof: bound.mappingsProof, vacancyScopes: bound.vacancyScopes, exactVacancyPaths: bound.exactVacancyPaths, sourceRows };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail('NATIVE_COPY_METADATA_TOO_LARGE');
  const targets = new Map(bound.mappings.map(mapping => [mapping.sourcePath, mapping.destinationPath]));
  const maximumAfter = sourceRows.flatMap(row => row.title === null ? [] : [{ path: targets.get(row.path)!, title: row.title,
    createdAt: MAX_CLOCK, updatedAt: MAX_CLOCK }]);
  // jsonb::text adds seven spaces per four-field object and one per array
  // separator. Reserve eight per row before any target publication can occur.
  if (Buffer.byteLength(JSON.stringify(maximumAfter)) + 8 * maximumAfter.length > MAX_BYTES) fail('NATIVE_COPY_METADATA_TOO_LARGE');
  return freeze(result);
}
function checkedSnapshot(input: NativeCopyMetadataSnapshot): NativeCopyMetadataSnapshot {
  const value = object(detached(input), ['version', 'kind', 'planId', 'sourceWorkspaceId', 'destinationWorkspaceId', 'mappingsProof', 'vacancyScopes', 'exactVacancyPaths', 'sourceRows']);
  if (value.version !== 1 || value.kind !== 'shared-title-copy' || !hash(value.planId) || !hash(value.mappingsProof)
    || ![value.sourceWorkspaceId, value.destinationWorkspaceId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256
      && Buffer.from(id).toString('utf8') === id && !/[\u0000-\u001f\u007f]/u.test(id))) fail();
  const scopes = list(value.vacancyScopes, 2000).map(path);
  if (!scopes.length || scopes.some((entry, index) => index > 0 && order(scopes[index - 1], entry) >= 0
    || scopes.some(other => entry.startsWith(other + '/')))) fail();
  const exactVacancyPaths = list(value.exactVacancyPaths, 32_000).map(path);
  if (exactVacancyPaths.some((entry, index) => index > 0 && order(exactVacancyPaths[index - 1], entry) >= 0
    || scopes.some(scope => entry === scope || entry.startsWith(scope + '/')))) fail();
  const rows = list(value.sourceRows, MAX_ROWS).map(entry => {
    const row = object(entry, ['path', 'title', 'createdAt', 'updatedAt']);
    if (!clock(row.createdAt) || !clock(row.updatedAt)) fail();
    return { path: path(row.path), title: title(row.title), createdAt: row.createdAt, updatedAt: row.updatedAt };
  });
  if (rows.some((row, index) => index > 0 && order(rows[index - 1].path, row.path) >= 0)) fail();
  const result = { version: 1 as const, kind: 'shared-title-copy' as const, planId: value.planId as string,
    sourceWorkspaceId: value.sourceWorkspaceId as string, destinationWorkspaceId: value.destinationWorkspaceId as string,
    mappingsProof: value.mappingsProof as string, vacancyScopes: scopes, exactVacancyPaths, sourceRows: rows };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) fail('NATIVE_COPY_METADATA_TOO_LARGE');
  return freeze(result);
}
export function nativeCopyMetadataWitness(input: NativeCopyMetadataSnapshot): NativeCopyMetadataWitness {
  const snapshot = checkedSnapshot(input);
  return freeze({ version: 1, kind: 'shared-title-copy', snapshotProof: proof(snapshot), sourceRowCount: snapshot.sourceRows.length,
    copiedTitleCount: snapshot.sourceRows.filter(row => row.title !== null).length });
}
function witness(input: unknown): NativeCopyMetadataWitness {
  const value = object(detached(input), ['version', 'kind', 'snapshotProof', 'sourceRowCount', 'copiedTitleCount']);
  if (value.version !== 1 || value.kind !== 'shared-title-copy' || !hash(value.snapshotProof)
    || !clock(value.sourceRowCount) || value.sourceRowCount > MAX_ROWS || !clock(value.copiedTitleCount)
    || value.copiedTitleCount > value.sourceRowCount) fail();
  return freeze(value as NativeCopyMetadataWitness);
}
export function nativeCopyMetadataCompositeDigest(coreV2StageDigest: string, input: NativeCopyMetadataWitness): string {
  if (!hash(coreV2StageDigest)) fail();
  return proof({ version: 3, kind: 'native-copy-stage', coreV2StageDigest, metadataWitness: witness(input) });
}
export function nativeCopyMetadataCompletionWitness(snapshot: NativeCopyMetadataSnapshot, copyCreatedAt: number): NativeCopyMetadataCompletionWitness {
  if (!clock(copyCreatedAt) || copyCreatedAt === 0) fail();
  const original = nativeCopyMetadataWitness(snapshot);
  return freeze({ ...original, copyCreatedAt, afterIntentProof: proof({ version: 1, kind: 'native-copy-title-after', metadataWitness: original, copyCreatedAt }) });
}
export function decodeNativeCopyMetadataCompletionWitness(input: unknown): NativeCopyMetadataCompletionWitness {
  const value = object(detached(input), ['version', 'kind', 'snapshotProof', 'sourceRowCount', 'copiedTitleCount', 'copyCreatedAt', 'afterIntentProof']);
  const original = witness({ version: value.version, kind: value.kind, snapshotProof: value.snapshotProof,
    sourceRowCount: value.sourceRowCount, copiedTitleCount: value.copiedTitleCount });
  if (!clock(value.copyCreatedAt) || value.copyCreatedAt === 0 || value.afterIntentProof !== proof({ version: 1,
    kind: 'native-copy-title-after', metadataWitness: original, copyCreatedAt: value.copyCreatedAt })) fail();
  return freeze(value as NativeCopyMetadataCompletionWitness);
}

type Storage = Readonly<{ schema: string; proof: string }>;
async function storage(database: SqlConnection): Promise<Storage> {
  const rows = await database.all(`SELECT n.nspname AS schema,c.relname,c.oid::text AS oid,n.oid::text AS namespace,
    c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    pg_catalog.to_regclass(c.relname)::oid::text AS resolved,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid::text,a.attnotnull) ORDER BY a.attname COLLATE "C")
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=pg_catalog.current_schema() AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
  [['workspace_file_metadata', 'workspace_file_user_states']]) as Row[];
  const expected: Record<string, Array<[string, string, boolean]>> = {
    workspace_file_metadata: [['created_at', '20', true], ['path', '25', true], ['title', '25', false], ['updated_at', '20', true], ['workspace_id', '25', true]],
    workspace_file_user_states: [['created_at', '20', true], ['is_favorite', '20', true], ['path', '25', true], ['pinned_at', '20', false],
      ['updated_at', '20', true], ['user_id', '25', true], ['workspace_id', '25', true]],
  };
  if (rows.length !== 2 || rows.some(row => typeof row.schema !== 'string' || !row.schema || row.schema.length > 63
    || !/^[1-9][0-9]*$/u.test(String(row.oid)) || row.resolved !== row.oid || row.relkind !== 'r'
    || row.relpersistence !== 'p' || row.relrowsecurity !== false || row.relforcerowsecurity !== false
    || !equal(row.columns, expected[String(row.relname)]))) fail('NATIVE_COPY_METADATA_CHANGED');
  return { schema: rows[0].schema as string, proof: proof(rows) };
}
type ReadContext = Readonly<{ plan: MetadataPlan; sourcePaths: readonly string[];
  vacancyScopes: readonly string[]; exactVacancyPaths: readonly string[]; mappingsProof: string }>;
async function sourceRows(database: SqlConnection, bound: ReadContext, pin: Storage): Promise<NativeCopyMetadataRow[]> {
  // Count, byte and scalar checks share this statement's snapshot with payload
  // output. SQL char_length is a coarse codepoint bound; the decoder enforces
  // the existing 160 UTF-16-unit limit as well (including astral characters).
  const headerBytes = Buffer.byteLength(JSON.stringify({ version: 1, kind: 'shared-title-copy', planId: bound.plan.planId,
    sourceWorkspaceId: bound.plan.sourceScope.workspaceId, destinationWorkspaceId: bound.plan.destinationScope.workspaceId,
    mappingsProof: bound.mappingsProof, vacancyScopes: bound.vacancyScopes, exactVacancyPaths: bound.exactVacancyPaths, sourceRows: [] }));
  if (headerBytes > MAX_BYTES) fail('NATIVE_COPY_METADATA_TOO_LARGE');
  const row = await database.get(`WITH original AS MATERIALIZED (
      SELECT path,title,created_at,updated_at FROM ${quote(pin.schema)}.workspace_file_metadata
      WHERE workspace_id=$1 AND path=ANY($2::text[]) ORDER BY path COLLATE "C" LIMIT 2049
    ), bounds AS (
      SELECT count(*)::integer AS count,
        coalesce(bool_and(octet_length(path)<=4096 AND (title IS NULL OR octet_length(title)<=640 AND char_length(title)<=160)
          AND created_at BETWEEN 0 AND 9007199254740990 AND updated_at BETWEEN 0 AND 9007199254740990),true) AS valid FROM original
    ), payload AS (
      SELECT CASE WHEN count<=2048 AND valid THEN (SELECT coalesce(sum(octet_length(jsonb_build_object('path',path,'title',title,
        'createdAt',created_at,'updatedAt',updated_at)::text)),0)+greatest(count-1,0)*2 FROM original) END AS bytes FROM bounds
    ) SELECT count,bytes,valid,CASE WHEN count<=2048 AND bytes<=$3 AND valid THEN
      (SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'title',title,'createdAt',created_at,'updatedAt',updated_at)
        ORDER BY path COLLATE "C"),'[]'::jsonb) FROM original) END AS rows FROM bounds CROSS JOIN payload`,
  [bound.plan.sourceScope.workspaceId, bound.sourcePaths, MAX_BYTES - headerBytes]) as Row | undefined;
  if (!row || row.valid !== true) fail('NATIVE_COPY_METADATA_INVALID');
  if (!clock(row.count) || row.count > MAX_ROWS || row.bytes === null || !clock(Number(row.bytes))
    || Number(row.bytes) > MAX_BYTES - headerBytes) fail('NATIVE_COPY_METADATA_TOO_LARGE');
  return list(row.rows, MAX_ROWS).map(entry => {
    const item = object(entry, ['path', 'title', 'createdAt', 'updatedAt']);
    if (!clock(item.createdAt) || !clock(item.updatedAt)) fail();
    return { path: path(item.path), title: title(item.title), createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
}
async function vacancy(database: SqlConnection, workspaceId: string, scopes: readonly string[], exactPaths: readonly string[], pin: Storage): Promise<void> {
  const row = await database.get(`SELECT EXISTS(SELECT 1 FROM ${quote(pin.schema)}.workspace_file_metadata m
      WHERE m.workspace_id=$1 AND (m.path=ANY($3::text[]) OR EXISTS(SELECT 1 FROM unnest($2::text[]) scope(path)
        WHERE m.path=scope.path OR left(m.path,length(scope.path)+1)=scope.path||'/')))
    OR EXISTS(SELECT 1 FROM ${quote(pin.schema)}.workspace_file_user_states u
      WHERE u.workspace_id=$1 AND (u.path=ANY($3::text[]) OR EXISTS(SELECT 1 FROM unnest($2::text[]) scope(path)
        WHERE u.path=scope.path OR left(u.path,length(scope.path)+1)=scope.path||'/'))) AS occupied`, [workspaceId, scopes, exactPaths]) as Row | undefined;
  if (!row || row.occupied !== false) fail('NATIVE_COPY_METADATA_CHANGED');
}
/** Mechanical bounded observation; this opens no checkout/TX and grants no
 * current principal, lifecycle, resume or mutation authority. */
export async function captureNativeCopyMetadataSnapshotOnConnection(database: SqlConnection, input: Input): Promise<NativeCopyMetadataSnapshot> {
  const bound = context(input), pin = await storage(database), rows = await sourceRows(database, bound, pin);
  await vacancy(database, bound.plan.destinationScope.workspaceId, bound.vacancyScopes, bound.exactVacancyPaths, pin);
  if (!equal(await storage(database), pin)) fail('NATIVE_COPY_METADATA_CHANGED');
  return decodeNativeCopyMetadataSnapshot({ version: 1, kind: 'shared-title-copy', planId: bound.plan.planId,
    sourceWorkspaceId: bound.plan.sourceScope.workspaceId, destinationWorkspaceId: bound.plan.destinationScope.workspaceId,
    mappingsProof: bound.mappingsProof, vacancyScopes: bound.vacancyScopes, exactVacancyPaths: bound.exactVacancyPaths,
    sourceRows: rows }, { plan: bound.plan, physical: bound.physical });
}
function capturedStage(stage: WorkspaceOperationNativeCopyStage): NativeCopyMetadataStage {
  object(stage, ['version', 'kind', 'identity', 'request', 'origin', 'plan', 'physical', 'nativeRecords', 'payloadSha256', 'metadata', 'coreV2StageDigest']);
  if (stage.version !== 3) fail();
  // The actual phase checker below requires this exact fully captured Stage
  // and checks its complete original pin. Do not rebuild C1/native snapshots
  // inside every short SQL boundary or treat a matching digest as authority.
  return stage;
}
async function guarded<T>(database: SqlConnection, stage: NativeCopyMetadataStage, operation: () => Promise<T>): Promise<T> {
  const { assertNativeCopyMetadataPhaseOnConnection } = await import('./workspace-operation-native-copy-phase');
  await assertNativeCopyMetadataPhaseOnConnection(database, stage);
  const result = await operation();
  await assertNativeCopyMetadataPhaseOnConnection(database, stage); return result;
}
export async function assertNativeCopyMetadataBeforeOnConnection(database: SqlConnection,
  input: Readonly<{ stage: WorkspaceOperationNativeCopyStage }>): Promise<void> {
  const fields = object(input, ['stage']), stage = capturedStage(fields.stage as WorkspaceOperationNativeCopyStage);
  const bound: ReadContext = { plan: stage.plan, sourcePaths: stage.plan.nativePathPlan.pathMappings.map(mapping => mapping.source.path),
    vacancyScopes: stage.metadata.vacancyScopes, exactVacancyPaths: stage.metadata.exactVacancyPaths, mappingsProof: stage.metadata.mappingsProof };
  const pin = await guarded(database, stage, () => storage(database));
  const rows = await guarded(database, stage, () => sourceRows(database, bound, pin));
  if (!equal(rows, stage.metadata.sourceRows)) fail('NATIVE_COPY_METADATA_CHANGED');
  await guarded(database, stage, () => vacancy(database, stage.identity.destinationWorkspaceId, stage.metadata.vacancyScopes, stage.metadata.exactVacancyPaths, pin));
  if (!equal(await guarded(database, stage, () => storage(database)), pin)) fail('NATIVE_COPY_METADATA_CHANGED');
}
export async function applyNativeCopyMetadataOnConnection(database: SqlConnection,
  input: Readonly<{ stage: WorkspaceOperationNativeCopyStage; copyCreatedAt: number }>): Promise<NativeCopyMetadataCompletionWitness> {
  const fields = object(input, ['stage', 'copyCreatedAt']), stage = capturedStage(fields.stage as WorkspaceOperationNativeCopyStage);
  const copyCreatedAt = fields.copyCreatedAt;
  if (!clock(copyCreatedAt) || copyCreatedAt === 0) fail();
  const completion = nativeCopyMetadataCompletionWitness(stage.metadata, copyCreatedAt);
  const mappings = new Map(stage.plan.nativePathPlan.pathMappings.map(mapping => [mapping.source.path, mapping.destinationPath]));
  const expected = stage.metadata.sourceRows.flatMap(row => row.title === null ? [] : [{ path: mappings.get(row.path)!, title: row.title,
    createdAt: copyCreatedAt, updatedAt: copyCreatedAt }]).sort((a, b) => order(a.path, b.path));
  const pin = await guarded(database, stage, () => storage(database));
  const birth = await guarded(database, stage, async () => database.get(`SELECT created_at FROM ${quote(pin.schema)}.collaboration_native_copy_receipts
    WHERE workspace_id=$1 AND operation_id=$2 AND publication_fingerprint=$3 AND actor_user_id=$4
      AND actor_session_id IS NOT DISTINCT FROM $5 AND kind='native_clone'`,
  [stage.identity.destinationWorkspaceId, stage.identity.operationId, stage.payloadSha256, stage.origin.actor.userId, stage.origin.actor.sessionId])) as Row | undefined;
  if (!birth || !clock(Number(birth.created_at)) || Number(birth.created_at) !== copyCreatedAt) fail('NATIVE_COPY_METADATA_CHANGED');
  await guarded(database, stage, () => vacancy(database, stage.identity.destinationWorkspaceId, stage.metadata.vacancyScopes, stage.metadata.exactVacancyPaths, pin));
  if (expected.length) {
    try {
      await guarded(database, stage, async () => database.run(`INSERT INTO ${quote(pin.schema)}.workspace_file_metadata
        (workspace_id,path,title,created_at,updated_at)
        SELECT $1,copied.path,copied.title,$4,$4 FROM unnest($2::text[],$3::text[]) AS copied(path,title)`,
      [stage.identity.destinationWorkspaceId, expected.map(row => row.path), expected.map(row => row.title), copyCreatedAt]));
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === '23505') fail('NATIVE_COPY_METADATA_CHANGED');
      throw error;
    }
  }
  const after = await guarded(database, stage, async () => database.get(`WITH actual AS MATERIALIZED (
      SELECT path,title,created_at,updated_at FROM ${quote(pin.schema)}.workspace_file_metadata m WHERE workspace_id=$1
        AND (m.path=ANY($3::text[]) OR EXISTS(SELECT 1 FROM unnest($2::text[]) scope(path) WHERE m.path=scope.path OR left(m.path,length(scope.path)+1)=scope.path||'/'))
      ORDER BY path COLLATE "C" LIMIT 2049
    ), bounds AS (SELECT count(*)::integer AS count,coalesce(bool_and(octet_length(path)<=4096
      AND (title IS NULL OR octet_length(title)<=640 AND char_length(title)<=160)
      AND created_at BETWEEN 0 AND 9007199254740990 AND updated_at BETWEEN 0 AND 9007199254740990),true) AS valid FROM actual),
    payload AS (SELECT CASE WHEN count<=2048 AND valid THEN (SELECT coalesce(sum(octet_length(jsonb_build_object('path',path,'title',title,
      'createdAt',created_at,'updatedAt',updated_at)::text)),0)+greatest(count-1,0)*2+2 FROM actual) END AS bytes FROM bounds)
    SELECT count,CASE WHEN count<=2048 AND valid AND bytes<=1048576 THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('path',path,'title',title,
        'createdAt',created_at,'updatedAt',updated_at) ORDER BY path COLLATE "C"),'[]'::jsonb) FROM actual) END AS rows,
      EXISTS(SELECT 1 FROM ${quote(pin.schema)}.workspace_file_user_states u WHERE workspace_id=$1
        AND (u.path=ANY($3::text[]) OR EXISTS(SELECT 1 FROM unnest($2::text[]) scope(path)
          WHERE u.path=scope.path OR left(u.path,length(scope.path)+1)=scope.path||'/'))) AS personal FROM bounds CROSS JOIN payload`,
  [stage.identity.destinationWorkspaceId, stage.metadata.vacancyScopes, stage.metadata.exactVacancyPaths])) as Row | undefined;
  if (!after || after.count !== expected.length || after.personal !== false || !equal(after.rows, expected)) fail('NATIVE_COPY_METADATA_CHANGED');
  if (!equal(await guarded(database, stage, () => storage(database)), pin)) fail('NATIVE_COPY_METADATA_CHANGED');
  return completion;
}
