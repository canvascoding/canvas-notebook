import assert from 'node:assert/strict';

import {
  FileVersionCenterClientError,
  resolveFileVersionCenterWhenReady,
  updateFileReviewPolicy,
} from '../app/lib/file-version-center/client';

const request = {
  contractVersion: 1 as const,
  target: { kind: 'lineage' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  requestedMode: 'safe_direct' as const,
  expectedRevision: 3,
};

async function main(): Promise<void> {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({
        contractVersion: 1,
        requestedMode: 'safe_direct',
        effectiveMode: 'safe_direct',
        revision: 4,
        locked: false,
        reason: 'user_preference',
      });
    }) as typeof fetch;
    const policy = await updateFileReviewPolicy(request);
    assert.equal(policy.revision, 4);
    assert.equal(calls[0]?.input, '/api/files/version-center/v1/policy');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.equal(new Headers(calls[0]?.init?.headers).get('x-canvas-workspace-id'), 'workspace-one');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), request);

    globalThis.fetch = (async () => Response.json({
      contractVersion: 1,
      success: false,
      error: {
        code: 'FVRC_POLICY_CONFLICT',
        message: 'Changed elsewhere.',
        retryable: false,
      },
    }, { status: 409 })) as typeof fetch;
    await assert.rejects(
      updateFileReviewPolicy(request),
      (error: unknown) => error instanceof FileVersionCenterClientError
        && error.code === 'FVRC_POLICY_CONFLICT'
        && error.status === 409
        && !error.retryable,
    );

    const resolveRequest = {
      contractVersion: 1 as const,
      target: { kind: 'path' as const, workspaceId: 'workspace-one', pathHint: 'notes.md' },
      initialView: 'history' as const,
      source: 'editor' as const,
    };
    const timeline = {
      contractVersion: 1,
      document: {
        workspaceId: 'workspace-one',
        lineageId: 'lineage-one',
        documentId: null,
        path: 'notes.md',
      },
      capabilities: {
        contractVersion: 1,
        history: true,
        compare: true,
        restore: true,
        agentReviewPolicy: true,
        preview: 'markdown',
      },
      policy: {
        contractVersion: 1,
        requestedMode: 'safe_direct',
        effectiveMode: 'safe_direct',
        revision: 0,
        locked: false,
        reason: 'default_safe_direct',
      },
      entries: [],
      page: { hasMore: false, nextCursor: null },
    };
    let resolveCalls = 0;
    globalThis.fetch = (async () => {
      resolveCalls += 1;
      if (resolveCalls === 1) return Response.json({
        contractVersion: 1,
        success: false,
        error: {
          code: 'FVRC_PERSISTENCE_UNAVAILABLE',
          message: 'The collaboration state is still hydrating.',
          retryable: true,
        },
      }, { status: 503 });
      return Response.json(timeline);
    }) as typeof fetch;
    const resolved = await resolveFileVersionCenterWhenReady(resolveRequest, undefined, {
      retryDelaysMs: [0],
    });
    assert.equal(resolveCalls, 2);
    assert.equal(resolved.policy?.effectiveMode, 'safe_direct');

    resolveCalls = 0;
    globalThis.fetch = (async () => {
      resolveCalls += 1;
      return Response.json({
        contractVersion: 1,
        success: false,
        error: {
          code: 'FVRC_NOT_FOUND',
          message: 'Missing.',
          retryable: false,
        },
      }, { status: 404 });
    }) as typeof fetch;
    await assert.rejects(resolveFileVersionCenterWhenReady(resolveRequest, undefined, {
      retryDelaysMs: [0, 0],
    }), (error: unknown) => error instanceof FileVersionCenterClientError
      && error.code === 'FVRC_NOT_FOUND');
    assert.equal(resolveCalls, 1);
    console.log('file-review-policy-client-test: ok');
  } finally {
    globalThis.fetch = previousFetch;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
