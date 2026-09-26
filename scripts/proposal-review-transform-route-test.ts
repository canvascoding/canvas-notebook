import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { proposalReviewActionErrorResponse } from '../app/lib/file-version-center/proposal-review-action-route-error';
import type * as Route from '../app/api/files/version-center/v1/proposals/transform/preview/route';

const body = { contractVersion: 1, target: { kind: 'document', workspaceId: 'workspace-one', documentId: 'document-one' },
  sourceProposalId: 'proposal-one', kind: 'detach', expectedGraphRevision: 3 };

async function harness() {
  const filename = path.resolve('app/api/files/version-center/v1/proposals/transform/preview/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const controls = { denied: false, enabled: false, rolloutWritable: true, fail: false };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/file-version-center/contracts/proposal-review-transform-v1') return {
      parseProposalReviewTransformRequestV1: (value: unknown) => value,
    };
    if (name === '@/app/lib/file-version-center/contracts/proposal-graph-v1') return { PROPOSAL_GRAPH_ERROR_CODES: Codes, ProposalGraphContractError };
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: { reviewMutation: { perUserPerMinute: 30, perIpPerMinute: 120 } },
      resolveFileVersionRolloutV1: () => ({ restore: controls.rolloutWritable }),
    };
    if (name === '@/app/lib/file-version-center/observability') return { observeFileVersionCenter: () => undefined };
    if (name === '@/app/lib/file-version-center/proposal-review-action-route-error') return { proposalReviewActionErrorResponse };
    if (name === '@/app/lib/file-version-center/proposal-review-capability') return { proposalReviewWritesEnabled: () => controls.enabled };
    if (name === '@/app/lib/file-version-center/proposal-review-action-runtime') return {
      createRuntimeProposalReviewActionService: async () => ({ prepareTransform: async (request: unknown) => {
        calls.push({ kind: 'prepare', value: request });
        if (controls.fail) throw new ProposalGraphContractError(Codes.currentChanged, 'private source bytes');
        return { contractVersion: 1, kind: 'detach', beforeContent: 'before', proposedContent: 'after' };
      } }),
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
          : { authorized: true, session: { user: { id: 'reviewer' } }, workspace: { workspaceId }, access: { userId: 'reviewer' } };
      },
      applyFileVersionCenterRateLimit: () => null,
    };
    return load(name);
  }, { exports: route }, route);
  const request = () => new NextRequest('https://canvas.test/api/files/version-center/v1/proposals/transform/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { route, calls, controls, request };
}

test('transform preview is capability and write gated before resolving document identity', async () => {
  const h = await harness();
  h.controls.denied = true;
  assert.equal((await h.route.POST(h.request())).status, 403);
  h.controls.denied = false;
  assert.equal((await h.route.POST(h.request())).status, 400);
  h.controls.enabled = true;
  h.controls.rolloutWritable = false;
  assert.equal((await h.route.POST(h.request())).status, 400);
  assert.equal(h.calls.some((call) => call.kind === 'resolve' || call.kind === 'prepare'), false);
});

test('transform preview passes only exact selection and redacts domain errors', async () => {
  const h = await harness();
  h.controls.enabled = true;
  const response = await h.route.POST(h.request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.deepEqual(h.calls.find((call) => call.kind === 'prepare')?.value,
    { kind: 'detach', sourceProposalId: 'proposal-one', expectedGraphRevision: 3 });
  h.controls.fail = true;
  const failed = await h.route.POST(h.request());
  assert.equal(failed.status, 409);
  const text = await failed.text();
  assert.equal(JSON.parse(text).diagnosis.reasonCode, Codes.currentChanged);
  assert.doesNotMatch(text, /private source bytes/u);
});
