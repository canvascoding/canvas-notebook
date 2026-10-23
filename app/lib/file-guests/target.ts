import 'server-only';

import type { SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceFileMetadataTarget } from '@/app/lib/files/workspace-file-metadata-contract';
import type { WorkspaceSideEffectWriterTarget } from '@/app/lib/files/workspace-side-effect-writer-fence';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';
import { COLLABORATION_SCHEMA_VERSION } from '@/app/lib/collaboration/types';

export class FileGuestTargetError extends Error {
  constructor(readonly code: 'FILE_GUEST_TARGET_INVALID' | 'FILE_GUEST_TARGET_CHANGED' | 'FILE_GUEST_BINDING_UNAVAILABLE') {
    super(code === 'FILE_GUEST_TARGET_INVALID' ? 'Die aktuellen Dateiinformationen sind erforderlich.'
      : code === 'FILE_GUEST_BINDING_UNAVAILABLE' ? 'Diese Einladung ist nicht an den aktuellen Dokumentstand gebunden. Eine neue Einladung ist nötig.'
      : 'Die Datei wurde zwischenzeitlich geändert. Bitte ihre aktuellen Informationen neu laden.');
    this.name = 'FileGuestTargetError';
  }
  get status() { return this.code === 'FILE_GUEST_TARGET_INVALID' ? 400 : this.code === 'FILE_GUEST_BINDING_UNAVAILABLE' ? 410 : 409; }
}

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const generation = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  && value >= 1 && value < Number.MAX_SAFE_INTEGER;

/** Actual Info evidence only. The value conveys no read or mutation authority. */
export function captureFileGuestTarget(value: unknown, workspaceId: string, path: string): WorkspaceFileMetadataTarget {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new FileGuestTargetError('FILE_GUEST_TARGET_INVALID');
  const target = value as Record<string, unknown>;
  const keys = target.kind === 'native_file' ? ['version','workspaceId','path','kind','documentId','lifecycleGeneration']
    : target.kind === 'filesystem' ? ['version','workspaceId','path','kind','fileVersion','entryType'] : [];
  if (keys.length === 0 || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    return !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor,'value');
  }) || target.version !== 1 || target.workspaceId !== workspaceId || !id(workspaceId)
    || target.path !== path || !isCanonicalAdmissionPath(path)) throw new FileGuestTargetError('FILE_GUEST_TARGET_INVALID');
  if (target.kind === 'native_file') {
    if (!id(target.documentId) || !generation(target.lifecycleGeneration)) throw new FileGuestTargetError('FILE_GUEST_TARGET_INVALID');
    return Object.freeze({ version:1,kind:'native_file',workspaceId,path,documentId:target.documentId,lifecycleGeneration:target.lifecycleGeneration });
  }
  if (typeof target.fileVersion !== 'string' || target.fileVersion.length > 1024
    || !/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?$/u.test(target.fileVersion)
    || target.entryType !== 'file') throw new FileGuestTargetError('FILE_GUEST_TARGET_INVALID');
  return Object.freeze({ version:1,kind:'filesystem',workspaceId,path,fileVersion:target.fileVersion,entryType:'file' });
}

export type FileGuestDocumentBinding = Readonly<{
  workspaceId: string; path: string; documentId: string; lineageId: string | null; lifecycleGeneration: number | null;
}>;

/** A historical invitation must already contain its original binding. */
export function requireFileGuestDocumentBinding(binding: FileGuestDocumentBinding): asserts binding is FileGuestDocumentBinding & {
  lineageId: string; lifecycleGeneration: number;
} {
  if (!id(binding.workspaceId) || !id(binding.documentId) || !id(binding.lineageId)
    || !generation(binding.lifecycleGeneration) || !isCanonicalAdmissionPath(binding.path)) throw new FileGuestTargetError('FILE_GUEST_BINDING_UNAVAILABLE');
}

/** Resolve only server-owned identity fields on the writer/read connection.
 * The caller still owns current rights, Shared admission, transaction and COMMIT. */
export async function readFileGuestNativeTargetOnConnection(database: SqlConnection, workspace: WorkspaceContext,
  expected: Readonly<{ workspaceId: string; path: string; documentId: string; lifecycleGeneration: number; lineageId?: string }>,
): Promise<WorkspaceSideEffectWriterTarget> {
  if (expected.workspaceId !== workspace.workspaceId || !id(expected.documentId) || !generation(expected.lifecycleGeneration)
    || !isCanonicalAdmissionPath(expected.path) || expected.lineageId !== undefined && !id(expected.lineageId)) throw new FileGuestTargetError('FILE_GUEST_TARGET_INVALID');
  const row = await database.get(`SELECT d.lineage_id,d.workspace_type,d.organization_id,d.path,d.provider,d.status,d.yjs_state_lifecycle,
    l.workspace_id AS lineage_workspace,l.workspace_type AS lineage_type,l.organization_id AS lineage_org,l.path AS lineage_path,l.status AS lineage_status,
    s.workspace_id AS state_workspace,s.organization_id AS state_org,s.path AS state_path,s.status AS state_status,
    s.lifecycle_generation,s.representation,s.schema_version
    FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1 AND d.workspace_id=$2`,
  [expected.documentId,workspace.workspaceId]) as Record<string, unknown> | undefined;
  const organizationId = workspace.organizationId ?? null;
  if (!row || !id(row.lineage_id) || expected.lineageId !== undefined && row.lineage_id !== expected.lineageId
    || row.workspace_type !== workspace.workspaceType || row.organization_id !== organizationId || row.path !== expected.path
    || row.provider !== 'yjs' || row.status !== 'active' || row.yjs_state_lifecycle !== 'initialized'
    || row.lineage_workspace !== workspace.workspaceId || row.lineage_type !== workspace.workspaceType
    || row.lineage_org !== organizationId || row.lineage_path !== expected.path || row.lineage_status !== 'active'
    || row.state_workspace !== workspace.workspaceId || row.state_org !== organizationId || row.state_path !== expected.path || row.state_status !== 'active'
    || Number(row.lifecycle_generation) !== expected.lifecycleGeneration || !['plain_text','tiptap_xml','tiptap_blocks'].includes(String(row.representation))
    || Number(row.schema_version) !== COLLABORATION_SCHEMA_VERSION) throw new FileGuestTargetError('FILE_GUEST_TARGET_CHANGED');
  return Object.freeze({ kind:'native_file',workspaceId:workspace.workspaceId,organizationId,path:expected.path,
    documentId:expected.documentId,lineageId:row.lineage_id,lifecycleGeneration:expected.lifecycleGeneration,
    representation:row.representation as WorkspaceSideEffectWriterTarget['representation'],schemaVersion:Number(row.schema_version) });
}
