import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { createRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import type { AgentDirectConnectionInput } from '../app/lib/collaboration/direct-connection';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import type * as YTypes from 'yjs';
import { fileVersionFencesMatch, type AuthoritativeFileVersionContent } from '../app/lib/file-version-center/authoritative-content';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import {
  FILE_VERSION_CENTER_CONTRACT_VERSION,
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  type FileVersionCurrentFenceV1,
  type FileVersionRestoreRequestV1,
} from '../app/lib/file-version-center/contracts/v1';
import type { FileVersionCaptureInput, FileVersionCaptureResult } from '../app/lib/file-version-center/history-service';
import type { ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import {
  createFileVersionRestoreService,
  createRuntimeFileVersionRestoreApply,
  type FileVersionRestoreApply,
} from '../app/lib/file-version-center/restore-service';
import { createFileVersionContentStore } from '../app/lib/file-version-center/version-content-store';
import type { FileRevisionRecord } from '../app/lib/files/collaboration-policy';
import type { WriteWorkspaceFileContentInput } from '../app/lib/files/write-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: async <Row>(sql: string, params?: unknown[]) => {
        const result = await transaction.query<Row>(sql, params);
        return { rows: result.rows, rowCount: result.affectedRows };
      },
    })),
  };
}

const workspace: WorkspaceContext = {
  workspaceId: 'workspace-a',
  workspaceType: 'personal',
  organizationId: 'org',
  customerId: null,
  projectId: null,
  rootPath: '/tmp/fvrc-restore',
  displayName: 'Restore',
  status: 'active',
  actor: { userId: 'owner', email: 'owner@restore.test', role: 'owner' },
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

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness() {
  const postgres = new PGlite();
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  const selectedContent = '# Selected\n\nRestored block\n';
  let currentContent = '# Current\n\nWorking block\n';
  let currentRevisionId = 'revision-current';
  let currentRevisionContent = currentContent;
  let stateGeneration = 1;
  let time = 1_789_389_600_000;
  let applyCount = 0;
  let restoreCaptureCount = 0;
  let revalidationCount = 0;
  let crashAfterApply = false;
  let mutateBeforeFence: string | null = null;
  let applyBarrier: { entered: Promise<void>; release: () => void } | null = null;
  const restoreRevisions = new Map<string, string>();

  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES ('owner', 'Owner', 'owner@restore.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES ('workspace-a', 'org', 'personal', 'owner', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, organization_id, workspace_id, workspace_type, path, status, created_at
    ) VALUES ('lineage-a', 'org', 'workspace-a', 'personal', 'renamed/review.md', 'active', 1);
    INSERT INTO collaboration_documents (
      id, organization_id, workspace_id, workspace_type, path, lineage_id,
      provider, state_version, status, created_at, updated_at
    ) VALUES ('document-a', 'org', 'workspace-a', 'personal', 'renamed/review.md', 'lineage-a',
      'yjs', 1, 'active', 1, 1);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, document_path, document_representation,
      workspace_id, organization_id, initiated_by_user_id, actor_id,
      idempotency_key, payload_hash, status, base_state_vector, created_at, updated_at
    ) VALUES
      ('operation-stale', 'document-a', 'renamed/review.md', 'plain_text',
       'workspace-a', 'org', 'owner', 'agent-stale', 'operation-stale-key', repeat('a', 64),
       'needs_review', '\\x00', 1, 1),
      ('operation-safe', 'document-a', 'renamed/review.md', 'plain_text',
       'workspace-a', 'org', 'owner', 'agent-safe', 'operation-safe-key', repeat('b', 64),
       'needs_review', '\\x00', 1, 1);
    INSERT INTO file_revisions (
      id, organization_id, workspace_id, workspace_type, path, content_hash,
      size_bytes, created_by_user_id, created_by_actor_type, lineage_id,
      revision_number, created_at
    ) VALUES
      ('revision-selected', 'org', 'workspace-a', 'personal', 'renamed/review.md', '${sha256(selectedContent)}',
       ${Buffer.byteLength(selectedContent)}, 'owner', 'user', 'lineage-a', 1, 1),
      ('revision-current', 'org', 'workspace-a', 'personal', 'renamed/review.md', '${sha256(currentContent)}',
       ${Buffer.byteLength(currentContent)}, 'owner', 'user', 'lineage-a', 2, 2);
  `);
  const db = database(postgres);
  const contentStore = createFileVersionContentStore({ database: db,
    now: () => time, id: (() => { let id = 0; return () => `blob-${++id}`; })() });
  await contentStore.bindRevisionContent({ revisionId: 'revision-selected', workspaceId: 'workspace-a',
    lineageId: 'lineage-a', content: selectedContent, format: 'markdown', source: 'manual' });
  await contentStore.bindRevisionContent({ revisionId: 'revision-current', workspaceId: 'workspace-a',
    lineageId: 'lineage-a', content: currentContent, format: 'markdown', source: 'manual' });

  const target = (): ResolvedFileVersionTarget => ({
    workspaceId: 'workspace-a', lineageId: 'lineage-a', documentId: 'document-a',
    path: 'renamed/review.md', latestRevisionId: currentRevisionId,
    latestRevisionHash: sha256(currentRevisionContent), latestRevisionSize: Buffer.byteLength(currentRevisionContent),
  });
  const current = async (): Promise<AuthoritativeFileVersionContent> => {
    const contentHash = sha256(currentContent);
    return { content: currentContent, fence: {
      revisionId: contentHash === sha256(currentRevisionContent) ? currentRevisionId : null,
      sha256: contentHash, stateVectorHash: sha256(`state-${stateGeneration}`),
    }, observedAt: time };
  };
  const revision = (id: string, content: string, source: FileRevisionRecord['createdByActorType'],
    sourceSessionId: string | null, baseRevisionId: string | null, revisionNumber: number): FileRevisionRecord => ({
    id, lineageId: 'lineage-a', organizationId: 'org', customerId: null, projectId: null,
    workspaceId: 'workspace-a', workspaceType: 'personal', path: 'renamed/review.md',
    contentHash: sha256(content), sizeBytes: Buffer.byteLength(content), createdByUserId: 'owner',
    createdByActorType: source, sourceSessionId, baseRevisionId, createdAt: time + revisionNumber,
  });
  const history = {
    capture: async (input: FileVersionCaptureInput): Promise<FileVersionCaptureResult> => {
      const value = typeof input.content === 'string' ? input.content : Buffer.from(input.content).toString('utf8');
      if (input.source !== 'restore') {
        const stored = await contentStore.readRevisionContent({ revisionId: currentRevisionId,
          workspaceId: 'workspace-a', lineageId: 'lineage-a' });
        assert.ok(stored);
        return { outcome: 'already_captured', revision: revision(currentRevisionId, currentRevisionContent,
          'user', null, null, currentRevisionId === 'revision-current' ? 2 : 3), binding: stored.binding };
      }
      restoreCaptureCount += 1;
      const marker = input.sourceSessionId ?? 'missing-marker';
      const prior = restoreRevisions.get(marker);
      if (prior) {
        const stored = await contentStore.readRevisionContent({ revisionId: prior,
          workspaceId: 'workspace-a', lineageId: 'lineage-a' });
        assert.ok(stored);
        return { outcome: 'already_captured', revision: revision(prior, value, 'user', marker,
          input.baseRevisionId ?? null, 3), binding: stored.binding };
      }
      const id = `revision-restore-${restoreRevisions.size + 1}`;
      await postgres.query(`
        INSERT INTO file_revisions (
          id, organization_id, workspace_id, workspace_type, path, content_hash,
          size_bytes, created_by_user_id, created_by_actor_type, source_session_id,
          base_revision_id, lineage_id, revision_number, created_at
        ) VALUES ($1, 'org', 'workspace-a', 'personal', 'renamed/review.md', $2, $3,
          'owner', 'user', $4, $5, 'lineage-a', $6, $7)
      `, [id, sha256(value), Buffer.byteLength(value), marker, input.baseRevisionId ?? null,
        3 + restoreRevisions.size, time + 3 + restoreRevisions.size]);
      const stored = await contentStore.bindRevisionContent({ revisionId: id, workspaceId: 'workspace-a',
        lineageId: 'lineage-a', content: value, format: 'markdown', source: 'restore' });
      restoreRevisions.set(marker, id);
      currentRevisionId = id;
      currentRevisionContent = value;
      return { outcome: 'captured', revision: revision(id, value, 'user', marker,
        input.baseRevisionId ?? null, 3), binding: stored.binding };
    },
  };
  const apply: FileVersionRestoreApply = async (input) => {
    if (mutateBeforeFence !== null) {
      currentContent = mutateBeforeFence;
      stateGeneration += 1;
      mutateBeforeFence = null;
    }
    const actual = await current();
    if (!fileVersionFencesMatch(actual.fence, input.expectedCurrent)) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
        'Concurrent edit won the restore fence.');
    }
    applyCount += 1;
    if (applyBarrier) await applyBarrier.entered;
    currentContent = input.content;
    stateGeneration += 1;
    if (crashAfterApply) {
      crashAfterApply = false;
      throw new Error('simulated uncertain network completion');
    }
    return current();
  };

  const makeService = () => createFileVersionRestoreService({ database: db,
    query: { resolve: async () => target() }, contentStore, history, current: async () => current(), apply,
    restoreEnabled: () => true, now: () => time,
    leaseToken: (() => { let id = 0; return () => `lease-token-${String(++id).padStart(8, '0')}`; })(),
    operationPreview: async ({ operationId }) => {
      revalidationCount += 1;
      const safe = operationId === 'operation-safe';
      return { documentId: 'document-a', workspaceId: 'workspace-a',
        baseSha256: safe ? sha256(selectedContent) : sha256('# Current\n\nWorking block\n'),
        baseStateVectorHash: safe ? sha256(`state-${stateGeneration}`) : sha256('state-1'),
        proposalVersion: 'v1.preview', content: safe ? selectedContent : null, stale: !safe };
    },
  });
  const request = (input: { key: string; fence?: FileVersionCurrentFenceV1 }): FileVersionRestoreRequestV1 => ({
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
    revisionId: 'revision-selected',
    expectedCurrent: input.fence ?? ({} as FileVersionCurrentFenceV1),
    idempotencyKey: input.key,
  });
  return {
    postgres, service: makeService(), makeService, selectedContent, current,
    request: async (key: string) => request({ key, fence: (await current()).fence }),
    requestWithFence: request,
    advance: (milliseconds: number) => { time += milliseconds; },
    counts: () => ({ applyCount, restoreCaptureCount, revalidationCount }),
    setCrashAfterApply: () => { crashAfterApply = true; },
    setConcurrentMutation: (content: string) => { mutateBeforeFence = content; },
    installBarrier: () => {
      let enteredResolve = () => {};
      let releaseResolve = () => {};
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
      applyBarrier = { entered: released, release: releaseResolve };
      return { waitUntilEntered: async () => {
        while (applyCount === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        enteredResolve();
        await entered;
      }, release: () => { applyBarrier?.release(); applyBarrier = null; } };
    },
  };
}

async function close(harness: Harness): Promise<void> {
  await harness.postgres.close();
}

async function successfulRestoreAndRestartRetry(): Promise<void> {
  const harness = await createHarness();
  try {
    const restoreRequest = await harness.request('restore-success-0001');
    const restored = await harness.service.restore({ request: restoreRequest, access, workspace, actorSessionId: 'session-a' });
    assert.equal(restored.outcome, 'restored');
    assert.equal(restored.priorRevisionId, 'revision-current');
    assert.equal(restored.current.sha256, sha256(harness.selectedContent));
    assert.equal(harness.counts().applyCount, 1);
    assert.equal(harness.counts().revalidationCount, 2);
    const rows = await harness.postgres.query<{ source: string; content_hash: string }>(`
      SELECT contents.source, revisions.content_hash
      FROM file_revisions revisions
      INNER JOIN file_revision_contents contents ON contents.revision_id = revisions.id
      WHERE revisions.lineage_id = 'lineage-a' ORDER BY revisions.revision_number
    `);
    assert.deepEqual(rows.rows.map((row) => row.source), ['manual', 'manual', 'restore']);
    assert.equal(rows.rows[0]?.content_hash, sha256(harness.selectedContent), 'restore never deletes the selected history row');
    const operations = await harness.postgres.query<{ operation_id: string; status: string }>(`
      SELECT operation_id, status FROM collaboration_agent_operations ORDER BY operation_id
    `);
    assert.deepEqual(operations.rows, [
      { operation_id: 'operation-safe', status: 'needs_review' },
      { operation_id: 'operation-stale', status: 'semantic_conflict' },
    ], 'restore re-evaluates proposals and invalidates only stale candidates');

    const afterRestart = harness.makeService();
    const retried = await afterRestart.restore({ request: restoreRequest, access, workspace, actorSessionId: 'session-a' });
    assert.equal(retried.outcome, 'already_restored');
    assert.equal(retried.restoredRevisionId, restored.restoredRevisionId);
    assert.equal(harness.counts().applyCount, 1);
  } finally { await close(harness); }
}

async function staleAndParallelUserEditFences(): Promise<void> {
  const harness = await createHarness();
  try {
    const actual = await harness.current();
    const stale = harness.requestWithFence({ key: 'restore-stale-00001',
      fence: { ...actual.fence, sha256: sha256('older') } });
    await assert.rejects(
      () => harness.service.restore({ request: stale, access, workspace }),
      (error) => error instanceof FileVersionCenterContractError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    );
    assert.equal((await harness.postgres.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_version_restore_receipts',
    )).rows[0]?.count, '0', 'a pre-apply stale request releases its unused receipt');

    const raced = await harness.request('restore-raced-00001');
    harness.setConcurrentMutation('# Parallel user edit\n');
    await assert.rejects(
      () => harness.service.restore({ request: raced, access, workspace }),
      (error) => error instanceof FileVersionCenterContractError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    );
    assert.equal(harness.counts().applyCount, 0);
  } finally { await close(harness); }
}

async function concurrentRetryHasOneApply(): Promise<void> {
  const harness = await createHarness();
  try {
    const restoreRequest = await harness.request('restore-concurrent-01');
    const barrier = harness.installBarrier();
    const first = harness.service.restore({ request: restoreRequest, access, workspace });
    await barrier.waitUntilEntered();
    await assert.rejects(
      () => harness.service.restore({ request: restoreRequest, access, workspace }),
      (error) => error instanceof FileVersionCenterContractError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
    );
    barrier.release();
    assert.equal((await first).outcome, 'restored');
    assert.equal(harness.counts().applyCount, 1);
  } finally { await close(harness); }
}

async function crashRecoveryDoesNotReapply(): Promise<void> {
  const harness = await createHarness();
  try {
    const restoreRequest = await harness.request('restore-crash-000001');
    harness.setCrashAfterApply();
    await assert.rejects(
      () => harness.service.restore({ request: restoreRequest, access, workspace }),
      /simulated uncertain network completion/u,
    );
    assert.equal(harness.counts().applyCount, 1);
    harness.advance(31_000);
    const restarted = harness.makeService();
    const recovered = await restarted.restore({ request: restoreRequest, access, workspace });
    assert.equal(recovered.outcome, 'already_restored');
    assert.equal(harness.counts().applyCount, 1);
    assert.equal(harness.counts().restoreCaptureCount, 1);
    const third = await restarted.restore({ request: restoreRequest, access, workspace });
    assert.equal(third.outcome, 'already_restored');
    assert.equal(harness.counts().applyCount, 1);
  } finally { await close(harness); }
}

async function readOnlyAndIdempotencyConflicts(): Promise<void> {
  const harness = await createHarness();
  try {
    const restoreRequest = await harness.request('restore-access-00001');
    await assert.rejects(
      () => harness.service.restore({ request: restoreRequest,
        access: { ...access, canWrite: false }, workspace: { ...workspace,
          permissions: { ...workspace.permissions, canWrite: false } } }),
      (error) => error instanceof FileVersionCenterContractError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
    );
    const completed = await harness.service.restore({ request: restoreRequest, access, workspace });
    assert.equal(completed.outcome, 'restored');
    const different = harness.requestWithFence({ key: restoreRequest.idempotencyKey,
      fence: { ...(await harness.current()).fence, revisionId: null } });
    await assert.rejects(
      () => harness.service.restore({ request: different, access, workspace }),
      (error) => error instanceof FileVersionCenterContractError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.conflict,
    );
  } finally { await close(harness); }
}

async function runtimeAdaptersHonorFencesAndRestoreSource(): Promise<void> {
  const markdown = createRichMarkdownYDoc('# Current\n', 'tiptap_xml');
  try {
    const state = (): PersistedCollaborationState => ({
      documentId: 'document-a', workspaceId: 'workspace-a', organizationId: 'org',
      path: 'renamed/review.md', lifecycleGeneration: 2, representation: 'tiptap_xml',
      documentSequence: 4, checkpointSequence: 4, stateVector: Y.encodeStateVector(markdown),
      yjsState: Y.encodeStateAsUpdate(markdown), status: 'active', schemaVersion: 1,
      persistedAt: 1, checkpointedAt: 1, canonicalHash: null, serializedHash: null,
      newlineStyle: 'lf', hasBom: false, degraded: false,
    });
    const observed = (): AuthoritativeFileVersionContent => {
      const content = richMarkdownFromYDoc(markdown);
      return { content, observedAt: 1, fence: { revisionId: null, sha256: sha256(content),
        stateVectorHash: createHash('sha256').update(Y.encodeStateVector(markdown)).digest('hex') } };
    };
    const directInputs: AgentDirectConnectionInput[] = [];
    const yjsApply = createRuntimeFileVersionRestoreApply({
      loadState: async () => state(),
      directConnection: async <T>(input: AgentDirectConnectionInput, change: (doc: YTypes.Doc) => T) => {
        directInputs.push(input);
        return change(markdown);
      },
      current: async () => observed(),
    });
    const expected = { ...observed().fence, revisionId: 'revision-current' };
    const yjsResult = await yjsApply({ target: { ...targetForAdapters(), documentId: 'document-a' }, workspace,
      userId: 'owner', actorSessionId: 'session-a', idempotencyKey: 'adapter-yjs-00001',
      content: '# Selected\n', expectedCurrent: expected, priorRevisionId: 'revision-current' });
    const directInput = directInputs.at(-1);
    assert.equal(yjsResult.content, '# Selected\n');
    assert.equal(directInput?.versionSource, 'restore');
    assert.equal(directInput?.versionBaseRevisionId, 'revision-current');
    assert.match(directInput?.versionSourceSessionId ?? '', /^fvrc-restore-/u);

    const beforeStaleAttempt = richMarkdownFromYDoc(markdown);
    await assert.rejects(
      () => yjsApply({ target: { ...targetForAdapters(), documentId: 'document-a' }, workspace,
        userId: 'owner', idempotencyKey: 'adapter-yjs-stale', content: '# Must not apply\n',
        expectedCurrent: { ...observed().fence, revisionId: null, stateVectorHash: sha256('stale-vector') },
        priorRevisionId: 'revision-current' }),
      (error) => error instanceof FileVersionCenterContractError
        && error.code === FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
    );
    assert.equal(richMarkdownFromYDoc(markdown), beforeStaleAttempt);
  } finally { markdown.destroy(); }

  let fileContent = '# File current\n';
  const fileWrites: WriteWorkspaceFileContentInput[] = [];
  const fileCurrent = (): AuthoritativeFileVersionContent => ({ content: fileContent, observedAt: 1,
    fence: { revisionId: null, sha256: sha256(fileContent) } });
  const fileApply = createRuntimeFileVersionRestoreApply({
    writeFileContent: async (input) => { fileWrites.push(input); fileContent = String(input.content); },
    current: async () => fileCurrent(),
  });
  const fileExpected = fileCurrent().fence;
  const fileResult = await fileApply({ target: targetForAdapters(), workspace, userId: 'owner',
    idempotencyKey: 'adapter-file-0001', content: '# File restored\n', expectedCurrent: fileExpected,
    priorRevisionId: 'revision-current' });
  const fileWrite = fileWrites.at(-1);
  assert.equal(fileResult.content, '# File restored\n');
  assert.equal(fileWrite?.versionSource, 'restore');
  assert.equal(fileWrite?.expectedSha256, fileExpected.sha256);
  assert.equal(fileWrite?.ensureCollaborationDocument, false);
  assert.match(fileWrite?.actorSessionId ?? '', /^fvrc-restore-/u);
}

function targetForAdapters(): ResolvedFileVersionTarget {
  return { workspaceId: 'workspace-a', lineageId: 'lineage-a', documentId: null,
    path: 'renamed/review.md', latestRevisionId: 'revision-current',
    latestRevisionHash: null, latestRevisionSize: 0 };
}

async function main(): Promise<void> {
  await successfulRestoreAndRestartRetry();
  await staleAndParallelUserEditFences();
  await concurrentRetryHasOneApply();
  await crashRecoveryDoesNotReapply();
  await readOnlyAndIdempotencyConflicts();
  await runtimeAdaptersHonorFencesAndRestoreSource();
  console.log('file-version-restore-service-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
