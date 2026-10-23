import 'server-only';

import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';

export type WorkspaceDocumentCatalogueEntry = {
  id: string;
  lineage_id: string | null;
  path: string;
  workspace_id: string;
  organization_id: string | null;
  status: 'active';
  state_version: number;
  /** Missing legacy evidence is never permission to fall back to disk. */
  yjs_state_lifecycle?: 'never_initialized' | 'initialized' | 'legacy_unknown' | null;
  has_persisted_state: boolean;
  has_state_history: boolean;
  lifecycle_generation: number | null;
  authority: 'initialized' | 'pristine' | 'missing-state';
  state_status: string | null;
  state_path: string | null;
  state_workspace_id: string | null;
  state_organization_id: string | null;
};

export class WorkspaceDocumentCatalogueError extends Error {
  readonly status = 409;
  constructor(readonly code: 'identity-conflict' | 'orphan-state', readonly documentId: string, readonly path: string) {
    super(`The workspace document catalogue is unsafe: ${code}.`);
    this.name = 'WorkspaceDocumentCatalogueError';
  }
}

/** PostgreSQL int8 is a decimal string unless the driver is explicitly configured. */
function catalogueInteger(value: unknown, minimum: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

/** The caller owns the read transaction and any lifecycle/admission fence.
 * Enumerates the durable registry, including documents without a disk projection. */
export async function readWorkspaceDocumentCatalogue(
  connection: SqlConnection,
  workspace: WorkspaceContext,
  options: { paths?: readonly string[]; maxEntries?: number; maxTextBytes?: number } = {},
): Promise<WorkspaceDocumentCatalogueEntry[]> {
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') {
    throw Object.assign(new Error('The workspace document catalogue is unavailable.'), { status: 403 });
  }
  const pathsInScope = options.paths?.map((scope) => scope === '.' ? '' : scope) ?? [''];
  if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries)
    || options.maxEntries < 1 || options.maxEntries > 10_000)) throw new Error('Invalid document catalogue limit.');
  if (options.maxTextBytes !== undefined && (!Number.isSafeInteger(options.maxTextBytes)
    || options.maxTextBytes < 1 || options.maxTextBytes > 8 * 1024 * 1024)) throw new Error('Invalid document catalogue text limit.');
  const textBudget = options.maxTextBytes, entryLimit = options.maxEntries ?? (textBudget === undefined ? undefined : 10_000);
  const tooLarge = (): never => { throw Object.assign(new Error('The native document catalogue exceeds its text budget.'),
    { status: 413, code: 'NATIVE_CATALOGUE_TOO_LARGE' }); };
  if (!pathsInScope.length) return [];
  if (pathsInScope.some((scope) => scope.startsWith('/') || scope.includes('\\') || scope.includes('\0')
    || scope !== '' && scope.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new Error('Document catalogue scopes must be canonical workspace paths.');
  }
  const orphanText = '(COALESCE(octet_length(s.document_id),0)::bigint+COALESCE(octet_length(s.path),0)::bigint)';
  const orphan = await connection.get(`SELECT ${textBudget === undefined ? 's.document_id,s.path' :
    `CASE WHEN ${orphanText}<=${textBudget} AND octet_length(s.document_id)<=16384 THEN s.document_id END AS document_id,
     CASE WHEN ${orphanText}<=${textBudget} AND octet_length(s.path)<=16384 THEN s.path END AS path,
     (${orphanText}>${textBudget} OR COALESCE(octet_length(s.document_id),0)>16384 OR COALESCE(octet_length(s.path),0)>16384) AS oversized_text`}
    FROM collaboration_yjs_states s
    LEFT JOIN collaboration_documents d ON d.id=s.document_id
    WHERE s.workspace_id=$1 AND s.status='active'
      AND EXISTS(SELECT 1 FROM unnest($2::text[]) p(scope) WHERE p.scope='' OR s.path=p.scope OR left(s.path,length(p.scope)+1)=p.scope||'/')
      AND (d.id IS NULL OR d.status<>'active' OR d.provider<>'yjs' OR d.workspace_id<>s.workspace_id
        OR d.path<>s.path OR d.organization_id IS DISTINCT FROM s.organization_id)
    LIMIT 1`, [workspace.workspaceId, pathsInScope]) as { document_id: string; path: string; oversized_text?: boolean } | undefined;
  if (orphan?.oversized_text) tooLarge();
  if (orphan) throw new WorkspaceDocumentCatalogueError('orphan-state', orphan.document_id, orphan.path);
  const textColumns = [['d.id', 'id'], ['d.lineage_id', 'lineage_id'], ['d.path', 'path'], ['d.workspace_id', 'workspace_id'],
    ['d.organization_id', 'organization_id'], ['d.status', 'status'], ['d.yjs_state_lifecycle', 'yjs_state_lifecycle'],
    ['s.status', 'state_status'], ['s.path', 'state_path'], ['s.workspace_id', 'state_workspace_id'],
    ['s.organization_id', 'state_organization_id']] as const;
  const totalText = `sum(${textColumns.map(([column]) => `COALESCE(octet_length(${column}),0)::bigint`).join('+')}) OVER ()`;
  const excess = `${totalText}>${textBudget ?? 0} OR count(*) OVER ()>${entryLimit ?? 10_000}
    OR ${textColumns.map(([column]) => `COALESCE(octet_length(${column}),0)>16384`).join(' OR ')}`;
  const select = textBudget === undefined ? `d.id,d.lineage_id,d.path,d.workspace_id,d.organization_id,d.status,d.state_version,d.yjs_state_lifecycle,
    s.lifecycle_generation,s.status AS state_status,s.path AS state_path,s.workspace_id AS state_workspace_id,s.organization_id AS state_organization_id`
    : `${textColumns.map(([column, alias]) => `CASE WHEN NOT (${excess}) THEN ${column} END AS ${alias}`).join(',')},
      d.state_version,s.lifecycle_generation,(${excess}) AS catalogue_text_budget_exceeded`;
  const documents = await connection.all(`SELECT ${select},
    EXISTS(SELECT 1 FROM collaboration_yjs_states s WHERE s.document_id=d.id) AS has_persisted_state,
    (EXISTS(SELECT 1 FROM collaboration_yjs_state_backups b WHERE b.document_id=d.id)
      OR EXISTS(SELECT 1 FROM collaboration_agent_operations a WHERE a.document_id=d.id)) AS has_state_history
    FROM collaboration_documents d LEFT JOIN collaboration_yjs_states s ON s.document_id=d.id
    WHERE d.workspace_id=$1 AND d.provider='yjs' AND d.status='active'
      AND EXISTS(SELECT 1 FROM unnest($2::text[]) p(scope) WHERE p.scope='' OR d.path=p.scope OR left(d.path,length(p.scope)+1)=p.scope||'/')
    ORDER BY d.path,d.id${entryLimit === undefined ? '' : ' LIMIT $3'}`,
  entryLimit === undefined ? [workspace.workspaceId, pathsInScope]
    : [workspace.workspaceId, pathsInScope, entryLimit + 1]) as (WorkspaceDocumentCatalogueEntry & { catalogue_text_budget_exceeded?: boolean })[];
  if (textBudget !== undefined && documents.some(document => document.catalogue_text_budget_exceeded)) tooLarge();
  if (entryLimit !== undefined && documents.length > entryLimit) {
    throw Object.assign(new Error('Too many native documents in this download scope.'), {
      status: 413, code: 'NATIVE_CATALOGUE_TOO_LARGE',
    });
  }
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const document of documents) {
    if (textBudget !== undefined) delete document.catalogue_text_budget_exceeded;
    const stateVersion = catalogueInteger(document.state_version, 0);
    const generation = document.lifecycle_generation === null ? null : catalogueInteger(document.lifecycle_generation, 1);
    if (!document.id || !document.path || document.path.startsWith('/') || document.path.includes('\\') || document.path.includes('\0')
      || document.path.split('/').some((part) => !part || part === '.' || part === '..')
      || document.workspace_id !== workspace.workspaceId || document.organization_id !== (workspace.organizationId ?? null)
      || document.status !== 'active' || paths.has(document.path) || ids.has(document.id) || stateVersion === null
      || document.lifecycle_generation !== null && generation === null
      || document.has_persisted_state && (document.state_status !== 'active' || document.state_path !== document.path
        || document.state_workspace_id !== workspace.workspaceId || document.state_organization_id !== (workspace.organizationId ?? null)
        || generation === null)) {
      throw new WorkspaceDocumentCatalogueError('identity-conflict', document.id, document.path);
    }
    document.state_version = stateVersion;
    document.lifecycle_generation = generation;
    document.authority = document.has_persisted_state ? 'initialized'
      : document.yjs_state_lifecycle === 'never_initialized' && document.state_version === 0 && !document.has_state_history
        ? 'pristine' : 'missing-state';
    paths.add(document.path); ids.add(document.id);
  }
  return documents;
}

export function workspaceDocumentCatalogueInPathScope(
  documents: readonly WorkspaceDocumentCatalogueEntry[],
  paths: readonly string[],
): WorkspaceDocumentCatalogueEntry[] {
  return documents.filter((document) => paths.some((scope) => scope === '' || scope === '.'
    || document.path === scope || document.path.startsWith(`${scope}/`)));
}
