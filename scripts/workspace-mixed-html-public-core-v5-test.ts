import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { captureWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5 }
  from '../app/lib/files/workspace-operation-mixed-source-evidence-v5';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { buildWorkspaceMixedHtmlLinkGraphV5, buildWorkspaceNativeLinkGraph, workspaceMixedHtmlBlockingCoverageV5 } from '../app/lib/markdown/workspace-native-link-graph';
import { createWorkspaceMixedHtmlFileOperationPlanV5, createWorkspaceNativeFileOperationPlan }
  from '../app/lib/markdown/workspace-native-file-operation-planner';
import { compileWorkspaceMixedHtmlBatchV5, compileWorkspaceNativeMixedBatch, type NativeMixedBatchRequest }
  from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import type { NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

const fixture = workspaceOperationMixedSourceEvidenceV5Fixture;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function operation(actual: ReturnType<typeof fixture>, sourcePath = 'target.md', destinationPath = 'renamed.md',
  kind: NativeMixedBatchRequest['kind'] = 'rename'): NativeMixedBatchRequest {
  return { kind, sourceWorkspaceId: actual.scope.workspaceId, destinationWorkspaceId: actual.scope.workspaceId,
    selections: [{ sourcePath, ...(kind === 'delete' ? {} : { destinationPath }) }] };
}
function plan(actual: ReturnType<typeof fixture>, request = operation(actual)) {
  return createWorkspaceMixedHtmlFileOperationPlanV5({ ...request, sourceEvidence: actual.evidence });
}
function compile(actual: ReturnType<typeof fixture>, request = operation(actual)) {
  return compileWorkspaceMixedHtmlBatchV5({ sourceEvidence: actual.evidence, states: actual.observation.privateNativeStates, requests: [request] });
}
/** Replaces one declared fixture payload with actual rich Yjs bytes and rebuilds
 * every old inventory/binding hash before E5 capture. No catalogue or DB state
 * is claimed; the fixture remains pure declared observations. */
function richFixture() {
  const actual = fixture({ native: [['note.md', '# Placeholder'], ['target.md', '# Target']], raw: [['page.html', '<p>Plain page</p>']] });
  const state = actual.observation.privateNativeStates[0];
  const doc = createRichMarkdownYDoc('[**Target**](target.md)\n\nIndependent', 'tiptap_blocks');
  try {
    state.representation = 'tiptap_blocks'; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc);
  } finally { doc.destroy(); }
  const inventory = inspectPersistedDocumentLinks(state), binding = actual.observation.nativeBindings[0];
  binding.expected.representation = state.representation; binding.expected.binaryHash = sha(state.yjsState);
  binding.expected.vectorHash = sha(state.stateVector); binding.expected.stateProof = inventory.version.stateProof;
  binding.inventoryProof = proof(inventory);
  actual.observation.stage.sources = actual.observation.stage.sources.map(source => source.kind === 'native'
    && source.inventory.document.documentId === state.documentId ? { kind: 'native' as const, inventory } : source);
  const gaps = actual.observation.stage.sources.flatMap(source => source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })));
  actual.observation.stage.coverage = { complete: !gaps.length, gaps };
  actual.observation.stage.stageProof = workspaceSourceAuthorityStageProof(actual.observation.stage);
  actual.evidence = captureWorkspaceOperationMixedSourceEvidenceV5(actual.scope, actual.observation);
  return actual;
}

/** Actual parser4/Yjs rehearsal and original-byte evidence. It does not grant
 * SQL/FD/principal/current-owner authority and performs no external I/O. */
export function workspaceMixedHtmlPublicCoreV5Test(): void {
  let families = 0;
  const family = (name: string, body: () => void) => { body(); families++; process.stdout.write(`ok public-html-core5 ${families}: ${name}\n`); };
  family('unrelated native HTML and native ordinary backlink share one graph without clearing gaps', () => {
    const actual = fixture({ native: [['note.md', '😀 [Target](target.md)\n\n<img src="stable.png">'], ['target.md', '# Target']], raw: [],
      extra: [{ path: 'stable.png', kind: 'file' }] });
    const snapshot = workspaceOperationMixedSourceSnapshotV5(actual.evidence), graph = buildWorkspaceMixedHtmlLinkGraphV5(snapshot);
    assert.equal(snapshot.coverage.complete, false); assert.deepEqual(graph.coverage, snapshot.coverage);
    assert.equal(graph.edges.length, 1); assert.equal(graph.edges[0].resolution.target?.path, 'target.md');
    const before = structuredClone(actual.observation.privateNativeStates), result = plan(actual), compiled = compile(actual);
    assert.equal(result.readiness, 'ready', JSON.stringify(result.issues)); assert.equal(compiled.readiness, 'ready', JSON.stringify(compiled.issues));
    assert.equal(result.contractVersion, 5); assert.equal(compiled.contractVersion, 5); assert.equal(compiled.executionReady, false);
    assert.equal(result.mutations[0].nextValue, 'renamed.md'); assert.equal(compiled.steps[0].linkIntents[0].nextValue, 'renamed.md');
    assert.equal(result.htmlAssessment.warnings[0].reason, 'unaffected-explicit-html-link');
    assert.deepEqual(result.sourceCoverage[0].coverage, snapshot.coverage); assert.deepEqual(compiled.sourceCoverage, result.sourceCoverage);
    assert(compiled.documentEvidence.every(row => row.inventory.parserVersion === 4));
    assert.deepEqual(actual.observation.privateNativeStates, before); assert.equal(compiled.planId, compile(actual).planId);
  });
  family('literal Wiki display text keeps its genuine outer target and complete parser4 boundary', () => {
    const actual = fixture({ native: [['note.md', '[[target|<img src="stable.png">]]'], ['target.md', '# Target']], raw: [],
      extra: [{ path: 'stable.png', kind: 'file' }] });
    const result = plan(actual), compiled = compile(actual);
    assert.equal(result.readiness, 'ready', JSON.stringify(result.issues)); assert.equal(compiled.readiness, 'ready', JSON.stringify(compiled.issues));
    assert.equal(result.mutations.length, 1); assert.equal(result.mutations[0].nextValue, '/renamed');
    assert.equal(compiled.documentEvidence[0].inventory.parserVersion, 4);
    const snapshot = workspaceOperationMixedSourceSnapshotV5(actual.evidence);
    const note = snapshot.documents.find(inventory => inventory.document.path === 'note.md')!;
    assert.equal(note.parserVersion, 4); assert.equal(note.coverage.complete, true); assert.equal(note.coverage.gaps.length, 0);
    assert.equal(note.links.length, 1); assert.equal(note.links[0].kind, 'wiki');
    assert.equal(note.links[0].alias, '<img src="stable.png">');
    assert.equal(snapshot.htmlOccurrences.length, 0); assert.equal(result.htmlAssessment.warnings.length, 0);
    assert.equal(snapshot.coverage.complete, false); assert(snapshot.coverage.gaps.some(gap => gap.code === 'uninspected-html' && gap.path === 'note.md'));
    assert.deepEqual(result.sourceCoverage[0].coverage, snapshot.coverage);
    assert.deepEqual(workspaceMixedHtmlBlockingCoverageV5(snapshot), []);
    const unknownGap = { code: 'uninspected-html', path: 'unread.md' };
    assert.deepEqual(workspaceMixedHtmlBlockingCoverageV5({ ...snapshot, coverage: { complete: false,
      gaps: [...snapshot.coverage.gaps, unknownGap] } }), [unknownGap]);
  });
  family('affected native HTML blocks before rehearsal and retains actual source line', () => {
    const actual = fixture({ native: [['note.md', '# One\n\n<img src="target.md">'], ['target.md', '# Target']], raw: [] });
    const result = plan(actual), compiled = compile(actual);
    assert.equal(result.readiness, 'blocked'); assert.equal(result.htmlAssessment.blockers[0].reason, 'affected-html-link');
    assert.equal(result.htmlAssessment.blockers[0].line, 3); assert.equal(compiled.readiness, 'blocked');
    assert.equal(compiled.steps.length, 0); assert.equal(compiled.finalGraphProof, null);
  });
  family('whole physical HTML without local URLs is assessed separately and ordinary rich edits rehearse', () => {
    const actual = richFixture(), result = plan(actual), compiled = compile(actual);
    assert.equal(result.readiness, 'ready', JSON.stringify(result.issues)); assert.equal(compiled.readiness, 'ready', JSON.stringify(compiled.issues));
    const document = compiled.documentEvidence.find(row => row.inventory.document.path === 'note.md')!;
    assert.equal(document.inventory.document.representation, 'tiptap_blocks'); assert.equal(document.inventory.links[0].ref.kind, 'link-mark');
    assert.equal(compiled.steps[0].linkIntents[0].nextValue, 'renamed.md');
    const snapshot = workspaceOperationMixedSourceSnapshotV5(actual.evidence);
    assert.equal(snapshot.physicalHtmlSources.length, 1); assert.equal('metadata' in snapshot.physicalHtmlSources[0], false);
    assert.equal(snapshot.coverage.complete, false);
  });
  family('unrelated whole physical HTML local URL remains a warning', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['page.html', '<a href="stable.png">image</a>']],
      extra: [{ path: 'stable.png', kind: 'file' }] });
    assert.equal(plan(actual).readiness, 'ready'); assert.equal(compile(actual).readiness, 'ready');
    assert.equal(plan(actual).htmlAssessment.warnings[0].sourcePath, 'page.html');
  });
  family('affected whole physical HTML reports its target and blocks', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['page.html', '<img src="target.md">']] });
    const result = plan(actual); assert.equal(result.readiness, 'blocked'); assert.equal(result.htmlAssessment.blockers[0].line, 1);
    assert.equal(result.htmlAssessment.blockers[0].targetLiteral, 'target.md'); assert.equal(compile(actual).steps.length, 0);
  });
  family('opaque HTML never receives an operation independence certificate', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['page.html', '<unknown value="stable.png">content</unknown>']] });
    assert.equal(plan(actual).readiness, 'blocked'); assert.equal(plan(actual).htmlAssessment.complete, false);
    assert.equal(compile(actual).readiness, 'blocked');
  });
  family('missing HTML target newly occupied by a rename is blocked', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['page.html', '<a href="renamed.md">future</a>']] });
    assert.equal(plan(actual).readiness, 'blocked'); assert.equal(compile(actual).readiness, 'blocked');
  });
  family('nonHTML historical gaps stay visible and block the new arm', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['raw.md', '---\ntitle: [\n---\n# Broken']] });
    assert(actual.evidence.coverage.gaps.some(gap => gap.code === 'invalid-frontmatter'));
    const result = plan(actual); assert.equal(result.readiness, 'blocked'); assert(result.issues.some(issue => issue.code === 'invalid-frontmatter'));
    assert.equal(compile(actual).readiness, 'blocked'); assert(result.sourceCoverage[0].coverage.gaps.some(gap => gap.code === 'invalid-frontmatter'));
  });
  family('selected physical Markdown still needs a genuine import', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['raw.md', '# Raw'], ['page.html', '<p>Page</p>']] });
    const request = operation(actual, 'raw.md', 'moved.md');
    assert(plan(actual, request).issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'raw.md'));
    assert.equal(compile(actual, request).readiness, 'blocked');
  });
  family('incoming physical ordinary rewrites still need import and native rebinding', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['raw.md', '[Target](target.md)'], ['page.html', '<p>Page</p>']] });
    const result = plan(actual); assert.equal(result.readiness, 'blocked');
    assert(result.issues.some(issue => issue.code === 'physical-source-import-required' && issue.path === 'raw.md'));
    assert.equal(compile(actual).readiness, 'blocked');
  });
  family('compiler compares every inventory4 against actual supplied Yjs state', () => {
    const actual = fixture({ native: [['note.md', '[Target](target.md)'], ['target.md', '# Target']], raw: [['page.html', '<p>Page</p>']] });
    const states = structuredClone(actual.observation.privateNativeStates); states[0].documentSequence++;
    const result = compileWorkspaceMixedHtmlBatchV5({ sourceEvidence: actual.evidence, states, requests: [operation(actual)] });
    assert.equal(result.readiness, 'blocked'); assert(result.issues.some(issue => issue.code === 'native-state-mismatch'));
    assert.equal(result.steps.length, 0);
  });
  family('untouched ordinary aliases participate in the complete after graph', () => {
    const actual = fixture({ native: [['note.md', '[[Target]]'], ['one/Target.md', '# Target'], ['other.md', '# Other']],
      raw: [['page.html', '<p>Page</p>']], extra: [{ path: 'one', kind: 'directory' }, { path: 'two', kind: 'directory' }] });
    const request = operation(actual, 'other.md', 'two/Target.md');
    assert(plan(actual, request).issues.some(issue => issue.code === 'resolution-changed'));
    assert.equal(compile(actual, request).readiness, 'blocked');
  });
  family('whole physical HTML is movable when its outgoing references need no rewrite', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['page.html', '<p>Page</p>']] });
    const request = operation(actual, 'page.html', 'renamed.html');
    assert.equal(plan(actual, request).readiness, 'ready'); assert.equal(compile(actual, request).readiness, 'ready');
    assert.equal(compile(actual, request).steps[0].namespaceEffects[0].destinationPath, 'renamed.html');
  });
  family('delete and copy each retain the exact HTML operation semantics', () => {
    const actual = fixture({ native: [['target.md', '# Target']], raw: [['page.html', '<img src="target.md">']] });
    const deletion = plan(actual, operation(actual, 'target.md', '', 'delete'));
    assert.equal(deletion.readiness, 'blocked'); assert.equal(deletion.htmlAssessment.blockers[0].reason, 'affected-html-link');
    const copiedPage = plan(actual, operation(actual, 'page.html', 'copy.html', 'copy'));
    assert.equal(copiedPage.readiness, 'blocked'); assert.equal(copiedPage.htmlAssessment.complete, false);
    assert.throws(() => compileWorkspaceMixedHtmlBatchV5({ sourceEvidence: actual.evidence,
      states: actual.observation.privateNativeStates, requests: [operation(actual), operation(actual)] }), /SINGLE_REQUEST_REQUIRED/u);
  });
  family('old native2 graph and planners keep the original incomplete-coverage gate', () => {
    const actual = fixture({ native: [['note.md', '<img src="stable.png">'], ['target.md', '# Target']], raw: [],
      extra: [{ path: 'stable.png', kind: 'file' }] });
    const documents = actual.observation.stage.sources.flatMap(source => source.kind === 'native' ? [source.inventory] : []);
    const body = { contractVersion: 2 as const, workspaceId: actual.scope.workspaceId, namespace: actual.evidence.namespace,
      documents, coverage: { complete: false, gaps: documents.flatMap(document => document.coverage.gaps) } };
    const snapshot: NativeWorkspaceLinkSnapshot = { ...body, snapshotProof: proof(body) };
    assert.deepEqual(buildWorkspaceNativeLinkGraph(snapshot).coverage, snapshot.coverage);
    const request = operation(actual);
    assert.equal(createWorkspaceNativeFileOperationPlan({ ...request, snapshots: [snapshot] }).readiness, 'blocked');
    assert.equal(compileWorkspaceNativeMixedBatch({ snapshots: [snapshot], states: actual.observation.privateNativeStates, requests: [request] }).readiness, 'blocked');
    assert(documents.every(inventory => inventory.parserVersion === 2));
  });
  process.stdout.write(`public HTML-aware graph/planner/compiler5: ${families} families passed\n`);
}
