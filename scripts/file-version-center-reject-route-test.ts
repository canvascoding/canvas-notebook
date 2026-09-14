import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import type * as Route from '../app/api/files/collaboration/operations/[operationId]/reject/route';

async function harness() {
  const filename = path.resolve('app/api/files/collaboration/operations/[operationId]/reject/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; input: unknown }> = [];
  const controls = { limited: false, revokeBeforeMutation: false, serviceError: false };
  let authorizationCalls = 0;
  const initialWorkspace = { workspaceId: 'workspace-one', marker: 'initial' };
  const refreshedWorkspace = { workspaceId: 'workspace-one', marker: 'refreshed' };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/workspaces/request') return {
      requireRequestWorkspace: async (_request: NextRequest, options: unknown) => {
        authorizationCalls += 1;
        calls.push({ kind: 'authorize', input: options });
        if (controls.revokeBeforeMutation && authorizationCalls === 2) {
          return { response: NextResponse.json({ success: false }, { status: 403 }) };
        }
        return {
          response: null,
          workspace: authorizationCalls === 1 ? initialWorkspace : refreshedWorkspace,
          session: { user: { id: authorizationCalls === 1 ? 'user-one' : 'user-refreshed' } },
        };
      },
    };
    if (name === '@/app/lib/utils/rate-limit') return {
      dualRateLimit: (_request: NextRequest, input: unknown) => {
        calls.push({ kind: 'rate-limit', input });
        return controls.limited
          ? { ok: false, response: new NextResponse(null, { status: 429 }) }
          : { ok: true };
      },
    };
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: {
        reviewMutation: { perUserPerMinute: 30, perIpPerMinute: 120 },
      },
    };
    if (name === '@/app/lib/file-version-center/observability') return {
      observeFileVersionCenter: (input: unknown) => { calls.push({ kind: 'observe', input }); },
    };
    if (name === '@/app/lib/file-version-center/route-adapter') return {
      withFileVersionCenterPrivateHeaders: (response: NextResponse) => {
        response.headers.set('Cache-Control', 'private, no-store, max-age=0');
        return response;
      },
    };
    if (name === '@/app/lib/collaboration/operation-route') return {
      readCollaborationOperationIdempotencyKey: async (request: NextRequest) => {
        const body = await request.json() as { idempotencyKey?: string };
        return body.idempotencyKey
          ? { idempotencyKey: body.idempotencyKey, response: null }
          : { idempotencyKey: null, response: NextResponse.json({ success: false }, { status: 400 }) };
      },
    };
    if (name === '@/app/lib/collaboration/agent-operations') return {
      rejectAgentOperation: async (input: unknown) => {
        calls.push({ kind: 'reject', input });
        if (controls.serviceError) throw new Error('private body at /workspace/secret.md');
        return { operationId: 'operation-one', status: 'rejected' };
      },
    };
    return load(name);
  }, { exports: route }, route);
  const reject = () => {
    authorizationCalls = 0;
    return route.POST(new NextRequest('https://canvas.test/api/files/collaboration/operations/operation-one/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'reject-once' }),
    }), { params: Promise.resolve({ operationId: 'operation-one' }) });
  };
  return { route, calls, controls, reject, refreshedWorkspace };
}

async function main(): Promise<void> {
  const success = await harness();
  const response = await success.reject();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  const authorizations = success.calls.filter((call) => call.kind === 'authorize');
  assert.deepEqual(authorizations.map((call) => call.input), [
    { permissions: 'canWrite' },
    { workspaceId: 'workspace-one', permissions: 'canWrite' },
  ]);
  assert.deepEqual(success.calls.find((call) => call.kind === 'reject')?.input, {
    operationId: 'operation-one',
    workspace: success.refreshedWorkspace,
    userId: 'user-refreshed',
    idempotencyKey: 'reject-once',
  });

  const revoked = await harness();
  revoked.controls.revokeBeforeMutation = true;
  assert.equal((await revoked.reject()).status, 403);
  assert.equal(revoked.calls.some((call) => call.kind === 'reject'), false);

  const limited = await harness();
  limited.controls.limited = true;
  const limitedResponse = await limited.reject();
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(limited.calls.some((call) => call.kind === 'reject'), false);

  const failed = await harness();
  failed.controls.serviceError = true;
  const failedResponse = await failed.reject();
  assert.equal(failedResponse.status, 409);
  assert.equal(failedResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.doesNotMatch(await failedResponse.text(), /private|workspace|secret\.md/iu);
  console.log('file-version-center-reject-route-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
