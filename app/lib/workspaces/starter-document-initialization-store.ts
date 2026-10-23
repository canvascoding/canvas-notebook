import 'server-only';

import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '../db';
import { isCanonicalWorkspacePath } from './path-identity';
import { assertObservedWorkspaceStarterDocumentCurrent, readObservedWorkspaceStarterDocument,
  WORKSPACE_STARTER_DOCUMENT_NAME, WORKSPACE_STARTER_MAX_BYTES, type ObservedWorkspaceStarterDocument } from './starter-document';
import type { WorkspaceType } from './types';

/** Historical original-source expectation; no permission or native-write grant. */
export type WorkspaceStarterInitializationIntent = Readonly<{
  workspaceId: string; operationId: string; requestId: string; actorUserId: string;
  path: typeof WORKSPACE_STARTER_DOCUMENT_NAME; seedDisposition: 'created' | 'existing';
  sourceFileVersion: string; sourceSha256: string; sourceBytes: number;
  organizationId: string | null; workspaceType: WorkspaceType; projectId: string | null;
  rootRelativePath: string; createdAt: number;
}>;

// Kept beside the sole record/read path. Global migration dispatch invokes this
// idempotently after the existing canvas_workspaces relation is available.
export const WORKSPACE_STARTER_INITIALIZATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS canvas_workspace_starter_initializations (
    workspace_id text PRIMARY KEY REFERENCES canvas_workspaces(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL UNIQUE,
    request_id uuid NOT NULL,
    actor_user_id text NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 256 AND actor_user_id=btrim(actor_user_id) AND actor_user_id !~ '[[:cntrl:]]'),
    path text NOT NULL CHECK (path='Erste Schritte.md'),
    seed_disposition text NOT NULL CHECK (seed_disposition IN ('created','existing')),
    source_file_version text NOT NULL CHECK (length(source_file_version)<=1024 AND source_file_version ~ '^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+([.][0-9]+)?:-?[0-9]+([.][0-9]+)?$'),
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    source_bytes bigint NOT NULL CHECK (source_bytes BETWEEN 0 AND 5242880),
    organization_id text,
    workspace_type text NOT NULL CHECK (workspace_type IN ('personal','team','organization','project')),
    project_id text,
    root_relative_path text NOT NULL CHECK (length(root_relative_path) BETWEEN 1 AND 4096),
    created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991)
  )`,
  `CREATE OR REPLACE FUNCTION validate_workspace_starter_initialization() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM set_config('search_path',quote_ident(TG_TABLE_SCHEMA)||', pg_catalog, pg_temp',true);
      IF TG_OP='DELETE' THEN
        -- The real parent FK cascade may remove this expectation. Standalone
        -- deletion while its Workspace exists must not erase retry identity.
        IF NOT EXISTS(SELECT 1 FROM canvas_workspaces WHERE id=OLD.workspace_id) THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'Workspace starter intents are immutable' USING ERRCODE='55000';
      END IF;
      IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Workspace starter intents are immutable' USING ERRCODE='55000'; END IF;
      IF length(NEW.workspace_id) NOT BETWEEN 1 AND 256 OR NEW.workspace_id<>btrim(NEW.workspace_id) OR NEW.workspace_id ~ '[[:cntrl:]]'
        OR NEW.organization_id IS NOT NULL AND (length(NEW.organization_id) NOT BETWEEN 1 AND 256 OR NEW.organization_id<>btrim(NEW.organization_id) OR NEW.organization_id ~ '[[:cntrl:]]')
        OR NEW.project_id IS NOT NULL AND (length(NEW.project_id) NOT BETWEEN 1 AND 256 OR NEW.project_id<>btrim(NEW.project_id) OR NEW.project_id ~ '[[:cntrl:]]')
        OR NEW.root_relative_path LIKE '/%' OR position(chr(92) IN NEW.root_relative_path)>0 OR NEW.root_relative_path ~ '[[:cntrl:]]'
        OR EXISTS(SELECT 1 FROM unnest(string_to_array(NEW.root_relative_path,'/')) part WHERE part IN ('','.','..'))
        OR split_part(NEW.source_file_version,':',3)::numeric<>NEW.source_bytes THEN
        RAISE EXCEPTION 'Workspace starter source is unavailable' USING ERRCODE='23514';
      END IF;
      PERFORM 1 FROM canvas_workspaces w WHERE w.id=NEW.workspace_id AND w.status='active'
        AND w.organization_id IS NOT DISTINCT FROM NEW.organization_id AND w.type=NEW.workspace_type
        AND w.project_id IS NOT DISTINCT FROM NEW.project_id AND w.root_relative_path=NEW.root_relative_path FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Workspace starter scope is unavailable' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='canvas_workspace_starter_initializations'::regclass AND tgname='workspace_starter_initialization_guard') THEN
      CREATE TRIGGER workspace_starter_initialization_guard BEFORE INSERT OR UPDATE OR DELETE
        ON canvas_workspace_starter_initializations FOR EACH ROW EXECUTE FUNCTION validate_workspace_starter_initialization();
    END IF;
  END $$`,
] as const;

const columns = ['workspace_id','operation_id','request_id','actor_user_id','path','seed_disposition','source_file_version','source_sha256',
  'source_bytes','organization_id','workspace_type','project_id','root_relative_path','created_at'] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
function unavailable(): never { throw new Error('WORKSPACE_STARTER_INITIALIZATION_INVALID'); }
function safeInteger(value: unknown): number {
  const number = typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return unavailable();
  return number;
}
function decode(row: unknown): WorkspaceStarterInitializationIntent {
  if (!row || typeof row !== 'object' || Object.getPrototypeOf(row) !== Object.prototype || Reflect.ownKeys(row).length !== columns.length) return unavailable();
  for (const key of columns) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return unavailable();
  }
  const value = row as Record<typeof columns[number], unknown>;
  if (!id(value.workspace_id) || !id(value.actor_user_id) || typeof value.operation_id !== 'string' || !uuid.test(value.operation_id)
    || typeof value.request_id !== 'string' || !uuid.test(value.request_id) || value.path !== WORKSPACE_STARTER_DOCUMENT_NAME
    || !['created','existing'].includes(value.seed_disposition as string)
    || typeof value.source_file_version !== 'string' || value.source_file_version.length > 1024
    || !/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?$/u.test(value.source_file_version)
    || typeof value.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.source_sha256)
    || value.organization_id !== null && !id(value.organization_id) || value.project_id !== null && !id(value.project_id)
    || !['personal','team','organization','project'].includes(value.workspace_type as string)
    || !isCanonicalWorkspacePath(value.root_relative_path)) return unavailable();
  const sourceBytes = safeInteger(value.source_bytes), createdAt = safeInteger(value.created_at);
  if (sourceBytes > WORKSPACE_STARTER_MAX_BYTES || Number(value.source_file_version.split(':')[2]) !== sourceBytes) return unavailable();
  return Object.freeze({ workspaceId: value.workspace_id, operationId: value.operation_id, requestId: value.request_id,
    actorUserId: value.actor_user_id, path: WORKSPACE_STARTER_DOCUMENT_NAME, seedDisposition: value.seed_disposition as 'created' | 'existing',
    sourceFileVersion: value.source_file_version, sourceSha256: value.source_sha256, sourceBytes,
    organizationId: value.organization_id as string | null, workspaceType: value.workspace_type as WorkspaceType,
    projectId: value.project_id as string | null, rootRelativePath: value.root_relative_path, createdAt });
}

export async function readWorkspaceStarterInitializationIntent(database: SqlConnection, workspaceId: string): Promise<WorkspaceStarterInitializationIntent | null> {
  if (!id(workspaceId)) return unavailable();
  const row = await database.get(`SELECT ${columns.join(',')} FROM canvas_workspace_starter_initializations WHERE workspace_id=$1`, [workspaceId]);
  if (row === undefined || row === null) return null;
  const intent = decode(row);
  if (intent.workspaceId !== workspaceId) return unavailable();
  return intent;
}

/** Sole creation path: call inside the actual Workspace INSERT transaction.
 * Source is a live descriptor observation, never a caller-issued byte claim. */
export async function recordWorkspaceStarterInitializationIntent(database: Pick<SqlConnection, 'get' | 'run'>, input: {
  workspaceId: string; actorUserId: string; organizationId: string | null; workspaceType: WorkspaceType;
  projectId: string | null; rootRelativePath: string; observation: ObservedWorkspaceStarterDocument;
}): Promise<WorkspaceStarterInitializationIntent> {
  const { workspaceId, actorUserId, organizationId, workspaceType, projectId, rootRelativePath, observation } = input;
  const source = readObservedWorkspaceStarterDocument(observation);
  const values = [workspaceId, randomUUID(), randomUUID(), actorUserId, source.path, source.seedDisposition,
    source.sourceFileVersion, source.sourceSha256, source.sourceBytes, organizationId, workspaceType, projectId, rootRelativePath, Date.now()];
  const intended = decode(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
  await assertObservedWorkspaceStarterDocumentCurrent(observation);
  const row = await database.get(`INSERT INTO canvas_workspace_starter_initializations (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')}) RETURNING ${columns.join(',')}`, values);
  const recorded = decode(row);
  if (JSON.stringify(recorded) !== JSON.stringify(intended)) return unavailable();
  await assertObservedWorkspaceStarterDocumentCurrent(observation);
  return recorded;
}
