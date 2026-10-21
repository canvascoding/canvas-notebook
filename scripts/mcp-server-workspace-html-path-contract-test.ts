import assert from 'node:assert/strict';
import Ajv from 'ajv';

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;

/** Pure public-codec/schema/projection matrix with actual source/plan captures.
 * No autorun, OAuth, SQL, HTTP transport, FD authority, executable MCP claim or
 * production acceptance is represented by these declared fixture facts. */
export async function mcpServerWorkspaceHtmlPathContractTest(): Promise<void> {
  const previousBase = process.env.BASE_URL, previousAuth = process.env.BETTER_AUTH_BASE_URL;
  process.env.BASE_URL = 'https://html-path-wire.example.test'; process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
  try {
    const { encodeDirectMcpWorkspacePathResultV1: encode, formatDirectMcpWorkspacePathResult: format, WorkspacePathToolError,
      DIRECT_MCP_WORKSPACE_MOVE_OUTPUT_SCHEMA_V1: moveSchema, DIRECT_MCP_WORKSPACE_DELETE_OUTPUT_SCHEMA_V1: deleteSchema,
      DIRECT_MCP_WORKSPACE_MOVE_HTML_PREVIEW_SCHEMA_V2: htmlSchema } = await import('../app/lib/mcp/server/workspace-path-tool-contract');
    const { workspaceOperationMcpHtmlPreviewV2: project } = await import('../app/lib/files/workspace-operation-mcp-path-service');
    const { workspaceOperationMixedSourceEvidenceV5Fixture: fixture } = await import('./workspace-operation-mixed-source-evidence-v5-test');
    const { createWorkspacePathHtmlNoImportPreparationPlanV2: preparation } = await import('../app/lib/files/workspace-path-html-no-import-preparation');
    const { createWorkspaceOperationNativeMoveBatchPlanV4: move } = await import('../app/lib/files/workspace-operation-native-move-plan');
    const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
    const validMove = ajv.compile(moveSchema), validDelete = ajv.compile(deleteSchema), validHtml = ajv.compile(htmlSchema);
    const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
    const envelope = (preview: unknown) => ({ apiVersion: 1, action: 'preview', preview });
    const invalid = (input: unknown): void => assert.throws(() => encode(input),
      error => error instanceof WorkspacePathToolError && error.code === 'PATH_UNAVAILABLE' && error.status === 503);
    const deepFrozen = (value: unknown): void => {
      if (!value || typeof value !== 'object') return; assert(Object.isFrozen(value));
      for (const child of Object.values(value)) deepFrozen(child);
    };
    let groups = 0;
    const source = fixture({ raw: [], native: [['Move.md', '# Move\n'], ['Incoming.md', '[Move](Move.md)\n'],
      ['HTML.md', '# Heading\n\n<img src="assets/stable.png">\n']],
      extra: [{ path: 'Dest', kind: 'directory' }, { path: 'assets/stable.png', kind: 'file' }] });
    const workspace = { ...source.scope, status: 'active' as const, permissions: { canRead: true, canWrite: true,
      canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
    const selections = [{ sourcePath: 'Move.md', destinationPath: 'Dest/Moved.md' }];
    const plan = move({ scope: { workspace, fileOptions: {} }, actions: [{ kind: 'move', reviewId: 'html-mcp-preview', selections }],
      observation: source.observation });

    // The actual private identity4 plan has original false coverage and a
    // complete operation-specific HTML assessment. The projection preserves it.
    const ready = project(plan);
    assert.equal(ready.version, 2); assert.equal(ready.kind, 'native-path-html-assessment');
    assert.equal(ready.operationKind, 'move'); assert.equal(ready.executionReady, false); assert.equal(ready.readiness, 'ready');
    assert.equal(ready.coverage.complete, false); assert.equal(ready.linkAssessment.complete, true);
    assert.deepEqual(ready.paths, selections); assert.deepEqual(ready.imports, []); assert.deepEqual(ready.issues, []);
    assert.equal(ready.planId, plan.planId); assert.equal(ready.linkChanges.rewrites, plan.nativePathPlan.mutations.length);
    assert.equal(ready.linkChanges.unlinks, 0); assert(ready.linkChanges.affectedDocuments > 0);
    assert.deepEqual(ready.linkAssessment.warnings, [{ code: 'unaffected-explicit-html-link', path: 'HTML.md', targets: ['assets/stable.png'] }]);
    assert.equal(validMove(envelope(ready)), true, JSON.stringify(validMove.errors));
    assert.equal(validHtml(ready), true, JSON.stringify(validHtml.errors)); assert.equal(validDelete(envelope(ready)), false);
    groups++;

    // Public encoding/formatting detaches and freezes the bounded summary.
    // Raw HTML, native IDs, proofs, actors and binary content stay private.
    const wire = envelope(ready), encoded = encode(wire);
    assert.deepEqual(encoded, wire); deepFrozen(encoded);
    const formatted = format(wire); assert.deepEqual(formatted.structuredContent, wire);
    assert.equal(formatted.content[0].type, 'text');
    if (formatted.content[0].type === 'text') assert.deepEqual(JSON.parse(formatted.content[0].text), wire);
    const publicText = JSON.stringify(encoded);
    for (const secret of ['sourceEvidence', 'nativeBindings', 'nativeOrdinarySources4', 'physicalSourceProof', 'htmlAssessmentProof',
      'nativeLinkId', 'stateVector', 'originalBytes', 'yjsState', 'actorSessionId', '<img']) assert(!publicText.includes(secret));
    groups++;

    // Early HTML blocks expose the actual line and decoded target path. They
    // make no speculative rewrite count or claim execution readiness.
    const blockedPlan = preparation({ scope: source.scope, kind: 'move',
      selections: [{ sourcePath: 'assets/stable.png', destinationPath: 'Dest/stable.png' }], observation: source.observation });
    const blocked = project(blockedPlan);
    assert.equal(blocked.readiness, 'blocked'); assert.equal(blocked.coverage.complete, false);
    assert.deepEqual(blocked.linkChanges, { rewrites: 0, unlinks: 0, affectedDocuments: 0 });
    assert.deepEqual(blocked.linkAssessment.blockers, [{ code: 'affected-html-link', path: 'HTML.md', line: 3, targets: ['assets/stable.png'] }]);
    assert.equal(validMove(envelope(blocked)), true, JSON.stringify(validMove.errors));
    assert.deepEqual(encode(envelope(blocked)), envelope(blocked));
    groups++;

    // Required raw Markdown births remain explicit blocked imports, even when
    // their HTML assessment is complete and they contain no ordinary links.
    const raw = fixture({ raw: [['Raw.md', '# Raw\n']], native: [['HTML.md', '<img src="stable.png">\n']],
      extra: [{ path: 'Dest', kind: 'directory' }, { path: 'stable.png', kind: 'file' }] });
    const rawPlan = preparation({ scope: raw.scope, kind: 'move',
      selections: [{ sourcePath: 'Raw.md', destinationPath: 'Dest/Raw.md' }], observation: raw.observation });
    const rawSummary = project(rawPlan);
    assert.equal(rawSummary.readiness, 'blocked'); assert.equal(rawSummary.linkAssessment.complete, true);
    assert.deepEqual(rawSummary.imports, [{ path: 'Raw.md', reasons: ['selected'] }]);
    assert(rawSummary.issues.some(item => item.code === 'physical-source-import-required' && item.path === 'Raw.md'));
    assert.equal(validMove(envelope(rawSummary)), true, JSON.stringify(validMove.errors));
    invalid(envelope({ ...rawSummary, readiness: 'ready' }));
    groups++;

    // Unknown HTML never gains an empty-target certificate. An opaque source
    // has its own blocker, without exposing its original markup.
    const opaqueText = '<custom-element></custom-element>\n';
    const opaque = fixture({ raw: [], native: [['Move.md', '# Move\n'], ['Opaque.md', opaqueText]] });
    const opaquePlan = preparation({ scope: opaque.scope, kind: 'move',
      selections: [{ sourcePath: 'Move.md', destinationPath: 'Moved.md' }], observation: opaque.observation });
    const opaqueSources = opaquePlan.sourceEvidence.nativeComponent.htmlSources.filter(item => item.path === 'Opaque.md');
    assert.equal(opaqueSources.length, 1);
    assert.equal(opaqueSources[0].documentId, opaque.observation.privateNativeStates.find(item => item.path === 'Opaque.md')!.documentId);
    // The actual inline Markdown AST has separate opening/closing HTML nodes.
    // Keep both source occurrences even though their public summaries match.
    assert.deepEqual(opaqueSources[0].inspection.occurrences, [
      { sourcePath: 'Opaque.md', start: 0, end: '<custom-element>'.length, raw: '<custom-element>',
        fullyInspected: false, explicitLocalTargets: [] },
      { sourcePath: 'Opaque.md', start: '<custom-element>'.length, end: opaqueText.length - 1, raw: '</custom-element>',
        fullyInspected: false, explicitLocalTargets: [] },
    ]);
    const opaqueSummary = project(opaquePlan);
    assert.equal(opaqueSummary.readiness, 'blocked'); assert.equal(opaqueSummary.linkAssessment.complete, false);
    assert.deepEqual(opaqueSummary.linkAssessment.blockers, [
      { code: 'unevaluated-link', path: 'Opaque.md', line: 1, targets: [] },
      { code: 'unevaluated-link', path: 'Opaque.md', line: 1, targets: [] },
    ]);
    assert.equal(validMove(envelope(opaqueSummary)), true, JSON.stringify(validMove.errors));
    assert(!JSON.stringify(opaqueSummary).includes('<custom-element>'));
    groups++;

    // Contradictory readiness, versions, operation kind and coverage cannot
    // cross the wire. Public display data still grants no mutation authority.
    for (const changed of [
      { ...ready, version: 1 }, { ...ready, kind: 'move' }, { ...ready, operationKind: 'delete' }, { ...ready, executionReady: true },
      { ...ready, coverage: { complete: 'false' } }, { ...ready, coverage: { complete: false, gaps: [] } },
      { ...ready, readiness: 'blocked' }, { ...ready, linkChanges: { ...ready.linkChanges, unlinks: 1 } },
      { ...ready, issues: [{ code: 'affected-html-link', path: 'HTML.md' }] },
      { ...ready, linkAssessment: { ...ready.linkAssessment, complete: false } },
      { ...blocked, readiness: 'ready' }, { ...blocked, linkAssessment: { ...blocked.linkAssessment, complete: true } },
      { ...blocked, linkChanges: { ...blocked.linkChanges, rewrites: 1 } },
      ...['rawHtml', 'targetLiteral', 'sourceEvidence', 'nativeIds', 'proof', 'origin'].map(key => ({ ...ready, [key]: 'private' })),
    ]) { invalid(envelope(changed)); assert.equal(validMove(envelope(changed)), false); }
    groups++;

    // Canonical paths, exact diagnostic objects, real positive integer lines,
    // bounded target strings and unique targets are validated independently.
    for (const diagnostic of [
      { ...blocked.linkAssessment.blockers[0], line: 0 }, { ...blocked.linkAssessment.blockers[0], line: 1.5 },
      { ...blocked.linkAssessment.blockers[0], path: '../private.md' },
      { ...blocked.linkAssessment.blockers[0], targets: [] },
      { ...blocked.linkAssessment.blockers[0], targets: ['same.png', 'same.png'] },
      { ...blocked.linkAssessment.blockers[0], targets: ['bad\npath'] },
      { ...blocked.linkAssessment.blockers[0], targets: ['\ud800'] },
      { ...blocked.linkAssessment.blockers[0], targets: ['x'.repeat(4097)] },
      { ...blocked.linkAssessment.blockers[0], code: 'private-error' },
      { ...blocked.linkAssessment.blockers[0], raw: '<img src="private">' },
    ]) invalid(envelope({ ...blocked, linkAssessment: { ...blocked.linkAssessment, blockers: [diagnostic] } }));
    for (const paths of [[], [...ready.paths, ...ready.paths], [{ sourcePath: 'Move.md', destinationPath: 'Move.md' }],
      [{ sourcePath: 'Move.md', destinationPath: '../Moved.md' }]]) invalid(envelope({ ...ready, paths }));
    groups++;

    // Import reasons retain their fixed order/set; no HTML or arbitrary
    // physical file is represented as a notebook Markdown initialization.
    for (const imports of [
      [...rawSummary.imports, ...rawSummary.imports], [{ path: 'Raw.md', reasons: [] }],
      [{ path: 'Raw.md', reasons: ['link-change', 'selected'] }], [{ path: 'Raw.md', reasons: ['selected', 'selected'] }],
      [{ path: 'page.html', reasons: ['selected'] }], [{ path: '../Raw.md', reasons: ['selected'] }],
    ]) invalid(envelope({ ...rawSummary, imports }));
    groups++;

    // The old native and import preview branches keep their complete:true
    // contract. Their six schemas remain first; new HTML branches are separate.
    assert.equal(moveSchema.oneOf.length, 7); assert.equal(deleteSchema.oneOf.length, 7);
    const nativeLegacy = { kind: 'move', workspaceId: 'workspace', planId: 'a'.repeat(64), readiness: 'ready',
      paths: [{ sourcePath: 'a.md', destinationPath: 'b.md' }], linkChanges: { rewrites: 0, unlinks: 0, affectedDocuments: 0 },
      coverage: { complete: true } };
    const importLegacy = { version: 1, kind: 'native-path-import-preparation', operationKind: 'move',
      workspaceId: 'workspace', planId: 'b'.repeat(64), executionReady: false, readiness: 'requires-import-rebinding',
      paths: [{ sourcePath: 'a.md', destinationPath: 'b.md' }], imports: [{ path: 'a.md', reasons: ['selected'] }],
      issues: [], coverage: { complete: true } };
    for (const legacy of [nativeLegacy, importLegacy]) {
      assert.deepEqual(encode(envelope(legacy)), envelope(legacy)); assert.equal(validMove(envelope(legacy)), true);
      invalid(envelope({ ...legacy, coverage: { complete: false } }));
      invalid(envelope({ ...legacy, linkAssessment: ready.linkAssessment }));
    }
    const oldArms = moveSchema.oneOf.slice(0, 6);
    const validateOldArms = ajv.compile({ type: 'object', oneOf: oldArms });
    assert.equal(validateOldArms(envelope(nativeLegacy)), true); assert.equal(validateOldArms(envelope(importLegacy)), true);
    assert.equal(validateOldArms(envelope(ready)), false);
    const htmlDelete = { ...ready, version: 3, operationKind: 'delete', paths: [{ sourcePath: 'Move.md' }],
      linkChanges: { rewrites: 0, unlinks: 1, affectedDocuments: 1 } };
    assert.deepEqual(encode(envelope(htmlDelete)), envelope(htmlDelete));
    assert.equal(validDelete(envelope(htmlDelete)), true, JSON.stringify(validDelete.errors));
    assert.equal(validMove(envelope(htmlDelete)), false);
    const validateOldDeleteArms = ajv.compile({ type: 'object', oneOf: deleteSchema.oneOf.slice(0, 6) });
    assert.equal(validateOldDeleteArms(envelope(htmlDelete)), false);
    groups++;

    // Projection requires a strictly decoded actual private new plan. A DTO,
    // a native-ready early summary or altered saved facts do not qualify.
    assert.throws(() => project(ready));
    const earlyReady = preparation({ scope: source.scope, kind: 'move', selections, observation: source.observation });
    assert.equal(earlyReady.readiness, 'native-ready'); assert.throws(() => project(earlyReady));
    assert.throws(() => project({ ...clone(plan), coverage: { ...plan.coverage, complete: true } }));
    assert.throws(() => project({ ...clone(blockedPlan), requiredRawImports: [], readiness: 'native-ready' }));
    groups++;

    // Exact existing response cap precedes cloning arbitrarily many long
    // targets. Failure reports only the fixed public size code.
    const tooLarge = { ...ready, linkAssessment: { ...ready.linkAssessment, warnings: Array.from({ length: 300 }, () => ({
      code: 'unaffected-explicit-html-link', path: 'HTML.md', targets: ['x'.repeat(4096)],
    })) } };
    assert.throws(() => encode(envelope(tooLarge)), error => error instanceof WorkspacePathToolError
      && error.code === 'PATH_OUTPUT_TOO_LARGE' && error.status === 413);
    groups++;

    // Hostile nested public data invokes no getters or proxy traps. Successful
    // encoding owns a detached frozen copy of mutable input data.
    let traps = 0;
    const proxy = new Proxy({}, { get() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); },
      getPrototypeOf() { traps++; throw new Error('trap'); } });
    invalid(envelope(proxy)); invalid(envelope({ ...ready, linkAssessment: proxy }));
    const getter = Object.defineProperty({ ...ready }, 'linkAssessment', { enumerable: true, get() { traps++; return ready.linkAssessment; } });
    invalid(envelope(getter));
    invalid(envelope({ ...ready, linkAssessment: { ...ready.linkAssessment, warnings: Array(1) } }));
    assert.equal(traps, 0);
    const mutable = clone(ready), captured = encode(envelope(mutable));
    mutable.linkAssessment.warnings[0].targets[0] = 'changed.png';
    assert.equal(captured.action, 'preview');
    if (captured.action === 'preview' && captured.preview.kind === 'native-path-html-assessment') {
      assert.equal(captured.preview.linkAssessment.warnings[0].targets[0], 'assets/stable.png'); deepFrozen(captured);
    }
    groups++;

    console.log(`MCP workspace HTML path contract: ${groups} families passed`);
  } finally {
    if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase;
    if (previousAuth === undefined) delete process.env.BETTER_AUTH_BASE_URL; else process.env.BETTER_AUTH_BASE_URL = previousAuth;
  }
}
