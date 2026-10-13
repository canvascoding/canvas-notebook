import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import type * as Route from '../app/api/files/version-center/v1/restore/route';
import * as contracts from '../app/lib/file-version-center/contracts/v1';

const restoreBody = {
  contractVersion: 1,
  target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  revisionId: 'revision-seven',
  expectedCurrent: { revisionId: 'revision-current', sha256: 'a'.repeat(64) },
  idempotencyKey: 'restore-request-0001',
};

async function harness() {
  const filename = path.resolve('app/api/files/version-center/v1/restore/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<Record<string, unknown>> = [];
  const controls = { denied: false, limited: false, revokeBeforeMutation: false, revokeWhileLocked: false,
    switchUserWhileLocked: false, switchSessionWhileLocked: false };
  let authorizationCalls = 0;
  const workspace = { workspaceId: 'workspace-one', permissions: { canWrite: true } };
  const access = { userId: 'user-one', canWrite: true };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/file-version-center/contracts/v1') {
      return contracts;
    }
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: { restore: { perUserPerMinute: 10, perIpPerMinute: 60 } },
    };
    if (name === '@/app/lib/file-version-center/observability') return {
      observeFileVersionCenter: () => undefined,
    };
    if (name === '@/app/lib/file-version-center/route-adapter') return {
      FILE_VERSION_CENTER_PRIVATE_HEADERS: { 'Cache-Control': 'private, no-store, max-age=0' },
      readFileVersionCenterJson: async (request: NextRequest) => request.json(),
      applyFileVersionCenterRateLimit: (_request: NextRequest, input: unknown) => {
        calls.push({ rateLimit: input });
        return controls.limited ? new NextResponse(null, { status: 429,
          headers: { 'Cache-Control': 'private, no-store, max-age=0' } }) : null;
      },
      authorizeFileVersionCenterRequest: async (_request: NextRequest, workspaceId: string, permission: string) => {
        authorizationCalls += 1;
        calls.push({ authorize: { workspaceId, permission } });
        return controls.denied || (controls.revokeBeforeMutation && authorizationCalls === 2)
          || (controls.revokeWhileLocked && authorizationCalls === 3)
          ? { authorized: false, response: new NextResponse(null, { status: 403 }) }
          : { authorized: true, session: { user: { id: controls.switchUserWhileLocked && authorizationCalls === 3 ? 'other-user' : 'user-one' },
            session: { id: controls.switchSessionWhileLocked && authorizationCalls === 3 ? 'other-session' : 'session-one' } }, workspace, access };
      },
      fileVersionCenterCaughtError: (error: unknown) => NextResponse.json({ success: false }, {
        status: error instanceof contracts.FileVersionCenterContractError
          && error.code === contracts.FILE_VERSION_CENTER_ERROR_CODES.accessDenied ? 403 : 500,
      }),
    };
    if (name === '@/app/lib/file-version-center/restore-service') return {
      fileVersionRestoreService: {
        restore: async (input: Record<string, unknown>) => {
          calls.push({ restore: input });
          await (input.beforeApply as () => Promise<unknown>)();
          return {
            contractVersion: 1,
            outcome: 'restored',
            priorRevisionId: 'revision-current',
            restoredRevisionId: 'revision-restored',
            current: { revisionId: 'revision-restored', sha256: 'b'.repeat(64) },
          };
        },
      },
    };
    return load(name);
  }, { exports: route }, route);
  const request = () => new NextRequest('https://canvas.test/api/files/version-center/v1/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': 'workspace-one' },
    body: JSON.stringify(restoreBody),
  });
  return { route, calls, controls, request, workspace, access };
}

async function main(): Promise<void> {
  const success = await harness();
  const response = await success.route.POST(success.request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.deepEqual(success.calls[0], { authorize: { workspaceId: 'workspace-one', permission: 'canWrite' } });
  const rateCall = success.calls[1]?.rateLimit as Record<string, unknown>;
  assert.equal(rateCall.operation, 'restore');
  assert.deepEqual(rateCall.rate, { perUserPerMinute: 10, perIpPerMinute: 60 });
  assert.equal(rateCall.verifiedUserId, 'user-one');
  assert.equal(typeof rateCall.startedAt, 'number');
  assert.deepEqual(success.calls[2], { authorize: { workspaceId: 'workspace-one', permission: 'canWrite' } });
  const applied = success.calls[3].restore as Record<string, unknown>;
  assert.deepEqual(applied.request, restoreBody);
  assert.deepEqual(applied.access, success.access);
  assert.deepEqual(applied.workspace, success.workspace);
  assert.equal(applied.actorSessionId, 'session-one');
  assert.equal(typeof applied.beforeApply, 'function');
  assert.deepEqual(success.calls[4], { authorize: { workspaceId: 'workspace-one', permission: 'canWrite' } });
  assert.equal((await response.json()).restoredRevisionId, 'revision-restored');

  const denied = await harness();
  denied.controls.denied = true;
  assert.equal((await denied.route.POST(denied.request())).status, 403);
  assert.equal(denied.calls.some((call) => 'restore' in call), false);

  const revoked = await harness();
  revoked.controls.revokeBeforeMutation = true;
  assert.equal((await revoked.route.POST(revoked.request())).status, 403);
  assert.equal(revoked.calls.filter((call) => 'authorize' in call).length, 2);
  assert.equal(revoked.calls.some((call) => 'restore' in call), false,
    'permission loss after validation must stop the restore mutation');

  for (const condition of ['revokeWhileLocked', 'switchUserWhileLocked', 'switchSessionWhileLocked'] as const) {
    const late = await harness();
    late.controls[condition] = true;
    assert.equal((await late.route.POST(late.request())).status, 403,
      'The callback executed under domain locks must revalidate current authority and immutable session identity.');
    assert.equal(late.calls.filter(call => 'authorize' in call).length, 3);
  }

  const limited = await harness();
  limited.controls.limited = true;
  const limitedResponse = await limited.route.POST(limited.request());
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(limited.calls.some((call) => 'restore' in call), false);
  console.log('file-version-center-restore-route-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
