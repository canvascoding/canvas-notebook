import 'server-only';

import { getSchema } from '@tiptap/core';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceSideEffectWriterTarget } from '../files/workspace-side-effect-writer-fence';
import { inspectPersistedNativeCollaborationSnapshot, type NativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { richMarkdownSchemaExtensions } from '../collaboration/markdown-state';
import { assertNativeDocumentSchema } from '../collaboration/native-document-schema';
import { validateRawState } from '../collaboration/native-session-state-reader';
import { loadCollaborationStateOnConnection } from '../collaboration/persistence';
import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { COLLABORATION_SCHEMA_VERSION } from '../collaboration/types';

type Row = Record<string, unknown>;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_VECTOR_BYTES = 1024 * 1024;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const safeNumber = (value: unknown, minimum = 0): boolean => (typeof value === 'number'
  || typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;

export class PublicShareNativeTargetError extends Error {
  constructor(readonly code: 'PUBLIC_SHARE_NATIVE_TARGET_CHANGED' | 'PUBLIC_SHARE_NATIVE_TARGET_TOO_LARGE') {
    super(code); this.name = 'PublicShareNativeTargetError';
  }
  get status(): 409 | 413 { return this.code === 'PUBLIC_SHARE_NATIVE_TARGET_TOO_LARGE' ? 413 : 409; }
}

function changed(): never { throw new PublicShareNativeTargetError('PUBLIC_SHARE_NATIVE_TARGET_CHANGED'); }
const tooLarge = (): never => { throw new PublicShareNativeTargetError('PUBLIC_SHARE_NATIVE_TARGET_TOO_LARGE'); };

function assertMetadata(row: Row, workspace: Pick<WorkspaceContext, 'workspaceType'>, target: WorkspaceSideEffectWriterTarget): void {
  if (row.registry_id !== target.documentId || row.lineage_id !== target.lineageId
    || row.registry_workspace_id !== target.workspaceId || row.registry_workspace_type !== workspace.workspaceType
    || row.registry_organization_id !== target.organizationId || row.registry_path !== target.path
    || row.provider !== 'yjs' || row.registry_status !== 'active' || row.yjs_state_lifecycle !== 'initialized'
    || !safeNumber(row.state_version) || row.lineage_workspace_id !== target.workspaceId
    || row.lineage_workspace_type !== workspace.workspaceType || row.lineage_organization_id !== target.organizationId
    || row.lineage_path !== target.path || row.lineage_status !== 'active'
    || row.state_document_id !== target.documentId || row.state_workspace_id !== target.workspaceId
    || row.state_organization_id !== target.organizationId || row.state_path !== target.path || row.state_status !== 'active'
    || !safeNumber(row.state_generation, 1) || Number(row.state_generation) !== target.lifecycleGeneration
    || row.state_representation !== target.representation || !safeNumber(row.state_schema_version, 1)
    || Number(row.state_schema_version) !== target.schemaVersion || !safeNumber(row.state_document_sequence)
    || Number(row.state_document_sequence) < Number(row.state_version)) changed();
  if (!safeNumber(row.state_bytes, 1) || !safeNumber(row.vector_bytes, 1)) changed();
  if (Number(row.state_bytes) > MAX_STATE_BYTES || Number(row.vector_bytes) > MAX_VECTOR_BYTES) tooLarge();
}

/** Mechanical persisted snapshot proof only. Caller retains its genuine
 * principal, bound relations, native Shared admission, transaction and COMMIT.
 * No filesystem projection, suffix, room, serializer or read authority is used.
 */
export async function readPublicShareNativeTargetOnConnection(database: SqlConnection,
  input: { workspace: WorkspaceContext; target: WorkspaceSideEffectWriterTarget; prefix: string },
): Promise<{ snapshot: NativeCollaborationSnapshot; stateByteLength: number }> {
  const { workspace, target, prefix } = input;
  // Only one already-qualified SQL identifier may be interpolated. Its actual
  // relation identity and transaction lifetime are the caller's existing fence.
  if (typeof prefix !== 'string' || !/^"(?:[^"\u0000-\u001f\u007f]|"")+"$/u.test(prefix)
    || !workspace || !target || target.kind !== 'native_file' || !validId(target.documentId) || !validId(target.lineageId)
    || !validId(target.workspaceId) || target.workspaceId !== workspace.workspaceId
    || target.organizationId !== (workspace.organizationId ?? null)
    || target.organizationId !== null && !validId(target.organizationId)
    || !['personal', 'organization', 'team', 'project'].includes(workspace.workspaceType)
    || !isCanonicalAdmissionPath(target.path) || !Number.isSafeInteger(target.lifecycleGeneration) || target.lifecycleGeneration < 1
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(target.representation)
    || target.schemaVersion !== COLLABORATION_SCHEMA_VERSION) changed();
  // Capture scalar evidence before the first await. Caller-owned objects cannot
  // change which document this read proves while ordinary content peers persist.
  const scope = Object.freeze({ workspaceType: workspace.workspaceType });
  const expected = Object.freeze({ ...target });
  const metadataColumns = `d.id AS registry_id,d.lineage_id,d.workspace_id AS registry_workspace_id,
    d.workspace_type AS registry_workspace_type,d.organization_id AS registry_organization_id,d.path AS registry_path,
    d.provider,d.status AS registry_status,d.state_version,d.yjs_state_lifecycle,
    l.workspace_id AS lineage_workspace_id,l.workspace_type AS lineage_workspace_type,
    l.organization_id AS lineage_organization_id,l.path AS lineage_path,l.status AS lineage_status,
    s.document_id AS state_document_id,s.workspace_id AS state_workspace_id,s.organization_id AS state_organization_id,
    s.path AS state_path,s.status AS state_status,s.lifecycle_generation AS state_generation,
    s.representation AS state_representation,s.schema_version AS state_schema_version,s.document_sequence AS state_document_sequence,
    octet_length(s.yjs_state) AS state_bytes,octet_length(s.state_vector) AS vector_bytes`;
  const relations = `${prefix}.collaboration_documents d FULL JOIN ${prefix}.collaboration_yjs_states s ON s.document_id=d.id
    LEFT JOIN ${prefix}.file_collaboration_lineages l ON l.id=d.lineage_id`;
  const readMetadata = async (): Promise<Row> => {
    const rows = await database.all(`SELECT ${metadataColumns} FROM ${relations}
      WHERE ((d.workspace_id=$1 AND d.path=$2) OR (s.workspace_id=$1 AND s.path=$2))
        AND (d.status='active' OR s.status='active') LIMIT 2`, [expected.workspaceId, expected.path]) as Row[];
    if (rows.length !== 1) changed();
    assertMetadata(rows[0], scope, expected);
    return rows[0];
  };
  await readMetadata();
  // The SQL bounds also reject state growth between metadata and binary reads.
  // Registry/lineage and the complete target tuple are rechecked on this row.
  const raw = await database.get(`SELECT s.*,${metadataColumns} FROM ${relations}
    WHERE d.id=$1 AND d.workspace_id=$2 AND octet_length(s.yjs_state)<=$3
      AND octet_length(s.state_vector)<=$4 LIMIT 1`,
  [expected.documentId, expected.workspaceId, MAX_STATE_BYTES, MAX_VECTOR_BYTES]) as Row | undefined;
  if (!raw) { await readMetadata(); changed(); }
  assertMetadata(raw, scope, expected);
  if (!(raw.yjs_state instanceof Uint8Array) || !(raw.state_vector instanceof Uint8Array)
    || raw.yjs_state.byteLength < 1 || raw.state_vector.byteLength < 1) changed();
  if (raw.yjs_state.byteLength > MAX_STATE_BYTES || raw.state_vector.byteLength > MAX_VECTOR_BYTES) tooLarge();
  if (raw.yjs_state.byteLength !== Number(raw.state_bytes) || raw.state_vector.byteLength !== Number(raw.vector_bytes)) changed();

  try {
    validateRawState(raw);
    // Preserve strict raw flag validation before the existing mapper normalizes
    // PG bigint strings. This facade only maps the real, already-bounded B row.
    const mappedRow = { ...raw, has_bom: raw.has_bom === true ? 1 : Number(raw.has_bom),
      degraded: raw.degraded === true ? 1 : Number(raw.degraded), projection_error_permanent: Number(raw.projection_error_permanent) };
    const state = await loadCollaborationStateOnConnection({ get: (sql, values) => {
      if (sql.replace(/\s+/gu, ' ').trim() !== 'SELECT * FROM collaboration_yjs_states WHERE document_id = $1 LIMIT 1'
        || values?.length !== 1 || values[0] !== expected.documentId) changed();
      return mappedRow;
    } }, expected.documentId, true);
    if (!state || state.documentId !== expected.documentId || state.workspaceId !== expected.workspaceId
      || state.organizationId !== expected.organizationId || state.path !== expected.path || state.status !== 'active'
      || state.lifecycleGeneration !== expected.lifecycleGeneration || state.representation !== expected.representation
      || state.schemaVersion !== expected.schemaVersion) changed();
    const snapshot = inspectPersistedNativeCollaborationSnapshot(state, (doc, native) => {
      assertNativeDocumentSchema(doc, state.representation, getSchema(richMarkdownSchemaExtensions()));
      return native;
    });
    return { snapshot, stateByteLength: state.yjsState.byteLength };
  } catch (error) {
    if (error instanceof PublicShareNativeTargetError) throw error;
    changed();
  }
}
