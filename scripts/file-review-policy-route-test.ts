import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import type * as Route from '../app/api/files/version-center/v1/policy/route';
import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileReviewPolicyUpdateRequestV1,
} from '../app/lib/file-version-center/contracts/v1';

const body = {
  contractVersion: 1 as const,
  target: { kind: 'lineage' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  requestedMode: 'safe_direct' as const,
  expectedRevision: 4,
};

async function harness() {
  const filename = path.resolve('app/api/files/version-center/v1/policy/route.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const calls: Array<{ kind: string; input: unknown }> = [];
  const controls = {
    denied: false,
    limited: false,
    capable: true,
    writeError: null as null | 'policy_conflict' | 'access_denied' | 'target_invalid' | 'policy_inconsistent',
  };
  class PolicyError extends Error {
    constructor(readonly code: NonNullable<typeof controls.writeError>) { super(code); }
  }
  const workspace = { workspaceId: 'workspace-one', permissions: { canWrite: true, canRunAgent: true } };
  const access = { userId: 'user-one', canWrite: true, canRunAgent: true };
  const route = {} as typeof Route;
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === '@/app/lib/api/route-helpers') return {
      readJsonBody: async (request: NextRequest) => request.json(),
      applyRateLimit: (_request: NextRequest, options: unknown) => {
        calls.push({ kind: 'rate-limit', input: options });
        return controls.limited ? new NextResponse(null, { status: 429 }) : null;
      },
    };
    if (name === '@/app/lib/file-version-center/contracts/v1') return {
      FILE_VERSION_CENTER_ERROR_CODES,
      FileVersionCenterContractError,
      parseFileReviewPolicyUpdateRequestV1,
    };
    if (name === '@/app/lib/file-version-center/policy-v1') return {
      FILE_VERSION_CENTER_RATE_LIMITS_V1: { policyMutation: { perUserPerMinute: 30 } },
    };
    if (name === '@/app/lib/file-version-center/query-service') return {
      fileVersionCenterQueryService: {
        timeline: async (input: unknown) => {
          calls.push({ kind: 'timeline', input });
          return {
            document: { workspaceId: 'workspace-one', lineageId: 'lineage-one' },
            capabilities: { agentReviewPolicy: controls.capable },
            policy: controls.capable ? { reason: 'user_preference' } : undefined,
          };
        },
      },
    };
    if (name === '@/app/lib/file-version-center/review-policy-service') return {
      FileReviewPolicyServiceError: PolicyError,
      fileReviewPolicyService: {
        writeAuthorized: async (input: unknown) => {
          calls.push({ kind: 'write', input });
          if (controls.writeError) throw new PolicyError(controls.writeError);
          return {
            contractVersion: 1,
            requestedMode: 'safe_direct',
            effectiveMode: 'safe_direct',
            revision: 5,
            locked: false,
            reason: 'user_preference',
          };
        },
      },
    };
    if (name === '@/app/lib/file-version-center/route-adapter') return {
      FILE_VERSION_CENTER_PRIVATE_HEADERS: { 'Cache-Control': 'private, no-store, max-age=0' },
      authorizeFileVersionCenterRequest: async (_request: NextRequest, workspaceId: string, permission: string) => {
        calls.push({ kind: 'authorize', input: { workspaceId, permission } });
        return controls.denied
          ? { authorized: false, response: new NextResponse(null, { status: 403 }) }
          : { authorized: true, session: { user: { id: 'user-one' } }, workspace, access };
      },
      fileVersionCenterCaughtError: (error: unknown) => {
        const code = error instanceof FileVersionCenterContractError
          ? error.code : FILE_VERSION_CENTER_ERROR_CODES.internal;
        const status = code === FILE_VERSION_CENTER_ERROR_CODES.policyConflict ? 409
          : code === FILE_VERSION_CENTER_ERROR_CODES.accessDenied ? 403
            : code === FILE_VERSION_CENTER_ERROR_CODES.notFound ? 404
              : code === FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable ? 503 : 400;
        return NextResponse.json({ contractVersion: 1, success: false, error: {
          code, message: error instanceof Error ? error.message : 'failed', retryable: status >= 500,
        } }, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
      },
    };
    return load(name);
  }, { exports: route }, route);
  const request = () => new NextRequest('https://canvas.test/api/files/version-center/v1/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': 'workspace-one' },
    body: JSON.stringify(body),
  });
  return { route, calls, controls, request, workspace, access };
}

async function main(): Promise<void> {
  const success = await harness();
  const response = await success.route.POST(success.request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.deepEqual(success.calls.map((call) => call.kind), ['authorize', 'rate-limit', 'timeline', 'write']);
  assert.deepEqual(success.calls.find((call) => call.kind === 'authorize')?.input, {
    workspaceId: 'workspace-one', permission: 'canWrite',
  });
  assert.deepEqual(success.calls.find((call) => call.kind === 'write')?.input, {
    access: success.access,
    lineageId: 'lineage-one',
    requestedMode: 'safe_direct',
    expectedRevision: 4,
    workspacePolicy: 'allow_user_choice',
  });
  assert.equal((await response.json()).revision, 5);

  const conflict = await harness();
  conflict.controls.writeError = 'policy_conflict';
  const conflictResponse = await conflict.route.POST(conflict.request());
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error.code, FILE_VERSION_CENTER_ERROR_CODES.policyConflict);

  const unsupported = await harness();
  unsupported.controls.capable = false;
  const unavailableResponse = await unsupported.route.POST(unsupported.request());
  assert.equal(unavailableResponse.status, 400);
  assert.equal((await unavailableResponse.json()).error.code, FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable);
  assert.equal(unsupported.calls.some((call) => call.kind === 'write'), false);

  const denied = await harness();
  denied.controls.denied = true;
  assert.equal((await denied.route.POST(denied.request())).status, 403);
  assert.equal(denied.calls.some((call) => call.kind === 'timeline'), false);

  const limited = await harness();
  limited.controls.limited = true;
  const limitedResponse = await limited.route.POST(limited.request());
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(limited.calls.some((call) => call.kind === 'timeline'), false);
  console.log('file-review-policy-route-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
