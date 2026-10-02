import 'server-only';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { workspaceAbsoluteRoot } from '../workspaces/contracts';
import { authoritativeCollaborationSnapshot } from './checkpoint';
import { serializeCanonicalText, type PersistedCollaborationState } from './persistence';
import { isCollaborationStateQuarantined } from './failure';
import { recoveryHash, type CollaborationRecoveryEvidence } from './recovery-plan';

export type RecoveryRow = Record<string, unknown>;
export type RecoveryRows = {
  states: RecoveryRow[]; registry: RecoveryRow[]; workspaces: RecoveryRow[];
  receipts: RecoveryRow[]; revisions: RecoveryRow[];
};

export function recoveryPostgresFlag(value: unknown): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error('Invalid PostgreSQL flag in recovery evidence.');
}

export function recoveryPostgresInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/u.test(value))) throw new Error('Invalid PostgreSQL integer in recovery evidence.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error('Unsafe PostgreSQL integer in recovery evidence.');
  return number;
}

export function recoveryBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value && typeof value === 'object' && 'encoding' in value && value.encoding === 'base64'
    && 'bytes' in value && typeof value.bytes === 'string') {
    const decoded = Buffer.from(value.bytes, 'base64');
    if (decoded.toString('base64') === value.bytes) return new Uint8Array(decoded);
  }
  throw new Error('Invalid binary recovery evidence.');
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid text recovery evidence.');
  return value;
}

export function decodeRecoveryState(row: RecoveryRow): PersistedCollaborationState {
  if (!['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(row.representation as string)
    || !['active', 'archived'].includes(row.status as string) || !['lf', 'crlf'].includes(row.newline_style as string)) {
    throw new Error('Unsupported recovery state metadata.');
  }
  const generation = recoveryPostgresInteger(row.lifecycle_generation, 1);
  return {
    documentId: text(row.document_id), workspaceId: text(row.workspace_id),
    organizationId: row.organization_id === null ? null : text(row.organization_id), path: text(row.path),
    representation: row.representation as PersistedCollaborationState['representation'], lifecycleGeneration: generation,
    schemaVersion: recoveryPostgresInteger(row.schema_version, 1), yjsState: recoveryBytes(row.yjs_state),
    stateVector: recoveryBytes(row.state_vector), documentSequence: recoveryPostgresInteger(row.document_sequence),
    checkpointSequence: recoveryPostgresInteger(row.checkpoint_sequence), persistedAt: recoveryPostgresInteger(row.persisted_at),
    checkpointedAt: row.checkpointed_at === null ? null : recoveryPostgresInteger(row.checkpointed_at),
    canonicalHash: row.canonical_hash === null ? null : text(row.canonical_hash),
    serializedHash: row.serialized_hash === null ? null : text(row.serialized_hash),
    newlineStyle: row.newline_style as 'lf' | 'crlf', hasBom: recoveryPostgresFlag(row.has_bom),
    degraded: recoveryPostgresFlag(row.degraded), status: row.status as 'active' | 'archived',
    ...(row.projection_error_code && recoveryPostgresInteger(row.projection_error_generation, 1) === generation
      ? { projectionError: { code: text(row.projection_error_code), sequence: recoveryPostgresInteger(row.projection_error_sequence),
        permanent: recoveryPostgresFlag(row.projection_error_permanent),
        ...(row.projection_error_phase ? { phase: text(row.projection_error_phase) } : {}) } } : {}),
  };
}

export function recoveryStateFingerprint(state: PersistedCollaborationState): string {
  const { yjsState, stateVector, projectionFinalized: _finalized, ...metadata } = state;
  const canonicalize = (value: unknown): unknown => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]))
    : Array.isArray(value) ? value.map(canonicalize) : value;
  return recoveryHash(JSON.stringify(canonicalize({ ...metadata, yjsHash: recoveryHash(yjsState), vectorHash: recoveryHash(stateVector) })));
}

export function buildCollaborationRecoveryEvidence(rows: RecoveryRows): CollaborationRecoveryEvidence {
  return {
    states: rows.states.filter(row => row.status === 'active').map(row => {
      const state = decodeRecoveryState(row);
      let computedSerializedHash: string | null = null; let validationCode: string | null = null;
      try { computedSerializedHash = recoveryHash(serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state)); }
      catch (error) { validationCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'snapshot_invalid'; }
      return { documentId: state.documentId, workspaceId: state.workspaceId, organizationId: state.organizationId, path: state.path,
        representation: state.representation, schemaVersion: state.schemaVersion, newlineStyle: state.newlineStyle, hasBom: state.hasBom,
        lifecycleGeneration: state.lifecycleGeneration, documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
        stateVector: Buffer.from(state.stateVector).toString('base64'), yjsHash: recoveryHash(state.yjsState),
        canonicalHash: state.canonicalHash, serializedHash: state.serializedHash, computedSerializedHash, validationCode,
        degraded: isCollaborationStateQuarantined(state) || state.degraded };
    }),
    registry: rows.registry.map(row => ({ id: text(row.id), workspaceId: text(row.workspace_id),
      organizationId: row.organization_id === null ? null : text(row.organization_id), path: text(row.path),
      provider: text(row.provider), status: text(row.status), workspaceType: text(row.workspace_type),
      snapshotRevisionId: row.snapshot_revision_id === null ? null : text(row.snapshot_revision_id) })),
    workspaces: rows.workspaces.map(row => ({ id: text(row.id), organizationId: row.organization_id === null ? null : text(row.organization_id),
      type: text(row.type), status: text(row.status), rootRelativePath: text(row.root_relative_path) })), files: [],
  };
}

export async function loadCollaborationRecoveryRows(database: { all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]> },
  workspaceId?: string): Promise<RecoveryRows> {
  const states = await database.all(`SELECT * FROM collaboration_yjs_states WHERE status='active'
    ${workspaceId ? 'AND workspace_id=$1' : ''} ORDER BY document_id LIMIT 10001`, workspaceId ? [workspaceId] : []) as RecoveryRow[];
  if (states.length > 10_000) throw new Error('Recovery scope exceeds 10000 active states.');
  const workspaceIds = [...new Set(states.map(row => text(row.workspace_id)))];
  const documentIds = states.map(row => text(row.document_id));
  const registry = await database.all('SELECT * FROM collaboration_documents WHERE workspace_id=ANY($1::text[]) ORDER BY id', [workspaceIds]) as RecoveryRow[];
  const workspaces = await database.all('SELECT * FROM canvas_workspaces WHERE id=ANY($1::text[]) ORDER BY id', [workspaceIds]) as RecoveryRow[];
  const receipts = await database.all('SELECT * FROM collaboration_file_projections WHERE document_id=ANY($1::text[]) ORDER BY document_id', [documentIds]) as RecoveryRow[];
  const revisionIds = [...new Set([...registry.map(row => row.snapshot_revision_id), ...receipts.map(row => row.revision_id)].filter(Boolean))];
  const revisions = await database.all('SELECT * FROM file_revisions WHERE id=ANY($1::text[]) ORDER BY id', [revisionIds]) as RecoveryRow[];
  return { states, registry, workspaces, receipts, revisions };
}

export async function observeRecoveryFile(rootRelativePath: string, documentPath: string,
  resolveRoot: (rootRelativePath: string) => string = workspaceAbsoluteRoot) {
  const root = await fs.realpath(resolveRoot(text(rootRelativePath)));
  const target = path.resolve(root, text(documentPath));
  if (!target.startsWith(root + path.sep)) throw new Error('Invalid recovery file scope.');
  const parent = await fs.realpath(path.dirname(target));
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('Invalid recovery parent scope.');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 5 * 1024 * 1024) throw new Error('Unsupported recovery file.');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('Recovery file changed while observing.');
    return { bytes, hash: recoveryHash(bytes), fileIdentity: { device: before.dev, inode: before.ino,
      birthtimeMs: before.birthtimeMs, mtimeMs: before.mtimeMs, size: before.size } };
  } finally { await handle.close(); }
}
