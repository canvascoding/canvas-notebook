import 'server-only';

import type { WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import { decodeOriginalDeleteNativeHtmlLinkIntentsV4, assertOriginalDeleteNativeHtmlLinkCompletionBudgetV4, prepareOriginalDeleteNativeHtmlLinksV4 } from './workspace-operation-original-delete-html-links';

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { authoritativeCollaborationSnapshot } from '../collaboration/checkpoint';
import { serializeCanonicalText } from '../collaboration/persistence';
import { prepareNativeFileArchiveTransition, type NativeFileArchiveExpected, type NativeFileArchiveTransition } from '../collaboration/native-file-archive-transition';
import { readWorkspaceDocumentCatalogue } from '../collaboration/workspace-document-catalogue';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { captureWorkspaceOperationMcpJobPrincipal, type WorkspaceOperationMcpJobPrincipal } from '../workspaces/workspace-operation-mcp-job-principal';
import { withPreparedWorkspaceSingleFileTrash, withRecoveredWorkspaceSingleFileTrash,
  readPreparedWorkspaceSingleFileTrash, movePreparedWorkspaceSingleFileTrash,
  type PreparedWorkspaceSingleFileTrash, type PreparedSingleFileTrashOriginalFacts } from '../filesystem/prepared-single-file-trash';
import { withPreparedWorkspaceSingleFileRestore, withRecoveredWorkspaceSingleFileRestore,
  readPreparedWorkspaceSingleFileRestore, readPreparedWorkspaceSingleFileRestoreDisposition, restorePreparedWorkspaceSingleFileTrash,
  assertPreparedWorkspaceSingleFileRestoreCurrent, type PreparedWorkspaceSingleFileRestore } from '../filesystem/prepared-single-file-trash';
import { computeWorkspaceOperationBatchPlanId } from './workspace-operation-batch-plan';
import { decodeWorkspaceOperationMcpAuthorization } from './workspace-operation-mcp-authorization';
import { decodeWorkspaceOperationNativeDeleteBatchPlan, assertWorkspaceOperationNativeDeleteBatchPlanCurrent,
  captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness, getWorkspaceOperationNativeDeleteLinkRecipes } from './workspace-operation-native-delete-plan';
import type { WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import type { WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { decodeWorkspaceOperationMixedOriginalSourceWitness } from './workspace-operation-native-original-source';
import { workspaceOperationSourceNativeEvidence, workspaceOperationSourceNamespace } from './workspace-operation-mixed-source-evidence';
import { prepareOriginalDeleteNativeLinks, assertOriginalDeleteNativeLinkPlan,
  assertOriginalDeleteNativeLinkCompletionBudget, decodeOriginalDeleteNativeLinkIntents } from './workspace-operation-original-delete-links';
import { assertWorkspaceOperationNativeDeleteUndoGraphCurrent } from './workspace-operation-native-delete-undo-graph';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { withWorkspaceOperationJobLifecycleOwner, withWorkspaceOperationJobLifecycleTransaction,
  completeWorkspaceOperationOriginalDeleteJob, readWorkspaceOperationOriginalDeleteJobHistory,
  type WorkspaceOperationJobLifecycleAccess } from './workspace-operation-job-lifecycle-owner';
import { waitForWorkspaceOperationNativePathAdmission } from './workspace-operation-native-path-admission';
import { readWorkspaceOperationOriginalDeleteAdmissionOnConnection } from './workspace-operation-original-delete-admission';
import { readOriginalNativeDeleteTargetOnConnection,
  readOriginalNativeRestoreTargetOnConnection, restoreOriginalNativeDeleteTargetOnConnection } from './workspace-operation-original-delete-native';
import { captureOriginalDeletePublicShareOnConnection, assertOriginalDeletePublicShareOnConnection } from './workspace-operation-original-delete-public';
import { assertNoCompetingWriter, assertStillPhysical, verifyTrashRow,
  completeWorkspaceOperationOriginalDeleteDomain } from './workspace-operation-original-delete-domain';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, readWorkspaceOperationOriginalDeleteReceiptOnConnection,
  readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection, insertWorkspaceOperationOriginalDeleteIntentOnConnection,
  readWorkspaceOperationOriginalRestoreIntentOnConnection, readWorkspaceOperationOriginalRestoreReceiptOnConnection,
  insertWorkspaceOperationOriginalRestoreIntentOnConnection, insertWorkspaceOperationOriginalRestoreReceiptOnConnection } from './workspace-operation-original-delete-repository';
import { parseIntent, completed, parseRestoreIntent, restored, WorkspaceOperationOriginalDeleteError, assertOriginalDeleteIntentPlan,
  captureOriginalDeleteAdmissionBinding,
  type OriginalIntent, type RestoreIntent, type RestoreCompletion,
  type WorkspaceOperationOriginalDeleteResult, type WorkspaceOperationOriginalRestoreResult,
  type WorkspaceOperationOriginalDeleteEvidenceContext } from './workspace-operation-original-delete-evidence';
export { WorkspaceOperationOriginalDeleteError } from './workspace-operation-original-delete-evidence';
export { verifyTrashRow } from './workspace-operation-original-delete-domain';
export type { WorkspaceOperationOriginalDeleteResult, WorkspaceOperationOriginalRestoreResult } from './workspace-operation-original-delete-evidence';

type Row = Record<string, unknown>;
function fail(code: WorkspaceOperationOriginalDeleteError['code']): never { throw new WorkspaceOperationOriginalDeleteError(code); }
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const json = (value: unknown): string => JSON.stringify(value);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function selection(claim: WorkspaceOperationBatchClaim, actionMode: 'apply' | 'undo' = 'apply'): WorkspaceOperationBatchClaimBinding {
  const binding = readWorkspaceOperationBatchClaimBinding(claim), { plan, authorization } = binding;
  if (plan.version === 3) fail('ORIGINAL_DELETE_UNSUPPORTED');
  if (authorization.mode === 'direct-mcp' && (actionMode !== 'apply' || plan.version !== 2
    || decodeWorkspaceOperationMcpAuthorization(authorization).tool !== 'delete_knowledge_source')) fail('ORIGINAL_DELETE_UNSUPPORTED');
  const step = plan.pathSteps[0], action = plan.actions[0], deleted = plan.deletedPaths[0];
  if (binding.actionMode !== actionMode || authorization.mode !== 'direct' && authorization.mode !== 'direct-mcp' || !authorization.jobScope
    || authorization.jobScope.legacy || ![1, 2].includes(plan.version) || plan.readiness !== 'ready' || plan.issues.length
    || plan.workspaceId !== binding.workspaceId || plan.planId !== binding.planId
    || computeWorkspaceOperationBatchPlanId(plan) !== binding.planId || plan.pathSteps.length !== 1
    || step.kind !== 'delete' || step.destinationPath !== undefined || plan.actions.length !== 1
    || action.kind !== 'delete' || action.reviewId !== step.reviewId || action.selections.length !== 1
    || action.selections[0].sourcePath !== step.sourcePath || action.selections[0].destinationPath !== undefined
    || plan.deletedPaths.length !== 1 || deleted.kind !== 'file' || deleted.path !== step.sourcePath
    || plan.pathMappings.length || plan.linkEdits.length || plan.originalDocuments.length || plan.previewContents.length
    || (!plan.coverage.complete && !(plan.version === 2 && plan.planIdentityVersion === 4)) || !plan.linkAssessment.complete || plan.linkAssessment.blockers.length) fail('ORIGINAL_DELETE_UNSUPPORTED');
  if (plan.version === 2) {
    const native = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
    if (!equal(native.sourceEvidence.workspaceScope, authorization.jobScope)) fail('ORIGINAL_DELETE_UNSUPPORTED');
    if (actionMode === 'undo' && (native.planIdentityVersion === 3 || native.planIdentityVersion === 4)) fail('ORIGINAL_DELETE_UNSUPPORTED');
    if (actionMode === 'undo' && native.nativeGraphPlan.steps.some(step => step.linkIntents.length)) fail('ORIGINAL_DELETE_UNSUPPORTED');
  }
  return binding;
}
function actor(binding: WorkspaceOperationBatchClaimBinding): OriginalIntent['actor'] {
  const auth = binding.authorization; if (auth.mode !== 'direct' && auth.mode !== 'direct-mcp') fail('ORIGINAL_DELETE_INVALID');
  if (auth.mode === 'direct-mcp' && decodeWorkspaceOperationMcpAuthorization(auth).tool !== 'delete_knowledge_source') fail('ORIGINAL_DELETE_INVALID');
  return Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null });
}

function assertPlanSource(binding: WorkspaceOperationBatchClaimBinding, physical: PreparedSingleFileTrashOriginalFacts,
  native: NativeFileArchiveExpected | null, nativeContentHash: string | null,
  currentWitness?: WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5): void {
  if (binding.plan.version === 2) {
    const plan = decodeWorkspaceOperationNativeDeleteBatchPlan(binding.plan);
    if (plan.planIdentityVersion === 4) {
      const evidence = decodeWorkspaceOperationMixedOriginalSourceWitness(plan.sourceEvidence, currentWitness);
      const expected = evidence.nativeComponent.nativeBindings.find(item => item.expected.documentId === plan.nativeTarget.documentId)?.expected;
      const entry = evidence.namespace.find(item => item.path === physical.canonicalPath);
      const identity = physical.source.kind === 'regular_file' ? physical.source.identity : null;
      const fingerprint = identity ? `${identity.device}:${identity.inode}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}` : null;
      if (!native || !equal(native, expected) || !entry || entry.documentId !== native.documentId
        || entry.filesystemIdentity !== fingerprint) fail('ORIGINAL_DELETE_CHANGED');
      return;
    }
    const evidence = plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3
      ? decodeWorkspaceOperationMixedOriginalSourceWitness(plan.sourceEvidence, currentWitness) : plan.sourceEvidence;
    const expected = plan.planIdentityVersion === 2 || plan.planIdentityVersion === 3
      ? workspaceOperationSourceNativeEvidence(evidence).nativeBindings.find(binding => binding.expected.documentId === plan.nativeTarget.documentId)?.expected : plan.nativeTarget;
    const entry = workspaceOperationSourceNamespace(evidence).find(candidate => candidate.path === physical.canonicalPath);
    const actual = physical.source.kind === 'regular_file' ? physical.source.identity : null;
    const physicalIdentity = actual ? `${actual.device}:${actual.inode}:${actual.size}:${actual.mtimeMs}:${actual.ctimeMs}` : null;
    if (!native || !equal(native, expected) || !entry || entry.documentId !== native.documentId
      || entry.filesystemIdentity !== physicalIdentity) fail('ORIGINAL_DELETE_CHANGED');
    return;
  }
  const source = physical.source, expectedIdentity = source.kind === 'regular_file'
    ? `${source.identity.device}:${source.identity.inode}:${source.identity.size}:${source.identity.mtimeMs}:${source.identity.ctimeMs}`
    : native && `native:${native.stateProof}`;
  if (!expectedIdentity || binding.plan.deletedPaths[0].identity !== expectedIdentity) fail('ORIGINAL_DELETE_CHANGED');
  for (const expected of binding.plan.expectedPathState) {
    if (expected.workspaceId !== binding.workspaceId || expected.path !== physical.canonicalPath
      || expected.identity !== expectedIdentity || expected.contentHash !== null
      && expected.contentHash !== nativeContentHash && (source.kind !== 'regular_file' || expected.contentHash !== source.sha256)) fail('ORIGINAL_DELETE_CHANGED');
  }
  if (source.kind === 'projection_absent' && native === null) fail('ORIGINAL_DELETE_UNPROVEN');
}

async function prepareIntent(access: WorkspaceOperationJobLifecycleAccess, binding: WorkspaceOperationBatchClaimBinding,
  physical: PreparedSingleFileTrashOriginalFacts): Promise<OriginalIntent> {
  const stageStartedAt = performance.now(), stageMilestones: { stage: string; elapsedMs: number }[] = [];
  let stageCompleted = false;
  const markStage = (stage: string) => { stageMilestones.push({ stage, elapsedMs: Math.round(performance.now() - stageStartedAt) }); };
  try {
    const schema = binding.source.schemaName, prefix = quote(schema), source = physical.canonicalPath;
    await assertNoCompetingWriter(access, prefix, source);
    markStage('writer-checked');
    const observation = binding.plan.version === 2 ? await access.readOriginalNativeDeleteSources() : null;
    markStage('source-read');
    const currentWitness = binding.plan.version === 2 && (binding.plan.planIdentityVersion === 2 || binding.plan.planIdentityVersion === 3 || binding.plan.planIdentityVersion === 4) && observation
      ? captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(binding.plan, observation,
        binding.authorization.mode === 'direct' || binding.authorization.mode === 'direct-mcp' ? binding.authorization.jobScope! : fail('ORIGINAL_DELETE_INVALID')) : null;
    if (binding.plan.version === 2 && observation && !currentWitness) assertWorkspaceOperationNativeDeleteBatchPlanCurrent(binding.plan, observation,
      binding.authorization.mode === 'direct' || binding.authorization.mode === 'direct-mcp' ? binding.authorization.jobScope! : fail('ORIGINAL_DELETE_INVALID'));
    markStage('current-witness');
    const catalogue = await readWorkspaceDocumentCatalogue(access.database, access.workspace, { paths: [source], maxEntries: 2 });
    markStage('catalogue-read');
    if (catalogue.some(entry => entry.path !== source) || catalogue.length > 1) fail('ORIGINAL_DELETE_UNSUPPORTED');
    let native: NativeFileArchiveExpected | null = null, nativeContentHash: string | null = null;
    let nativeTransition: NativeFileArchiveTransition | null = null;
    if (catalogue.length) {
      const entry = catalogue[0];
      if (entry.authority !== 'initialized' || !entry.lineage_id) fail('ORIGINAL_DELETE_UNSUPPORTED');
      const original = await readOriginalNativeDeleteTargetOnConnection(access.database,
        { schema, workspace: access.workspace, documentId: entry.id, lineageId: entry.lineage_id, path: source });
      native = original.expected;
      // Native archive authority does not require a lossless Markdown export.
      // Export only when this particular stored plan actually demands that hash.
      const requiresNativeContent = binding.plan.version === 1 && binding.plan.expectedPathState.some(expected => expected.contentHash !== null
        && (physical.source.kind !== 'regular_file' || expected.contentHash !== physical.source.sha256));
      if (requiresNativeContent) nativeContentHash = digest(serializeCanonicalText(
        authoritativeCollaborationSnapshot(original.state).canonicalContent, original.state));
      // Reject archive limits/quarantine before making the physical transition.
      nativeTransition = prepareNativeFileArchiveTransition(original.state, native, { trashEntryId: physical.trashEntryId, archivedAt: physical.deletedAtMs });
    } else if (await access.database.get(`SELECT id FROM ${prefix}.file_collaboration_lineages WHERE workspace_id=$1
      AND path=$2 AND status='active' LIMIT 1 FOR SHARE NOWAIT`, [binding.workspaceId, source])) fail('ORIGINAL_DELETE_UNSUPPORTED');
    markStage('native-target-read');
    assertPlanSource(binding, physical, native, nativeContentHash, currentWitness ?? undefined);
    markStage('plan-source');
    const publicShare = await captureOriginalDeletePublicShareOnConnection(access.database,
      { schema, workspace: access.workspace, path: source, ...(native ? { nativeExpected: native } : {}) });
    markStage('public-share-read');
    const auth = binding.authorization; if (auth.mode !== 'direct' && auth.mode !== 'direct-mcp' || !auth.jobScope) fail('ORIGINAL_DELETE_INVALID');
    const linkContext = { batchId: binding.batchId, workspaceId: binding.workspaceId, sourcePath: source, requestHash: auth.requestHash, actor: actor(binding) };
    const nativeLinks = binding.plan.version === 2 && observation ? binding.plan.planIdentityVersion === 4
      ? prepareOriginalDeleteNativeHtmlLinksV4(getWorkspaceOperationNativeDeleteLinkRecipes(binding.plan), observation, linkContext)
      : prepareOriginalDeleteNativeLinks(binding.plan, observation, linkContext) : [];
    markStage('native-links-prepared');
    // HTML4 preparation has just compared the exact strictly-derived recipes
    // with its strictly decoded intents. Keep that local comparison instead of
    // decoding the same immutable plan again; other profiles retain their path.
    if (binding.plan.version === 2 && binding.plan.planIdentityVersion !== 4) assertOriginalDeleteNativeLinkPlan(binding.plan, nativeLinks);
    markStage('link-plan');
    if (nativeLinks.length && !access.workspace.permissions.canWrite) {
      throw Object.assign(new Error('Current workspace write permission is required to update incoming links.'), { status: 403 });
    }
    for (const item of nativeLinks) await assertNoCompetingWriter(access, prefix, item.prepared.source.path);
    markStage('link-writers-checked');
    const fields = { batchId: binding.batchId, planId: binding.planId, requestHash: auth.requestHash,
      actor: actor(binding), jobScope: auth.jobScope, physical, native, publicShare };
    const value: OriginalIntent = currentWitness ? currentWitness.evidenceVersion === 5
      ? { ...fields, version: 6, currentWitness, nativeLinks: decodeOriginalDeleteNativeHtmlLinkIntentsV4(nativeLinks,
        { batchId: binding.batchId, workspaceId: binding.workspaceId, sourcePath: source, requestHash: auth.requestHash, actor: actor(binding) }),
        admission: captureOriginalDeleteAdmissionBinding(await access.readOriginalNativeDeleteAdmission()) }
      : currentWitness.evidenceVersion === 3
      ? { ...fields, version: 5, currentWitness, nativeLinks: decodeOriginalDeleteNativeLinkIntents(nativeLinks,
        { batchId: binding.batchId, workspaceId: binding.workspaceId, sourcePath: source, requestHash: auth.requestHash, actor: actor(binding) }, true),
        admission: captureOriginalDeleteAdmissionBinding(await access.readOriginalNativeDeleteAdmission()) }
      : { ...fields, version: 4, currentWitness, nativeLinks: decodeOriginalDeleteNativeLinkIntents(nativeLinks,
        { batchId: binding.batchId, workspaceId: binding.workspaceId, sourcePath: source, requestHash: auth.requestHash, actor: actor(binding) }, true),
        admission: captureOriginalDeleteAdmissionBinding(await access.readOriginalNativeDeleteAdmission()) }
      : { ...fields, version: nativeLinks.length ? 2 : 1, ...(nativeLinks.length
        ? { nativeLinks: decodeOriginalDeleteNativeLinkIntents(nativeLinks, linkContext) } : {}) };
    markStage('intent-bound');
    if (Buffer.byteLength(json(value)) > 1048576) fail('ORIGINAL_DELETE_UNSUPPORTED');
    if (nativeLinks.length && observation) {
      // The original facts and predicted native transition are exact. Every
      // finite JSON numeric identity value is shorter than this 64-byte reserve;
      // the fixed public result is bounded below 32 KiB by its existing codec.
      const observationBudget = physical.source.kind === 'regular_file' ? { kind: 'moved', method: 'rename',
        identity: Object.fromEntries(Object.keys(physical.source.identity).map(key => [key, 'N'.repeat(64)])), sha256: '0'.repeat(64) }
        : { kind: 'projection_absent' };
      const envelope = { version: 2, batchId: binding.batchId, intentDigest: '0'.repeat(64), trashEntryId: physical.trashEntryId,
        physical: { version: 1, original: physical, observation: observationBudget }, native: nativeTransition,
        publicShare: 'P'.repeat(32768), trashReceiptDigest: '0'.repeat(64), nativeLinks: [] };
      if (value.version === 6) assertOriginalDeleteNativeHtmlLinkCompletionBudgetV4(value.nativeLinks, observation, Buffer.byteLength(json(envelope)));
      else assertOriginalDeleteNativeLinkCompletionBudget(decodeOriginalDeleteNativeLinkIntents(nativeLinks,
        { batchId: binding.batchId, workspaceId: binding.workspaceId, sourcePath: source, requestHash: auth.requestHash, actor: actor(binding) }, true), observation, Buffer.byteLength(json(envelope)), currentWitness ? 3 : undefined);
    }
    markStage('completion-budget');
    const frozen = freeze(value);
    stageCompleted = true;
    return frozen;
  } finally {
    try { console.info('[File action owner] Delete stage timings.', JSON.stringify({ version: 1,
      elapsedMs: Math.round(performance.now() - stageStartedAt), completed: stageCompleted, milestones: stageMilestones })); }
    catch { /* Timing diagnostics never replace the original operation result. */ }
  }
}

/** Original single-file Delete path stage. The native V2 arm rechecks its full
 * source/graph basis on the genuine B; no Markdown export or span plan is used. */
export async function executeWorkspaceOperationOriginalDelete(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb, mcpPrincipal?: WorkspaceOperationMcpJobPrincipal): Promise<WorkspaceOperationOriginalDeleteResult> {
  const mcp = mcpPrincipal === undefined ? undefined : captureWorkspaceOperationMcpJobPrincipal(mcpPrincipal);
  const binding = selection(claim), schema = binding.source.schemaName, prefix = quote(schema);
  const evidenceContext: WorkspaceOperationOriginalDeleteEvidenceContext = Object.freeze({ batchId: binding.batchId,
    planId: binding.planId, workspaceId: binding.workspaceId, authorization: binding.authorization,
    sourcePath: binding.plan.pathSteps[0].sourcePath });
  const history = await readWorkspaceOperationOriginalDeleteJobHistory(claim, openConnection, mcp);
  if (history) return history;
  if (binding.plan.version === 2) await waitForWorkspaceOperationNativePathAdmission(claim, openConnection, mcp);
  return withWorkspaceOperationJobLifecycleOwner(claim, async owner => {
    const observe = () => withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
      const durable = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      const receipt = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      const trash = await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      if (!durable && (receipt || trash) || durable && !receipt && trash) fail('ORIGINAL_DELETE_UNPROVEN');
      const intent = durable ? parseIntent(durable, evidenceContext, access.workspace, resolveWorkspaceDataRoot()) : null;
      if (intent && binding.plan.version === 2) {
        assertOriginalDeleteIntentPlan(intent, binding.plan);
        assertPlanSource(binding, intent.physical, intent.native, null, intent.currentWitness);
        assertOriginalDeleteNativeLinkPlan(binding.plan, intent.nativeLinks ?? []);
      }
      const result = receipt && durable && intent ? completed(receipt, trash, durable, intent) : null;
      if (intent?.version === 4 || intent?.version === 5 || intent?.version === 6) await readWorkspaceOperationOriginalDeleteAdmissionOnConnection(access.database,
        { schema, intent, ...(result ? { result } : {}) });
      return { workspace: access.workspace, durable, intent, result };
    });
    const observed = await observe();
    if (observed.result) return observed.result; // Historical completion, never inspect/adopt current D2/S2.
    const apply = async (prepared: PreparedWorkspaceSingleFileTrash) => {
      let durable = observed.durable, intent = observed.intent;
      if (!durable || !intent) {
        const captured = await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
          const value = await prepareIntent(access, binding, readPreparedWorkspaceSingleFileTrash(prepared));
          const inserted = await insertWorkspaceOperationOriginalDeleteIntentOnConnection(access.database,
            { schema, batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
              requestHash: value.requestHash, intentText: json(value) });
          if (inserted.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
          return { durable: inserted.row, intent: value };
        });
        durable = captured.durable; intent = captured.intent;
      }
      const originalIntent = intent, originalDurable = durable;
      // A resumed intent is historical data. Recheck its original D1/S1 before
      // attempting a rename, then check them again in the atomic SQL apply.
      await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const preflightStartedAt = performance.now(), preflightMilestones: { stage: string; elapsedMs: number }[] = [];
        let callbackCompleted = false;
        const markPreflight = (stage: string) => { preflightMilestones.push({ stage,
          elapsedMs: Math.round(performance.now() - preflightStartedAt) }); };
        try {
          const current = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
          markPreflight('intent-read');
          if (!current || !equal(current, originalDurable)) fail('ORIGINAL_DELETE_CHANGED');
          parseIntent(current, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
          markPreflight('intent-checked');
          if (originalIntent.nativeLinks?.length && !access.workspace.permissions.canWrite) {
            throw Object.assign(new Error('Current workspace write permission is required to update incoming links.'), { status: 403 });
          }
          await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
          markPreflight('target-writers-checked');
          for (const item of originalIntent.nativeLinks ?? []) await assertNoCompetingWriter(access, prefix, item.prepared.source.path);
          markPreflight('link-writers-checked');
          if (binding.plan.version === 2) assertWorkspaceOperationNativeDeleteBatchPlanCurrent(binding.plan,
            await access.readOriginalNativeDeleteSources(), originalIntent.jobScope);
          markPreflight('current-witness');
          if (originalIntent.native) {
            const native = await readOriginalNativeDeleteTargetOnConnection(access.database, { schema, workspace: access.workspace,
              documentId: originalIntent.native.documentId, lineageId: originalIntent.native.lineageId, path: originalIntent.native.path });
            if (!equal(native.expected, originalIntent.native)) fail('ORIGINAL_DELETE_CHANGED');
          } else await assertStillPhysical(access, prefix, originalIntent.physical.canonicalPath);
          markPreflight('native-target-checked');
          await assertOriginalDeletePublicShareOnConnection(access.database,
            { schema, workspace: access.workspace, original: originalIntent.publicShare, nowMs: originalIntent.physical.deletedAtMs });
          markPreflight('public-share-checked');
          callbackCompleted = true;
        } finally {
          try { console.info('[File action owner] Delete preflight timings.', JSON.stringify({ version: 1,
            elapsedMs: Math.round(performance.now() - preflightStartedAt), callbackCompleted, milestones: preflightMilestones })); }
          catch { /* Timing diagnostics never replace the original operation result. */ }
        }
      });
      const physical = await movePreparedWorkspaceSingleFileTrash(prepared);
      if (originalIntent.version === 4 || originalIntent.version === 5 || originalIntent.version === 6) return completeWorkspaceOperationOriginalDeleteJob(owner,
        { expectedIntentDigest: originalDurable.intentDigest, prepared, physical });
      return withWorkspaceOperationJobLifecycleTransaction(owner, access => completeWorkspaceOperationOriginalDeleteDomain(access,
        { binding, evidenceContext, originalDurable, originalIntent, prepared, physical }));
    };
    return observed.intent
      ? withRecoveredWorkspaceSingleFileTrash({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), original: observed.intent.physical }, apply)
      : withPreparedWorkspaceSingleFileTrash({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(),
        canonicalPath: binding.plan.pathSteps[0].sourcePath, trashEntryId: `trash-${randomUUID()}` }, apply);
  }, openConnection, mcp);
}

async function assertPhysicalRestoreVacancy(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) {
    if (await access.database.get(`SELECT 1 AS present FROM ${prefix}.${table} WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left(path,length($2)+1)=$2||'/' OR left($2,length(path)+1)=path||'/') LIMIT 1 FOR SHARE NOWAIT`,
    [access.workspace.workspaceId, source])) fail('ORIGINAL_DELETE_CHANGED');
  }
}

/** Undo the actual completed original Delete, with a fresh genuine human Undo
 * claim. FS intent is committed before rename; native activation, original Trash
 * status and immutable completion share B2. No public share is reactivated. */
export async function undoWorkspaceOperationOriginalDelete(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<WorkspaceOperationOriginalRestoreResult> {
  const binding = selection(claim, 'undo'), schema = binding.source.schemaName, prefix = quote(schema);
  const evidenceContext: WorkspaceOperationOriginalDeleteEvidenceContext = Object.freeze({ batchId: binding.batchId,
    planId: binding.planId, workspaceId: binding.workspaceId, authorization: binding.authorization,
    sourcePath: binding.plan.pathSteps[0].sourcePath });
  return withWorkspaceOperationJobLifecycleOwner(claim, async owner => {
    const observed = await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
      const input = { schema, batchId: binding.batchId, forShare: true as const };
      const originalDurable = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, input);
      const originalReceipt = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, input);
      const originalTrash = await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database, input);
      if (!originalDurable || !originalReceipt || !originalTrash) fail('ORIGINAL_DELETE_UNPROVEN');
      const original = parseIntent(originalDurable, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
      if (binding.plan.version === 2) assertPlanSource(binding, original.physical, original.native, null);
      const originalResult = completed(originalReceipt, originalTrash, originalDurable, original);
      const durable = await readWorkspaceOperationOriginalRestoreIntentOnConnection(access.database, input);
      const receipt = await readWorkspaceOperationOriginalRestoreReceiptOnConnection(access.database, input);
      if (receipt && !durable) fail('ORIGINAL_DELETE_UNPROVEN');
      const intent = durable ? parseRestoreIntent(durable, evidenceContext, access.workspace, original, originalDurable, originalResult) : null;
      return { workspace: access.workspace, original, originalDurable, originalResult, durable, intent,
        result: receipt && durable && intent ? restored(receipt, durable, intent, original) : null };
    });
    // History is history: after confirmed original Undo, never inspect/adopt a
    // replacement document, public share or filesystem node at the old path.
    if (observed.result) return observed.result;
    const { original, originalDurable, originalResult } = observed;
    const checkTarget = async (access: WorkspaceOperationJobLifecycleAccess, intent: RestoreIntent, assessGraph = true): Promise<void> => {
      if (access.actorType !== 'user' || access.actorId !== intent.actorUserId || access.userId !== intent.actorUserId) fail('ORIGINAL_DELETE_UNPROVEN');
      await assertNoCompetingWriter(access, prefix, original.physical.canonicalPath);
      const trash = await access.database.get(`SELECT * FROM ${prefix}.workspace_trash_entries WHERE id=$1 FOR UPDATE NOWAIT`, [intent.trashEntryId]) as Row | undefined;
      verifyTrashRow(original, originalDurable.intentDigest, trash);
      if (original.native && originalResult.native) await readOriginalNativeRestoreTargetOnConnection(access.database,
        { schema, workspace: access.workspace, expected: original.native, archived: originalResult.native,
          trashEntryId: intent.trashEntryId, restoredAt: intent.restoredAtMs });
      else if (!original.native && !originalResult.native) await assertPhysicalRestoreVacancy(access, prefix, original.physical.canonicalPath);
      else fail('ORIGINAL_DELETE_UNPROVEN');
      if (binding.plan.version === 2 && assessGraph) assertWorkspaceOperationNativeDeleteUndoGraphCurrent(binding.plan,
        await readWorkspaceLinkSourceAuthorityOnConnection(access.database, access.workspace));
    };
    const apply = async (prepared: PreparedWorkspaceSingleFileRestore) => {
      let durable = observed.durable, intent = observed.intent;
      if (!durable || !intent) {
        const captured = await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
          const auth = binding.authorization; if (auth.mode !== 'direct') fail('ORIGINAL_DELETE_UNPROVEN');
          const value: RestoreIntent = freeze({ version: 1, batchId: binding.batchId, planId: binding.planId,
            requestHash: auth.requestHash, originalIntentDigest: originalDurable.intentDigest,
            originalReceiptDigest: originalResult.receiptDigest, trashEntryId: original.physical.trashEntryId,
            actorUserId: access.userId, jobScope: original.jobScope,
            restoredAtMs: Math.max(Date.now(), original.physical.deletedAtMs), physical: readPreparedWorkspaceSingleFileRestore(prepared) });
          if (!equal(value.physical.trashReceipt, originalResult.physical)) fail('ORIGINAL_DELETE_UNPROVEN');
          await checkTarget(access, value);
          const inserted = await insertWorkspaceOperationOriginalRestoreIntentOnConnection(access.database,
            { schema, batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
              requestHash: value.requestHash, intentText: json(value) });
          if (inserted.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
          return { durable: inserted.row, intent: value };
        });
        durable = captured.durable; intent = captured.intent;
      }
      const restoreIntent = intent, restoreDurable = durable;
      await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const current = await readWorkspaceOperationOriginalRestoreIntentOnConnection(access.database,
          { schema, batchId: binding.batchId, forShare: true });
        if (!current || !equal(current, restoreDurable)) fail('ORIGINAL_DELETE_CHANGED');
        parseRestoreIntent(current, evidenceContext, access.workspace, original, originalDurable, originalResult);
        // Recovery can already hold the exact restored original file while D1
        // is still archived. Assess its complete graph after the real B2 CAS;
        // parsing those known projection bytes as an unregistered .md source
        // would permanently block recovery. This phase performs no new rename.
        await checkTarget(access, restoreIntent, readPreparedWorkspaceSingleFileRestoreDisposition(prepared) !== 'already-restored');
      });
      const physical = await restorePreparedWorkspaceSingleFileTrash(prepared);
      return withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const current = await readWorkspaceOperationOriginalRestoreIntentOnConnection(access.database,
          { schema, batchId: binding.batchId, forShare: true });
        if (!current || !equal(current, restoreDurable) || !equal(physical.original, restoreIntent.physical)) fail('ORIGINAL_DELETE_CHANGED');
        parseRestoreIntent(current, evidenceContext, access.workspace, original, originalDurable, originalResult);
        await checkTarget(access, restoreIntent, false);
        if (await readWorkspaceOperationOriginalRestoreReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, forShare: true })) fail('ORIGINAL_DELETE_UNPROVEN');
        const native = original.native && originalResult.native ? await restoreOriginalNativeDeleteTargetOnConnection(access.database,
          { schema, workspace: access.workspace, expected: original.native, archived: originalResult.native,
            trashEntryId: restoreIntent.trashEntryId, restoredAt: restoreIntent.restoredAtMs }) : null;
        if (binding.plan.version === 2) assertWorkspaceOperationNativeDeleteUndoGraphCurrent(binding.plan,
          await readWorkspaceLinkSourceAuthorityOnConnection(access.database, access.workspace), 'after-restore');
        await assertPreparedWorkspaceSingleFileRestoreCurrent(prepared);
        const changed = await access.database.get(`UPDATE ${prefix}.workspace_trash_entries SET status='restored',restored_by_user_id=$1,
          restored_at=$2 WHERE id=$3 AND workspace_id=$4 AND status='trashed' RETURNING *`,
        [access.userId, restoreIntent.restoredAtMs, restoreIntent.trashEntryId, binding.workspaceId]) as Row | undefined;
        verifyTrashRow(original, originalDurable.intentDigest, changed, { userId: access.userId, restoredAt: restoreIntent.restoredAtMs });
        const reread = await access.database.get(`SELECT * FROM ${prefix}.workspace_trash_entries WHERE id=$1 FOR SHARE NOWAIT`,
          [restoreIntent.trashEntryId]) as Row | undefined;
        if (!equal(reread, changed)) fail('ORIGINAL_DELETE_POSTCONDITION');
        const value: RestoreCompletion = freeze({ version: 1, batchId: binding.batchId, intentDigest: current.intentDigest,
          originalReceiptDigest: originalResult.receiptDigest, trashEntryId: restoreIntent.trashEntryId,
          actorUserId: access.userId, restoredAtMs: restoreIntent.restoredAtMs, physical, native });
        const receipt = await insertWorkspaceOperationOriginalRestoreReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(value) });
        if (receipt.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
        await access.assertCurrent(); await assertPreparedWorkspaceSingleFileRestoreCurrent(prepared);
        return restored(receipt.row, current, restoreIntent, original);
      });
    };
    return observed.intent
      ? withRecoveredWorkspaceSingleFileRestore({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), original: observed.intent.physical }, apply)
      : withPreparedWorkspaceSingleFileRestore({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), receipt: originalResult.physical }, apply);
  }, openConnection);
}
