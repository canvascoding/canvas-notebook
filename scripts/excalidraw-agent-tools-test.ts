import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { openDb, closeDatabaseConnections } from '@/app/lib/db';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { piTools } from '@/app/lib/pi/core-tools';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { workspaceToAgentExecutionContext } from '@/app/lib/pi/session-workspace-context';
import { filterToolsForWorkspacePermissions } from '@/app/lib/pi/workspace-tool-policy';
import { filterToolsForPlanningMode } from '@/app/lib/pi/planning-mode';
import { getPiToolsetsForTool } from '@/app/lib/pi/toolsets';
import { getProgressiveGatewayCapabilityNames } from '@/app/lib/pi/progressive-tool-gateway';
import { getToolDisplayInfo } from '@/app/lib/pi/tool-display';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext, WorkspaceType } from '@/app/lib/workspaces/types';
import type { ExcalidrawDocumentSnapshot } from '@/app/lib/excalidraw-collaboration/scene-service';
import { loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';

const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const userId = `scene-tools-user-${suffix}`;
const organizationId = `scene-tools-org-${suffix}`;
const projectId = `scene-tools-project-${suffix}`;
const sceneTools = ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'];

async function sql(query: string, params: unknown[] = []) {
  const connection = await openDb();
  try { return await connection.all(query, params); }
  finally { await connection.close(); }
}

function workspace(type: WorkspaceType): WorkspaceContext {
  const rootRelativePath = `workspaces/scene-agent-tools-test/${suffix}/${type}/files`;
  return { workspaceId: `scene-tools-${type}-${suffix}`, workspaceType: type, rootRelativePath,
    rootPath: workspaceAbsoluteRoot(rootRelativePath), organizationId,
    ownerUserId: type === 'personal' ? userId : null, projectId: type === 'project' ? projectId : null,
    displayName: `Scene agent tools ${type}`, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: false, canRunAgent: true } };
}

function context(current: WorkspaceContext): AgentExecutionContext {
  return workspaceToAgentExecutionContext({ workspace: current, userId,
    sessionId: `${current.workspaceId}-session`, agentId: DEFAULT_MANAGED_AGENT_ID });
}

function element(id: string, x = 0) {
  return { id, type: 'rectangle', version: 1, versionNonce: 101, isDeleted: false,
    index: `a${id}`, x, y: 0, width: 100, height: 80, angle: 0, opacity: 100, groupIds: [], boundElements: [] };
}

async function invoke(current: WorkspaceContext, name: string, input: unknown, callId = `${name}-${randomUUID()}`) {
  const tool = piTools.find(candidate => candidate.name === name);
  assert.ok(tool, `Missing registered tool ${name}`);
  return runWithAgentExecutionContext(context(current), () => tool.execute(callId, input));
}

function success<T>(result: Awaited<ReturnType<typeof invoke>>): T {
  assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
  assert.equal((result.details as { error?: string }).error, undefined, JSON.stringify(result));
  assert.ok(result.content.some(part => part.type === 'text' && part.text.length > 0));
  return result.details as T;
}

function failure(result: Awaited<ReturnType<typeof invoke>>, code?: string) {
  assert.equal((result as { isError?: boolean }).isError, true, JSON.stringify(result));
  const details = result.details as { error: string; code?: string };
  assert.ok(details.error);
  if (code) assert.equal(details.code, code);
}

async function seed(workspaces: WorkspaceContext[]) {
  // The shared native PostgreSQL database is migrated before this suite runs.
  await sql(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Scene agent tools test',$2,1,1,1)`, [userId, `${userId}@scene.test`]);
  await sql(`INSERT INTO canvas_organization_settings
    (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,1,1)`, [organizationId, userId]);
  await sql(`INSERT INTO organization_user_permissions
    (organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
    VALUES ($1,$2,'member','active',1,1,1)`, [organizationId, userId]);
  await sql(`INSERT INTO canvas_projects (id,organization_id,name,slug,status,created_at,updated_at)
    VALUES ($1,$2,'Scene tool project',$1,'active',1,1)`, [projectId, organizationId]);
  await sql(`INSERT INTO canvas_project_members
    (organization_id,project_id,user_id,role,status,can_read,can_write,created_at,updated_at)
    VALUES ($1,$2,$3,'member','active',1,1,1,1)`, [organizationId, projectId, userId]);
  for (const current of workspaces) {
    await fs.mkdir(current.rootPath, { recursive: true });
    await sql(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,project_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',1,1)`, [current.workspaceId, organizationId,
      current.workspaceType, current.ownerUserId, current.projectId, current.rootRelativePath, current.displayName]);
    if (current.workspaceType === 'team') await sql(`INSERT INTO canvas_workspace_members
      (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
      VALUES ($1,$2,$3,'member','active',1,1,0,1,1)`, [organizationId, current.workspaceId, userId]);
    await sql(`INSERT INTO pi_sessions
      (session_id,user_id,agent_id,workspace_id,workspace_type,organization_id,project_id,workspace_root_relative_path,provider,model,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'fixture','fixture',1,1)`, [context(current).sessionId,
      userId, DEFAULT_MANAGED_AGENT_ID, current.workspaceId, current.workspaceType,
      organizationId, current.projectId, current.rootRelativePath]);
  }
}

async function roundTrip(current: WorkspaceContext, other: WorkspaceContext) {
  const createId = `create-call-${current.workspaceType}-${suffix}`;
  const created = success<ExcalidrawDocumentSnapshot>(await invoke(current, 'create_excalidraw_scene',
    { path: 'tool-created.excalidraw' }, createId));
  const duplicate = success<ExcalidrawDocumentSnapshot>(await invoke(current, 'create_excalidraw_scene',
    { path: 'tool-created.excalidraw' }, createId));
  assert.equal(duplicate.documentId, created.documentId, 'Tool call ID must be the default create idempotency key.');
  failure(await invoke(current, 'create_excalidraw_scene', { path: 'different.excalidraw' }, createId), 'EXCALIDRAW_IDEMPOTENCY_CONFLICT');
  assert.ok(created.documentUrl.includes(encodeURIComponent(current.workspaceId)));
  const loaded = success<ExcalidrawDocumentSnapshot>(await invoke(current, 'get_excalidraw_scene',
    { documentId: created.documentId, workspaceId: current.workspaceId }));
  assert.equal(loaded.documentId, created.documentId);
  const editInput = { documentId: loaded.documentId, lifecycleGeneration: loaded.lifecycleGeneration,
    observedSceneSequence: loaded.sceneSequence, actions: [{ type: 'create', element: element('one') }] };
  const editId = `edit-call-${current.workspaceType}-${suffix}`;
  const applied = success<{ operationId: string; status: string; sceneSequence: number;
    checkpoint: { status: string }; reviewRequired: boolean; documentUrl: string }>(
    await invoke(current, 'edit_excalidraw_scene', editInput, editId));
  assert.equal(applied.status, 'applied');
  assert.equal(applied.sceneSequence, 1);
  assert.equal(applied.checkpoint.status, 'saved');
  assert.equal(applied.reviewRequired, false);
  const repeated = success<typeof applied>(await invoke(current, 'edit_excalidraw_scene', editInput, editId));
  assert.equal(repeated.operationId, applied.operationId);
  assert.equal(repeated.sceneSequence, 1);
  failure(await invoke(current, 'edit_excalidraw_scene', { ...editInput,
    actions: [{ type: 'create', element: element('different') }] }, editId), 'EXCALIDRAW_IDEMPOTENCY_CONFLICT');
  const observed = success<ExcalidrawDocumentSnapshot>(await invoke(current, 'get_excalidraw_scene', { path: loaded.path }));
  const target = observed.elements[0];
  const update = { documentId: observed.documentId, lifecycleGeneration: observed.lifecycleGeneration,
    observedSceneSequence: observed.sceneSequence, actions: [{ type: 'update', elementId: target.id,
      expectedVersion: target.version, expectedVersionNonce: target.versionNonce, element: { ...target, x: 20 } }] };
  success(await invoke(current, 'edit_excalidraw_scene', update));
  const review = success<{ status: string; reviewRequired: boolean; reviewAvailable: boolean;
    conflictHint: string; reviewHint: string | null; documentUrl: string }>(
    await invoke(current, 'edit_excalidraw_scene', { ...update,
      actions: [{ ...update.actions[0], element: { ...target, x: 30 } }] }));
  assert.equal(review.status, 'needs_review');
  assert.equal(review.reviewRequired, true);
  assert.match(review.conflictHint, /not been applied/);
  if (review.reviewAvailable) assert.match(review.reviewHint!, /accept or reject/);
  else assert.equal(review.reviewHint, null);
  assert.equal(review.documentUrl, created.documentUrl);
  assert.doesNotMatch(getToolDisplayInfo('edit_excalidraw_scene', 'de', review).label, /aktualisiert/iu);
  assert.equal((await loadExcalidrawScene(created.documentId))!.elements[0].x, 20);
  failure(await invoke(current, 'edit_excalidraw_scene', { ...editInput, lifecycleGeneration: undefined }), 'INVALID_EXCALIDRAW_REQUEST');
  failure(await invoke(current, 'edit_excalidraw_scene', { ...editInput, documentId: undefined }), 'INVALID_EXCALIDRAW_REQUEST');
  failure(await invoke(current, 'edit_excalidraw_scene', { ...editInput, path: 'different.excalidraw' }), 'EXCALIDRAW_DOCUMENT_MISMATCH');
  for (const name of sceneTools) {
    const input = name === 'create_excalidraw_scene' ? { path: 'outside.excalidraw' }
      : name === 'get_excalidraw_scene' ? { documentId: created.documentId } : editInput;
    failure(await invoke(current, name, { ...input, workspaceId: other.workspaceId }), 'EXCALIDRAW_PERMISSION_DENIED');
  }
  await fs.writeFile(path.join(current.rootPath, 'unopened.excalidraw'),
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [element('imported')], appState: {}, files: {} }));
  const read = success<{ collaboration: { documentId: string; lifecycleGeneration: number; sceneSequence: number; canonicalHash: string } }>(
    await invoke(current, 'read', { path: 'unopened.excalidraw', maxChars: 30_000 }));
  const imported = success<ExcalidrawDocumentSnapshot>(await invoke(current, 'get_excalidraw_scene', { path: 'unopened.excalidraw' }));
  assert.equal(read.collaboration.documentId, imported.documentId, 'Generic read must initialize a portable scene without an editor.');
  assert.equal(read.collaboration.canonicalHash, imported.canonicalHash);
  await fs.writeFile(path.join(current.rootPath, 'invalid-image.excalidraw'), JSON.stringify({ type: 'excalidraw',
    version: 2, elements: [{ ...element('missing-image'), type: 'image', fileId: 'missing-file', status: 'saved' }],
    appState: {}, files: {} }));
  failure(await invoke(current, 'read', { path: 'invalid-image.excalidraw' }));
  await sql('UPDATE pi_sessions SET archived_at=1 WHERE session_id=$1 AND user_id=$2', [context(current).sessionId, userId]);
  failure(await invoke(current, 'get_excalidraw_scene', { documentId: created.documentId }), 'EXCALIDRAW_PERMISSION_DENIED');
  failure(await invoke(current, 'read', { path: loaded.path }));
  failure(await invoke(current, 'create_excalidraw_scene', { path: 'archived-session.excalidraw' }), 'EXCALIDRAW_PERMISSION_DENIED');
  await sql('UPDATE pi_sessions SET archived_at=NULL WHERE session_id=$1 AND user_id=$2', [context(current).sessionId, userId]);
  return observed;
}

async function revokeWhileLocked(current: WorkspaceContext, observed: ExcalidrawDocumentSnapshot) {
  const before = await loadExcalidrawScene(observed.documentId);
  assert.ok(before);
  const lock = await openDb();
  let pending: ReturnType<typeof invoke> | undefined;
  try {
    await lock.run('BEGIN');
    await lock.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`excalidraw:${observed.documentId}`]);
    pending = invoke(current, 'edit_excalidraw_scene', { documentId: observed.documentId,
      lifecycleGeneration: observed.lifecycleGeneration, observedSceneSequence: before.sceneSequence,
      actions: [{ type: 'create', element: element('revoked-under-lock') }] }, `revoked-${suffix}`);
    const deadline = Date.now() + 15_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows = await sql(`SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory'
        AND NOT granted AND objid=(hashtext($1)::bigint & 4294967295)`, [`excalidraw:${observed.documentId}`]) as { count: string }[];
      if (Number(rows[0].count) > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(waiting, 'The real tool must reach the PostgreSQL scene lock before revoking access.');
    await lock.run('UPDATE canvas_workspace_members SET can_write=0 WHERE workspace_id=$1 AND user_id=$2',
      [current.workspaceId, userId]);
    await lock.run('COMMIT');
    failure(await pending, 'EXCALIDRAW_PERMISSION_DENIED');
    const after = await loadExcalidrawScene(observed.documentId);
    assert.equal(after!.sceneSequence, before.sceneSequence);
    assert.equal(after!.canonicalHash, before.canonicalHash);
    const operations = await sql('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE document_id=$1 AND idempotency_key=$2',
      [observed.documentId, `revoked-${suffix}`]);
    assert.equal(operations.length, 0, 'Revocation while waiting must leave no operation receipt or scene change.');
    failure(await invoke(current, 'create_excalidraw_scene', { path: 'revoked-create.excalidraw' }), 'EXCALIDRAW_PERMISSION_DENIED');
    success(await invoke(current, 'get_excalidraw_scene', { documentId: observed.documentId }));
  } finally {
    await lock.run('ROLLBACK').catch(() => undefined);
    await lock.close();
    await pending?.catch(() => undefined);
    await sql('UPDATE canvas_workspace_members SET can_write=1 WHERE workspace_id=$1 AND user_id=$2',
      [current.workspaceId, userId]);
  }
}

async function revokeReadWhileRowLocked(current: WorkspaceContext, observed: ExcalidrawDocumentSnapshot) {
  const filePath = path.join(current.rootPath, observed.path);
  const original = await fs.readFile(filePath);
  for (const name of ['get_excalidraw_scene', 'read']) {
    const before = await loadExcalidrawScene(observed.documentId);
    assert.ok(before);
    const historyBefore = await sql('SELECT id FROM file_revisions WHERE workspace_id=$1 AND path=$2',
      [current.workspaceId, observed.path]);
    await fs.writeFile(filePath, JSON.stringify({ type: 'excalidraw', version: 2,
      elements: [element(`foreign-${name}`)], appState: {}, files: {} }));
    const lock = await openDb();
    let pending: ReturnType<typeof invoke> | undefined;
    try {
      await lock.run('BEGIN');
      const owner = await lock.get('SELECT pg_backend_pid() AS pid') as { pid: number };
      await lock.get('SELECT document_id FROM collaboration_excalidraw_states WHERE document_id=$1 FOR UPDATE',
        [observed.documentId]);
      pending = invoke(current, name, name === 'read' ? { path: observed.path }
        : { documentId: observed.documentId });
      const deadline = Date.now() + 15_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const blocked = await sql(`SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [owner.pid]) as { count: string }[];
        if (Number(blocked[0].count) > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(waiting, 'The actual Pi read must wait on the PostgreSQL scene row after its initial authority check.');
      await lock.run('UPDATE canvas_workspace_members SET can_read=0,can_write=0 WHERE workspace_id=$1 AND user_id=$2',
        [current.workspaceId, userId]);
      await lock.run('COMMIT');
      failure(await pending, name === 'read' ? undefined : 'EXCALIDRAW_PERMISSION_DENIED');
      const after = await loadExcalidrawScene(observed.documentId);
      assert.equal(after!.degradedReason, before.degradedReason,
        'A revoked read must not modify checkpoint metadata before reporting denial.');
      assert.equal(after!.canonicalHash, before.canonicalHash);
      assert.equal((await sql('SELECT id FROM file_revisions WHERE workspace_id=$1 AND path=$2',
        [current.workspaceId, observed.path])).length, historyBefore.length,
      'A revoked read must not retain newly observed external bytes in history.');
    } finally {
      await lock.run('ROLLBACK').catch(() => undefined);
      await lock.close();
      await pending?.catch(() => undefined);
      await sql('UPDATE canvas_workspace_members SET can_read=1,can_write=1 WHERE workspace_id=$1 AND user_id=$2',
        [current.workspaceId, userId]);
      await fs.writeFile(filePath, original);
    }
  }
}

function catalogs() {
  const names = getProgressiveGatewayCapabilityNames(piTools);
  for (const name of sceneTools) {
    assert.ok(names.includes(name), `Capability catalog is missing ${name}`);
    assert.ok(getPiToolsetsForTool(name).includes('file'));
  }
  const readOnly = filterToolsForWorkspacePermissions(piTools, { canWrite: false, canDelete: false, canShare: false });
  assert.ok(readOnly.some(tool => tool.name === 'get_excalidraw_scene'));
  assert.ok(!readOnly.some(tool => tool.name === 'create_excalidraw_scene' || tool.name === 'edit_excalidraw_scene'));
  const planning = filterToolsForPlanningMode(piTools);
  assert.ok(planning.some(tool => tool.name === 'get_excalidraw_scene'));
  assert.ok(!planning.some(tool => tool.name === 'create_excalidraw_scene' || tool.name === 'edit_excalidraw_scene'));
}

async function unavailableProvider() {
  const current = workspace('personal');
  failure(await invoke(current, 'create_excalidraw_scene', { path: 'unavailable.excalidraw' }), 'EXCALIDRAW_PROVIDER_UNAVAILABLE');
  failure(await invoke(current, 'get_excalidraw_scene', { path: 'unavailable.excalidraw' }), 'EXCALIDRAW_PROVIDER_UNAVAILABLE');
  failure(await invoke(current, 'edit_excalidraw_scene', { documentId: 'unavailable-document', lifecycleGeneration: 1,
    observedSceneSequence: 0, actions: [{ type: 'create', element: element('unavailable') }] }), 'EXCALIDRAW_PROVIDER_UNAVAILABLE');
}

async function main() {
  if (process.argv.includes('--provider-unavailable')) { await unavailableProvider(); return; }
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const workspaces = (['personal', 'organization', 'team', 'project'] as const).map(workspace);
  try {
    await seed(workspaces);
    catalogs();
    const scenes: ExcalidrawDocumentSnapshot[] = [];
    for (let index = 0; index < workspaces.length; index += 1) {
      scenes.push(await roundTrip(workspaces[index], workspaces[(index + 1) % workspaces.length]));
    }
    await revokeWhileLocked(workspaces[2], scenes[2]);
    await revokeReadWhileRowLocked(workspaces[2], scenes[2]);
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
        'scripts/excalidraw-agent-tools-test.ts', '--provider-unavailable'],
      { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
      child.once('error', reject);
      child.once('exit', status => status === 0 ? resolve() : reject(new Error(`Provider adapter regression failed: ${output}`)));
    });
    console.log(JSON.stringify({ success: true, actualTools: sceneTools,
      workspaces: workspaces.map(current => current.workspaceType), toolCallIdIdempotency: true,
      genericReadBeforeEditor: true, mandatoryIdentity: true, unauthorizedWorkspaceOverride: true,
      freshSessionAccess: true, revocationUnderSceneLock: true, noPartialMutationOnRevocation: true,
      revokedReadUnderSceneRowLock: true, noReadHistorySideEffectsOnRevocation: true,
      reviewStatusAndLink: true, catalogsAndPolicies: true, providerUnavailable: true }));
  } finally {
    for (const current of workspaces) {
      await sql("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [current.workspaceId]).catch(() => undefined);
      await sql('UPDATE pi_sessions SET archived_at=1 WHERE user_id=$1 AND session_id=$2', [userId, context(current).sessionId]).catch(() => undefined);
      await fs.rm(current.rootPath, { recursive: true, force: true });
    }
  }
}

void main().finally(() => process.argv.includes('--provider-unavailable') ? undefined : closeDatabaseConnections());
