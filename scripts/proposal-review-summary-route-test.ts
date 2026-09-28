import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import { ProposalGraphContractError, PROPOSAL_GRAPH_ERROR_CODES as Codes } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { parseProposalReviewSummaryRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-summary-v1';
import { proposalReviewActionErrorResponse } from '../app/lib/file-version-center/proposal-review-action-route-error';
import type * as Route from '../app/api/files/version-center/v1/proposals/summary/route';

const body = {
  contractVersion: 1,
  target: { kind: 'document' as const, workspaceId: 'workspace-one', documentId: 'document-one' },
  operationIds: ['operation-one'],
};
const privateHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
};

async function harness() {
  const filename = path.resolve('app/api/files/version-center/v1/proposals/summary/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const controls = { denied: false, limited: false, fail: false };
  const workspace = { workspaceId: 'workspace-one', permissions: { canRead: true } };
  const access = { userId: 'reviewer', canRead: true };
  const resolvedTarget = { workspaceId: 'workspace-one', lineageId: 'lineage-one', documentId: 'document-one',
    path: 'private/document.md' };
  const summary = { contractVersion: 1, target: { workspaceId: 'workspace-one', lineageId: 'lineage-one',
    documentId: 'document-one' }, current: null, graphRevision: null, checkedAt: 1_800_000_000_000,
    items: [{ mode: 'legacy', operationId: 'operation-one' }] };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/file-version-center/contracts/proposal-review-summary-v1') {
      return { parseProposalReviewSummaryRequestV1 };
    }
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: { compare: { perUserPerMinute: 20, perIpPerMinute: 80 } },
    };
    if (name === '@/app/lib/file-version-center/proposal-review-summary') return {
      readProposalReviewSummary: async (input: unknown) => {
        calls.push({ kind: 'summary', value: input });
        if (controls.fail) throw new ProposalGraphContractError(Codes.currentChanged, 'private path and candidate bytes');
        return summary;
      },
    };
    if (name === '@/app/lib/file-version-center/query-service') return {
      fileVersionCenterQueryService: { resolve: async (input: unknown) => {
        calls.push({ kind: 'resolve', value: input });
        return resolvedTarget;
      } },
    };
    if (name === '@/app/lib/file-version-center/proposal-review-action-route-error') return { proposalReviewActionErrorResponse };
    if (name === '@/app/lib/file-version-center/route-adapter') return {
      FILE_VERSION_CENTER_PRIVATE_HEADERS: privateHeaders,
      readFileVersionCenterJson: async (request: NextRequest) => {
        calls.push({ kind: 'read-body' });
        return request.json();
      },
      authorizeFileVersionCenterRequest: async (_request: NextRequest, workspaceId: string, permission: string) => {
        calls.push({ kind: 'authorize', value: { workspaceId, permission } });
        return controls.denied ? { authorized: false, response: new NextResponse(null, { status: 403 }) }
          : { authorized: true, session: { user: { id: 'reviewer' } }, workspace, access };
      },
      applyFileVersionCenterRateLimit: (_request: NextRequest, input: unknown) => {
        calls.push({ kind: 'rate-limit', value: input });
        return controls.limited ? NextResponse.json({ error: 'rate limited' }, { status: 429,
          headers: privateHeaders }) : null;
      },
      fileVersionCenterCaughtError: () => NextResponse.json({ success: false }, { status: 500, headers: privateHeaders }),
    };
    if (name === '@/app/lib/file-version-center/contracts/proposal-graph-v1') return {
      PROPOSAL_GRAPH_ERROR_CODES: Codes, ProposalGraphContractError,
    };
    return load(name);
  }, { exports: route }, route);
  const request = (payload: unknown = body) => new NextRequest('https://canvas.test/api/files/version-center/v1/proposals/summary', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-canvas-workspace-id': 'workspace-one' },
    body: JSON.stringify(payload),
  });
  return { route, calls, controls, request, workspace, access, resolvedTarget, summary };
}

test('summary route authorizes before rate limiting, resolving scope, or reading the summary', async () => {
  const h = await harness();
  h.controls.denied = true;
  const response = await h.route.POST(h.request());
  assert.equal(response.status, 403);
  assert.deepEqual(h.calls.map((call) => call.kind), ['read-body', 'authorize']);
  assert.deepEqual(h.calls[1]?.value, { workspaceId: 'workspace-one', permission: 'canRead' });
  assert.equal(h.calls.some((call) => call.kind === 'resolve' || call.kind === 'summary' || call.kind === 'rate-limit'), false);
});

test('malformed summary requests fail contract validation before scope resolution', async () => {
  const h = await harness();
  const response = await h.route.POST(h.request({ ...body, operationIds: [] }));
  assert.equal(response.status, 400);
  assert.deepEqual(h.calls.map((call) => call.kind), ['read-body']);
  const payload = await response.json();
  assert.equal(payload.error.code, 'FVRC_INVALID_REQUEST');
  assert.equal(h.calls.some((call) => call.kind === 'resolve' || call.kind === 'summary'), false);
});

test('summary route applies the compare rate limit before resolving or evaluating', async () => {
  const h = await harness();
  h.controls.limited = true;
  const response = await h.route.POST(h.request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('cache-control'), privateHeaders['Cache-Control']);
  assert.deepEqual(h.calls.map((call) => call.kind), ['read-body', 'authorize', 'rate-limit']);
  const rate = h.calls[2]?.value as Record<string, unknown>;
  assert.equal(rate.operation, 'compare');
  assert.deepEqual(rate.rate, { perUserPerMinute: 20, perIpPerMinute: 80 });
  assert.equal(rate.verifiedUserId, 'reviewer');
});

test('success resolves the exact target scope and returns a private summary', async () => {
  const h = await harness();
  const response = await h.route.POST(h.request());
  assert.equal(response.status, 200);
  for (const [name, value] of Object.entries(privateHeaders)) assert.equal(response.headers.get(name), value);
  assert.deepEqual(h.calls.map((call) => call.kind), ['read-body', 'authorize', 'rate-limit', 'resolve', 'summary']);
  assert.deepEqual(h.calls.find((call) => call.kind === 'resolve')?.value,
    { target: body.target, access: h.access });
  assert.deepEqual(h.calls.find((call) => call.kind === 'summary')?.value,
    { request: body, target: h.resolvedTarget, workspace: h.workspace, access: h.access });
  assert.deepEqual(await response.json(), h.summary);
});

test('summary route redacts private service exceptions while preserving the bounded conflict diagnosis', async () => {
  const h = await harness();
  h.controls.fail = true;
  const response = await h.route.POST(h.request());
  assert.equal(response.status, 409);
  for (const [name, value] of Object.entries(privateHeaders)) assert.equal(response.headers.get(name), value);
  const payload = await response.text();
  assert.equal(JSON.parse(payload).diagnosis.reasonCode, Codes.currentChanged);
  assert.doesNotMatch(payload, /private path|candidate bytes|private\/document\.md/u);
});
