import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import type * as DetailRoute from '../app/api/files/operation-reviews/[reviewId]/route';
import type * as ListRoute from '../app/api/files/operation-reviews/route';

const review = { reviewId: 'review-1234567890123456', planId: 'a'.repeat(64),
  sourceWorkspaceId: 'workspace-one', destinationWorkspaceId: 'workspace-one', status: 'pending',
  kind: 'move', selections: [{ sourcePath: 'target.md', destinationPath: 'moved.md' }] };

async function loadRoute<T extends object>(filename: string, mocks: Record<string, unknown>): Promise<T> {
  const absolute = path.resolve(filename);
  const source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const native = createRequire(absolute);
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', source)((name: string) => name in mocks ? mocks[name] : native(name),
    loaded, loaded.exports);
  return loaded.exports;
}

async function harness() {
  const controls = { authenticated: true, revokedOnRefresh: false, sessionRevokedOnRefresh: false,
    reviewEnabled: true,
    sessionCalls: 0, workspaceCalls: 0, reviewKind: 'move',
    requestedPermissions: [] as unknown[],
    stale: false, applyCalls: 0 };
  const workspace = { workspaceId: 'workspace-one', permissions: { canRead: true, canWrite: true,
    canDelete: true } };
  const helpers = {
    applyRateLimit: () => null,
    jsonError: (message: string, status: number, detail?: object) => NextResponse.json({ success: false,
      error: message, ...detail }, { status }),
    jsonSuccess: (body: object) => NextResponse.json({ success: true, ...body }),
    jsonServerError: () => NextResponse.json({ success: false }, { status: 500 }),
  };
  const service = {
    WorkspaceOperationReviewError: class extends Error {
      constructor(readonly code: string, readonly status: number, message: string) { super(message); }
    },
    getWorkspaceOperationReview: async (reviewId: string) => reviewId === review.reviewId
      ? { ...review, kind: controls.reviewKind } : null,
    listWorkspaceOperationReviews: async () => [review, { ...review, reviewId: 'blocked-1234567890123456', status: 'blocked' }],
    rejectWorkspaceOperationReview: async () => ({ ...review, status: 'rejected' }),
    acceptWorkspaceOperationReview: async (input: { refreshAccess: () => Promise<unknown> }) => {
      controls.applyCalls += 1;
      await input.refreshAccess();
      if (controls.stale) throw new service.WorkspaceOperationReviewError('PREVIEW_STALE', 409, 'stale');
      return { ...review, status: 'applied', operationId: 'operation-one' };
    },
  };
  const mocks = {
    '@/app/lib/document-review-availability': { readDocumentReviewAvailability: () => ({ documentReviewEnabled: controls.reviewEnabled, updatedAt: null }) },
    '@/app/lib/auth': { auth: { api: { getSession: async () => {
      controls.sessionCalls += 1;
      return controls.authenticated && !(controls.sessionRevokedOnRefresh && controls.sessionCalls > 1)
        ? { user: { id: 'user-one', name: 'User' } } : null;
    } } } },
    '@/app/lib/api/route-helpers': helpers,
    '@/app/lib/files/workspace-operation-review-service': service,
    '@/app/lib/workspaces/request': {
      requireRequestWorkspace: async () => ({ workspace, session: { user: { id: 'user-one' } }, response: null }),
      requireSessionWorkspace: async (_session: unknown, options: { permissions?: unknown }) => {
        controls.workspaceCalls += 1;
        controls.requestedPermissions.push(options.permissions);
        if (controls.revokedOnRefresh && controls.workspaceCalls > 2) return {
          response: NextResponse.json({ success: false }, { status: 403 }) };
        return { workspace, response: null };
      },
      workspaceFileOptions: () => ({ workspace }),
    },
  };
  const detail = await loadRoute<typeof DetailRoute>('app/api/files/operation-reviews/[reviewId]/route.ts', mocks);
  const list = await loadRoute<typeof ListRoute>('app/api/files/operation-reviews/route.ts', mocks);
  const context = { params: Promise.resolve({ reviewId: review.reviewId }) };
  const request = (body?: object) => new NextRequest('https://canvas.test/api/files/operation-reviews/' + review.reviewId, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { controls, detail, list, context, request };
}

test('review API requires session and exact reviewed plan identity', async () => {
  const h = await harness();
  h.controls.authenticated = false;
  const unauthorized = await h.detail.GET(h.request(), h.context);
  assert.ok(unauthorized);
  assert.equal(unauthorized.status, 401);
  h.controls.authenticated = true;
  const invalid = await h.detail.POST(h.request({ action: 'accept', planId: 'wrong' }), h.context);
  assert.ok(invalid);
  assert.equal(invalid.status, 422);
  h.controls.stale = true;
  const stale = await h.detail.POST(h.request({ action: 'accept', planId: review.planId }), h.context);
  assert.ok(stale);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'PREVIEW_STALE');
});

test('OFF review actions reject new approval and refresh while authenticated status/list/reject remain accessible', async () => {
  const h = await harness();
  h.controls.reviewEnabled = false;
  for (const action of ['accept', 'refresh']) {
    const response = await h.detail.POST(h.request({ action, planId: review.planId }), h.context);
    assert.ok(response);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'DOCUMENT_REVIEW_DISABLED');
  }
  assert.equal(h.controls.applyCalls, 0);
  assert.equal((await h.detail.GET(h.request(), h.context))?.status, 200);
  assert.equal((await h.list.GET(new NextRequest('https://canvas.test/api/files/operation-reviews?workspaceId=workspace-one'))).status, 200);
  assert.equal((await h.detail.POST(h.request({ action: 'reject', planId: review.planId }), h.context))?.status, 200);
});

test('explicit wrong workspace headers cannot expose or mutate an otherwise readable review', async () => {
  const h = await harness();
  for (const method of ['GET', 'POST']) {
    const request = new NextRequest(`https://canvas.test/api/files/operation-reviews/${review.reviewId}`, {
      method, headers: { 'content-type': 'application/json', 'x-canvas-workspace-id': 'another-readable-workspace' },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'accept', planId: review.planId }) } : {}),
    });
    const response = await h.detail[method as 'GET' | 'POST'](request, h.context);
    assert.ok(response);
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.code, 'REVIEW_ACCESS_DENIED');
    assert.equal(payload.review, undefined);
    assert.equal(JSON.stringify(payload).includes('target.md'), false);
  }
  assert.equal(h.controls.applyCalls, 0);
  assert.equal(h.controls.workspaceCalls, 0, 'mismatched navigation is rejected before public workspace projection');
});

test('review API refreshes permissions within accept and exposes attention states', async () => {
  const h = await harness();
  h.controls.revokedOnRefresh = true;
  const rejected = await h.detail.POST(h.request({ action: 'accept', planId: review.planId }), h.context);
  assert.ok(rejected);
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, 'REVIEW_ACCESS_DENIED');
  const listed = await h.list.GET(new NextRequest('https://canvas.test/api/files/operation-reviews?workspaceId=workspace-one'));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).reviews.map((item: { status: string }) => item.status), ['pending', 'blocked']);
});

test('review API rejects a session revoked after the initial route check', async () => {
  const h = await harness();
  h.controls.sessionRevokedOnRefresh = true;
  const response = await h.detail.POST(h.request({ action: 'accept', planId: review.planId }), h.context);
  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'REVIEW_ACCESS_DENIED');
});

test('copy review route asks only read permission on source at both checks', async () => {
  const h = await harness();
  h.controls.reviewKind = 'copy';
  const response = await h.detail.POST(h.request({ action: 'accept', planId: review.planId }), h.context);
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.deepEqual(h.controls.requestedPermissions, ['canRead', 'canWrite', 'canRead', 'canWrite']);
});
