import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { proposalReviewActionErrorResponse } from '../app/lib/file-version-center/proposal-review-action-route-error';
import type * as Route from '../app/api/files/version-center/v1/proposals/actions/route';

const body = { contractVersion: 1, target: { kind: 'document', workspaceId: 'workspace-one',
  documentId: 'document-one', lineageId: 'lineage-one' },
  action: { fence: { actionType: 'reject' } } };

async function harness() {
  const filename = path.resolve('app/api/files/version-center/v1/proposals/actions/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const controls = { denied: false, enabled: false, rolloutWritable: true, fail: false };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/file-version-center/contracts/proposal-review-session-v1') return {
      parseProposalReviewActionApiRequestV1: (value: unknown) => value,
    };
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: { reviewMutation: { perUserPerMinute: 30, perIpPerMinute: 120 } },
      resolveFileVersionRolloutV1: () => ({ restore: controls.rolloutWritable }),
    };
    if (name === '@/app/lib/file-version-center/observability') return { observeFileVersionCenter: (value: unknown) => {
      calls.push({ kind: 'observe', value });
    } };
    if (name === '@/app/lib/file-version-center/proposal-review-capability') return {
      proposalReviewWritesEnabled: (input: { workspaceId: string }) => {
        assert.deepEqual(input, { workspaceId: 'workspace-one' });
        calls.push({ kind: 'capability', value: input });
        return controls.enabled;
      },
    };
    if (name === '@/app/lib/file-version-center/proposal-review-action-runtime') return {
      createRuntimeProposalReviewActionService: async (input: unknown) => { calls.push({ kind: 'runtime', value: input }); return { execute: async () => {
        calls.push({ kind: 'execute' });
        if (controls.fail) throw new ProposalGraphContractError(Codes.currentChanged, 'private path and candidate bytes');
        return { contractVersion: 1, phase: 'succeeded' };
      } }; },
    };
    if (name === '@/app/lib/file-version-center/proposal-review-action-route-error') return { proposalReviewActionErrorResponse };
    if (name === '@/app/lib/file-version-center/query-service') return {
      fileVersionCenterQueryService: { resolve: async () => {
        calls.push({ kind: 'resolve' }); return { workspaceId: 'workspace-one' };
      } },
    };
    if (name === '@/app/lib/file-version-center/route-adapter') return {
      FILE_VERSION_CENTER_PRIVATE_HEADERS: { 'Cache-Control': 'private, no-store, max-age=0' },
      readFileVersionCenterJson: async (request: NextRequest) => request.json(),
      authorizeFileVersionCenterRequest: async (_request: NextRequest, workspaceId: string, permission: string) => {
        calls.push({ kind: 'authorize', value: { workspaceId, permission } });
        return controls.denied ? { authorized: false, response: new NextResponse(null, { status: 403 }) }
          : { authorized: true, session: { user: { id: 'reviewer' }, session: { id: 'reviewer-session-1234' } },
            workspace: { workspaceId }, access: { userId: 'reviewer' } };
      },
      applyFileVersionCenterRateLimit: () => null,
      fileVersionCenterCaughtError: () => NextResponse.json({ success: false }, { status: 500 }),
    };
    if (name === '@/app/lib/file-version-center/contracts/proposal-graph-v1') return { PROPOSAL_GRAPH_ERROR_CODES: Codes, ProposalGraphContractError };
    if (name === '@/app/lib/file-version-center/contracts/v1') return { FILE_VERSION_CENTER_ERROR_CODES: {
      accessDenied: 'FVRC_ACCESS_DENIED', notFound: 'FVRC_NOT_FOUND', conflict: 'FVRC_CONFLICT', invalidRequest: 'FVRC_INVALID_REQUEST' } };
    if (name === '@/app/lib/file-version-center/proposal-review-route-error') return { toProposalReviewRouteError: (error: unknown) => error };
    return load(name);
  }, { exports: route }, route);
  const request = () => new NextRequest('https://canvas.test/api/files/version-center/v1/proposals/actions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { route, calls, controls, request };
}

test('action route requires write authorization and a live capability before resolving target', async () => {
  const h = await harness();
  h.controls.denied = true;
  assert.equal((await h.route.POST(h.request())).status, 403);
  assert.equal(h.calls.some((call) => call.kind === 'capability'), false);
  assert.equal(h.calls.some((call) => call.kind === 'resolve'), false);
  h.controls.denied = false;
  const closed = await h.route.POST(h.request());
  assert.equal(closed.status, 400);
  assert.equal((await closed.json()).diagnosis.reasonCode, Codes.upgradeRequired);
  assert.equal(h.calls.some((call) => call.kind === 'resolve'), false);
  h.controls.enabled = true;
  h.controls.rolloutWritable = false;
  const readOnly = await h.route.POST(h.request());
  assert.equal(readOnly.status, 400);
  assert.equal((await readOnly.json()).diagnosis.reasonCode, Codes.upgradeRequired);
  assert.equal(h.calls.some((call) => call.kind === 'resolve'), false);
  assert.deepEqual(h.calls.filter((call) => call.kind === 'authorize').map((call) => call.value), [
    { workspaceId: 'workspace-one', permission: 'canWrite' },
    { workspaceId: 'workspace-one', permission: 'canWrite' },
    { workspaceId: 'workspace-one', permission: 'canWrite' },
  ]);
});

test('action route emits a private receipt and retains redacted conflict diagnosis', async () => {
  const h = await harness();
  h.controls.enabled = true;
  const success = await h.route.POST(h.request());
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal((await success.json()).phase, 'succeeded');
  assert.equal((h.calls.find((call) => call.kind === 'runtime')?.value as { reviewerSessionId?: string }).reviewerSessionId,
    'reviewer-session-1234');
  h.controls.fail = true;
  const conflict = await h.route.POST(h.request());
  assert.equal(conflict.status, 409);
  const payload = await conflict.text();
  assert.equal(JSON.parse(payload).diagnosis.reasonCode, Codes.currentChanged);
  assert.doesNotMatch(payload, /private path|candidate bytes/u);
});

test('unexpected server errors retain a redacted diagnosis and matching server reference', async () => {
  const original = console.info;
  const logged: string[] = [];
  console.info = (value: unknown) => { logged.push(String(value)); };
  try {
    const response = await proposalReviewActionErrorResponse(Object.assign(
      new Error('private SQL and document bytes /private/file.md'), { code: '40P01', detail: 'secret query' }),
    'compare', Date.now());
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    const body = await response.json();
    assert.equal(body.error.code, 'FVRC_INTERNAL');
    assert.equal(body.diagnosis.reasonCode, 'FVRC_INTERNAL');
    assert.equal(body.diagnosis.phase, 'review');
    assert.equal(typeof body.diagnosis.timestamp, 'number');
    assert.ok(body.diagnosis.buildMarker);
    assert.match(body.diagnosis.correlationId, /^[a-f0-9-]{36}$/u);
    assert.equal(body.error.correlationId, body.diagnosis.correlationId);
    const event = logged.map(value => JSON.parse(value)).find(item => item.component === 'proposal_review_error');
    assert.equal(event.correlationId, body.diagnosis.correlationId);
    assert.equal(event.cause, 'database_deadlock');
    assert.doesNotMatch(JSON.stringify({ body, logged }), /private SQL|private\/file|secret query|document bytes/u);
  } finally { console.info = original; }
});
