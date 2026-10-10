import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';
import { collaborationStateProof, collaborationUpdateStateProof, isCollaborationStateProof } from '../app/lib/collaboration/state-proof';
import { isCanonicalAdmissionPath } from '../app/lib/collaboration/room-admission-contract';

async function main() {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, '# Exact saved content\n');
  const proof = collaborationStateProof(doc, Y)!;
  const state = { documentId: 'checkpoint-doc', workspaceId: 'checkpoint-workspace', organizationId: null,
    path: 'Notes/Exact.md', lifecycleGeneration: 2, documentSequence: 3, checkpointSequence: 3,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), status: 'active' };
  const body = { path: state.path, expectedDocumentId: state.documentId, expectedLifecycleGeneration: 2,
    documentSequence: 3, stateVector: Buffer.from(state.stateVector).toString('base64'), stateProof: proof };
  let current = state;
  let final = state;
  let fileId = state.documentId;
  let projection = { projectionFinalized: true, degraded: false };
  let materializations = 0;
  let denied: Response | undefined;
  let failure: Error | undefined;
  let failures = 0;
  const authorization: unknown[] = [];
  class Superseded extends Error {}
  const filename = path.resolve('app/api/mobile/v1/notebook/collaboration/checkpoint/route.ts');
  const runtimeRequire = createRequire(filename);
  const mocks: Record<string, unknown> = {
    '@/app/lib/api/route-helpers': { applyRateLimit: () => null, readJsonBody: (request: NextRequest) => request.json() },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async (_request: unknown, options: unknown) => {
      authorization.push(options);
      return denied ? { response: denied } : { workspace: { workspaceId: state.workspaceId, organizationId: null },
        session: { user: { id: 'checkpoint-user' }, session: { id: 'checkpoint-session' } } };
    } },
    '@/app/lib/files/collaboration-policy': { readFileCollaborationState: async () => ({ document: { id: fileId } }) },
    '@/app/lib/collaboration/persistence': { loadCollaborationState: async () => current },
    '@/app/lib/collaboration/checkpoint': { CollaborationCheckpointSupersededError: Superseded,
      materializeCollaborationCheckpoint: async () => { materializations++; if (failure) throw failure; return { state: final, revisionId: 'exact-revision' }; } },
    '@/app/lib/collaboration/state-proof': { collaborationStateProof, collaborationUpdateStateProof, isCollaborationStateProof },
    '@/app/lib/collaboration/server-runtime': { Y },
    '@/app/lib/collaboration/projection-errors': { classifyCollaborationProjectionError: () => ({ code: 'COLLABORATION_CHECKPOINT_FAILED' }) },
    '@/app/lib/collaboration/projection-repository': { loadCollaborationProjectionStatus: async () => projection,
      recordCollaborationProjectionFailure: async () => { failures++; } },
    '@/app/lib/collaboration/room-admission-contract': { isCanonicalAdmissionPath },
  };
  const output = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exported = {} as { POST: (request: NextRequest) => Promise<Response> };
  new Function('require', 'module', 'exports', output)((name: string) => mocks[name] ?? runtimeRequire(name), { exports: exported }, exported);
  const request = (input: unknown = body) => exported.POST(new NextRequest('https://canvas.test/api/mobile/v1/notebook/collaboration/checkpoint', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }));
  try {
    const response = await request();
    assert.equal(response.status, 200);
    const wire = await response.json();
    assert.deepEqual(authorization.at(-1), { permissions: 'canWrite' });
    for (const key of ['documentSequence', 'stateVector', 'stateProof']) assert.equal(wire[key], body[key as keyof typeof body]);
    assert.equal(wire.documentId, body.expectedDocumentId);
    assert.equal(wire.lifecycleGeneration, body.expectedLifecycleGeneration);
    assert.equal(wire.checkpointSequence, body.documentSequence);
    assert.equal(wire.revisionId, 'exact-revision');
    assert.equal(wire.projectionFinalized, true);
    assert.equal(Object.hasOwn(wire, 'token'), false, 'HTTP checkpoint uses live auth, never a one-use WS ticket');

    for (const bad of [null, { ...body, path: '../Exact.md' }, { ...body, expectedDocumentId: '' },
      { ...body, stateProof: 'not-a-proof' }, { ...body, stateVector: '?' }, { ...body, documentSequence: -1 }]) {
      const before = materializations;
      assert.equal((await request(bad)).status, 400);
      assert.equal(materializations, before);
    }
    for (const bad of [{ ...body, expectedLifecycleGeneration: 1 }, { ...body, expectedDocumentId: 'replacement-doc' },
      { ...body, documentSequence: 2 }]) assert.equal((await request(bad)).status, 409);
    fileId = 'replacement-at-same-path';
    assert.equal((await request()).status, 409, 'old doc ID must not mutate a replacement at the same path');
    fileId = state.documentId;
    const beforeDelete = materializations;
    doc.getText('content').delete(0, 1);
    current = { ...state, yjsState: Y.encodeStateAsUpdate(doc) };
    assert.deepEqual(Y.encodeStateVector(doc), state.stateVector, 'deletion-only updates retain the state vector');
    assert.equal((await request()).status, 409, 'full state proof fences deletion-only changes');
    assert.equal(materializations, beforeDelete);
    current = state;
    projection = { projectionFinalized: false, degraded: false };
    assert.equal((await request()).status, 409, 'an SQL checkpoint without finalized file projection is not a receipt');
    projection = { projectionFinalized: true, degraded: true };
    assert.equal((await request()).status, 409, 'quarantine cannot certify preparation');
    projection = { projectionFinalized: true, degraded: false };
    final = { ...state, lifecycleGeneration: 3 };
    assert.equal((await request()).status, 409, 'a newer lifecycle never certifies the old preparation');
    final = state;
    failure = new Superseded();
    assert.equal((await request()).status, 409);
    assert.equal(failures, 0, 'superseded old work does not poison current projection');
    failure = new Error('projection failed');
    assert.equal((await request()).status, 500);
    assert.equal(failures, 1);
    denied = new Response('denied', { status: 403 });
    const beforeDenied = materializations;
    assert.equal(await request(), denied);
    assert.equal(materializations, beforeDenied);
    console.log('mobile checkpoint route: exact finalized receipt, identity/sequence/deletion proof, malformed input, projection quarantine/supersession and live ACL passed');
  } finally { doc.destroy(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
