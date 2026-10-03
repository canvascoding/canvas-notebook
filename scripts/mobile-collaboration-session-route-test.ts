import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest } from 'next/server';
import ts from 'typescript';
import * as Y from 'yjs';

import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { mobileCollaborationProjectionStatus } from '../app/lib/mobile/collaboration-session';

/** Real route and reducer; only authorization, grant creation and ticket side effects are boundaries. */
async function main() {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'current binary');
  const stateProof = collaborationStateProof(doc, Y);
  assert.ok(stateProof, 'the actual test document must produce a binary state proof');
  const base = { path: 'Notes/Owned.md', provider: 'yjs', representation: 'tiptap_xml',
    documentId: 'document-owned', documentName: 'document-owned', lifecycleGeneration: 2,
    permission: 'write', documentSequence: 7, checkpointSequence: 7,
    stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof };
  let grant: Record<string, unknown> = { ...base };
  let workspaceResponse: Response | undefined;
  const claims: Record<string, unknown>[] = [];
  const authorization: unknown[] = [];
  const filename = path.resolve('app/api/mobile/v1/notebook/collaboration/session/route.ts');
  const runtimeRequire = createRequire(filename);
  class SessionError extends Error {}
  const mocks: Record<string, unknown> = {
    '@/app/lib/api/route-helpers': { applyRateLimit: () => null, readJsonBody: (request: NextRequest) => request.json() },
    '@/app/lib/collaboration/identity': { collaborationUserColors: () => ({ color: '#000000', colorLight: '#ffffff' }) },
    '@/app/lib/collaboration/session-service': {
      CollaborationSessionError: SessionError,
      parseCollaborationSessionRequest: (request: unknown) => request,
      createCollaborationSessionGrant: async () => grant,
    },
    '@/app/lib/collaboration/types': { COLLABORATION_SCHEMA_VERSION: 1, RICH_MARKDOWN_SCHEMA_VERSION: 3, RICH_BLOCK_TREE_FORMAT_VERSION: 1 },
    '@/app/lib/collaboration/runtime-policy': { liveCollaborationRuntimeAvailable: () => true },
    '@/app/lib/mobile/collaboration-session': { mobileCollaborationProjectionStatus },
    '@/app/lib/mobile/collaboration-ticket': { issueMobileCollaborationTicket: (input: { claims: Record<string, unknown> }) => {
      claims.push(input.claims); return { token: 'test-ticket', expiresAt: '2026-10-03T12:00:00.000Z' };
    } },
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async (_request: unknown, options: unknown) => {
        authorization.push(options);
        return workspaceResponse ? { response: workspaceResponse } : {
          workspace: { workspaceId: 'personal-workspace', organizationId: null, permissions: { canRead: true, canWrite: grant.permission === 'write' } },
          session: { session: { id: 'session-owned' }, user: { id: 'user-owned', name: 'Owner' } },
        };
      },
      workspaceFileOptions: () => ({}),
    },
  };
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const exported = {} as { POST: (request: NextRequest) => Promise<Response> };
  new Function('require', 'module', 'exports', compiled.outputText)(
    (name: string) => mocks[name] ?? runtimeRequire(name), { exports: exported }, exported,
  );
  const request = () => exported.POST(new NextRequest('https://canvas.test/api/mobile/v1/notebook/collaboration/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: base.path }),
  }));
  const stateFrom = (wire: Record<string, unknown>) => {
    let state = createInitialTextCollaborationClientState(wire as Parameters<typeof createInitialTextCollaborationClientState>[0]);
    state = reduceTextCollaborationClientState(state, { type: 'indexeddb_hydrated' });
    state = reduceTextCollaborationClientState(state, { type: 'remote_synced', permission: wire.permission as 'read' | 'write' });
    return reduceTextCollaborationClientState(state, { type: 'authoritative_snapshot',
      documentSequence: 7, checkpointSequence: 7, stateVector: base.stateVector, stateProof,
      matchesCurrentDocument: true, ...mobileCollaborationProjectionStatus(wire as Parameters<typeof mobileCollaborationProjectionStatus>[0]),
    });
  };
  try {
    // A valid binary proof cannot erase a quarantined server document or certify an unfinished projection.
    grant = { ...base, degraded: true, projectionFinalized: false,
      projectionError: { code: 'COLLABORATION_QUARANTINED', sequence: 7, permanent: true, phase: 'validation' } };
    let response = await request();
    assert.equal(response.status, 200);
    let wire = await response.json() as Record<string, unknown>;
    assert.equal(stateFrom(wire).durability, 'degraded', 'the actual v1 response must preserve quarantine rather than produce false checkpoint provenance');
    assert.equal(wire.degraded, true);
    assert.equal(wire.projectionFinalized, false);
    assert.deepEqual(wire.projectionError, grant.projectionError);
    assert.equal(Object.hasOwn(wire, 'schemaValidated'), false, 'HTTP grants do not certify schema validation');

    grant = { ...base, degraded: false, projectionFinalized: false,
      projectionError: { code: 'COLLABORATION_SERIALIZATION_FAILED', sequence: 7, permanent: false } };
    wire = await (await request()).json() as Record<string, unknown>;
    assert.equal(stateFrom(wire).durability, 'persisted_yjs', 'an unfinished derived projection does not invalidate an acknowledged binary');
    assert.deepEqual(wire.projectionError, grant.projectionError);

    grant = { ...base, degraded: false, projectionFinalized: true };
    wire = await (await request()).json() as Record<string, unknown>;
    assert.equal(stateFrom(wire).durability, 'checkpointed_file');
    assert.equal(wire.degraded, false);
    assert.equal(Object.hasOwn(wire, 'projectionError'), false);

    grant = { ...base };
    wire = await (await request()).json() as Record<string, unknown>;
    assert.equal(stateFrom(wire).durability, 'checkpointed_file', 'legacy absence retains the existing v1 behavior');
    for (const field of ['degraded', 'projectionFinalized', 'projectionError', 'schemaValidated']) assert.equal(Object.hasOwn(wire, field), false);

    grant = { ...base, permission: 'read', degraded: false, projectionFinalized: true };
    wire = await (await request()).json() as Record<string, unknown>;
    assert.equal(wire.permission, 'read');
    assert.equal(claims.at(-1)?.permission, 'read', 'projection metadata never upgrades the ticket grant');
    assert.equal(claims.at(-1)?.workspaceId, 'personal-workspace');
    assert.equal(stateFrom(wire).connection, 'read_only');
    assert.deepEqual(authorization.at(-1), { permissions: 'canRead' });

    for (const malformed of [
      { degraded: 'false' }, { projectionFinalized: 1 }, { projectionError: null },
      { projectionError: { code: 'code', sequence: 8, permanent: false } },
      { projectionError: { code: 'code', sequence: -1, permanent: false } },
      { projectionError: { code: 'code', sequence: 7.5, permanent: false } },
      { projectionError: { code: 1, sequence: 7, permanent: false } },
      { projectionError: { code: 'code', sequence: 7, permanent: 'false' } },
      { projectionError: { code: 'code', sequence: 7, permanent: false, phase: {} } },
    ]) {
      grant = { ...base, ...malformed };
      const before = claims.length;
      response = await request();
      assert.equal(response.status, 500, 'malformed internal status cannot become a successful v1 grant');
      assert.equal(claims.length, before, 'reject malformed projection metadata before issuing a ticket');
    }
    workspaceResponse = new Response('denied', { status: 403 });
    const before = claims.length;
    response = await request();
    assert.equal(response, workspaceResponse);
    assert.equal(claims.length, before, 'the original workspace authorization fence remains authoritative');
    console.log('mobile-collaboration-session-route-test: actual response/reducer quarantine, binary-only durability, healthy/legacy, malformed, readonly and ACL fences passed');
  } finally { doc.destroy(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
