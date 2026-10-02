import assert from 'node:assert/strict';
import { isWorkspaceFileOperationLinkSafe } from '../app/lib/markdown/workspace-file-operation-link-safety';
import type { WorkspaceFileOperationPlanV1 } from '../app/lib/markdown/workspace-link-contract-v1';

type LinkPlan = Pick<WorkspaceFileOperationPlanV1, 'coverage' | 'linkAssessment'>;
const coverage = { complete: false, omittedSources: [], unresolvedLinks: [
  { sourcePath: 'archive/old.md', targetLiteral: 'missing.md', status: 'missing' as const },
] };
const safe: LinkPlan = { coverage, linkAssessment: { version: 1, complete: true, blockers: [], warnings: [
  { ...coverage.unresolvedLinks[0], reason: 'unaffected-existing-link' },
] } };

assert.equal(isWorkspaceFileOperationLinkSafe(safe), true);
assert.equal(isWorkspaceFileOperationLinkSafe({ coverage }), false, 'legacy incomplete plans remain blocked');
assert.equal(isWorkspaceFileOperationLinkSafe({ coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } }), true);
assert.equal(isWorkspaceFileOperationLinkSafe({ ...safe, linkAssessment: { ...safe.linkAssessment!, warnings: [] } }), false,
  'unclassified diagnostics must never pass');
assert.equal(isWorkspaceFileOperationLinkSafe({ ...safe, coverage: { ...coverage,
  omittedSources: [{ path: 'unknown.md', reason: 'source-unreadable' }] } }), false);
assert.equal(isWorkspaceFileOperationLinkSafe({ ...safe, linkAssessment: { ...safe.linkAssessment!, complete: false } }), false);
assert.equal(isWorkspaceFileOperationLinkSafe({ ...safe, linkAssessment: { ...safe.linkAssessment!, blockers: [
  { sourcePath: 'moving/page.md', targetLiteral: 'missing.md', status: 'missing', reason: 'affected-unresolved-link' },
] } }), false);
for (const malformed of [null, {}, { coverage: {} }, { ...safe, linkAssessment: null },
  { ...safe, linkAssessment: { ...safe.linkAssessment, version: 2 } },
  { ...safe, linkAssessment: { ...safe.linkAssessment, warnings: [null] } },
  { ...safe, linkAssessment: { ...safe.linkAssessment, blockers: null } },
  { ...safe, coverage: { ...coverage, unresolvedLinks: null } },
  { ...safe, linkAssessment: { ...safe.linkAssessment, warnings: [{ ...safe.linkAssessment!.warnings[0], status: 'not-evaluated' }] } },
]) assert.equal(isWorkspaceFileOperationLinkSafe(malformed as LinkPlan), false, 'malformed assessment must fail closed');
console.log('workspace file operation link safety tests passed');
const restored: LinkPlan = { coverage, linkAssessment: { version: 1, complete: true, warnings: [], blockers: [], restoredLinks: [
  { sourcePath: 'archive/old.md', sourcePathAfter: 'archive/old.md', targetLiteral: 'missing.md', targetPath: 'missing.md' },
] } };
assert.equal(isWorkspaceFileOperationLinkSafe(restored), true, 'Recorded exact repairs classify the original missing diagnostic');
assert.equal(isWorkspaceFileOperationLinkSafe({ ...restored, coverage: { ...coverage, unresolvedLinks: [{ ...coverage.unresolvedLinks[0], status: 'ambiguous' }] } }), false,
  'A repair cannot excuse ambiguity');
for (const malformed of [null, {}, [null], [{ ...restored.linkAssessment!.restoredLinks![0], targetPath: '../outside.md' }],
  [{ ...restored.linkAssessment!.restoredLinks![0], sourcePathAfter: '' }]]) {
  assert.equal(isWorkspaceFileOperationLinkSafe({ ...restored, linkAssessment: { ...restored.linkAssessment!, restoredLinks: malformed } } as LinkPlan), false);
}
