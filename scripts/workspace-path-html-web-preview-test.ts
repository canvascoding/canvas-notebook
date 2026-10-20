import assert from 'node:assert/strict';
import { createWorkspacePathHtmlNoImportPreparationPlanV2 } from '../app/lib/files/workspace-path-html-no-import-preparation';
import { workspacePathImportPreparationPreview } from '../app/lib/files/workspace-path-operation-preview';
import { readWorkspacePathOperationBlockedPreview } from '../app/lib/files/workspace-path-operation-preview-error';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

/** Actual early-plan/public-projector/client-parser chain. This is not an HTTP,
 * browser or current-principal test; its filesystem catalogue is declared. */
export function workspacePathHtmlWebPreviewTest(): void {
  const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['Move.md', '# Move'], ['HTML.md', '# Source\n\n<img src="Move.md">']] });
  const plan = createWorkspacePathHtmlNoImportPreparationPlanV2({ scope: actual.scope, kind: 'rename',
    selections: [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }], observation: actual.observation });
  const projected = workspacePathImportPreparationPreview(plan);
  assert.equal(projected.version, 2); assert.equal(projected.readiness, 'blocked');
  assert.equal(projected.coverage.complete, false); assert.equal(projected.linkAssessment?.blockers[0].line, 3);
  const binding = { workspaceId: actual.scope.workspaceId, sourcePath: 'Move.md', destinationPath: 'Moved.md',
    authScope: { userId: 'declared-reader', sessionId: 'declared-session', epoch: 1 } };
  const response = { dryRun: true, requiresRevalidation: true, plan: projected };
  const parsed = readWorkspacePathOperationBlockedPreview(JSON.parse(JSON.stringify(response)), binding);
  assert.equal(parsed.plan.kind, 'native-path-import-preparation');
  assert.deepEqual(parsed.plan.linkAssessment?.blockers[0], { sourcePath: 'HTML.md', targetLiteral: 'Move.md',
    status: 'not-evaluated', reason: 'affected-html-link', line: 3 });
  assert.equal(parsed.plan.coverage.complete, false);
  assert(!JSON.stringify(projected).includes('sourceEvidence'));
  assert(!JSON.stringify(projected).includes('inventoryProof'));

  for (const patch of [
    { version: 1 }, { version: 3 }, { linkAssessment: undefined }, { workspaceId: 'foreign' },
    { pathMappings: [{ sourcePath: 'Move.md', destinationPath: 'Other.md' }] },
    { physicalLinkChanges: [{ sourcePathBefore: 'HTML.md', sourcePathAfter: 'HTML.md',
      previousTargetLiteral: 'Move.md', targetPathAfter: 'Moved.md', action: 'rewrite' }] },
  ]) assert.throws(() => readWorkspacePathOperationBlockedPreview({ ...response, plan: { ...projected, ...patch } }, binding));

  const raw = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [['Raw.md', '# Raw']],
    native: [['HTML.md', '<img src="stable.png">']], extra: [{ path: 'stable.png', kind: 'file' }] });
  const required = createWorkspacePathHtmlNoImportPreparationPlanV2({ scope: raw.scope, kind: 'move',
    selections: [{ sourcePath: 'Raw.md', destinationPath: 'Moved.md' }], observation: raw.observation });
  const rawProjection = workspacePathImportPreparationPreview(required);
  assert.deepEqual(rawProjection.imports, [{ path: 'Raw.md', reasons: ['selected'] }]);
  const rawParsed = readWorkspacePathOperationBlockedPreview({ ...response, plan: rawProjection },
    { ...binding, sourcePath: 'Raw.md' });
  assert.equal(rawParsed.plan.kind, 'native-path-import-preparation');
  if (rawParsed.plan.kind === 'native-path-import-preparation') assert.deepEqual(rawParsed.plan.imports, rawProjection.imports);
  assert(rawParsed.plan.issues.some(issue => issue.code === 'physical-source-import-required'));

  console.log(JSON.stringify({ suite: 'workspace-html-web-preview', groups: 3, actualProjectionAndClientParser: true,
    executionAuthority: false }));
}
