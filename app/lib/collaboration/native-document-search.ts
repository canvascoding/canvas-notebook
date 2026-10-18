import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '../db';
import { DocumentReadError, type DocumentCurrencyV1, type NativeDocumentRefV1 } from '../documents/contracts';
import { documentMetadataVersionV1, documentVersionV1 } from '../documents/read-version';
import { decodeDocumentSearchRequestV1, DocumentSearchError, DOCUMENT_SEARCH_CURSOR_BYTES,
  DOCUMENT_SEARCH_ENVELOPE_BYTES, DOCUMENT_SEARCH_SNIPPET_BYTES, DOCUMENT_SEARCH_WINDOW_SIZE,
  type DecodedDocumentSearchRequestV1, type DocumentSearchHitV1, type DocumentSearchPageV1 } from '../documents/search-contract';
import { getFileDisplayName } from '../files/display-name';
import type { WorkspaceContext } from '../workspaces/types';
import { readNativeDocumentByIdOnConnection } from './native-document-read';
import { NATIVE_SEARCH_DOCUMENT_BUDGET } from './native-search-budget';
import { collaborationAdmissionLockKey } from './room-admission-contract';
import { lockIdentity, type CollaborationRoomOwnerFence } from './room-owner';
import { captureLocalCollaborationSearchRooms } from './search-room-census';
import { COLLABORATION_SCHEMA_VERSION, type TextCollaborationRepresentation } from './types';
import { readWorkspaceDocumentCatalogue, type WorkspaceDocumentCatalogueEntry } from './workspace-document-catalogue';
import { nativeCollaborationSearchText } from './workspace-search-reader';

type Row = Record<string, unknown>;
type Header = Readonly<Record<string, string | number | null>>;
type Owner = Readonly<{ documentId: string; pid: number; start: string }>;
type Candidate = Readonly<{ entry: WorkspaceDocumentCatalogueEntry; header: Header; title: string; priority: number;
  stateBytes: number; vectorBytes: number; representation: string; owner: CollaborationRoomOwnerFence | null;
  unavailableOwner: boolean }>;
type Census = Readonly<{ proof: string; candidates: readonly Candidate[]; pristine: number }>;
type BinaryProof = Readonly<{ stateSha256: string; vectorSha256: string; stateBytes: number; vectorBytes: number;
  generation: number; sequence: number }>;
type Continuation = Readonly<{ version: 1; authority: string; selection: string; corpus: string; local: string;
  start: number; end: number; offset: number; window: string | null }>;
type PreparedSearch = Readonly<{ page: DocumentSearchPageV1; assertCurrent(): Promise<void> }>;
const CATALOGUE_LIMIT = 10_000, HEADER_BYTES = 8 * 1024 * 1024;
const WINDOW_STATE_BYTES = 8 * 1024 * 1024, WINDOW_VECTOR_BYTES = 512 * 1024, TEXT_BYTES = 256 * 1024;
const KERNEL_WORK_MS = 4000;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(JSON.stringify(value));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hidden = (path: string) => path.split('/').some(part => part.startsWith('.'));
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown, min = 0): number | null => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) && Number.isSafeInteger(Number(value))
  && Number(value) >= min ? Number(value) : null;
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0
  && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
  && Buffer.from(value, 'utf8').toString('utf8') === value;
function changed(): never { throw new DocumentSearchError('SEARCH_CORPUS_CHANGED'); }
function unsafe(): never { throw new DocumentReadError('DOCUMENT_STATE_INVALID'); }
function busy(): never { throw new DocumentReadError('DOCUMENT_BUSY'); }

const textColumns = [
  ['d.id', 'id'], ['d.lineage_id', 'lineage_id'], ['d.workspace_id', 'workspace_id'],
  ['d.workspace_type', 'workspace_type'], ['d.organization_id', 'organization_id'],
  ['d.customer_id', 'customer_id'], ['d.project_id', 'project_id'], ['d.path', 'path'],
  ['d.provider', 'provider'], ['d.status', 'status'], ['d.yjs_state_lifecycle', 'lifecycle'],
  ['l.id', 'lineage_actual_id'], ['l.workspace_id', 'lineage_workspace_id'],
  ['l.workspace_type', 'lineage_workspace_type'], ['l.organization_id', 'lineage_organization_id'],
  ['l.customer_id', 'lineage_customer_id'], ['l.project_id', 'lineage_project_id'],
  ['l.path', 'lineage_path'], ['l.status', 'lineage_status'], ['l.trash_entry_id', 'lineage_trash_id'],
  ['s.document_id', 'state_id'], ['s.workspace_id', 'state_workspace_id'],
  ['s.organization_id', 'state_organization_id'], ['s.path', 'state_path'],
  ['s.representation', 'representation'], ['s.status', 'state_status'],
  ['s.room_owner_token', 'owner_token'], ['s.room_owner_backend_start', 'owner_start'], ['m.title', 'title'],
] as const;
const scalarColumns = [['s.lifecycle_generation', 'generation'], ['s.schema_version', 'schema_version'],
  ['s.document_sequence', 'sequence'], ['s.room_owner_epoch', 'owner_epoch'],
  ['s.room_owner_backend_pid', 'owner_pid'], ['l.archived_at', 'lineage_archived_at'],
  ['m.updated_at', 'metadata_revision'], ['octet_length(s.yjs_state)', 'state_bytes'],
  ['octet_length(s.state_vector)', 'vector_bytes']] as const;
const allColumns = [...textColumns, ...scalarColumns];
const relations = `collaboration_documents d FULL JOIN collaboration_yjs_states s ON s.document_id=d.id
  LEFT JOIN file_collaboration_lineages l ON l.id=d.lineage_id
  LEFT JOIN workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path`;
const scope = (column: string) => `($2='' OR ${column}=$2 OR left(${column},length($2)+1)=$2||'/')`;
const included = `((d.workspace_id=$1 AND d.provider='yjs' AND d.status='active' AND ${scope('d.path')})
  OR (s.workspace_id=$1 AND s.status='active' AND ${scope('s.path')}))`;
const oversized = textColumns.map(([column]) => `COALESCE(octet_length(${column}),0)>16384`).join(' OR ');
const totalText = `sum(${textColumns.map(([column]) => `COALESCE(octet_length(${column}),0)::bigint`).join('+')}) OVER ()`;
const rowBudgetExceeded = `(${oversized}) OR ${totalText}>${HEADER_BYTES} OR count(*) OVER ()>${CATALOGUE_LIMIT}`;

function matcher(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu');
}
function metadataPriority(query: string, title: string, path: string): number {
  const pattern = matcher(query), basename = path.split('/').at(-1)!, stem = basename.replace(/\.[^.]*$/u, '');
  const exact = (value: string) => new RegExp(`^(?:${pattern.source})$`, 'iu').test(value);
  if (exact(title)) return 0;
  if (exact(stem)) return 1;
  if (exact(path)) return 2;
  const prefix = new RegExp(`(?:^|[\\s_./-])(?:${pattern.source})`, 'iu');
  if (prefix.test(title) || prefix.test(basename)) return 3;
  if (pattern.test(title) || pattern.test(basename)) return 4;
  return pattern.test(path) ? 5 : 6;
}

function validateHeader(row: Row, entry: WorkspaceDocumentCatalogueEntry, workspace: WorkspaceContext): Header {
  if (row.oversized_text === true) throw new DocumentSearchError('SEARCH_CORPUS_TOO_LARGE');
  if (row.id !== entry.id || row.lineage_id !== entry.lineage_id || !text(row.id)
    || row.path !== entry.path || row.workspace_id !== workspace.workspaceId || row.workspace_type !== workspace.workspaceType
    || row.organization_id !== (workspace.organizationId ?? null) || row.provider !== 'yjs' || row.status !== 'active') unsafe();
  if (row.lineage_id === null ? entry.authority === 'initialized'
    || textColumns.some(([, alias]) => alias.startsWith('lineage_') && row[alias] !== null)
    : !text(row.lineage_id) || row.lineage_actual_id !== row.lineage_id || row.lineage_workspace_id !== workspace.workspaceId
    || row.lineage_workspace_type !== workspace.workspaceType || row.lineage_organization_id !== (workspace.organizationId ?? null)
    || row.lineage_path !== entry.path || row.lineage_status !== 'active' || row.lineage_archived_at !== null
    || row.lineage_trash_id !== null && !text(row.lineage_trash_id)) unsafe();
  for (const [name, expected] of [['customer_id', workspace.customerId ?? null], ['project_id', workspace.projectId ?? null]] as const) {
    for (const value of [row[name], row[`lineage_${name}`]]) if (value !== null && (!text(value) || value !== expected)) unsafe();
  }
  if (row.metadata_revision === null ? row.title !== null
    : integer(row.metadata_revision) === null || row.title !== null && (typeof row.title !== 'string'
      || row.title.length > 4096 || Buffer.from(row.title, 'utf8').toString('utf8') !== row.title)) unsafe();
  if (entry.authority === 'initialized' && (row.lifecycle !== 'initialized' || row.state_id !== entry.id
    || row.state_workspace_id !== workspace.workspaceId || row.state_organization_id !== (workspace.organizationId ?? null)
    || row.state_path !== entry.path || row.state_status !== 'active'
    || integer(row.generation, 1) !== entry.lifecycle_generation || integer(row.schema_version, 1) !== COLLABORATION_SCHEMA_VERSION
    || integer(row.sequence) === null || entry.state_version > Number(row.sequence)
    || integer(row.state_bytes, 1) === null || integer(row.vector_bytes, 1) === null
    || typeof row.representation !== 'string' || !text(row.representation))) unsafe();
  const result: Record<string, string | number | null> = {};
  for (const [, alias] of allColumns) {
    const value = row[alias];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') unsafe();
    result[alias] = value as string | number | null;
  }
  // Normalize int8 strings so driver integer parsing cannot alter comparisons.
  for (const [, alias] of scalarColumns) if (result[alias] !== null) {
    const parsed = integer(result[alias], alias === 'generation' || alias === 'schema_version' || alias === 'owner_pid' ? 1 : 0);
    if (parsed === null) unsafe(); result[alias] = parsed;
  }
  return Object.freeze(result);
}

async function readOwnerHolders(connection: SqlConnection, entries: readonly WorkspaceDocumentCatalogueEntry[]): Promise<readonly Owner[]> {
  if (!entries.length) return Object.freeze([]);
  const keys = entries.map(entry => lockIdentity(entry.id));
  if (new Set(keys.map(key => `${key.high}:${key.low}`)).size !== entries.length) unsafe();
  const rows = await connection.all(`SELECT /* canvas.native-search.owners.v1 */ i.document_id,l.pid,extract(epoch FROM a.backend_start)::text AS started
    FROM unnest($1::text[],$2::bigint[],$3::bigint[]) i(document_id,high,low)
    JOIN pg_locks l ON l.classid::bigint=i.high AND l.objid::bigint=i.low
    LEFT JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
    ORDER BY i.document_id,l.pid`, [entries.map(entry => entry.id), keys.map(key => key.high), keys.map(key => key.low)]) as Row[];
  if (rows.length > entries.length) unsafe();
  const ids = new Set(entries.map(entry => entry.id)), seen = new Set<string>(), result: Owner[] = [];
  for (const row of rows) {
    if (!text(row.document_id) || !ids.has(row.document_id) || seen.has(row.document_id)
      || integer(row.pid, 1) === null || typeof row.started !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(row.started)) unsafe();
    seen.add(row.document_id); result.push(Object.freeze({ documentId: row.document_id, pid: Number(row.pid), start: row.started }));
  }
  return Object.freeze(result);
}

function observeOwner(header: Header, holder: Owner | undefined, entry: WorkspaceDocumentCatalogueEntry): {
  owner: CollaborationRoomOwnerFence | null; unavailable: boolean;
} {
  if (entry.authority !== 'initialized') { if (holder) unsafe(); return { owner: null, unavailable: false }; }
  const epoch = integer(header.owner_epoch), empty = header.owner_token === null && header.owner_pid === null && header.owner_start === null;
  if (epoch === null) unsafe();
  if (empty) { if (holder) unsafe(); return { owner: null, unavailable: false }; }
  if (epoch < 1 || !text(header.owner_token, 1024) || integer(header.owner_pid, 1) === null
    || typeof header.owner_start !== 'string' || !/^[0-9]+\.[0-9]+$/u.test(header.owner_start)) unsafe();
  if (!holder || holder.pid !== header.owner_pid || holder.start !== header.owner_start) return { owner: null, unavailable: true };
  return { owner: Object.freeze({ scope: Object.freeze({ documentId: entry.id, workspaceId: entry.workspace_id,
    organizationId: entry.organization_id, path: entry.path, lifecycleGeneration: Number(header.generation),
    representation: header.representation as TextCollaborationRepresentation, schemaVersion: Number(header.schema_version) }),
  epoch, token: header.owner_token, backendPid: holder.pid, backendStart: holder.start }), unavailable: false };
}

async function readCensus(connection: SqlConnection, workspace: WorkspaceContext,
  selection: DecodedDocumentSearchRequestV1): Promise<Census> {
  const values = [workspace.workspaceId, selection.scopePath === '.' ? '' : selection.scopePath];
  // Bound every catalogue-selected text BEFORE its existing unbounded projection.
  const preflight = await connection.get(`SELECT /* canvas.native-search.header-budget.v1 */ count(*)::text AS count,
    COALESCE(sum(${textColumns.map(([column]) => `COALESCE(octet_length(${column}),0)::bigint`).join('+')}),0)::text AS text_bytes,
    COALESCE(bool_or(${oversized}),false) AS oversized_text FROM ${relations} WHERE ${included}`, values) as Row | undefined;
  const count = integer(preflight?.count), bytes = integer(preflight?.text_bytes);
  if (count === null || bytes === null || typeof preflight?.oversized_text !== 'boolean') unsafe();
  if (count > CATALOGUE_LIMIT || bytes > HEADER_BYTES || preflight!.oversized_text) throw new DocumentSearchError('SEARCH_CORPUS_TOO_LARGE');
  let entries: WorkspaceDocumentCatalogueEntry[];
  try { entries = await readWorkspaceDocumentCatalogue(connection, workspace,
    { paths: [selection.scopePath], maxEntries: CATALOGUE_LIMIT, maxTextBytes: HEADER_BYTES }); }
  catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (code === 'NATIVE_CATALOGUE_TOO_LARGE') throw new DocumentSearchError('SEARCH_CORPUS_TOO_LARGE');
    if (code === 'identity-conflict' || code === 'orphan-state') unsafe();
    throw error;
  }
  const rows = await connection.all(`SELECT /* canvas.native-search.corpus.v1 */ ${textColumns.map(([column, alias]) =>
    `CASE WHEN NOT (${rowBudgetExceeded}) THEN ${column} END AS ${alias}`).join(',')},
    ${scalarColumns.map(([column, alias]) => `${column} AS ${alias}`).join(',')},(${rowBudgetExceeded}) AS oversized_text
    FROM ${relations} WHERE ${included} ORDER BY d.path,d.id LIMIT 10001`, values) as Row[];
  if (rows.some(row => row.oversized_text === true)) throw new DocumentSearchError('SEARCH_CORPUS_TOO_LARGE');
  if (rows.length !== entries.length || rows.length > CATALOGUE_LIMIT) changed();
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== rows.length) unsafe();
  const holders = await readOwnerHolders(connection, entries), holderById = new Map(holders.map(holder => [holder.documentId, holder]));
  const candidates: Candidate[] = [], captured: unknown[] = [];
  let pristine = 0;
  for (const entry of entries) {
    const row = byId.get(entry.id); if (!row) changed();
    const header = validateHeader(row, entry, workspace);
    if (entry.authority === 'missing-state') throw new DocumentReadError('DOCUMENT_STATE_MISSING');
    const ownership = observeOwner(header, holderById.get(entry.id), entry);
    // Hidden facts are checked, but never counted or returned publicly.
    captured.push([entry.id, entry.lineage_id, entry.path, entry.authority, header]);
    if (hidden(entry.path)) continue;
    if (entry.authority === 'pristine') { pristine++; continue; }
    const title = header.title as string | null ?? getFileDisplayName({ name: entry.path.split('/').at(-1)!, type: 'file' });
    candidates.push(Object.freeze({ entry: Object.freeze({ ...entry }), header, title,
      priority: metadataPriority(selection.query, title, entry.path), stateBytes: Number(header.state_bytes),
      vectorBytes: Number(header.vector_bytes), representation: String(header.representation),
      owner: ownership.owner, unavailableOwner: ownership.unavailable }));
  }
  candidates.sort((a, b) => a.priority - b.priority || compare(a.entry.path, b.entry.path) || compare(a.entry.id, b.entry.id));
  return Object.freeze({ proof: digest(['native-search-census', 1, workspace.workspaceId, captured, holders]),
    candidates: Object.freeze(candidates), pristine });
}

async function binaryProofs(connection: SqlConnection, candidates: readonly Candidate[]): Promise<ReadonlyMap<string, BinaryProof>> {
  if (!candidates.length) return new Map();
  const rows = await connection.all(`SELECT /* canvas.native-search.window.v1 */ document_id,lifecycle_generation,document_sequence,
    octet_length(yjs_state) AS state_bytes,octet_length(state_vector) AS vector_bytes,
    CASE WHEN octet_length(yjs_state) BETWEEN 1 AND $2 AND octet_length(state_vector) BETWEEN 1 AND $3
      THEN encode(sha256(yjs_state),'hex') END AS state_sha256,
    CASE WHEN octet_length(yjs_state) BETWEEN 1 AND $2 AND octet_length(state_vector) BETWEEN 1 AND $3
      THEN encode(sha256(state_vector),'hex') END AS vector_sha256
    FROM collaboration_yjs_states WHERE document_id=ANY($1::text[]) ORDER BY document_id`,
  [candidates.map(candidate => candidate.entry.id), NATIVE_SEARCH_DOCUMENT_BUDGET.maxStateBytes,
    NATIVE_SEARCH_DOCUMENT_BUDGET.maxVectorBytes]) as Row[];
  if (rows.length !== candidates.length) changed();
  const byId = new Map(candidates.map(candidate => [candidate.entry.id, candidate])), proofs = new Map<string, BinaryProof>();
  for (const row of rows) {
    const candidate = byId.get(String(row.document_id));
    if (!candidate || proofs.has(candidate.entry.id) || !hex(row.state_sha256) || !hex(row.vector_sha256)
      || integer(row.state_bytes, 1) !== candidate.stateBytes || integer(row.vector_bytes, 1) !== candidate.vectorBytes
      || integer(row.lifecycle_generation, 1) !== Number(candidate.header.generation)
      || integer(row.document_sequence) !== Number(candidate.header.sequence)) changed();
    proofs.set(candidate.entry.id, Object.freeze({ stateSha256: row.state_sha256, vectorSha256: row.vector_sha256,
      stateBytes: candidate.stateBytes, vectorBytes: candidate.vectorBytes, generation: Number(candidate.header.generation),
      sequence: Number(candidate.header.sequence) }));
  }
  return proofs;
}

function decodeCursor(value: string): Continuation {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.byteLength > DOCUMENT_SEARCH_CURSOR_BYTES || bytes.toString('base64url') !== value) throw new Error();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const row = parsed as Row, keys = ['version', 'authority', 'selection', 'corpus', 'local', 'start', 'end', 'offset', 'window'];
    if (Reflect.ownKeys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))
      || row.version !== 1 || !hex(row.authority) || !hex(row.selection) || !hex(row.corpus) || !hex(row.local)
      || ['start', 'end', 'offset'].some(key => typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)
      || Number(row.start) >= CATALOGUE_LIMIT || Number(row.end) > CATALOGUE_LIMIT
      || Number(row.offset) > DOCUMENT_SEARCH_WINDOW_SIZE || row.window !== null && !hex(row.window)) throw new Error();
    return Object.freeze(row as unknown as Continuation);
  } catch { throw new DocumentSearchError('SEARCH_CURSOR_INVALID'); }
}
function encodeCursor(value: Continuation): string {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  if (Buffer.byteLength(encoded, 'utf8') > DOCUMENT_SEARCH_CURSOR_BYTES) throw new DocumentSearchError('SEARCH_OUTPUT_TOO_LARGE');
  return encoded;
}
function snippet(value: string, query: string): string {
  const match = matcher(query).exec(value), centre = match?.index ?? 0;
  let start = Math.max(0, centre - 120);
  if (start && /[\uDC00-\uDFFF]/u.test(value[start]) && /[\uD800-\uDBFF]/u.test(value[start - 1])) start--;
  const points: string[] = []; let bytes = 0;
  for (const point of value.slice(start, start + 1024)) {
    const size = Buffer.byteLength(point, 'utf8'); if (bytes + size > DOCUMENT_SEARCH_SNIPPET_BYTES) break;
    points.push(point); bytes += size;
  }
  return points.join('');
}

/** Internal borrowed-B preparation, never authentication. The fixed service
 * owns genuine principal/current realm, RC/RW, commit/rollback and awaited close.
 * No callback/DTO from a caller grants authority or substitutes SQL observations. */
export async function prepareNativeDocumentSearchOnConnection(connection: SqlConnection,
  input: Readonly<{ workspace: WorkspaceContext; authorityScopeSha256: string;
    selection: DecodedDocumentSearchRequestV1 }>): Promise<PreparedSearch> {
  const selection = decodeDocumentSearchRequestV1(input.selection), workspace = structuredClone(input.workspace);
  if (!hex(input.authorityScopeSha256) || !workspace.permissions.canRead || workspace.status !== 'active' || workspace.legacy
    || workspace.workspaceId !== selection.workspaceId) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
  const authority = input.authorityScopeSha256, deadline = performance.now() + KERNEL_WORK_MS;
  const alive = () => { if (performance.now() > deadline) busy(); };
  const tx = await connection.get(`SELECT current_schema() AS schema,pg_backend_pid() AS backend,
    pg_current_xact_id_if_assigned()::text AS xid,current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`) as Row | undefined;
  if (!tx || !text(tx.schema, 63) || integer(tx.backend, 1) === null || integer(tx.xid, 1) === null
    || tx.isolation !== 'read committed' || tx.read_only !== 'off') throw new DocumentReadError('DOCUMENT_SCOPE_CHANGED');
  const txProof = digest(tx);
  const acquired = await connection.get('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired',
    [collaborationAdmissionLockKey(workspace.workspaceId)]) as Row | undefined;
  if (acquired?.acquired !== true) busy();
  const local = captureLocalCollaborationSearchRooms(workspace.workspaceId, 4096, 'exclude_dot_segments');
  const assertLocalCurrent = () => {
    try { local.assertCurrent(); }
    catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'SEARCH_ROOM_CENSUS_CHANGED') changed();
      throw error;
    }
  };
  if (local.uncertainty.some(issue => issue !== 'not_installed')) busy();
  const initial = await readCensus(connection, workspace, selection); alive(); assertLocalCurrent();
  const candidateById = new Map(initial.candidates.map(candidate => [candidate.entry.id, candidate]));
  for (const room of local.rooms) {
    if (selection.scopePath !== '.' && room.path !== selection.scopePath && !room.path.startsWith(`${selection.scopePath}/`)) continue;
    const candidate = candidateById.get(room.documentId);
    // Both directions matter: a genuine local room cannot be treated as idle
    // merely because its SQL row/holder is absent, released or contradictory.
    if (!candidate?.owner || candidate.unavailableOwner || !local.coversOwner(candidate.owner)) busy();
  }
  const selectionProof = digest(['native-search-selection', 1, workspace.workspaceId, selection.query,
    selection.scopePath, 'exclude_dot_segments', 'metadata_priority_path_id_v1', 'within_scan_window']);
  const localProof = digest([local.serverEpoch, local.revision]);
  const continuation = selection.cursor === undefined ? undefined : decodeCursor(selection.cursor);
  if (continuation && (continuation.authority !== authority || continuation.selection !== selectionProof
    || continuation.corpus !== initial.proof || continuation.local !== localProof)) changed();
  const start = continuation?.start ?? 0;
  if (start > initial.candidates.length || continuation && start === initial.candidates.length) changed();
  const selected: Candidate[] = [], readable: Candidate[] = [];
  const excluded = { tooLarge: 0, unavailableOwner: 0, unsupportedRepresentation: 0 };
  let stateBytes = 0, vectorBytes = 0, end = start;
  while (end < initial.candidates.length && selected.length < DOCUMENT_SEARCH_WINDOW_SIZE) {
    const candidate = initial.candidates[end];
    if (!['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(candidate.representation)) {
      selected.push(candidate); excluded.unsupportedRepresentation++; end++; continue;
    }
    if (candidate.unavailableOwner || candidate.owner && !local.coversOwner(candidate.owner)) {
      selected.push(candidate); excluded.unavailableOwner++; end++; continue;
    }
    if (candidate.stateBytes > NATIVE_SEARCH_DOCUMENT_BUDGET.maxStateBytes
      || candidate.vectorBytes > NATIVE_SEARCH_DOCUMENT_BUDGET.maxVectorBytes) {
      selected.push(candidate); excluded.tooLarge++; end++; continue;
    }
    if (stateBytes + candidate.stateBytes > WINDOW_STATE_BYTES || vectorBytes + candidate.vectorBytes > WINDOW_VECTOR_BYTES) break;
    selected.push(candidate); readable.push(candidate); stateBytes += candidate.stateBytes; vectorBytes += candidate.vectorBytes; end++;
  }
  if (continuation && (continuation.window !== null ? continuation.end !== end : continuation.end !== 0)) changed();
  const binaries = await binaryProofs(connection, readable);
  const hits: Array<{ hit: DocumentSearchHitV1; priority: number }> = [];
  for (const candidate of readable) {
    alive(); assertLocalCurrent(); const expected = binaries.get(candidate.entry.id)!;
    try {
      const observation = await readNativeDocumentByIdOnConnection(connection, { workspace, documentId: candidate.entry.id,
        budget: NATIVE_SEARCH_DOCUMENT_BUDGET,
        expectedPersistedBinary: { stateSha256: expected.stateSha256, vectorSha256: expected.vectorSha256 } });
      const n = observation.native;
      if (observation.identity.documentId !== candidate.entry.id || observation.identity.lineageId !== candidate.entry.lineage_id
        || n.path !== candidate.entry.path || n.lifecycleGeneration !== candidate.entry.lifecycle_generation
        || observation.metadata.title !== candidate.header.title
        || observation.metadata.revision !== candidate.header.metadata_revision) changed();
      const identity = { workspaceId: n.workspaceId, organizationId: n.organizationId, documentId: n.documentId,
        lineageId: observation.identity.lineageId, lifecycleGeneration: n.lifecycleGeneration,
        representation: n.representation, schemaVersion: n.schemaVersion };
      const version = documentVersionV1(identity, n.observed.stateProof);
      const document: NativeDocumentRefV1 = Object.freeze({ kind: 'native_document', ...identity,
        path: n.path, title: candidate.title, version, metadataVersion: documentMetadataVersionV1(identity,
          { path: n.path, title: candidate.title, metadataRevision: observation.metadata.revision }) });
      const content = nativeCollaborationSearchText(n.observed.content, { maxBytes: TEXT_BYTES });
      const matchedIn: Array<'title' | 'path' | 'content'> = [];
      if (matcher(selection.query).test(candidate.title)) matchedIn.push('title');
      if (matcher(selection.query).test(candidate.entry.path)) matchedIn.push('path');
      if (matcher(selection.query).test(content)) matchedIn.push('content');
      if (!matchedIn.length) continue;
      const currency: DocumentCurrencyV1 = Object.freeze({ source: n.source, observedVersion: version,
        observedDurable: n.observed.durable, durableVersion: documentVersionV1(identity, n.durable.stateProof),
        durableSequence: n.durable.documentSequence, persistedAt: n.durable.persistedAt });
      hits.push({ priority: candidate.priority, hit: Object.freeze({ document, currency, matchedIn: Object.freeze(matchedIn),
        snippet: snippet(matchedIn.includes('content') ? content : matchedIn.includes('title') ? candidate.title : candidate.entry.path, selection.query) }) });
    } catch (error) {
      if (error instanceof DocumentReadError && error.code === 'DOCUMENT_TOO_LARGE') excluded.tooLarge++;
      else throw error;
    }
  }
  hits.sort((a, b) => a.priority - b.priority
    || Number(b.hit.matchedIn.includes('content')) - Number(a.hit.matchedIn.includes('content'))
    || compare(a.hit.document.path, b.hit.document.path)
    || compare(a.hit.document.documentId, b.hit.document.documentId));
  const windowProof = digest(['native-search-window', 1, start, end, [...binaries], hits.map(value => value.hit), excluded]);
  const offset = continuation?.offset ?? 0;
  if (offset > hits.length || continuation && ((offset > 0) !== (continuation.window !== null)
    || continuation.window !== null && continuation.window !== windowProof)) changed();
  let checking = false, poisoned = false;
  const assertCurrent = async () => {
    if (checking || poisoned) { poisoned = true; changed(); }
    checking = true;
    try {
      alive(); assertLocalCurrent();
      const currentTx = await connection.get(`SELECT current_schema() AS schema,pg_backend_pid() AS backend,
        pg_current_xact_id_if_assigned()::text AS xid,current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS read_only`) as Row | undefined;
      if (digest(currentTx) !== txProof || (await readCensus(connection, workspace, selection)).proof !== initial.proof) changed();
      if (digest([...(await binaryProofs(connection, readable))]) !== digest([...binaries])) changed();
      assertLocalCurrent(); alive();
    } catch (error) { poisoned = true; throw error; }
    finally { checking = false; }
  };
  await assertCurrent();
  const makePage = (count: number): DocumentSearchPageV1 => {
    const nextOffset = offset + count, moreWindowHits = nextOffset < hits.length, moreCandidates = end < initial.candidates.length;
    const nextCursor = moreWindowHits || moreCandidates ? encodeCursor({ version: 1, authority, selection: selectionProof,
      corpus: initial.proof, local: localProof, start: moreWindowHits ? start : end,
      end: moreWindowHits ? end : 0, offset: moreWindowHits ? nextOffset : 0, window: moreWindowHits ? windowProof : null }) : null;
    return Object.freeze({ apiVersion: 1, workspaceId: workspace.workspaceId, query: selection.query, scopePath: selection.scopePath,
      hits: Object.freeze(hits.slice(offset, nextOffset).map(value => value.hit)), nextCursor,
      coverage: Object.freeze({ corpus: 'visible_initialized_native_yjs', candidateOrder: 'metadata_priority_path_id_v1',
        ranking: 'within_scan_window', membershipCheckedBeforeAndAfter: true, candidateCount: initial.candidates.length,
        windowStart: start, windowEnd: end, inspected: selected.length, matched: hits.length, returned: count,
        excludedInWindow: Object.freeze({ ...excluded }), pristineExcluded: initial.pristine,
        localLive: local.complete ? 'verified' : 'unknown', remoteLive: 'unknown', globalCurrentContent: 'not_certified',
        moreWindowHits, moreCandidates }) });
  };
  let count = Math.min(selection.limit, hits.length - offset), page = makePage(count);
  while (Buffer.byteLength(JSON.stringify(page), 'utf8') > DOCUMENT_SEARCH_ENVELOPE_BYTES) {
    if (count <= 1) throw new DocumentSearchError('SEARCH_OUTPUT_TOO_LARGE');
    page = makePage(--count);
  }
  return Object.freeze({ page, assertCurrent });
}
