import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { WorkspaceFileOperationServiceInput } from '../app/lib/files/workspace-file-operation-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

/** HTTP contract tests only: backend boundaries are explicit stubs. Genuine
 * principal, journal, graph and FD authority are covered by the owner PG tests. */
async function main() {
  let nativeEnabled = true, authenticated = true, forbidden = false;
  let diskCalls = 0, legacyPreviewCalls = 0, nativePreviewCalls = 0, rawCopies = 0, lockDepth = 0;
  let diskUnavailable = true, historical = false;
  let backendError: Error | null = null, overwriteError: Error | null = null;
  let serviceInput: WorkspaceFileOperationServiceInput | undefined;
  let nativeInput: Record<string, unknown> | undefined;
  const workspace = (workspaceId: string, writable: boolean): WorkspaceContext => ({
    workspaceId, workspaceType: 'organization', organizationId: 'org', ownerUserId: 'user',
    rootPath: `/isolated/${workspaceId}`, rootRelativePath: workspaceId, legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: writable, canDelete: writable,
      canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
  });
  const source = workspace('source', false), destination = workspace('destination', true);
  const planId = 'a'.repeat(64), operationId = 'native-copy-http-operation';
  const privatePlan = { privateNativeStates: ['PRIVATE_NATIVE_SNAPSHOT'], sourceEvidence: 'PRIVATE_EVIDENCE',
    nativePathPlan: 'PRIVATE_NATIVE_ANCHOR', planId };
  const publicPlan = { version: 4, kind: 'native-copy', planId, readiness: 'ready',
    sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    pathMappings: [{ sourcePath: 'note.md', destinationPath: 'Logical/note.md', sourceKind: 'file' }],
    linkEdits: [{ sourcePathBefore: 'note.md', sourcePathAfter: 'Logical/note.md',
      previousTargetLiteral: './old.md', nextTargetLiteral: '../old.md' }],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [] };
  const original = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'user', actorId: 'user', sessionId: 'historical-session' },
    sourceWorkspace: source, destinationWorkspace: destination });
  const record = { operationId, planId, actor: { type: 'user', id: 'user' },
    sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId,
    requestJson: JSON.stringify({ kind: 'copy', origin: original, selections: [{ sourcePath: 'note.md', destinationPath: 'Logical/note.md' }] }),
    status: 'completed', phase: 'complete', revision: 3, errorCode: null,
    steps: [{ stepKey: 'copy-completion', phase: 'link', status: 'applied', receiptJson: 'PRIVATE_RECEIPT' }] };
  const jsonError = (error: string, status: number, details: Record<string, unknown> = {}) =>
    Response.json({ success: false, error, ...details }, { status });
  class WorkspacePreviewStaleError extends Error {}
  class WorkspacePreviewUnavailableError extends Error {}
  class WorkspacePreviewBlockedError extends Error {}
  mock.module('@/app/lib/collaboration/native-text-session-activation', { exports: {
    authenticatedNativeTextSessionEnabled: () => nativeEnabled,
  } });
  mock.module('@/app/lib/auth', { exports: { auth: { api: { getSession: async () => authenticated
    ? { user: { id: 'user', name: 'User' }, session: { id: 'current-session' } } : null } } } });
  mock.module('@/app/lib/workspaces/request', { exports: {
    requireSessionWorkspace: async (_session: unknown, input: { workspaceId: string; permissions: string }) => {
      if (forbidden) return { response: jsonError('Forbidden', 403) };
      const selected = input.workspaceId === source.workspaceId ? source : destination;
      assert.equal(input.permissions, selected === source ? 'canRead' : 'canWrite');
      return { workspace: selected };
    },
    workspaceFileOptions: (workspace: WorkspaceContext) => ({ workspace }),
  } });
  mock.module('@/app/lib/api/route-helpers', { exports: {
    applyRateLimit: () => null, invalidateWorkspaceFileViews: () => {}, jsonError,
    jsonSuccess: (payload: object, init?: ResponseInit) => Response.json({ success: true, ...payload }, init),
    jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
    readJsonBody: (request: Request) => request.json(),
  } });
  mock.module('@/app/lib/audit/audit-service', { exports: { recordAuditEvent: async () => {} } });
  mock.module('@/app/lib/filesystem/app-output-folders', { exports: { isProtectedAppOutputFolder: () => false } });
  mock.module('@/app/lib/filesystem/workspace-files', { exports: {
    getFileStats: async () => { diskCalls += 1; if (diskUnavailable) throw Object.assign(new Error('No physical projection'), { code: 'ENOENT' });
      return { isDirectory: true }; },
    withWorkspaceCopyMutationLocks: async (_source: unknown, _target: unknown, work: () => Promise<unknown>) => {
      lockDepth += 1; try { return await work(); } finally { lockDepth -= 1; }
    },
    batchCopyBetweenWorkspaces: async (_sources: string[], _destDir: string, overwrite: boolean) => {
      assert.equal(lockDepth, 1); assert.equal(overwrite, true); rawCopies += 1;
      if (overwriteError) throw overwriteError;
      return { copied: ['Logical/note.md'], failed: [], skipped: [], collaborationInitializedPaths: ['Logical/note.md'] };
    },
  } });
  mock.module('@/app/lib/files/workspace-file-lifecycle-guard', { exports: {
    withWorkspaceFileLifecycleGuards: async (_scopes: unknown, work: () => Promise<unknown>) => {
      assert.equal(lockDepth, 1); return work();
    },
  } });
  mock.module('@/app/lib/files/collaboration-policy', { exports: { initializeCopiedFileCollaborationPaths: async () => {} } });
  mock.module('@/app/lib/markdown/workspace-file-operation-preview', { exports: {
    WorkspacePreviewStaleError, WorkspacePreviewUnavailableError, WorkspacePreviewBlockedError,
    assertFreshWorkspaceFileOperationPlan: () => {},
    buildWorkspaceFileOperationPreview: async () => { legacyPreviewCalls += 1; return { planId, readiness: 'ready',
      linkEdits: [], pathMappings: [], previewContents: ['PRIVATE_LEGACY_CONTENT'] }; },
  } });
  mock.module('@/app/lib/files/workspace-operation-native-copy-owner', { exports: {
    previewWorkspaceNativeCopyOperation: async (input: Record<string, unknown>) => {
      nativePreviewCalls += 1; nativeInput = input;
      assert.ok(input.request instanceof NextRequest);
      assert.equal(input.request.headers.get('cookie'), 'test-current-session-cookie');
      assert.deepEqual(input.origin, captureWorkspaceOperationCopyOrigin({
        actor: { type: 'user', userId: 'user', actorId: 'user', sessionId: 'current-session' },
        sourceWorkspace: source, destinationWorkspace: destination,
      }));
      if (backendError) throw backendError;
      return privatePlan;
    },
  } });
  mock.module('@/app/lib/files/workspace-operation-native-copy-public', { exports: {
    workspaceOperationNativeCopyPublicPreview: (plan: unknown) => { assert.equal(plan, privatePlan); return publicPlan; },
  } });
  mock.module('@/app/lib/files/workspace-operation-journal', { exports: {
    WorkspaceOperationJournal: class { async get(id: string) { assert.equal(id, operationId); return record; } },
  } });
  mock.module('@/app/lib/files/workspace-file-operation-service', { exports: {
    executeWorkspaceFileOperationService: async (input: WorkspaceFileOperationServiceInput) => {
      serviceInput = input;
      if (backendError) throw backendError;
      return { execution: { operationId, planId, status: 'complete', completedSteps: ['copy-completion'], pendingSteps: [], errorCode: null },
        plan: historical ? null : publicPlan, copied: ['Logical/note.md'], alreadyKnown: historical };
    },
  } });
  const copyRoute = await import('../app/api/files/copy/route');
  const recoveryRoute = await import('../app/api/files/operations/[operationId]/route');
  const request = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/files/copy', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'test-current-session-cookie' },
    body: JSON.stringify({ sources: ['note.md'], destDir: 'Logical', sourceWorkspaceId: source.workspaceId,
      targetWorkspaceId: destination.workspaceId, ...body }),
  });
  const recoveryRequest = () => new NextRequest(`http://localhost/api/files/operations/${operationId}`, {
    method: 'POST', headers: { cookie: 'test-current-session-cookie' },
  });
  const context = { params: Promise.resolve({ operationId }) };
  let passed = 0;
  const group = async (name: string, work: () => Promise<void>) => { await work(); passed += 1; console.log(`ok ${passed} - ${name}`); };
  try {
    await group('native dry-run uses the public projector and the actual current origin/request', async () => {
      const submitted = request({ dryRun: true }); const response = await copyRoute.POST(submitted);
      assert.equal(response.status, 200); const body = await response.json();
      assert.equal(nativeInput?.request, submitted); assert.equal(nativeInput?.destinationDirectory, 'Logical');
      assert.deepEqual(body.plan, publicPlan); assert.equal(body.requiresRevalidation, true);
      for (const secret of ['PRIVATE_', 'privateNativeStates', 'sourceEvidence', 'nativePathPlan', 'historical-session', 'current-session']) {
        assert.equal(JSON.stringify(body).includes(secret), false, `must not expose ${secret}`);
      }
      assert.equal(diskCalls, 0); assert.equal(legacyPreviewCalls, 0); assert.equal(serviceInput, undefined);
    });
    await group('native workspace root is canonical empty-directory data', async () => {
      assert.equal((await copyRoute.POST(request({ dryRun: true, destDir: '.' }))).status, 200);
      assert.equal(nativeInput?.destinationDirectory, '');
    });
    await group('native execute forwards the real request and skips projection-only directory stats', async () => {
      const calls = nativePreviewCalls, submitted = request({ planId });
      const response = await copyRoute.POST(submitted); assert.equal(response.status, 200);
      assert.equal(serviceInput?.request, submitted); assert.equal(serviceInput?.destinationDirectory, 'Logical');
      assert.equal(serviceInput?.actorSessionId, 'current-session'); assert.equal(nativePreviewCalls, calls);
      assert.equal((await response.json()).updatedLinks, 1); assert.equal(diskCalls, 0);
    });
    await group('native root execute forwards empty-directory data', async () => {
      assert.equal((await copyRoute.POST(request({ destDir: '.' }))).status, 200);
      assert.equal(serviceInput?.destinationDirectory, '');
    });
    await group('completed copy HTTP replay does not replan today source or destination', async () => {
      historical = true; const calls = nativePreviewCalls;
      const response = await copyRoute.POST(request({ planId })); assert.equal(response.status, 200);
      assert.equal(nativePreviewCalls, calls); assert.equal(diskCalls, 0);
      assert.equal((await response.json()).operation.status, 'complete');
    });
    await group('recovery forwards the actual new session request without inventing original pins', async () => {
      const calls = nativePreviewCalls, submitted = recoveryRequest();
      const response = await recoveryRoute.POST(submitted, context); assert.ok(response); assert.equal(response.status, 200);
      assert.equal(serviceInput?.request, submitted); assert.equal(serviceInput?.operationId, operationId);
      assert.equal(serviceInput?.actorSessionId, 'current-session'); assert.equal(serviceInput?.actorType, 'user');
      assert.equal(Object.hasOwn(serviceInput!, 'origin'), false); assert.equal(serviceInput?.destinationDirectory, undefined);
      assert.equal(nativePreviewCalls, calls); assert.equal(diskCalls, 0);
      const body = JSON.stringify(await response.json()); assert.equal(body.includes('historical-session'), false);
      assert.equal(body.includes('PRIVATE_RECEIPT'), false);
    });
    await group('native destination 404 and 409 are preserved at the HTTP boundary', async () => {
      for (const [status, code] of [[404, 'DESTINATION_NOT_FOUND'], [409, 'DESTINATION_NOT_DIRECTORY']] as const) {
        backendError = Object.assign(new Error(code), { status, code });
        const response = await copyRoute.POST(request({ dryRun: true })); assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
      }
      backendError = null;
    });
    await group('expired actual principals stay 401 in execute and recovery', async () => {
      backendError = Object.assign(new Error('Current session expired'), { status: 401, code: 'PRINCIPAL_AUTH_REVOKED' });
      assert.equal((await copyRoute.POST(request({}))).status, 401);
      assert.equal((await recoveryRoute.POST(recoveryRequest(), context))!.status, 401); backendError = null;
    });
    await group('statusless principal revocation and denial codes retain their real HTTP meaning', async () => {
      for (const [status, code] of [[401, 'PRINCIPAL_AUTH_REVOKED'], [403, 'PRINCIPAL_ACCESS_DENIED']] as const) {
        // Existing WorkspaceRequestPrincipalError exposes code and no status.
        backendError = Object.assign(new Error(code), { code });
        const response = await copyRoute.POST(request({})); assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
        assert.equal((await recoveryRoute.POST(recoveryRequest(), context))!.status, status);
      }
      backendError = null;
    });
    await group('initial authentication and workspace denial stop before backend work', async () => {
      const calls = nativePreviewCalls; authenticated = false;
      assert.equal((await copyRoute.POST(request({ dryRun: true }))).status, 401); authenticated = true;
      forbidden = true; assert.equal((await copyRoute.POST(request({ dryRun: true }))).status, 403); forbidden = false;
      assert.equal(nativePreviewCalls, calls);
    });
    await group('gate-disabled dry-run retains its physical preview contract', async () => {
      nativeEnabled = false; diskUnavailable = false;
      const calls = diskCalls, response = await copyRoute.POST(request({ dryRun: true }));
      assert.equal(response.status, 200); assert.equal(diskCalls, calls + 1); assert.equal(legacyPreviewCalls, 1);
      assert.equal((await response.json()).plan.previewContents, undefined); nativeEnabled = true;
    });
    await group('legacy overwrite remains under its original mutation and lifecycle guards', async () => {
      const calls = rawCopies; assert.equal((await copyRoute.POST(request({ overwrite: true }))).status, 200);
      assert.equal(rawCopies, calls + 1);
      overwriteError = Object.assign(new Error('Native replacement is unsupported'), { status: 409, code: 'NATIVE_COPY_REPLACEMENT_UNSUPPORTED' });
      const response = await copyRoute.POST(request({ overwrite: true })); assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'NATIVE_COPY_REPLACEMENT_UNSUPPORTED'); overwriteError = null;
      assert.equal((await copyRoute.POST(request({ overwrite: true, dryRun: true }))).status, 422);
    });
    console.log(`workspace-operation-native-copy-route-test: ${passed}/${passed} groups passed`);
  } finally { mock.reset(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
