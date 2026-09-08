import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';

import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';

async function main() {
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'ABC');
  const claims = { provider: 'yjs', representation: 'plain_text', permission: 'write', documentId: 'doc',
    userId: 'user', sessionId: 'session', workspaceId: 'workspace', organizationId: null, lifecycleGeneration: 1, path: 'doc.txt' };
  let state = { ...claims, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 1, checkpointSequence: 1 } as unknown as PersistedCollaborationState;
  let materialized = 0;
  const filename = path.resolve('app/api/files/collaboration/checkpoint/route.ts');
  const runtimeRequire = createRequire(filename);
  const mocks: Record<string, unknown> = {
    '@/app/lib/audit/audit-service': { recordAuditEvent: async () => {} },
    '@/app/lib/api/route-helpers': { applyRateLimit: () => null, readJsonBody: (request: NextRequest) => request.json() },
    '@/app/lib/collaboration/ticket': { verifyCollaborationTicket: () => claims },
    '@/app/lib/collaboration/persistence': { loadCollaborationState: async () => state },
    '@/app/lib/collaboration/checkpoint': {
      CollaborationCheckpointSupersededError: class extends Error {},
      materializeCollaborationCheckpoint: async () => {
        materialized++; state = { ...state, checkpointSequence: state.documentSequence };
        return { state, revisionId: 'revision' };
      },
    },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async () => ({
      workspace: { workspaceId: claims.workspaceId, organizationId: null },
      session: { session: { id: claims.sessionId }, user: { id: claims.userId } },
    }) },
  };
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {} as { POST: (request: NextRequest) => Promise<Response> };
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => mocks[name] ?? runtimeRequire(name), { exports: exported }, exported,
  );
  const request = (stateProof: unknown) => exported.POST(new NextRequest('https://canvas.test/api/files/collaboration/checkpoint', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test', stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof }),
  }));
  try {
    const originalProof = collaborationStateProof(doc, Y);
    assert.equal((await request(undefined)).status, 400, 'vector-only requests must explicitly reload/update');
    assert.equal((await request('invalid')).status, 400);
    doc.getText('content').delete(0, 1);
    const deletedProof = collaborationStateProof(doc, Y);
    assert.deepEqual(Y.encodeStateVector(doc), state.stateVector);
    assert.equal((await request(deletedProof)).status, 409, 'unsaved deletion cannot use an already-checkpointed vector');
    assert.equal(materialized, 0);
    state = { ...state, yjsState: Y.encodeStateAsUpdate(doc), documentSequence: 2 };
    assert.equal((await request(originalProof)).status, 409, 'a stale client cannot certify a different persisted delete set');
    assert.equal(materialized, 0);
    const response = await request(deletedProof);
    assert.equal(response.status, 200);
    assert.equal(materialized, 1);
    const result = await response.json();
    assert.equal(result.stateProof, deletedProof);
    assert.equal(result.checkpointSequence, 2);
    const already = await request(deletedProof);
    assert.equal(already.status, 200);
    assert.equal((await already.json()).alreadyCheckpointed, true);
    assert.equal(materialized, 1);
    state = { ...state, lifecycleGeneration: 2 };
    assert.equal((await request(deletedProof)).status, 409, 'proof equality cannot override the generation fence');
    console.log('Checkpoint endpoint: required proof, pure-delete races, authoritative response, idempotent confirmation and generation fence passed.');
  } finally { doc.destroy(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
