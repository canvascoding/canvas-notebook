import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server';
import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import * as sceneService from '@/app/lib/excalidraw-collaboration/scene-service';
import * as mobile from '@/app/lib/mobile/excalidraw';
import * as http from '@/app/lib/excalidraw-collaboration/http';
import * as policy from '@/app/lib/files/collaboration-policy';
import * as routeHelpers from '@/app/lib/api/route-helpers';
import { importExcalidrawDocumentFile } from '@/app/lib/excalidraw-collaboration/portable-import';
import { applyExcalidrawScenePatch } from '@/app/lib/excalidraw-collaboration/repository';
import { ensureExcalidrawCheckpointsCurrent } from '@/app/lib/excalidraw-collaboration/checkpoint-worker';
import { runWorkspaceUploadWrite } from '@/app/lib/files/workspace-upload-flow';
import * as mutationLock from '@/app/lib/files/workspace-mutation-lock';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';

const requireDependency = createRequire(import.meta.url);
const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const userId = `clients-user-${suffix}`;
const organizationId = `clients-org-${suffix}`;
const actor = { userId, actorId: `user:${userId}`, actorType: 'user' as const, sessionId: `clients-session-${suffix}` };

function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
  const javascript = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluated = { exports: {} };
  const localRequire = createRequire(path.resolve(filename));
  const load = (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name]
    : name.startsWith('.') ? localRequire(name) : requireDependency(name);
  new Function('require', 'module', 'exports', javascript)(load, evaluated, evaluated.exports);
  return evaluated.exports as T;
}

async function execute(sql: string, params: unknown[] = []) {
  const database = await openDb();
  try { await database.run(sql, params); } finally { await database.close(); }
}

async function count(sql: string, params: unknown[] = []) {
  const database = await openDb();
  try { return Number((await database.get(sql, params) as { count: string }).count); } finally { await database.close(); }
}

function workspace(type: 'personal' | 'team'): WorkspaceContext {
  const rootRelativePath = `workspaces/excalidraw-clients/${suffix}/${type}/files`;
  return { workspaceId: `clients-${type}-${suffix}`, workspaceType: type, organizationId,
    ownerUserId: type === 'personal' ? userId : null, rootRelativePath,
    rootPath: workspaceAbsoluteRoot(rootRelativePath), displayName: `Clients ${type}`, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true } };
}

function element(id: string, extra: Record<string, unknown> = {}): ExcalidrawElementRecord {
  return { id, type: 'rectangle', version: 1, versionNonce: 10, isDeleted: false,
    x: 0, y: 0, width: 100, height: 80, angle: 0, opacity: 100, groupIds: [], boundElements: [], ...extra };
}

function portable(elements: ExcalidrawElementRecord[] = [], files: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: { viewBackgroundColor: '#ffffff' }, files });
}

function routes(current: WorkspaceContext) {
  const state = { canRead: true, canWrite: true, resolves: 0, revokeAt: 0 };
  const requestWorkspace = { workspaceFileOptions: (workspace: WorkspaceContext) => ({ workspace }),
    requireRequestWorkspace: async (request: NextRequest, options: { permissions: 'canRead' | 'canWrite' }) => {
      state.resolves += 1;
      if (state.revokeAt === state.resolves) state.canWrite = false;
      if (request.headers.get('authorization') !== 'Bearer fixture-session') return { response: NextResponse.json({ success: false }, { status: 401 }) };
      if (!state[options.permissions]) return { response: NextResponse.json({ success: false }, { status: 403 }) };
      const workspace = { ...current, permissions: { ...current.permissions, canRead: state.canRead, canWrite: state.canWrite } };
      return { response: null, workspace, session: { user: { id: userId }, session: { id: actor.sessionId } } };
    },
  };
  const helpers = { ...routeHelpers, applyRateLimit: () => null };
  const evaluatedHttp = loadModule<typeof http>('app/lib/excalidraw-collaboration/http.ts', {
    'server-only': {}, 'next/server': { NextRequest, NextResponse },
    '@/app/lib/workspaces/request': requestWorkspace, '@/app/lib/api/route-helpers': helpers,
    './scene-service': sceneService,
  });
  const deps = { 'next/server': { NextRequest, NextResponse },
    '@/app/lib/workspaces/request': requestWorkspace, '@/app/lib/api/route-helpers': helpers,
    '@/app/lib/excalidraw-collaboration/http': evaluatedHttp,
    '@/app/lib/mobile/excalidraw': mobile,
    '@/app/lib/excalidraw-collaboration/scene-service': sceneService,
    '@/app/lib/utils/rate-limit': { rateLimit: () => ({ ok: true }) },
    '@/app/lib/files/workspace-mutation-lock': mutationLock,
  };
  const mobileRoute = loadModule<{ GET(request: NextRequest): Promise<NextResponse>; PUT(request: NextRequest): Promise<NextResponse> }>(
    'app/api/mobile/v1/files/excalidraw/route.ts', deps);
  const createRoute = loadModule<{ POST(request: NextRequest): Promise<NextResponse> }>('app/api/files/create/route.ts', deps);
  const readRoute = loadModule<{ GET(request: NextRequest): Promise<NextResponse> }>('app/api/files/read/route.ts', deps);
  const downloadRoute = loadModule<{ GET(request: NextRequest): Promise<NextResponse> }>('app/api/files/download/route.ts', {
    ...deps, '@/app/lib/admin-auth': { isAdminUser: () => false },
  });
  const uploadRoute = loadModule<{ POST(request: NextRequest): Promise<NextResponse> }>('app/api/files/upload/route.ts', deps);
  const request = (url: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost:3001${url}`, {
    method, headers: { authorization: 'Bearer fixture-session', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { state, mobileRoute, createRoute, readRoute, downloadRoute, uploadRoute, request };
}

async function clients(current: WorkspaceContext) {
  const fileOptions = { workspace: current };
  const { state, createRoute, readRoute, mobileRoute, downloadRoute, request } = routes(current);
  const createdResponse = await createRoute.POST(request('/api/files/create', 'POST', { path: 'drawing.excalidraw', type: 'file' }));
  assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
  const created = await sceneService.getExcalidrawDocument({ workspace: current, path: 'drawing.excalidraw' });
  assert.equal((await policy.getFileCollaborationState({ workspace: current, path: created.path })).sceneCapable, true);
  const mobileRead = await mobileRoute.GET(request(`/api/mobile/v1/files/excalidraw?path=${created.path}`));
  assert.equal(mobileRead.status, 200, await mobileRead.clone().text());
  const initial = (await mobileRead.json()).document as mobile.MobileExcalidrawDocument;
  assert.equal(initial.documentId, created.documentId);
  assert.deepEqual(JSON.parse(initial.content).canvasDocument, { documentId: created.documentId, lifecycleGeneration: created.lifecycleGeneration });
  const incoming = portable([element('mobile-first'), element('mobile-delete')]);
  const savedResponse = await mobileRoute.PUT(request('/api/mobile/v1/files/excalidraw', 'PUT', {
    path: created.path, content: incoming, expectedSha256: initial.sha256, baseRevisionId: initial.revisionId,
    baseSceneSequence: initial.sceneSequence,
  }));
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const saved = (await savedResponse.json()).document as mobile.MobileExcalidrawDocument;
  assert.equal(saved.sceneSequence, 1);
  assert.equal(saved.checkpoint.status, 'saved');
  const replacement = portable([element('mobile-first', { x: 99 })]);
  const changed = await mobile.saveMobileExcalidrawDocument({ workspace: current, fileOptions,
    actorUserId: userId, actorSessionId: actor.sessionId, path: created.path, content: replacement,
    baseSceneSequence: saved.sceneSequence, documentId: saved.documentId, lifecycleGeneration: saved.lifecycleGeneration,
    expectedSha256: undefined, baseRevisionId: undefined });
  const persisted = await sceneService.getExcalidrawDocument({ workspace: current, documentId: created.documentId });
  assert.equal(persisted.elements.find(entry => entry.id === 'mobile-first')?.x, 99);
  assert.equal(persisted.elements.find(entry => entry.id === 'mobile-first')?.version, 2);
  assert.equal(persisted.elements.find(entry => entry.id === 'mobile-delete')?.isDeleted, true);
  const staleResponse = await mobileRoute.PUT(request('/api/mobile/v1/files/excalidraw', 'PUT', {
    path: created.path, content: replacement, baseSceneSequence: initial.sceneSequence,
    documentId: created.documentId, lifecycleGeneration: created.lifecycleGeneration,
  }));
  assert.equal(staleResponse.status, 409);
  const staleLifecycle = { ...changed };
  await execute('UPDATE collaboration_excalidraw_states SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1', [created.documentId]);
  const regenerated = await mobile.readMobileExcalidrawDocument({ workspace: current, fileOptions, path: created.path });
  assert.equal(regenerated.revisionId, staleLifecycle.revisionId, 'Fixture deliberately retains the same checkpoint revision.');
  assert.notEqual(regenerated.sha256, staleLifecycle.sha256);
  await assert.rejects(mobile.saveMobileExcalidrawDocument({ workspace: current, fileOptions, actorUserId: userId,
    actorSessionId: actor.sessionId, path: created.path, content: replacement, expectedSha256: staleLifecycle.sha256,
    baseRevisionId: staleLifecycle.revisionId, baseSceneSequence: staleLifecycle.sceneSequence }), { code: 'EXCALIDRAW_DOCUMENT_MISMATCH' });
  await assert.rejects(mobile.saveMobileExcalidrawDocument({ workspace: current, fileOptions, actorUserId: userId,
    actorSessionId: actor.sessionId, path: created.path, content: replacement, expectedSha256: undefined,
    baseRevisionId: undefined, baseSceneSequence: staleLifecycle.sceneSequence,
    documentId: staleLifecycle.documentId, lifecycleGeneration: staleLifecycle.lifecycleGeneration }), { code: 'EXCALIDRAW_LIFECYCLE_STALE' });
  const latest = await sceneService.getExcalidrawDocument({ workspace: current, documentId: created.documentId });
  const target = latest.elements.find(entry => entry.id === 'mobile-first')!;
  await applyExcalidrawScenePatch({ documentId: latest.documentId, lifecycleGeneration: latest.lifecycleGeneration,
    baseSequence: latest.sceneSequence, messageId: `pending-${suffix}`, elements: [{ ...target, x: 321,
      version: target.version + 1, versionNonce: 6 }], actorType: 'user', actorId: userId });
  const beforeReadHistory = await count('SELECT count(*) FROM file_revisions WHERE workspace_id=$1', [current.workspaceId]);
  const read = await readRoute.GET(request(`/api/files/read?path=${created.path}`));
  assert.equal(read.status, 200, await read.clone().text());
  const data = (await read.json()).data;
  assert.equal(JSON.parse(data.content).elements.find((entry: ExcalidrawElementRecord) => entry.id === 'mobile-first').x, 321);
  assert.equal(data.checkpoint.status, 'pending');
  assert.equal(await count('SELECT count(*) FROM file_revisions WHERE workspace_id=$1', [current.workspaceId]), beforeReadHistory);
  const downloaded = await downloadRoute.GET(request(`/api/files/download?path=${created.path}`));
  assert.equal(downloaded.status, 200, await downloaded.clone().text());
  assert.equal(JSON.parse(await downloaded.text()).elements.find((entry: ExcalidrawElementRecord) => entry.id === 'mobile-first').x, 321);
  const currentMobile = await mobile.readMobileExcalidrawDocument({ workspace: current, fileOptions, path: created.path });
  state.resolves = 0;
  state.revokeAt = 3;
  const revoked = await mobileRoute.PUT(request('/api/mobile/v1/files/excalidraw', 'PUT', {
    path: created.path, content: portable([element('denied')]), documentId: currentMobile.documentId,
    lifecycleGeneration: currentMobile.lifecycleGeneration, baseSceneSequence: currentMobile.sceneSequence,
  }));
  assert.equal(revoked.status, 403, await revoked.clone().text());
  assert.equal((await sceneService.getExcalidrawDocument({ workspace: current, documentId: created.documentId })).sceneSequence, currentMobile.sceneSequence);
  state.canWrite = true;
  state.revokeAt = 0;
  const malformed = await mobileRoute.PUT(new NextRequest('http://localhost:3001/api/mobile/v1/files/excalidraw', {
    method: 'PUT', headers: { authorization: 'Bearer fixture-session' }, body: '{',
  }));
  assert.equal(malformed.status, 400);
  await fs.writeFile(path.join(current.rootPath, created.path), portable([element('foreign')]));
  await assert.rejects(ensureExcalidrawCheckpointsCurrent({ workspaceId: current.workspaceId, paths: [created.path] }));
  const blockedDownload = await downloadRoute.GET(request(`/api/files/download?path=${created.path}`));
  assert.equal(blockedDownload.status, 409);
}

async function uploads(current: WorkspaceContext) {
  const fileOptions = { workspace: current };
  let genericWriteCalled = false;
  const content = Buffer.from(portable([element('upload-element')]));
  await runWorkspaceUploadWrite({ workspace: current, fileOptions, actorUserId: userId, targetPath: 'upload.excalidraw', content,
    write: async () => { genericWriteCalled = true; throw new Error('Uncontrolled upload write must not run.'); } });
  assert.equal(genericWriteCalled, false);
  const imported = await sceneService.getExcalidrawDocument({ workspace: current, path: 'upload.excalidraw' });
  assert.equal(imported.elements[0].id, 'upload-element');
  const before = await fs.readFile(path.join(current.rootPath, imported.path));
  await assert.rejects(runWorkspaceUploadWrite({ workspace: current, fileOptions, actorUserId: userId,
    targetPath: imported.path, content, write: async () => { throw new Error('Must not run'); } }), { code: 'PATH_EXISTS' });
  assert.deepEqual(await fs.readFile(path.join(current.rootPath, imported.path)), before);
  await fs.unlink(path.join(current.rootPath, imported.path));
  await assert.rejects(importExcalidrawDocumentFile({ workspace: current, path: imported.path, actor, content }), { code: 'PATH_EXISTS' });
  await assert.rejects(fs.stat(path.join(current.rootPath, imported.path)), { code: 'ENOENT' });
  await fs.writeFile(path.join(current.rootPath, 'foreign.excalidraw'), content);
  await assert.rejects(importExcalidrawDocumentFile({ workspace: current, path: 'foreign.excalidraw', actor, content }), { code: 'PATH_EXISTS' });
  await assert.rejects(importExcalidrawDocumentFile({ workspace: current, path: 'invalid.excalidraw', actor,
    content: portable([element('missing-image', { type: 'image', fileId: 'missing' })]) }), { code: 'INVALID_EXCALIDRAW_SCENE' });
  await assert.rejects(fs.stat(path.join(current.rootPath, 'invalid.excalidraw')), { code: 'ENOENT' });
  const staged = path.join(current.rootPath, 'portable-source.tmp');
  await fs.writeFile(staged, content);
  const fromSource = await importExcalidrawDocumentFile({ workspace: current, path: 'staged.excalidraw', actor, sourcePath: staged });
  assert.equal(fromSource.elements[0].id, 'upload-element');
  assert.notEqual(fromSource.documentId, imported.documentId);
  const { uploadRoute, state } = routes(current);
  const upload = (filename = 'route-upload.excalidraw') => {
    const form = new FormData();
    form.append('files', new File([content], filename, { type: 'application/octet-stream' }));
    return new NextRequest('http://localhost:3001/api/files/upload', {
      method: 'POST', headers: { authorization: 'Bearer fixture-session' }, body: form,
    });
  };
  const routeImported = await uploadRoute.POST(upload());
  assert.equal(routeImported.status, 200, await routeImported.clone().text());
  assert.equal((await sceneService.getExcalidrawDocument({ workspace: current, path: 'route-upload.excalidraw' })).elements[0].id, 'upload-element');
  const overwrite = await uploadRoute.POST(upload());
  assert.equal(overwrite.status, 409, await overwrite.clone().text());
  assert.equal((await overwrite.json()).code, 'PATH_EXISTS');
  state.resolves = 0;
  state.revokeAt = 3; // Initial resolver and admission allow; staged publication is revoked.
  const revoked = await uploadRoute.POST(upload('late-revoked.excalidraw'));
  assert.equal(revoked.status, 403, await revoked.clone().text());
  await assert.rejects(fs.stat(path.join(current.rootPath, 'late-revoked.excalidraw')), { code: 'ENOENT' });
  assert.equal((await policy.getFileCollaborationState({ workspace: current, path: 'late-revoked.excalidraw' })).document, null);
  assert.equal((await fs.readdir(current.rootPath)).some(name => name.startsWith('late-revoked.excalidraw.canvas-create-')), false);
}

async function allCheckpointPages() {
  const documentIds = Array.from({ length: 231 }, (_, index) => `document-${String(index).padStart(4, '0')}`);
  const visited: string[] = [];
  const cursors: string[] = [];
  let fail = false;
  const worker = loadModule<{ ensureExcalidrawCheckpointsCurrent(options: { workspaceId: string; paths: string[] }): Promise<void> }>(
    'app/lib/excalidraw-collaboration/checkpoint-worker.ts', {
      'server-only': {}, '@/app/lib/db': { openDb: async () => ({
        all: async (_sql: string, params: [string, string, string[], number, boolean]) => {
          assert.equal(params[4], true, 'Saved checkpoints require forceValidation too.');
          assert.deepEqual(params[2], ['drawings']);
          cursors.push(params[1]);
          return documentIds.filter(id => id > params[1]).slice(0, params[3])
            .map(document_id => ({ document_id, workspace_id: 'pagination' }));
        },
        get: async () => ({ id: 'pagination', type: 'personal', root_relative_path: 'workspaces/pagination/files' }),
        close: async () => undefined,
      }) },
      './repository': { loadExcalidrawScene: async (documentId: string) => ({ documentId }) },
      './checkpoint': { materializeExcalidrawCheckpoint: async ({ state }: { state: { documentId: string } }) => {
        visited.push(state.documentId);
        if (fail && state.documentId === documentIds[202]) throw new Error('Checkpoint conflict must block this consumer.');
      } },
    });
  await worker.ensureExcalidrawCheckpointsCurrent({ workspaceId: 'pagination', paths: ['drawings'] });
  assert.deepEqual(visited, documentIds);
  assert.deepEqual(cursors, ['', documentIds[99], documentIds[199], documentIds[230]]);
  fail = true;
  visited.length = 0;
  await assert.rejects(worker.ensureExcalidrawCheckpointsCurrent({ workspaceId: 'pagination', paths: ['drawings'] }), {
    code: 'EXCALIDRAW_CHECKPOINT_NOT_CURRENT', status: 503,
  });
  assert.ok(visited.includes(documentIds[202]), 'A conflict beyond the first two pages must not be omitted.');
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const workspaces = [workspace('personal'), workspace('team')];
  await execute(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Excalidraw clients',$2,1,1,1)`, [userId, `${userId}@clients.test`]);
  await execute(`INSERT INTO canvas_organization_settings
    (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ($1,$2,'team',1,1,1)`, [organizationId, userId]);
  try {
    await allCheckpointPages();
    for (const current of workspaces) {
      await fs.mkdir(current.rootPath, { recursive: true });
      await execute(`INSERT INTO canvas_workspaces
        (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'active',1,1)`, [current.workspaceId, organizationId, current.workspaceType,
        current.ownerUserId ?? null, current.rootRelativePath, current.displayName]);
      await clients(current);
      await uploads(current);
    }
    console.log(JSON.stringify({ success: true, nativePostgres: true, substitutedIdentityIO: true,
      workspaces: ['personal', 'team'], mobileSnapshotPatches: true, lifecycleBoundLegacyHash: true,
      authoritativeRead: true, downloadFreshness: true, allCheckpointPages: true,
      controlledUploads: true, noWholeFileWrites: true }));
  } finally {
    for (const current of workspaces) {
      await execute('DELETE FROM collaboration_excalidraw_creates WHERE workspace_id=$1', [current.workspaceId]).catch(() => undefined);
      await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [current.workspaceId]).catch(() => undefined);
      await fs.rm(current.rootPath, { recursive: true, force: true });
    }
  }
}

void main().finally(closeDatabaseConnections);
