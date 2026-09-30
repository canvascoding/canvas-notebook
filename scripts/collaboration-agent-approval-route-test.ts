import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import { readCollaborationOperationApproval, readCollaborationOperationIdempotencyKey } from '../app/lib/collaboration/operation-route';
import type * as Route from '../app/api/files/collaboration/operations/[operationId]/accept/route';

const proposalVersion = `v1.${'a'.repeat(64)}`;
const body = { idempotencyKey: 'delivery', proposalVersion };
const request = (value: unknown) => new NextRequest('https://canvas.test/api/files/collaboration/operations/operation/accept', {
  method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' },
});

async function harness(action: 'accept' | 'reject' | 'revert' | 'direct-edit-grant' = 'accept') {
  const calls: Array<Record<string, unknown>> = [];
  const workspace = { workspaceId: 'workspace', organizationId: 'organization' };
  const controls = {
    denied: false,
    limited: false,
    revokeBeforeMutation: false,
    documentReviewEnabled: true,
    disableBeforeMutation: false,
    error: null as Error | null,
  };
  let authorizationCalls = 0;
  class ProposalChangedError extends Error { readonly code = 'AGENT_PROPOSAL_CHANGED'; }
  const filename = path.resolve(`app/api/files/collaboration/operations/[operationId]/${action}/route.ts`);
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const route = {} as typeof Route & { GET?: typeof Route.POST };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/workspaces/request') return { requireRequestWorkspace: async (_request: NextRequest, options: unknown) => {
      authorizationCalls += 1;
      if (controls.disableBeforeMutation && authorizationCalls === 2) controls.documentReviewEnabled = false;
      const permission = action === 'direct-edit-grant' ? 'canRead' : 'canWrite';
      assert.deepEqual(options, authorizationCalls === 1
        ? { permissions: permission }
        : { workspaceId: 'workspace', permissions: 'canWrite' });
      return controls.denied || (controls.revokeBeforeMutation && authorizationCalls === 2)
        ? { response: NextResponse.json({ error: 'Denied' }, { status: 403 }) }
        : { response: null, workspace, session: { user: { id: 'user' } } };
    } };
    if (name === '@/app/lib/utils/rate-limit') return { dualRateLimit: () => controls.limited
      ? { ok: false, response: new NextResponse(null, { status: 429 }) }
      : { ok: true } };
    if (name === '@/app/lib/api/route-helpers') return { applyRateLimit: () => controls.limited
      ? new NextResponse(null, { status: 429 }) : null };
    if (name === '@/app/lib/file-version-center/policy-v1') return { FILE_VERSION_CENTER_RATE_LIMITS_V1: {
      reviewMutation: { perUserPerMinute: 30, perIpPerMinute: 120 },
    } };
    if (name === '@/app/lib/file-version-center/observability') return { observeFileVersionCenter: () => undefined };
    if (name === '@/app/lib/file-version-center/route-adapter') return {
      documentReviewUnavailableResponse: () => controls.documentReviewEnabled ? null : NextResponse.json({
        contractVersion: 1, success: false,
        error: { code: 'FVRC_CAPABILITY_UNAVAILABLE', message: 'The Document Review Center is disabled.', retryable: false },
      }, { status: 409, headers: { 'Cache-Control': 'private, no-store, max-age=0' } }),
      withFileVersionCenterPrivateHeaders: (response: NextResponse) => {
        response.headers.set('Cache-Control', 'private, no-store, max-age=0');
        return response;
      },
    };
    if (name === '@/app/lib/collaboration/agent-operations') return {
      AgentProposalChangedError: ProposalChangedError,
      acceptAgentOperation: async (input: Record<string, unknown>) => {
        calls.push(input); if (controls.error) throw controls.error;
        return { operationId: input.operationId, operationStatus: 'persisted_yjs', durability: 'persisted_yjs',
          status: 'applied_to_ydoc', appliedTargetIds: ['target'], conflicts: [] };
      },
      rejectAgentOperation: async (input: Record<string, unknown>) => {
        calls.push(input); return { operationId: input.operationId, status: 'rejected' };
      },
      revertAgentOperation: async (input: Record<string, unknown>) => {
        calls.push(input); return { operationId: input.operationId, status: 'reverted' };
      },
    };
    if (name === '@/app/lib/collaboration/agent-direct-edit-grants') return {
      AgentDirectEditGrantUnavailableError: class extends Error {},
      getAgentDirectEditGrantForOperation: async (input: Record<string, unknown>) => {
        calls.push(input); return { grant: null };
      },
      setAgentDirectEditGrantForOperation: async (input: Record<string, unknown>) => {
        calls.push(input); return { status: input.action === 'grant' ? 'active' : 'revoked' };
      },
    };
    if (name === '@/app/lib/collaboration/agent-database-capacity') return { isAgentDatabaseCapacityError: () => false };
    return load(name);
  }, { exports: route }, route);
  const accept = (req: NextRequest) => {
    authorizationCalls = 0;
    return route.POST(req, { params: Promise.resolve({
      get operationId() {
        if (controls.disableBeforeMutation && (action === 'revert' || action === 'direct-edit-grant')) {
          controls.documentReviewEnabled = false;
        }
        return 'operation';
      },
    }) });
  };
  const get = (req: NextRequest) => {
    authorizationCalls = 0;
    if (!route.GET) throw new Error('This route does not expose GET.');
    return route.GET(req, { params: Promise.resolve({ operationId: 'operation' }) });
  };
  return { accept, get, calls, controls, workspace, ProposalChangedError };
}

test('the accept route forwards only the exact proposal and authenticated action scope', async () => {
  const h = await harness();
  const response = await h.accept(request({ ...body, idempotencyKey: '  delivery  ' }));
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls, [{ operationId: 'operation', workspace: h.workspace, userId: 'user', idempotencyKey: 'delivery', proposalVersion }]);
  assert.equal((await response.json()).operation.operationStatus, 'persisted_yjs');
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
});

test('unknown approval fields are rejected instead of becoming a mass-assignment surface', async () => {
  const h = await harness();
  const response = await h.accept(request({ ...body, userId: 'other', workspace: 'foreign', targets: ['forged'] }));
  assert.equal(response.status, 400);
  assert.equal(h.calls.length, 0);
});

test('missing, malformed and nonobject approval bodies never call the operation service', async (t) => {
  const invalid: Array<[string, unknown]> = [
    ['null', null], ['array', []], ['string', 'value'], ['number', 7], ['boolean', false], ['empty object', {}],
    ['legacy client', { idempotencyKey: 'delivery' }], ['null token', { ...body, proposalVersion: null }],
    ['wrong token type', { ...body, proposalVersion: 1 }], ['wrong token version', { ...body, proposalVersion: proposalVersion.replace('v1.', 'v2.') }],
    ['short token', { ...body, proposalVersion: proposalVersion.slice(0, -1) }],
    ['long token', { ...body, proposalVersion: proposalVersion + 'a' }],
    ['uppercase token', { ...body, proposalVersion: `v1.${'A'.repeat(64)}` }],
    ['token whitespace', { ...body, proposalVersion: ` ${proposalVersion}` }],
    ['missing key', { proposalVersion }], ['null key', { ...body, idempotencyKey: null }],
    ['blank key', { ...body, idempotencyKey: '  ' }], ['long key', { ...body, idempotencyKey: 'x'.repeat(201) }],
  ];
  for (const [label, value] of invalid) await t.test(label, async () => {
    const h = await harness(); const response = await h.accept(request(value));
    assert.equal(response.status, 400); assert.equal(h.calls.length, 0);
    if (label === 'legacy client') assert.match((await response.json()).error, /Reload/u);
  });
  for (const raw of ['', '{"idempotencyKey":']) {
    const h = await harness();
    const response = await h.accept(new NextRequest('https://canvas.test/accept', { method: 'POST', body: raw }));
    assert.equal(response.status, 400); assert.equal(h.calls.length, 0);
  }
});

test('declared and streamed oversized bodies are rejected before any acceptance', async () => {
  const h = await harness();
  const declared = new NextRequest('https://canvas.test/accept', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-length': '4097' },
  });
  assert.equal((await h.accept(declared)).status, 413);
  assert.equal((await h.accept(request({ ...body, padding: 'x'.repeat(4096) }))).status, 413);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3000)); controller.enqueue(new Uint8Array(2000)); },
    cancel() { cancelled = true; },
  });
  const streamed = new NextRequest(new Request('https://canvas.test/accept', { method: 'POST', body: stream, duplex: 'half' } as RequestInit));
  assert.equal((await h.accept(streamed)).status, 413);
  assert.equal(cancelled, true); assert.equal(h.calls.length, 0);
});

test('authorization and rate limits still stop acceptance before parsing or applying', async () => {
  const h = await harness();
  h.controls.denied = true;
  assert.equal((await h.accept(request(body))).status, 403);
  h.controls.denied = false; h.controls.limited = true;
  assert.equal((await h.accept(request(body))).status, 429);
  assert.equal(h.calls.length, 0);
});

test('permission loss immediately before acceptance prevents the mutation', async () => {
  const h = await harness();
  h.controls.revokeBeforeMutation = true;
  const response = await h.accept(request(body));
  assert.equal(response.status, 403);
  assert.equal(h.calls.length, 0);
});

test('disabled review blocks public accept, reject and revert without touching pending proposals', async (t) => {
  for (const action of ['accept', 'reject', 'revert'] as const) await t.test(action, async () => {
    const h = await harness(action);
    h.controls.documentReviewEnabled = false;
    const response = await h.accept(request(action === 'accept' ? body : { idempotencyKey: 'delivery' }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'FVRC_CAPABILITY_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(h.calls.length, 0);
    h.controls.denied = true;
    assert.equal((await h.accept(request(body))).status, 403);
  });
});

test('turning review off during reauthorization stops acceptance and rejection', async (t) => {
  for (const action of ['accept', 'reject'] as const) await t.test(action, async () => {
    const h = await harness(action);
    h.controls.disableBeforeMutation = true;
    const response = await h.accept(request(action === 'accept' ? body : { idempotencyKey: 'delivery' }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'FVRC_CAPABILITY_UNAVAILABLE');
    assert.equal(h.calls.length, 0);
  });
});

test('turning review off after parsing also stops revert and grant before their service call', async (t) => {
  for (const action of ['revert', 'direct-edit-grant'] as const) await t.test(action, async () => {
    const h = await harness(action);
    h.controls.disableBeforeMutation = true;
    const response = await h.accept(request(action === 'revert'
      ? { idempotencyKey: 'delivery' } : { action: 'grant', idempotencyKey: 'delivery' }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'FVRC_CAPABILITY_UNAVAILABLE');
    assert.equal(h.calls.length, 0);
  });
});

test('granting requires enabled review while revocation and grant inspection remain available', async () => {
  const h = await harness('direct-edit-grant');
  h.controls.documentReviewEnabled = false;
  const deniedGrant = await h.accept(request({ action: 'grant', idempotencyKey: 'delivery' }));
  assert.equal(deniedGrant.status, 409);
  assert.equal((await deniedGrant.json()).error.code, 'FVRC_CAPABILITY_UNAVAILABLE');
  assert.equal(h.calls.length, 0);
  const revoked = await h.accept(request({ action: 'revoke', idempotencyKey: 'revoke' }));
  assert.equal(revoked.status, 200);
  assert.equal(h.calls[0]?.action, 'revoke');
  const inspected = await h.get(new NextRequest('https://canvas.test/direct-edit-grant'));
  assert.equal(inspected.status, 200);
  assert.equal(h.calls.length, 2);
  h.controls.documentReviewEnabled = true;
  assert.equal((await h.accept(request({ action: 'grant', idempotencyKey: 'grant' }))).status, 200);
  assert.equal(h.calls[2]?.action, 'grant');
});

test('a changed proposal has a typed refresh response without leaking service details', async () => {
  const h = await harness();
  h.controls.error = new h.ProposalChangedError('private document text, path, or proposal bytes');
  const response = await h.accept(request(body));
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.success, false); assert.equal(payload.code, 'AGENT_PROPOSAL_CHANGED');
  assert.match(payload.error, /Reload/u); assert.doesNotMatch(JSON.stringify(payload), /private/u);
  assert.equal(h.calls.length, 1);
});

test('unexpected service errors are redacted from private responses', async () => {
  const h = await harness();
  h.controls.error = new Error('private document text at /workspace/secret.md');
  const response = await h.accept(request(body));
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /private|workspace|secret\.md/iu);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
});

test('the approval reader preserves tokens exactly while other action bodies remain compatible', async () => {
  const approval = await readCollaborationOperationApproval(request(body));
  assert.equal(approval.response, null); assert.equal(approval.proposalVersion, proposalVersion);
  const rejection = await readCollaborationOperationIdempotencyKey(request({ idempotencyKey: '  legacy-reject  ' }));
  assert.equal(rejection.response, null); assert.equal(rejection.idempotencyKey, 'legacy-reject');
});
