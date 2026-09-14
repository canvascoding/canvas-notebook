import assert from 'node:assert/strict';

import {
  FileVersionCenterClientError,
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
    console.log('file-review-policy-client-test: ok');
  } finally {
    globalThis.fetch = previousFetch;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
