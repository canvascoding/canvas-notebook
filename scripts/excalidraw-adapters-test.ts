import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import * as sdk from '@modelcontextprotocol/server';
import ts from 'typescript';

import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import * as apiContract from '@/app/lib/excalidraw-collaboration/api-contract';
import * as sceneService from '@/app/lib/excalidraw-collaboration/scene-service';
import * as provider from '@/app/lib/excalidraw-collaboration/provider';
import { applyExcalidrawScenePatch } from '@/app/lib/excalidraw-collaboration/repository';
import * as mutationLock from '@/app/lib/files/workspace-mutation-lock';
import { jsonDatabaseUnavailable } from '@/app/lib/api/route-helpers';
import { DirectMcpAuthorizationError, type DirectMcpAccessPrincipal } from '@/app/lib/mcp/server/access-token-verifier';
import * as config from '@/app/lib/mcp/server/config';
import type { DirectMcpToolDescriptor } from '@/app/lib/mcp/server/tool-descriptor';
import type { DirectMcpExcalidrawTool } from '@/app/lib/mcp/server/excalidraw-authority';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';
import type { ExcalidrawDocumentSnapshot } from '@/app/lib/excalidraw-collaboration/scene-service';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';

const requireDependency = createRequire(import.meta.url);
const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const userId = `adapter-user-${suffix}`;
const organizationId = `adapter-org-${suffix}`;

/** Complete production adapters execute with only identity/policy IO replaced.
 * Scene persistence, workspace locks, checkpoints and history use native PG. */
function loadModule<T>(filename: string, dependencies: Record<string, unknown>): T {
  const absolutePath = path.resolve(filename);
  const javascript = ts.transpileModule(readFileSync(absolutePath, 'utf8'), {
    fileName: absolutePath, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluatedModule = { exports: {} };
  const load = (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireDependency(name);
  new Function('require', 'module', 'exports', javascript)(load, evaluatedModule, evaluatedModule.exports);
  return evaluatedModule.exports as T;
}

function element(id: string, extra: Record<string, unknown> = {}): ExcalidrawElementRecord {
  return { id, type: 'rectangle', version: 1, versionNonce: 100, isDeleted: false,
    x: 0, y: 0, width: 100, height: 80, angle: 0, opacity: 100, groupIds: [], boundElements: [], ...extra };
}

async function execute(sql: string, params: unknown[] = []): Promise<void> {
  const database = await openDb();
  try { await database.run(sql, params); } finally { await database.close(); }
}

async function rows(sql: string, params: unknown[] = []): Promise<unknown[]> {
  const database = await openDb();
  try { return await database.all(sql, params); } finally { await database.close(); }
}

function workspace(type: 'personal' | 'team'): WorkspaceContext {
  const rootRelativePath = `workspaces/excalidraw-adapters/${suffix}/${type}/files`;
  return { workspaceId: `adapter-${type}-${suffix}`, workspaceType: type, organizationId,
    ownerUserId: type === 'personal' ? userId : null, rootRelativePath,
    rootPath: workspaceAbsoluteRoot(rootRelativePath), displayName: `Adapters ${type}`, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true } };
}

type ToolExports = {
  getDirectMcpExcalidrawToolDefinitions(): Array<{ id: DirectMcpExcalidrawTool; descriptor: DirectMcpToolDescriptor;
    execute(args: unknown, auth?: sdk.AuthInfo, signal?: AbortSignal): Promise<sdk.CallToolResult> }>;
  executeDirectMcpExcalidrawTool(id: DirectMcpExcalidrawTool, args: unknown, auth?: sdk.AuthInfo, signal?: AbortSignal): Promise<sdk.CallToolResult>;
};
type Route = { POST(request: NextRequest, context?: { params: Promise<{ documentId: string }> }): Promise<NextResponse> };
type GetRoute = { GET(request: NextRequest, context: { params: Promise<{ documentId: string }> }): Promise<NextResponse> };

function fixture(current: WorkspaceContext) {
  const state = { canRead: true, canWrite: true, canRunAgent: true, sessionId: `session-${suffix}`,
    actorUserId: userId, rootPath: current.rootPath, sessionAllowed: true, resolverCalls: 0,
    mutateOnResolve: undefined as undefined | { call: number; apply(): void },
    limited: false, workspaceResolutionError: false,
    mcpEnabled: true, enabledTools: ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene'] as string[],
    allowed: true, workspaceEnabled: true, clientId: `client-${suffix}`, expiresAt: Math.floor(Date.now() / 1000) + 600,
    scopes: ['knowledge:read', 'knowledge:write'], verifyCalls: 0, requestedScopes: [] as string[][],
    mutateOnVerify: undefined as undefined | { call: number; apply(): void } };
  const resolvedWorkspace = () => ({ ...current, rootPath: state.rootPath,
    permissions: { ...current.permissions, canRead: state.canRead, canWrite: state.canWrite, canRunAgent: state.canRunAgent } });
  const requestWorkspace = {
    requireRequestWorkspace: async (request: NextRequest, options: { workspaceId?: string; permissions: 'canRead' | 'canWrite' }) => {
      state.resolverCalls += 1;
      if (state.mutateOnResolve?.call === state.resolverCalls) state.mutateOnResolve.apply();
      const authorized = request.headers.get('cookie') === 'session=fixture-session'
        || request.headers.get('authorization') === 'Bearer fixture-session';
      if (!authorized || !state.sessionAllowed) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
      if (state.workspaceResolutionError) return { response: NextResponse.json({ success: false, error: 'Workspace resolution failed' }, { status: 500 }) };
      if (options.workspaceId && options.workspaceId !== current.workspaceId) return { response: NextResponse.json({ success: false, error: 'Workspace unavailable' }, { status: 404 }) };
      if (!state[options.permissions]) return { response: NextResponse.json({ success: false, error: 'Workspace permission denied' }, { status: 403 }) };
      return { response: null, workspace: resolvedWorkspace(), session: {
        user: { id: state.actorUserId }, session: { id: state.sessionId },
      } };
    },
  };
  const helpers = { jsonDatabaseUnavailable, applyRateLimit: () => state.limited
    ? NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 }) : null };
  const http = loadModule<Record<string, unknown>>('app/lib/excalidraw-collaboration/http.ts', {
    'server-only': {}, 'next/server': { NextRequest, NextResponse },
    '@/app/lib/api/route-helpers': helpers, '@/app/lib/workspaces/request': requestWorkspace,
    '@/app/lib/workspaces/constants': { WORKSPACE_ID_HEADER: 'x-canvas-workspace-id' },
    './scene-service': sceneService, './api-contract': apiContract, './provider': provider,
  });
  const dependencies = { 'next/server': { NextRequest, NextResponse },
    '@/app/lib/api/route-helpers': helpers,
    '@/app/lib/excalidraw-collaboration/api-contract': apiContract,
    '@/app/lib/excalidraw-collaboration/http': http,
    '@/app/lib/excalidraw-collaboration/scene-service': sceneService,
    '@/app/lib/files/workspace-mutation-lock': mutationLock,
  };
  const create = loadModule<Route>('app/api/excalidraw/scenes/route.ts', dependencies);
  const get = loadModule<GetRoute>('app/api/excalidraw/scenes/[documentId]/route.ts', dependencies);
  const edit = loadModule<Route>('app/api/excalidraw/scenes/[documentId]/operations/route.ts', dependencies);
  const verifier = { DirectMcpAuthorizationError,
    verifyDirectMcpAccessToken: async (token: string, requested: string[]) => {
      state.verifyCalls += 1;
      state.requestedScopes.push(requested);
      if (state.mutateOnVerify?.call === state.verifyCalls) state.mutateOnVerify.apply();
      if (token !== 'fixture-oauth') throw new DirectMcpAuthorizationError('invalid_token', 401, 'Invalid token.');
      if (requested.some(scope => !state.scopes.includes(scope))) {
        throw new DirectMcpAuthorizationError('insufficient_scope', 403, 'Additional scope required.');
      }
      return { userId: state.actorUserId, subject: state.actorUserId, clientId: state.clientId,
        sessionId: state.sessionId, expiresAt: state.expiresAt, scopes: state.scopes,
        issuer: 'https://fixture.test/api/auth', audience: 'https://fixture.test/mcp', issuedAt: Date.now() / 1000,
        payload: {}, clientName: 'Fixture MCP' } satisfies DirectMcpAccessPrincipal;
    },
  };
  const authority = loadModule<Record<string, unknown>>('app/lib/mcp/server/excalidraw-authority.ts', {
    'server-only': {}, './access-token-verifier': verifier,
    '@/app/lib/excalidraw-collaboration/scene-service': sceneService,
    './runtime-settings': { getDirectMcpRuntimeSettings: async () => ({ enabled: state.mcpEnabled, tools: state.enabledTools }) },
    './workspace-access-policy': {
      isDirectMcpReadableWorkspace: (candidate: WorkspaceContext) => candidate.permissions.canRead && candidate.status === 'active',
      loadDirectMcpWorkspaceListingForUser: async () => ({ workspaces: [resolvedWorkspace()] }),
      listDirectMcpAllowedWorkspaceIds: async () => new Set(state.allowed ? [current.workspaceId] : []),
      listDirectMcpEnabledWorkspaceIds: async () => new Set(state.workspaceEnabled ? [current.workspaceId] : []),
    },
  });
  const toolAuth = loadModule<Record<string, unknown>>('app/lib/mcp/server/tool-auth.ts', {
    'server-only': {}, '@/app/lib/mcp/server/access-token-verifier': verifier,
  });
  const tools = loadModule<ToolExports>('app/lib/mcp/server/excalidraw-tools.ts', {
    'server-only': {}, ...dependencies, './access-token-verifier': verifier,
    './excalidraw-authority': authority, './tool-auth': toolAuth,
  });
  const request = (url: string, body?: unknown, authentication: 'cookie' | 'bearer' | 'oauth' | 'none' = 'cookie', headers: Record<string, string> = {}) => {
    const credentials = authentication === 'cookie' ? { cookie: 'session=fixture-session' }
      : authentication === 'bearer' ? { authorization: 'Bearer fixture-session' }
        : authentication === 'oauth' ? { authorization: 'Bearer fixture-oauth' } : {};
    return new NextRequest(`http://localhost:3001${url}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...credentials, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { state, create, get, edit, tools, http, request };
}

async function success(response: NextResponse, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.success, true);
  return body;
}

function toolSuccess(result: sdk.CallToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

function toolFailure(result: sdk.CallToolResult, code?: string) {
  assert.equal(result.isError, true);
  if (code) assert.equal(result.structuredContent?.code, code);
}

async function rest(current: WorkspaceContext) {
  const { state, create, get, edit, request } = fixture(current);
  const input = { workspaceId: current.workspaceId, path: 'rest.excalidraw', idempotencyKey: `rest-create-${suffix}` };
  const created = (await success(await create.POST(request('/api/excalidraw/scenes', input)), 201)).document as ExcalidrawDocumentSnapshot;
  assert.equal(created.workspaceId, current.workspaceId);
  assert.ok(created.documentUrl.includes(encodeURIComponent(current.workspaceId)));
  state.sessionId = `renewed-session-${suffix}`;
  const replay = (await success(await create.POST(request('/api/excalidraw/scenes', input, 'bearer')), 201)).document;
  assert.equal(replay.documentId, created.documentId, 'User create identity must survive a renewed Canvas session.');
  const context = { params: Promise.resolve({ documentId: created.documentId }) };
  const sceneURL = `/api/excalidraw/scenes/${created.documentId}?workspaceId=${current.workspaceId}`;
  const loaded = (await success(await get.GET(request(sceneURL, undefined, 'bearer'), context))).document;
  assert.equal(loaded.documentId, created.documentId);
  const editInput = { workspaceId: current.workspaceId, documentId: created.documentId,
    lifecycleGeneration: created.lifecycleGeneration, observedSceneSequence: created.sceneSequence,
    idempotencyKey: `rest-edit-${suffix}`, actions: [{ type: 'create', element: element('rest-element') }] };
  const edited = (await success(await edit.POST(request(`/api/excalidraw/scenes/${created.documentId}/operations`, editInput), context))).operation;
  assert.equal(edited.status, 'applied');
  assert.equal(edited.checkpoint.status, 'saved');
  assert.equal(edited.actorId, `user:${userId}`);
  assert.equal(edited.reviewRequired, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(current.rootPath, input.path), 'utf8')).elements[0].id, 'rest-element');
  for (const [label, body, headers, status] of [
    ['mixed header', input, { 'x-canvas-workspace-id': 'another-workspace' }, 400],
    ['forged actor', { ...input, actor: { userId: 'forged' } }, {}, 400],
  ] as const) {
    assert.equal((await create.POST(request('/api/excalidraw/scenes', body, 'cookie', headers))).status, status, label);
  }
  assert.equal((await create.POST(request('/api/excalidraw/scenes?workspaceId=another-workspace', input))).status, 400);
  assert.equal((await create.POST(request('/api/excalidraw/scenes', input, 'none'))).status, 401);
  assert.equal((await create.POST(request('/api/excalidraw/scenes', input, 'oauth'))).status, 401,
    'An OAuth MCP token must not become a Canvas Session REST token.');
  assert.equal((await edit.POST(request('/edit', { ...editInput, documentId: 'wrong' }), context)).status, 400);
  assert.equal((await edit.POST(request('/edit', { ...editInput, lifecycleGeneration: undefined }), context)).status, 400);
  assert.equal((await edit.POST(request('/edit', { ...editInput, actorId: 'forged' }), context)).status, 400);
  assert.equal((await get.GET(request(`${sceneURL}&path=another.excalidraw`), context)).status, 409);
  const malformed = new NextRequest('http://localhost:3001/api/excalidraw/scenes', {
    method: 'POST', headers: { cookie: 'session=fixture-session', 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal((await create.POST(malformed)).status, 400);
  assert.equal((await create.POST(request('/api/excalidraw/scenes', { ...input, path: 'x'.repeat(1024 * 1024) }))).status, 413);
  state.limited = true;
  assert.equal((await create.POST(request('/api/excalidraw/scenes', input))).status, 429);
  state.limited = false;
  state.resolverCalls = 0;
  state.mutateOnResolve = { call: 2, apply: () => { state.canWrite = false; } };
  const revokedCreate = { ...input, path: 'revoked-rest.excalidraw', idempotencyKey: `revoked-rest-${suffix}` };
  assert.equal((await create.POST(request('/api/excalidraw/scenes', revokedCreate))).status, 403);
  await assert.rejects(fs.stat(path.join(current.rootPath, revokedCreate.path)), { code: 'ENOENT' });
  state.canWrite = true;
  state.resolverCalls = 0;
  state.mutateOnResolve = { call: 3, apply: () => { state.canWrite = false; } };
  const before = await sceneService.getExcalidrawDocument({ workspace: current, documentId: created.documentId });
  const revokedEdit = { ...editInput, observedSceneSequence: before.sceneSequence,
    idempotencyKey: `revoked-rest-edit-${suffix}`, actions: [{ type: 'create', element: element('must-not-apply') }] };
  assert.equal((await edit.POST(request('/edit', revokedEdit), context)).status, 403);
  assert.equal((await sceneService.getExcalidrawDocument({ workspace: current, documentId: created.documentId })).sceneSequence, before.sceneSequence);
  assert.equal((await rows('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE workspace_id=$1 AND idempotency_key=$2',
    [current.workspaceId, revokedEdit.idempotencyKey])).length, 0, 'Revocation inside the engine lock must roll back the operation.');
  state.canWrite = true;
  state.resolverCalls = 0;
  state.mutateOnResolve = { call: 2, apply: () => { state.sessionId = 'replaced-under-lock'; } };
  assert.equal((await create.POST(request('/api/excalidraw/scenes', { ...revokedCreate, path: 'session-changed.excalidraw' }))).status, 403);
  state.resolverCalls = 0;
  state.mutateOnResolve = { call: 2, apply: () => { state.canRead = false; } };
  assert.equal((await get.GET(request(sceneURL), context)).status, 403);
}

async function mcp(current: WorkspaceContext) {
  const { state, tools } = fixture(current);
  const auth = { token: 'fixture-oauth' } as sdk.AuthInfo;
  const call = (id: DirectMcpExcalidrawTool, args: unknown, signal?: AbortSignal) => tools.executeDirectMcpExcalidrawTool(id, args, auth, signal);
  const definitions = tools.getDirectMcpExcalidrawToolDefinitions();
  assert.deepEqual(definitions.map(tool => tool.id), ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene']);
  for (const tool of definitions) {
    assert.deepEqual(tool.descriptor.securitySchemes, [{ type: 'oauth2', scopes: [tool.id === 'get_excalidraw_scene' ? 'knowledge:read' : 'knowledge:write'] }]);
    assert.deepEqual(tool.descriptor._meta.securitySchemes, tool.descriptor.securitySchemes);
    assert.equal(tool.descriptor.inputSchema.additionalProperties, false);
  }
  const input = { workspaceId: current.workspaceId, path: 'mcp.excalidraw', idempotencyKey: `mcp-create-${suffix}` };
  const created = toolSuccess(await call('create_excalidraw_scene', input)) as ExcalidrawDocumentSnapshot;
  const repeated = toolSuccess(await call('create_excalidraw_scene', input));
  assert.equal(repeated.documentId, created.documentId);
  const scene = toolSuccess(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, path: input.path })) as ExcalidrawDocumentSnapshot;
  assert.equal(scene.documentId, created.documentId);
  const editInput = { workspaceId: current.workspaceId, documentId: scene.documentId,
    lifecycleGeneration: scene.lifecycleGeneration, observedSceneSequence: scene.sceneSequence,
    idempotencyKey: `mcp-edit-${suffix}`, actions: [{ type: 'create', element: element('mcp-target') }] };
  const applied = toolSuccess(await call('edit_excalidraw_scene', editInput));
  assert.equal(applied.status, 'applied');
  assert.equal((applied.checkpoint as { status: string }).status, 'saved');
  assert.equal(applied.actorId, `direct-mcp:${createHash('sha256').update(state.clientId).digest('hex').slice(0, 32)}`);
  assert.equal(toolSuccess(await call('edit_excalidraw_scene', editInput)).operationId, applied.operationId);
  const before = await sceneService.getExcalidrawDocument({ workspace: current, documentId: scene.documentId });
  const target = before.elements[0];
  await applyExcalidrawScenePatch({ documentId: before.documentId, lifecycleGeneration: before.lifecycleGeneration,
    baseSequence: before.sceneSequence, messageId: `human-mcp-${suffix}`, actorType: 'user', actorId: userId,
    elements: [{ ...target, version: target.version + 1, versionNonce: 80, x: 200 }] });
  const conflicted = toolSuccess(await call('edit_excalidraw_scene', { ...editInput, observedSceneSequence: before.sceneSequence,
    idempotencyKey: `mcp-conflict-${suffix}`, actions: [
      { type: 'update', elementId: target.id, expectedVersion: target.version, expectedVersionNonce: target.versionNonce,
        element: { ...target, x: 300 } }, { type: 'create', element: element('conflicting-batch-untouched') },
    ] }));
  assert.equal(conflicted.status, 'needs_review');
  assert.equal(conflicted.reviewRequired, true);
  assert.ok(conflicted.conflictHint);
  if (conflicted.reviewAvailable) assert.ok(conflicted.reviewHint);
  else assert.equal(conflicted.reviewHint, null);
  assert.ok(conflicted.documentUrl);
  const after = await sceneService.getExcalidrawDocument({ workspace: current, documentId: scene.documentId });
  assert.equal(after.elements[0].x, 200);
  assert.equal(after.elements.some(entry => entry.id === 'conflicting-batch-untouched'), false);
  toolFailure(await tools.executeDirectMcpExcalidrawTool('get_excalidraw_scene', { workspaceId: current.workspaceId, path: input.path }));
  state.scopes = ['knowledge:read'];
  toolFailure(await call('create_excalidraw_scene', { ...input, path: 'no-write-scope.excalidraw' }));
  assert.equal(toolSuccess(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, documentId: scene.documentId })).documentId, scene.documentId);
  state.scopes = ['knowledge:read', 'knowledge:write'];
  for (const mutate of [() => { state.mcpEnabled = false; }, () => { state.enabledTools = []; }]) {
    mutate();
    toolFailure(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, path: input.path }), 'EXCALIDRAW_MCP_NOT_ENABLED');
    state.mcpEnabled = true;
    state.enabledTools = definitions.map(tool => tool.id);
  }
  for (const property of ['allowed', 'workspaceEnabled', 'canRead'] as const) {
    state[property] = false;
    toolFailure(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, path: input.path }), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
    state[property] = true;
  }
  for (const property of ['canWrite', 'canRunAgent'] as const) {
    state[property] = false;
    toolFailure(await call('create_excalidraw_scene', { ...input, path: 'denied-mcp.excalidraw' }), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
    state[property] = true;
  }
  state.expiresAt = Math.floor(Date.now() / 1000) - 1;
  toolFailure(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, path: input.path }), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
  state.expiresAt = Math.floor(Date.now() / 1000) + 600;
  toolFailure(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, documentId: scene.documentId, path: 'wrong.excalidraw' }), 'EXCALIDRAW_DOCUMENT_MISMATCH');
  for (const invalid of [
    { workspace_id: current.workspaceId, path: input.path }, { workspaceId: current.workspaceId },
    { workspaceId: current.workspaceId, path: input.path, actorId: 'forged' },
  ]) toolFailure(await call('get_excalidraw_scene', invalid), 'INVALID_EXCALIDRAW_REQUEST');
  toolFailure(await call('edit_excalidraw_scene', { ...editInput, sceneSequence: 0 }), 'INVALID_EXCALIDRAW_REQUEST');
  toolFailure(await call('edit_excalidraw_scene', { ...editInput, lifecycleGeneration: undefined }), 'INVALID_EXCALIDRAW_REQUEST');
  const oversized = await call('edit_excalidraw_scene', { ...editInput,
    actions: [{ type: 'create', element: element('large', { text: 'x'.repeat(1024 * 1024) }) }] });
  toolFailure(oversized, 'INVALID_EXCALIDRAW_REQUEST');
  assert.equal(oversized.structuredContent?.status, 413);
  state.verifyCalls = 0;
  state.mutateOnVerify = { call: 3, apply: () => { state.allowed = false; } };
  const revokedCreate = { ...input, path: 'revoked-mcp.excalidraw', idempotencyKey: `revoked-mcp-${suffix}` };
  toolFailure(await call('create_excalidraw_scene', revokedCreate), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
  await assert.rejects(fs.stat(path.join(current.rootPath, revokedCreate.path)), { code: 'ENOENT' });
  state.allowed = true;
  state.verifyCalls = 0;
  state.mutateOnVerify = { call: 3, apply: () => { state.enabledTools = []; } };
  const revokedEdit = { ...editInput, observedSceneSequence: after.sceneSequence,
    idempotencyKey: `revoked-mcp-edit-${suffix}`, actions: [{ type: 'create', element: element('must-not-apply-mcp') }] };
  toolFailure(await call('edit_excalidraw_scene', revokedEdit), 'EXCALIDRAW_MCP_NOT_ENABLED');
  assert.equal((await sceneService.getExcalidrawDocument({ workspace: current, documentId: scene.documentId })).sceneSequence, after.sceneSequence);
  assert.equal((await rows('SELECT operation_id FROM collaboration_excalidraw_agent_operations WHERE workspace_id=$1 AND idempotency_key=$2',
    [current.workspaceId, revokedEdit.idempotencyKey])).length, 0);
  state.enabledTools = definitions.map(tool => tool.id);
  state.verifyCalls = 0;
  state.mutateOnVerify = { call: 2, apply: () => { state.sessionId = 'different-session'; } };
  toolFailure(await call('get_excalidraw_scene', { workspaceId: current.workspaceId, path: input.path }), 'EXCALIDRAW_MCP_AUTHORITY_CHANGED');
  state.mutateOnVerify = undefined;
  const controller = new AbortController();
  controller.abort();
  toolFailure(await call('create_excalidraw_scene', { ...input, path: 'cancelled-before-call.excalidraw' }, controller.signal));
  await assert.rejects(fs.stat(path.join(current.rootPath, 'cancelled-before-call.excalidraw')), { code: 'ENOENT' });
  assert.ok(state.requestedScopes.some(scopes => scopes.includes('knowledge:read')));
  assert.ok(state.requestedScopes.some(scopes => scopes.includes('knowledge:write')));
}

async function serverRegistration() {
  type Handler = (...args: unknown[]) => Promise<unknown>;
  class Server {
    handlers = new Map<string, Handler>();
    constructor(readonly info: unknown, readonly options: unknown) {}
    setRequestHandler(name: string, handler: Handler) { this.handlers.set(name, handler); }
  }
  const fixtures = fixture(workspace('personal'));
  const direct = loadModule<{ createDirectMcpServer(tools: readonly config.DirectMcpToolId[]): Server }>(
    'app/lib/mcp/server/direct-server.ts', { 'server-only': {}, '@modelcontextprotocol/server': { ...sdk, Server },
      '@/app/lib/mcp/server/config': config, '@/app/lib/mcp/server/auth-probe': {},
      '@/app/lib/mcp/server/diagnostics': { recordDirectMcpRequestOperation() {}, recordDirectMcpToolFailure() {},
        recordDirectMcpSuccessfulOperation: async () => undefined },
      '@/app/lib/mcp/server/workspace-tools': { getDirectMcpWorkspaceToolDefinitions: () => [] },
      '@/app/lib/mcp/server/version': { DIRECT_MCP_SERVER_VERSION: 'fixture' },
      './ingest-tools': { getDirectMcpIngestToolDefinitions: () => [] },
      './excalidraw-tools': fixtures.tools,
    });
  const readOnly = direct.createDirectMcpServer(['get_excalidraw_scene']);
  const listed = await readOnly.handlers.get('tools/list')!() as { tools: DirectMcpToolDescriptor[] };
  assert.deepEqual(listed.tools.map(tool => tool.name), ['get_excalidraw_scene']);
  await assert.rejects(readOnly.handlers.get('tools/call')!({ params: { name: 'create_excalidraw_scene' } }, {}), /disabled/u);
  const enabled = direct.createDirectMcpServer(['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene']);
  assert.equal((await enabled.handlers.get('tools/list')!() as { tools: unknown[] }).tools.length, 3);
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const workspaces = [workspace('personal'), workspace('team')];
  await execute(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Excalidraw adapter test',$2,1,1,1)`, [userId, `${userId}@adapter.test`]);
  await execute(`INSERT INTO canvas_organization_settings
    (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,1,1)`, [organizationId, userId]);
  try {
    for (const current of workspaces) {
      await fs.mkdir(current.rootPath, { recursive: true });
      await execute(`INSERT INTO canvas_workspaces
        (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'active',1,1)`, [current.workspaceId, organizationId, current.workspaceType,
        current.ownerUserId ?? null, current.rootRelativePath, current.displayName]);
      await rest(current);
      await mcp(current);
    }
    await serverRegistration();
    console.log(JSON.stringify({ success: true, nativePostgres: true, substitutedIdentityIO: true,
      workspaces: workspaces.map(current => current.workspaceType), restCookieAndSessionBearer: true,
      mcpScopesAndRegistration: true, createGetEdit: true, checkpoints: true, reviewStatus: true,
      freshAuthorityUnderLocks: true, malformedAndBoundedInputs: true, idempotentRenewedSession: true }));
  } finally {
    for (const current of workspaces) {
      await execute('DELETE FROM collaboration_excalidraw_creates WHERE workspace_id=$1', [current.workspaceId]).catch(() => undefined);
      await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [current.workspaceId]).catch(() => undefined);
      await fs.rm(current.rootPath, { recursive: true, force: true });
    }
  }
}

void main().finally(closeDatabaseConnections);
