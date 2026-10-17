import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import { findPostgresUserById, readPostgresWorkspaceForActorOnConnection } from '@/app/lib/workspaces/postgres-runtime';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../resources/contracts';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import { authority, lockCapabilityScopeWorkspaceAuthority } from '../scope-authority';
import { CapabilityPackageError, type CapabilityPackageDraft } from './contracts';

export type CapabilityPackageSourceCapture = {
  source: 'package'; storage: CapabilityResourceStorageBinding; parentStorage?: CapabilityResourceStorageBinding;
  resourceRef: string; revisionRef: string | null; checksum: string; parentChecksum?: string;
  childRelativeRoot: string; selectedChildChecksum: string; targetRelativeRoot: string;
  name: string; version: string; targetName: string; targetVersion: string; changes: string[];
  skillLicense?: string; parentName?: string; parentVersion?: string; parentLicense?: string;
} | {
  source: 'workspace'; workspaceId: string; kind: 'skill' | 'plugin'; workspaceDraftId: string; packageName: string;
  checksum: string; version: string; targetName: string; targetVersion: string; targetRelativeRoot: string; changes: string[];
};

export async function readableImportWorkspace(actor: CapabilityResourceActor, workspaceId: string, database: SqlConnection) {
  const access = await authority(database,{...actor,workspaceId},true);
  if (!access.valid || !access.contextValid || !access.requestedWorkspace?.canRead) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','The source workspace is not readable.',403);
  }
  const requested=access.requestedWorkspace;
  await lockCapabilityScopeWorkspaceAuthority(database,access,{type:'team',organizationId:requested.organizationId,workspaceId},[]);
  const fresh=await authority(database,{...actor,workspaceId},true);
  if(!fresh.valid || !fresh.contextValid || !fresh.requestedWorkspace?.canRead) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','The source workspace is not readable.',403);
  }
  const user = await findPostgresUserById(database,actor.userId);
  if (!user) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','An active actor is required.',403);
  const workspace = await readPostgresWorkspaceForActorOnConnection(database,resolveWorkspaceActor({id:user.id,email:user.email,role:user.role}),workspaceId);
  if (!workspace?.permissions.canRead) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED','The source workspace is not readable.',403);
  return workspace;
}

export async function withCapabilityPackageCaptureRead<T>(actor: CapabilityResourceActor, captures: readonly CapabilityPackageSourceCapture[],
  database: SqlConnection, callback: () => Promise<T>): Promise<T> {
  const next = async (index: number): Promise<T> => {
    const source = captures[index];
    if (!source) return callback();
    if (source.source === 'workspace') { await readableImportWorkspace(actor,source.workspaceId,database); return next(index+1); }
    return withAuthorizedCapabilityPackageResource(actor,source.storage,'read',undefined,async () => next(index+1),{database,parentStorage:source.parentStorage});
  };
  return next(0);
}

export async function readCapabilityPackageDraftCaptures(actor: CapabilityResourceActor,draftRef: string,database: SqlConnection): Promise<CapabilityPackageSourceCapture[]> {
  const rows = await database.all(`SELECT capture_json FROM capability_package_source_captures
    WHERE actor_user_id=$1 AND draft_ref=$2 AND published_revision_ref IS NULL ORDER BY capture_ref`,[actor.userId,draftRef]) as {capture_json:string}[];
  let captures: CapabilityPackageSourceCapture[];
  try { captures=rows.map(row => JSON.parse(row.capture_json) as CapabilityPackageSourceCapture); }
  catch { throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE','Stored source provenance is unavailable.',503); }
  return captures;
}

export async function recordCapabilityPackageSourceCaptures(actor: CapabilityResourceActor,draft: CapabilityPackageDraft,
  captures: readonly CapabilityPackageSourceCapture[],database: SqlConnection): Promise<void> {
  for (const capture of captures) await database.run(`INSERT INTO capability_package_source_captures
    (capture_ref,actor_user_id,draft_ref,target_resource_ref,published_revision_ref,capture_json,created_at) VALUES ($1,$2,$3,$4,NULL,$5,$6)`,
  [randomUUID(),actor.userId,draft.draftRef,draft.resourceRef,JSON.stringify(capture),Date.now()]);
}
