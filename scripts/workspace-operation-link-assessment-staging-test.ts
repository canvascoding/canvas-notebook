import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceOperationStaging, WorkspaceOperationStagingError } from '../app/lib/files/workspace-operation-staging';
import { computeWorkspaceFileOperationPlanId, createWorkspaceFileOperationPlan,
  type WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';
import { assertFreshWorkspaceFileOperationPlan, WorkspacePreviewBlockedError } from '../app/lib/markdown/workspace-file-operation-preview';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-assessment-stage-'));
  try {
    const content = '[Image](old.png)\n';
    const preview = createWorkspaceFileOperationPlan({
      kind: 'rename', sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace',
      selections: [{ sourcePath: 'old.png', destinationPath: 'new.png' }],
      snapshots: [{ workspaceId: 'workspace', entries: [
        { identity: 'target', path: 'old.png', kind: 'file' },
        { identity: 'note', path: 'index.md', kind: 'file', markdownContent: content },
        { identity: 'archive', path: 'archive.md', kind: 'file', markdownContent: '[Old](missing.md)\n' },
      ] }],
    });
    assert.equal(preview.readiness, 'ready');
    assert.equal(preview.coverage.complete, false, 'global diagnostics remain honest');
    assert.equal(preview.linkAssessment?.warnings.length, 1);
    assert.doesNotThrow(() => assertFreshWorkspaceFileOperationPlan(preview, preview.planId));
    const stageInput = (plan: WorkspaceFileOperationPreview, operationId: string) => ({
      operationId, preview: plan, sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace',
      originalDocuments: [{ workspaceId: 'workspace', path: 'index.md', content }],
      linkPreflight: { planId: plan.planId, sources: [{ sourceWorkspaceId: 'workspace',
        sourcePathBefore: 'index.md', beforeSha256: hash(content), documentId: null,
        mode: 'plain-file' as const }] },
    });
    const identity = { operationId: 'warning_stage_operation', planId: preview.planId,
      sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace' };
    const staging = new WorkspaceOperationStaging({ dataRoot: root });
    await staging.stage(stageInput(preview, identity.operationId));
    const restarted = new WorkspaceOperationStaging({ dataRoot: root });
    assert.deepEqual((await restarted.load(identity)).preview, preview,
      'restart retains the exact warning classification and body covered by the plan ID');

    const rejects = async (plan: WorkspaceFileOperationPreview, operationId: string) => {
      plan.planId = computeWorkspaceFileOperationPlanId(plan);
      assert.throws(() => assertFreshWorkspaceFileOperationPlan(plan, plan.planId), WorkspacePreviewBlockedError);
      await assert.rejects(staging.stage(stageInput(plan, operationId)), (error: unknown) =>
        error instanceof WorkspaceOperationStagingError && error.code === 'STAGE_CONFLICT');
    };
    const legacy = structuredClone(preview);
    delete legacy.linkAssessment;
    await rejects(legacy, 'legacy_stage_operation');
    const unknown = structuredClone(preview);
    unknown.linkAssessment!.version = 2 as never;
    await rejects(unknown, 'unknown_stage_operation');
    const unclassified = structuredClone(preview);
    unclassified.linkAssessment!.warnings = [];
    await rejects(unclassified, 'unclassified_stage_operation');
    const omitted = structuredClone(preview);
    omitted.coverage.omittedSources.push({ path: 'large.md', reason: 'source-too-large' });
    await rejects(omitted, 'omitted_stage_operation');
    const affected = structuredClone(preview);
    affected.linkAssessment!.blockers.push({ sourcePath: 'index.md', targetLiteral: 'missing.md',
      status: 'missing', reason: 'affected-unresolved-link' });
    await rejects(affected, 'affected_stage_operation');

    const changedClassification = structuredClone(preview);
    changedClassification.linkAssessment!.warnings[0]!.targetLiteral = 'different.md';
    await assert.rejects(staging.stage(stageInput(changedClassification, identity.operationId)),
      WorkspaceOperationStagingError, 'the reviewed plan ID cannot be reused for changed diagnostics');
    console.log('workspace operation assessment staging: warning-only restart, legacy, malformed, omitted, affected, plan ID OK');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
