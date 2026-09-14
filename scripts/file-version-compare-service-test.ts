import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createFileVersionCompareService,
  type AuthoritativeFileVersionContent,
  type FileVersionAgentCandidate,
} from '../app/lib/file-version-center/compare-service';
import {
  FILE_VERSION_CENTER_CONTRACT_LIMITS,
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  type FileVersionCompareRequestV1,
  type FileVersionCurrentFenceV1,
} from '../app/lib/file-version-center/contracts/v1';
import { FILE_VERSION_CENTER_LIMITS_V1 } from '../app/lib/file-version-center/policy-v1';
import type { ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { FileVersionContentBinding } from '../app/lib/file-version-center/version-content-store';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const workspace: WorkspaceContext = {
  workspaceId: 'workspace-a',
  workspaceType: 'personal',
  organizationId: 'org',
  customerId: null,
  projectId: null,
  rootPath: '/tmp/fvrc-compare',
  displayName: 'Compare',
  status: 'active',
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: true,
    canRunAgent: true,
  },
  legacy: false,
};

const access = {
  userId: 'owner',
  authenticatedWorkspaceId: 'workspace-a',
  requestedWorkspaceId: 'workspace-a',
  membership: 'active' as const,
  permissionsResolved: true,
  canRead: true,
  canWrite: true,
  canRunAgent: true,
  canManageWorkspace: true,
};

const target: ResolvedFileVersionTarget = {
  workspaceId: 'workspace-a',
  lineageId: 'lineage-a',
  documentId: 'document-a',
  path: 'notes/review.md',
  latestRevisionId: 'revision-current',
  latestRevisionHash: null,
  latestRevisionSize: 0,
};

function current(value: string, state = 'state-vector-current'): AuthoritativeFileVersionContent {
  return {
    content: value,
    fence: { revisionId: null, sha256: sha256(value), stateVectorHash: sha256(state) },
    observedAt: 1_789_389_600_000,
  };
}

function request(input: {
  fence: FileVersionCurrentFenceV1;
  kind?: 'revision' | 'agent_operation';
  id?: string;
  cursor?: string;
  limit?: number;
}): FileVersionCompareRequestV1 {
  return {
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
    candidate: { kind: input.kind ?? 'revision', id: input.id ?? 'revision-old' },
    expectedCurrent: input.fence,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  };
}

function binding(revisionId: string, content: string): FileVersionContentBinding {
  return {
    revisionId,
    workspaceId: 'workspace-a',
    lineageId: 'lineage-a',
    blobId: `blob-${revisionId}`,
    format: 'markdown',
    source: 'manual',
    stateVectorHash: null,
    sha256: sha256(content),
    rawSizeBytes: Buffer.byteLength(content),
    storedSizeBytes: 1,
    createdAt: 1,
  };
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error) => error instanceof FileVersionCenterContractError && error.code === code);
}

async function run(): Promise<void> {
  let currentValue = '# Current\n\nShared block\n\nHuman-only line\n';
  const revisions = new Map<string, string>([
    ['revision-old', '# Old\n\nShared block\n'],
    ['revision-missing', ''],
  ]);
  const agentCandidates = new Map<string, FileVersionAgentCandidate>([
    ['operation-review', {
      content: '# Proposed\n\nShared block\n\nHuman-only line\n',
      baseSha256: sha256(currentValue),
      baseStateVectorHash: sha256('state-vector-current'),
      stale: false,
    }],
    ['operation-conflict', {
      content: '# Proposed on stale base\n',
      baseSha256: sha256('# Earlier\n'),
      baseStateVectorHash: sha256('state-vector-earlier'),
      stale: false,
    }],
  ]);
  const service = createFileVersionCompareService({
    query: {
      resolve: async () => target,
      resolveOperation: async ({ operationId }) => operationId === 'operation-other'
        ? { ...target, lineageId: 'lineage-other', documentId: 'document-other' }
        : target,
    },
    contentStore: {
      readRevisionContent: async ({ revisionId }) => {
        const content = revisions.get(revisionId);
        return content === undefined || revisionId === 'revision-missing'
          ? null
          : { binding: binding(revisionId, content), content: Buffer.from(content) };
      },
    },
    current: async () => current(currentValue),
    agentCandidate: async ({ operationId }) => agentCandidates.get(operationId)
      ?? { content: null, baseSha256: null, stale: true },
    compareEnabled: () => true,
  });

  const fence = current(currentValue).fence;
  const historical = await service.compareWithPreview({ request: request({ fence }), access, workspace });
  assert.equal(historical.response.current.fence.sha256, fence.sha256);
  assert.deepEqual(historical.response.candidate.selection, { kind: 'revision', id: 'revision-old' });
  assert.equal(historical.response.candidate.contentAvailable, true);
  assert.ok(historical.response.summary.additions > 0);
  assert.ok(historical.response.summary.deletions > 0);
  assert.ok(historical.response.hunks.length > 0);
  assert.equal(historical.preview.blocks.unchanged, 1);

  await rejectsCode(
    () => service.compare({ request: request({ fence: { ...fence, sha256: sha256('stale') } }), access, workspace }),
    FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
  );

  const agent = await service.compareWithPreview({
    request: request({ fence, kind: 'agent_operation', id: 'operation-review' }), access, workspace,
  });
  assert.equal(agent.response.candidate.stale, false);
  assert.equal(agent.response.candidate.contentAvailable, true);
  assert.match(agent.preview.candidate ?? '', /Human-only line/u,
    'a full candidate projection must retain independent current edits');

  const conflict = await service.compare({
    request: request({ fence, kind: 'agent_operation', id: 'operation-conflict' }), access, workspace,
  });
  assert.equal(conflict.candidate.stale, true);
  assert.equal(conflict.candidate.contentAvailable, false);
  assert.equal(conflict.hunks.length, 0);
  assert.equal(conflict.truncated, true);
  await rejectsCode(
    () => service.compare({
      request: request({ fence, kind: 'agent_operation', id: 'operation-other' }), access, workspace,
    }),
    FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
  );

  const missing = await service.compare({
    request: request({ fence, id: 'revision-missing' }), access, workspace,
  });
  assert.equal(missing.candidate.contentAvailable, false);
  assert.equal(missing.truncated, true);

  const oversized = `${'x'.repeat(FILE_VERSION_CENTER_LIMITS_V1.maxCompareBytesPerSide + 1)}\n`;
  revisions.set('revision-oversized', oversized);
  const oversizedResponse = await service.compare({
    request: request({ fence, id: 'revision-oversized' }), access, workspace,
  });
  assert.equal(oversizedResponse.candidate.contentAvailable, true);
  assert.equal(oversizedResponse.truncated, true);
  assert.equal(oversizedResponse.hunks.length, 0);

  currentValue = Array.from({ length: 32 }, (_, index) => `line-${index}`).join('\n');
  const pagedCandidate = Array.from({ length: 32 }, (_, index) => (
    [3, 15, 27].includes(index) ? `changed-${index}` : `line-${index}`
  )).join('\n');
  revisions.set('revision-paged', pagedCandidate);
  const pagedFence = current(currentValue).fence;
  const firstPage = await service.compare({
    request: request({ fence: pagedFence, id: 'revision-paged', limit: 1 }), access, workspace,
  });
  assert.equal(firstPage.hunks.length, 1);
  assert.equal(firstPage.page.hasMore, true);
  assert.ok(firstPage.page.nextCursor);
  const secondPage = await service.compare({
    request: request({ fence: pagedFence, id: 'revision-paged', limit: 1,
      cursor: firstPage.page.nextCursor ?? undefined }), access, workspace,
  });
  assert.equal(secondPage.hunks.length, 1);
  assert.notEqual(secondPage.hunks[0]?.id, firstPage.hunks[0]?.id);

  revisions.set('revision-paged', `${pagedCandidate}\nlate-change`);
  await rejectsCode(
    () => service.compare({ request: request({ fence: pagedFence, id: 'revision-paged', limit: 1,
      cursor: firstPage.page.nextCursor ?? undefined }), access, workspace }),
    FILE_VERSION_CENTER_ERROR_CODES.staleSelection,
  );

  currentValue = '# Safe\n';
  const unsafe = '<script src="https://evil.test/x.js"></script>\n\n![remote](https://evil.test/i.png)\n'
    + '[click](javascript:alert(1)) and https://evil.test/plain\n';
  revisions.set('revision-unsafe', unsafe);
  let fetchCalls = 0;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    throw new Error('Preview attempted an external request.');
  }) as typeof fetch;
  try {
    const sanitized = await service.compareWithPreview({
      request: request({ fence: current(currentValue).fence, id: 'revision-unsafe' }), access, workspace,
    });
    assert.equal(sanitized.preview.externalRequestsAllowed, false);
    assert.ok(sanitized.preview.blockedExternalReferences >= 4);
    assert.doesNotMatch(sanitized.preview.candidate ?? '', /<script|https:|javascript:|!\[[^\]]*\]\(/iu);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = priorFetch;
  }

  const longLine = 'z'.repeat(FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters + 10);
  revisions.set('revision-long-line', `${longLine}\n`);
  const longLineResult = await service.compare({
    request: request({ fence: current(currentValue).fence, id: 'revision-long-line' }), access, workspace,
  });
  assert.equal(longLineResult.truncated, true);
  assert.equal(longLineResult.hunks[0]?.lines.some((line) => line.text.length
    === FILE_VERSION_CENTER_CONTRACT_LIMITS.diffLineCharacters), true);

  console.log('file-version-compare-service-test: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
