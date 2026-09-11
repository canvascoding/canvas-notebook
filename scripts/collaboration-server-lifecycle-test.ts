import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import * as Direct from '../app/lib/collaboration/direct-connection';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type * as Server from '../server/collaboration-server';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'Human text');
  const workspace = { workspaceId: 'server-lifecycle-test', organizationId: 'org',
    workspaceType: 'organization', rootPath: '/unused', permissions: { canRead: true, canWrite: true, canRunAgent: true } } as WorkspaceContext;
  const initial: PersistedCollaborationState = { documentId: 'document', workspaceId: workspace.workspaceId,
    organizationId: 'org', path: 'document.txt', lifecycleGeneration: 1, representation: 'plain_text',
    documentSequence: 1, checkpointSequence: 1, stateVector: Y.encodeStateVector(doc), yjsState: Y.encodeStateAsUpdate(doc),
    status: 'active', schemaVersion: 1, persistedAt: 1, checkpointedAt: 1, canonicalHash: null, serializedHash: null,
    newlineStyle: 'lf', hasBom: false, degraded: false };
  const h = { doc, workspace, state: initial as PersistedCollaborationState | null, authorized: true,
    documentId: 'document', accessChecks: 0, userAccessChecks: 0, applied: 0, disconnected: 0, admissionCount: 0,
    openEntered: gate(), releaseOpen: gate(), beforeDisconnect: async () => {},
    events: [] as string[], run: null as unknown as Parameters<typeof Direct.installCollaborationDirectConnection>[0] };
  let hooks!: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
  class Hocuspocus {
    documents = new Map([['document', doc]]);
    constructor(options: typeof hooks) { hooks = options; }
    closeConnections() {}
    async openDirectConnection() {
      h.openEntered.resolve();
      await h.releaseOpen.promise;
      return {
        async transact(callback: (document: Y.Doc) => void) { h.applied++; callback(doc); },
        async disconnect() { await h.beforeDisconnect(); h.disconnected++; h.events.push('persisted'); },
      };
    }
  }
  const filename = path.resolve('server/collaboration-server.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {} as typeof Server;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name === '@hocuspocus/server') return { Hocuspocus };
    if (name === 'ws') return { WebSocketServer: class extends EventEmitter {} };
    if (name.endsWith('/direct-connection')) return { ...Direct,
      installCollaborationDirectConnection: (run: typeof h.run) => { h.run = run; } };
    if (name.endsWith('/workspace-mutation-lock')) return { withWorkspaceMutationLock };
    if (name.endsWith('/runtime-state')) return {
      installCollaborationRoomInspector() {},
      withCollaborationRoomLifecycleLock: async (_id: string, run: () => Promise<unknown>) => run(),
      reserveCollaborationRoomAdmission: () => { h.admissionCount++; return () => { h.admissionCount--; }; },
    };
    if (name.endsWith('/persistence')) return { loadCollaborationState: async () => h.state };
    if (name.endsWith('/collaboration-policy')) return { readFileCollaborationState: async () => ({
      document: { id: h.documentId, status: 'active', provider: 'yjs' },
    }) };
    if (name.endsWith('/session-workspace-context')) return {
      resolveAgentExecutionContextForStoredSession: async (request: Record<string, unknown>) => {
        assert.equal(request.sessionId, 'stored-session'); assert.equal(request.agentId, 'agent');
        assert.equal(request.userId, 'user'); assert.deepEqual(request.permissions, ['canRead', 'canRunAgent', 'canWrite']);
        h.accessChecks++;
        if (!h.authorized) throw new Error('Session permissions revoked');
        return workspace;
      },
      workspaceFromAgentExecutionContext: (value: WorkspaceContext) => value,
    };
    if (name.endsWith('/connection-access')) return {
      resolveCollaborationSessionAccess: async () => {
        h.userAccessChecks++;
        if (!h.authorized) throw new Error('User session revoked');
        return { workspace };
      },
    };
    if (name.endsWith('/projection-runtime')) return { createCollaborationProjectionRuntime: () => ({ enqueue() {}, dispose() {} }) };
    if (name.endsWith('/access-monitor')) return { createCollaborationAccessMonitor: () => ({ dispose() {} }) };
    if (name.endsWith('/agent-operations')) return { recoverCollaborationAgentOperations: async () => {} };
    if (name.endsWith('/health')) return { setCollaborationRuntimeHealth() {} };
    if (name.endsWith('/document-access')) return { installCollaborationDocumentReader() {} };
    if (name.endsWith('/server-runtime')) return { Y };
    if (name.startsWith('@/')) return {};
    return load(name);
  }, { exports: exported }, exported);
  const server = new EventEmitter();
  exported.createCollaborationServer(server as unknown as http.Server);
  await hooks.onLoadDocument({ documentName: 'document', document: doc });
  const input: Direct.AgentDirectConnectionInput = { documentId: 'document', documentPath: 'document.txt',
    documentRepresentation: 'plain_text', documentLifecycleGeneration: 1, documentSchemaVersion: 1,
    requiresFileCheckpointIdentity: true, workspace, actorId: 'agent', actorDisplayName: 'Agent',
    initiatedByUserId: 'user', operationId: 'operation', actorSessionId: 'stored-session' };
  return { ...h, input, mutable: h,
    edit: (actorType: 'agent' | 'user' = 'agent') => h.run({ ...input, actorType }, (document) => {
      document.getText('content').insert(0, 'Agent edit: '); h.events.push('applied'); return 'result';
    }, async (result) => { assert.equal(result, 'result'); h.events.push('receipt'); }),
    close: () => { server.emit('close'); doc.destroy(); },
  };
}

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-server-lifecycle-'));
  const oldData = process.env.DATA;
  const oldRoot = process.env.CANVAS_DATA_ROOT;
  process.env.DATA = data; process.env.CANVAS_DATA_ROOT = data;
  let cases = 0;
  try {
    {
      const h = await harness(); h.releaseOpen.resolve();
      try {
        assert.equal(await h.edit(), 'result');
        assert.equal(h.mutable.accessChecks, 2, 'authorization is repeated after opening the room');
        assert.equal(h.mutable.applied, 1); assert.equal(h.mutable.admissionCount, 0);
        assert.deepEqual(h.events, ['applied', 'receipt', 'persisted']); cases++;
      } finally { h.close(); }
    }
    for (const actorType of ['agent', 'user'] as const) {
      const h = await harness();
      try {
        const editing = h.edit(actorType); await h.openEntered.promise;
        h.mutable.authorized = false; h.releaseOpen.resolve();
        await assert.rejects(editing, actorType === 'agent' ? Direct.AgentDirectConnectionAuthorizationError : /User session revoked/);
        assert.equal(h.mutable.applied, 0); assert.equal(h.doc.getText('content').toString(), 'Human text');
        assert.equal(h.mutable.admissionCount, 0); assert.equal(h.mutable.disconnected, 1); cases++;
      } finally { h.close(); }
    }
    for (const mutate of [
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.state = { ...h.state!, path: 'renamed.txt' }; },
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.state = null; },
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.state = { ...h.state!, status: 'archived', lifecycleGeneration: 2 }; },
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.state = { ...h.state!, lifecycleGeneration: 3 }; },
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.state = { ...h.state!, schemaVersion: 2 }; },
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.state = { ...h.state!, representation: 'tiptap_xml' }; },
      (h: Awaited<ReturnType<typeof harness>>) => { h.mutable.documentId = 'replacement-document'; },
    ]) {
      const h = await harness();
      try {
        const editing = h.edit(); await h.openEntered.promise;
        await withWorkspaceMutationLock(h.workspace.workspaceId, async () => mutate(h));
        h.releaseOpen.resolve();
        await assert.rejects(editing, Direct.AgentDirectConnectionAuthorizationError);
        assert.equal(h.mutable.applied, 0); assert.equal(h.doc.getText('content').toString(), 'Human text');
        assert.equal(h.mutable.admissionCount, 0); cases++;
      } finally { h.close(); }
    }
    {
      const h = await harness(); const entered = gate(); const release = gate();
      const mutation = withWorkspaceMutationLock(h.workspace.workspaceId, async () => {
        entered.resolve(); await release.promise; h.mutable.authorized = false;
      });
      try {
        await entered.promise;
        const editing = h.edit(); await h.openEntered.promise; h.releaseOpen.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(h.mutable.applied, 0, 'a room opening cannot bypass an ongoing workspace mutation');
        release.resolve(); await mutation;
        await assert.rejects(editing, Direct.AgentDirectConnectionAuthorizationError);
        assert.equal(h.mutable.applied, 0); cases++;
      } finally { release.resolve(); await mutation; h.close(); }
    }
    {
      const h = await harness(); const entered = gate(); const release = gate();
      h.mutable.beforeDisconnect = async () => { entered.resolve(); await release.promise; };
      h.releaseOpen.resolve();
      try {
        const editing = h.edit(); await entered.promise;
        const lifecycle = withWorkspaceMutationLock(h.workspace.workspaceId, async () => {
          h.mutable.state = { ...h.state!, status: 'archived', lifecycleGeneration: 2 }; h.events.push('archived');
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(h.events, ['applied', 'receipt'], 'delete must wait for the acknowledged edit to persist');
        release.resolve(); await editing; await lifecycle;
        assert.deepEqual(h.events, ['applied', 'receipt', 'persisted', 'archived']); cases++;
      } finally { release.resolve(); h.close(); }
    }
    console.log(`Server direct-connection lifecycle: ${cases} cases passed (late permission loss, rename/archive/restore/replacement, workspace wait and persistence ordering).`);
  } finally {
    if (oldData === undefined) delete process.env.DATA; else process.env.DATA = oldData;
    if (oldRoot === undefined) delete process.env.CANVAS_DATA_ROOT; else process.env.CANVAS_DATA_ROOT = oldRoot;
    await fs.rm(data, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
