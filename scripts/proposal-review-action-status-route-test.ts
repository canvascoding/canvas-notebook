import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { proposalReviewActionErrorResponse } from '../app/lib/file-version-center/proposal-review-action-route-error';
import type * as Route from '../app/api/files/version-center/v1/proposals/actions/status/route';

const body = { contractVersion: 1, target: { kind: 'document', workspaceId: 'workspace-one', documentId: 'document-one' },
  idempotencyKey: 'action-key-00000001', requestDigest: 'a'.repeat(64), approvalExpiresAt: Date.now() + 1_000 };

async function harness() {
  const filename = path.resolve('app/api/files/version-center/v1/proposals/actions/status/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const controls = { denied: false, missing: false, fail: false,
    delayStatus: false, statusReturnAt: 0 };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/file-version-center/contracts/proposal-review-session-v1') return {
      parseProposalReviewActionStatusRequestV1: (value: unknown) => value,
    };
    if (name === '@/app/lib/file-version-center/contracts/proposal-graph-v1') return { PROPOSAL_GRAPH_ERROR_CODES: Codes, ProposalGraphContractError };
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: { reviewMutation: { perUserPerMinute: 30, perIpPerMinute: 120 } },
      resolveFileVersionRolloutV1: () => { throw new Error('Status must not depend on new-write rollout.'); },
    };
    if (name === '@/app/lib/file-version-center/observability') return { observeFileVersionCenter: () => undefined };
    if (name === '@/app/lib/file-version-center/proposal-review-action-route-error') return { proposalReviewActionErrorResponse };
    if (name === '@/app/lib/file-version-center/proposal-review-capability') return {
      proposalReviewWritesEnabled: () => { throw new Error('Status must not depend on new-write capability.'); },
    };
    if (name === '@/app/lib/file-version-center/proposal-review-action-runtime') return {
      createRuntimeProposalReviewActionService: async (input: unknown) => { calls.push({ kind: 'runtime', value: input }); return { status: async (identity: unknown) => {
        calls.push({ kind: 'status', value: identity });
        if (controls.fail) throw new ProposalGraphContractError(Codes.idempotencyMismatch, 'private stored request');
        if (controls.delayStatus) await new Promise((resolve) => setTimeout(resolve, 12));
        controls.statusReturnAt = Date.now();
        return controls.missing ? null : { contractVersion: 1, actionId: 'action-one', phase: 'succeeded' };
      } }; },
    };
    if (name === '@/app/lib/file-version-center/query-service') return { fileVersionCenterQueryService: { resolve: async () => {
      calls.push({ kind: 'resolve' }); return { workspaceId: 'workspace-one' };
    } } };
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
    };
    return load(name);
  }, { exports: route }, route);
  const request = () => new NextRequest('https://canvas.test/api/files/version-center/v1/proposals/actions/status', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { route, calls, controls, request };
}

test('status route authorizes write access before receipt lookup even during rollout shutdown', async () => {
  const h = await harness();
  h.controls.denied = true;
  assert.equal((await h.route.POST(h.request())).status, 403);
  assert.equal(h.calls.some((call) => call.kind === 'resolve' || call.kind === 'status'), false);
  assert.deepEqual(h.calls[0]?.value, { workspaceId: 'workspace-one', permission: 'canWrite' });
  h.controls.denied = false;
  assert.equal((await h.route.POST(h.request())).status, 200);
  assert.equal(h.calls.some((call) => call.kind === 'status'), true);
});

test('status route returns exact receipt or null with private headers and redacted mismatch', async () => {
  const h = await harness();
  const receipt = await h.route.POST(h.request());
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get('cache-control'), 'private, no-store, max-age=0');
  const found = await receipt.json();
  assert.equal(found.receipt.actionId, 'action-one');
  assert.equal(typeof found.checkedAt, 'number');
  assert.equal((h.calls.find((call) => call.kind === 'runtime')?.value as { reviewerSessionId?: string }).reviewerSessionId,
    'reviewer-session-1234');
  assert.deepEqual(h.calls.find((call) => call.kind === 'status')?.value,
    { idempotencyKey: body.idempotencyKey, requestDigest: body.requestDigest });
  h.controls.missing = true;
  const absent = await (await h.route.POST(h.request())).json();
  assert.equal(absent.receipt, null);
  assert.equal(typeof absent.checkedAt, 'number');
  h.controls.fail = true;
  const mismatch = await h.route.POST(h.request());
  assert.equal(mismatch.status, 400);
  const payload = await mismatch.text();
  assert.equal(JSON.parse(payload).diagnosis.reasonCode, Codes.idempotencyMismatch);
  assert.doesNotMatch(payload, /private stored request/u);
});

test('absent status timestamp is a conservative bound from before the locked lookup', async () => {
  const h = await harness();
  h.controls.missing = true;
  h.controls.delayStatus = true;
  const result = await (await h.route.POST(h.request())).json();
  assert.equal(result.receipt, null);
  assert.ok(result.checkedAt < h.controls.statusReturnAt);
});
