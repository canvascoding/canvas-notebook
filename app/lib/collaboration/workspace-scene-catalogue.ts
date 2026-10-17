import 'server-only';

import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import { isCanonicalWorkspacePath } from '../workspaces/path-identity';

export type WorkspaceSceneCatalogueEntry = {
  id: string;
  lineage_id: string;
  workspace_id: string;
  workspace_type: WorkspaceContext['workspaceType'];
  organization_id: string | null;
  customer_id: string | null;
  project_id: string | null;
  path: string;
  provider: 'excalidraw';
  status: 'active';
  state_version: number;
  has_persisted_state: boolean;
  /** A registry row without a scene never proves a pristine file fallback. */
  authority: 'initialized' | 'missing-state';
  state_document_id: string | null;
  state_workspace_id: string | null;
  state_organization_id: string | null;
  state_path: string | null;
  state_status: 'active' | null;
  lifecycle_generation: number | null;
  scene_schema_version: number | null;
  excalidraw_version: string | null;
  scene_sequence: number | null;
  checkpoint_sequence: number | null;
  canonical_hash: string | null;
  elements_bytes: number | null;
  shared_app_state_bytes: number | null;
  assets_bytes: number | null;
  lineage_row_id: string;
  lineage_workspace_id: string;
  lineage_workspace_type: WorkspaceContext['workspaceType'];
  lineage_organization_id: string | null;
  lineage_customer_id: string | null;
  lineage_project_id: string | null;
  lineage_path: string;
  lineage_status: 'active';
  lineage_archived_at: null;
  lineage_trash_entry_id: string | null;
};

export class WorkspaceSceneCatalogueError extends Error {
  readonly status = 409;
  constructor(readonly code: 'identity-conflict' | 'orphan-state', readonly documentId: string, readonly path: string) {
    super(`The workspace scene catalogue is unsafe: ${code}.`);
    this.name = 'WorkspaceSceneCatalogueError';
  }
}

/** PostgreSQL int8 values may be decimal strings; coercion must not admit booleans or unsafe integers. */
function sceneCatalogueInteger(value: unknown, minimum: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && !Object.is(parsed, -0) ? parsed : null;
}

function sceneCatalogueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

const stateFields = ['state_document_id', 'state_workspace_id', 'state_organization_id', 'state_path', 'state_status',
  'lifecycle_generation', 'scene_schema_version', 'excalidraw_version', 'scene_sequence', 'checkpoint_sequence',
  'canonical_hash', 'elements_bytes', 'shared_app_state_bytes', 'assets_bytes'] as const;
const stateNumbers = { lifecycle_generation: 1, scene_schema_version: 1, scene_sequence: 0, checkpoint_sequence: 0,
  elements_bytes: 1, shared_app_state_bytes: 1, assets_bytes: 1 } as const;

/** Read-only header facts, never a mutation capability or current-principal proof.
 * The caller owns its connection, transaction and lifecycle fences. One SQL
 * snapshot includes both registry and scene paths, including missing projections
 * and foreign suffixes. Bodies/assets/files are deliberately not loaded here. */
export async function readWorkspaceSceneCatalogue(
  connection: SqlConnection,
  workspace: WorkspaceContext,
  options: { paths?: readonly string[]; maxEntries?: number } = {},
): Promise<WorkspaceSceneCatalogueEntry[]> {
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active'
    || !sceneCatalogueId(workspace.workspaceId)) {
    throw Object.assign(new Error('The workspace scene catalogue is unavailable.'), { status: 403 });
  }
  const workspaceId = workspace.workspaceId, organizationId = workspace.organizationId ?? null, workspaceType = workspace.workspaceType;
  const customerId = workspace.customerId ?? null, projectId = workspace.projectId ?? null;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new Error('Invalid scene catalogue options.');
  }
  const maxEntries = options.maxEntries === undefined ? 10_000 : options.maxEntries;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) throw new Error('Invalid scene catalogue limit.');
  if (options.paths !== undefined && (!Array.isArray(options.paths) || options.paths.length > 10_000)) {
    throw new Error('Scene catalogue scopes must be canonical workspace paths.');
  }
  const pathsInScope: string[] = [];
  if (options.paths === undefined) pathsInScope.push('');
  else for (let index = 0; index < options.paths.length; index++) {
    const scope = options.paths[index] === '.' ? '' : options.paths[index];
    if (!Object.hasOwn(options.paths, index) || !isCanonicalWorkspacePath(scope, true)) {
      throw new Error('Scene catalogue scopes must be canonical workspace paths.');
    }
    pathsInScope.push(scope);
  }
  if (!pathsInScope.length) return [];

  // FULL JOIN is intentional: starting from the registry alone would miss an
  // active orphan, and filtering only s.path would miss a moved registry path.
  // Corrupt cross-workspace pairs belong to both affected workspace checks.
  const rows = await connection.all(`SELECT d.id,d.lineage_id,d.workspace_id,d.workspace_type,d.organization_id,d.customer_id,d.project_id,d.path,
    d.provider,d.status,d.state_version,s.document_id IS NOT NULL AS has_persisted_state,
    s.document_id AS state_document_id,s.workspace_id AS state_workspace_id,
    s.organization_id AS state_organization_id,s.path AS state_path,s.status AS state_status,
    s.lifecycle_generation,s.scene_schema_version,s.excalidraw_version,s.scene_sequence,s.checkpoint_sequence,s.canonical_hash,
    octet_length(s.elements_json::text) AS elements_bytes,
    octet_length(s.shared_app_state_json::text) AS shared_app_state_bytes,octet_length(s.assets_json::text) AS assets_bytes,
    l.id AS lineage_row_id,l.workspace_id AS lineage_workspace_id,l.workspace_type AS lineage_workspace_type,
    l.organization_id AS lineage_organization_id,l.customer_id AS lineage_customer_id,l.project_id AS lineage_project_id,
    l.path AS lineage_path,l.status AS lineage_status,l.archived_at AS lineage_archived_at,l.trash_entry_id AS lineage_trash_entry_id,
    EXISTS(SELECT 1 FROM collaboration_documents other WHERE other.workspace_id=d.workspace_id AND other.path=d.path
      AND other.status='active' AND other.id<>d.id) AS has_path_conflict
    FROM collaboration_documents d FULL OUTER JOIN collaboration_excalidraw_states s ON s.document_id=d.id
    LEFT JOIN file_collaboration_lineages l ON l.id=d.lineage_id
    WHERE (d.provider='excalidraw' AND d.status='active' OR s.status='active')
      AND (d.workspace_id=$1 OR s.workspace_id=$1)
      AND EXISTS(SELECT 1 FROM unnest($2::text[]) p(scope) WHERE p.scope=''
        OR d.path=p.scope OR left(d.path,length(p.scope)+1)=p.scope||'/'
        OR s.path=p.scope OR left(s.path,length(p.scope)+1)=p.scope||'/')
    ORDER BY coalesce(d.path,s.path),coalesce(d.id,s.document_id) LIMIT $3`,
  [workspaceId, pathsInScope, maxEntries + 1]) as Array<Omit<WorkspaceSceneCatalogueEntry, 'authority'> & { has_path_conflict: boolean }>;
  if (rows.length > maxEntries) {
    throw Object.assign(new Error('Too many scene documents in this scope.'), { status: 413, code: 'SCENE_CATALOGUE_TOO_LARGE' });
  }

  const ids = new Set<string>(), paths = new Set<string>();
  const entries: WorkspaceSceneCatalogueEntry[] = [];
  for (const row of rows) {
    const fail = (code: WorkspaceSceneCatalogueError['code']): never => {
      throw new WorkspaceSceneCatalogueError(code,
        typeof row.id === 'string' ? row.id : typeof row.state_document_id === 'string' ? row.state_document_id : '',
        typeof row.path === 'string' ? row.path : typeof row.state_path === 'string' ? row.state_path : '');
    };
    if (row.state_status === 'active' && (!sceneCatalogueId(row.id) || row.status !== 'active' || row.provider !== 'excalidraw'
      || row.state_document_id !== row.id || row.workspace_id !== workspaceId || row.state_workspace_id !== workspaceId
      || row.organization_id !== organizationId || row.state_organization_id !== organizationId
      || row.path !== row.state_path || row.workspace_type !== workspaceType)) fail('orphan-state');
    const stateVersion = sceneCatalogueInteger(row.state_version, 0);
    if (!sceneCatalogueId(row.id) || !sceneCatalogueId(row.lineage_id) || !isCanonicalWorkspacePath(row.path)
      || row.provider !== 'excalidraw' || row.status !== 'active' || row.workspace_id !== workspaceId
      || row.workspace_type !== workspaceType || row.organization_id !== organizationId || stateVersion === null
      || ids.has(row.id) || paths.has(row.path) || row.has_path_conflict !== false
      || row.lineage_row_id !== row.lineage_id || row.lineage_workspace_id !== workspaceId
      || row.lineage_workspace_type !== workspaceType || row.lineage_organization_id !== organizationId
      || row.lineage_path !== row.path || row.lineage_status !== 'active' || row.lineage_archived_at !== null
      || row.lineage_trash_entry_id !== null && !sceneCatalogueId(row.lineage_trash_entry_id)
      || typeof row.has_persisted_state !== 'boolean') fail('identity-conflict');
    // Match the existing native header policy: legacy nulls may remain, but a
    // declared customer/project must be valid and match this workspace scope.
    for (const [field, expected] of [['customer_id', customerId], ['project_id', projectId]] as const) {
      for (const value of [row[field], row[`lineage_${field}`]]) {
        if (value !== null && (!sceneCatalogueId(value) || value !== expected)) fail('identity-conflict');
      }
    }
    if (row.has_persisted_state) {
      if (row.state_status !== 'active' || row.state_document_id !== row.id || row.state_path !== row.path
        || row.state_workspace_id !== workspaceId || row.state_organization_id !== organizationId
        || !sceneCatalogueId(row.excalidraw_version) || typeof row.canonical_hash !== 'string'
        || !/^[a-f0-9]{64}$/u.test(row.canonical_hash)) fail('identity-conflict');
      for (const key of Object.keys(stateNumbers) as Array<keyof typeof stateNumbers>) {
        const parsed = sceneCatalogueInteger(row[key], stateNumbers[key]);
        if (parsed === null) fail('identity-conflict');
        row[key] = parsed;
      }
      // Initial creation uses 0/0; patches/restores only advance scene_sequence,
      // and both checkpoint writers stamp the exact current scene sequence.
      if (row.scene_sequence === null || row.checkpoint_sequence === null || row.checkpoint_sequence > row.scene_sequence) fail('identity-conflict');
    } else if (stateFields.some(key => row[key] !== null)) fail('identity-conflict');
    const { has_path_conflict: _pathConflict, ...entry } = row;
    entries.push({ ...entry, state_version: stateVersion!, authority: row.has_persisted_state ? 'initialized' : 'missing-state' });
    ids.add(row.id); paths.add(row.path);
  }
  return entries;
}
