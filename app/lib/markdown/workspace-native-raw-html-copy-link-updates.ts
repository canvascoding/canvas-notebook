import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal, types } from 'node:util';
import type { NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import type { NativeRecoveryRecord } from '../collaboration/native-document-recovery';
import { decodeNativeCopyMarkdownBirthV1, nativeCopyMarkdownImportIds,
  type NativeCopyMarkdownBirthV1 } from '../collaboration/native-copy-markdown-birth-contract';
import { authoritativeNativeCollaborationSnapshot } from '../collaboration/document-snapshot';
import { Y } from '../collaboration/server-runtime';
import { decodeWorkspaceOperationManagedCopyPlanV7, type WorkspaceOperationManagedCopyPlanV7 } from '../files/workspace-operation-managed-copy-plan-v7';
import { captureWorkspaceOperationNativePlanData } from '../files/workspace-operation-native-plan-data';
import { NativeCopyLinkBindingError } from './workspace-native-copy-link-updates';
import type { NativeLinkMutationRecipe } from './workspace-link-contract-v2';
import { inspectPersistedDocumentLinksV4, nativeLinkJsonProof as proof } from './workspace-native-link-inventory';
import { nativeRawCopyLinkMutationId } from './workspace-native-raw-copy-link-updates';
import { captureRawHtmlCopyNativeBindingV2 } from './workspace-raw-html-copy-binding';
import { formatNativeLinkTargetForPathChange } from './workspace-native-mixed-batch-compiler';
import { prepareNativeLinkMutationsV4, prepareNativeLinkInverseV4, type PreparedNativeLinkUpdateV4 } from './workspace-native-link-mutations';

export type NativeRawHtmlCopyLinkUpdatesInput = Readonly<{
  plan: WorkspaceOperationManagedCopyPlanV7;
  parent: Readonly<{ operationId: string; stageDigest: string; requestHash: string }>;
  births: readonly NativeCopyMarkdownBirthV1[];
  nativeReceipt: NativeCopyReceipt;
}>;
export type NativeRawHtmlCopyLinkUpdates = Readonly<{
  requirementIndex: number; entityKey: string; documentId: string; mutationId: string;
  linkBindings: ReadonlyArray<Readonly<{ physicalLinkId: string; nativeLinkId: string }>>;
  recipes: readonly NativeLinkMutationRecipe[];
}>;

/** Historical data-to-recipes only. The fixed owner must authenticate the
 * current phase and confirm the complete original Plan/parent/birth/clone
 * ledgers first. No current state, import, receipt reconstruction or authority
 * callback is used. B2 can call this against original birth facts after seq1. */
export function nativeRawHtmlCopyLinkTargets(input: NativeRawHtmlCopyLinkUpdatesInput): readonly NativeRawHtmlCopyLinkUpdates[] {
  try {
    const plan = decodeWorkspaceOperationManagedCopyPlanV7(input.plan);
    const parent = captureWorkspaceOperationNativePlanData(input.parent, () => { throw new NativeCopyLinkBindingError(); }) as typeof input.parent;
    // Block-ID dictionaries may legally contain reserved/long opaque IDs.
    // This adapter needs only already owner-validated source/clone identities;
    // never push that dictionary through the generic DTO-key validator.
    const receiptFields: Record<string, unknown> = {};
    for (const key of ['version', 'operationId', 'workspaceId', 'requestFingerprint', 'publicationStatus', 'documents']) {
      if (!input.nativeReceipt || types.isProxy(input.nativeReceipt)) throw new NativeCopyLinkBindingError();
      const field = Object.getOwnPropertyDescriptor(input.nativeReceipt, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new NativeCopyLinkBindingError();
      receiptFields[key] = field.value;
    }
    const documents = receiptFields.documents;
    if (!Array.isArray(documents) || types.isProxy(documents) || documents.length !== plan.cloneRequirements.length
      || Reflect.ownKeys(documents).length !== documents.length + 1) throw new NativeCopyLinkBindingError();
    receiptFields.documents = Array.from({ length: documents.length }, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(documents, String(index));
      if (!item?.enumerable || !Object.hasOwn(item, 'value') || types.isProxy(item.value)) throw new NativeCopyLinkBindingError();
      return Object.fromEntries(['version', 'source', 'clone'].map(key => {
        const field = Object.getOwnPropertyDescriptor(item.value, key);
        if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new NativeCopyLinkBindingError(); return [key, field.value];
      }));
    });
    const receipt = captureWorkspaceOperationNativePlanData(receiptFields, () => { throw new NativeCopyLinkBindingError(); }, 16 * 1024 * 1024) as
      Omit<NativeCopyReceipt, 'documents'> & { documents: Array<Omit<NativeCopyReceipt['documents'][number], 'blockIdMapping'>> };
    if (!Array.isArray(input.births) || types.isProxy(input.births) || Object.getPrototypeOf(input.births) !== Array.prototype
      || input.births.length !== plan.rawImportRequirements.length || Reflect.ownKeys(input.births).length !== input.births.length + 1
      || Object.keys(parent).length !== 3 || !/^[A-Za-z0-9:_-]{1,256}$/u.test(parent.operationId)
      || ![parent.stageDigest, parent.requestHash].every(value => /^[a-f0-9]{64}$/u.test(value))
      || receipt.version !== 1 || receipt.operationId !== parent.operationId || receipt.workspaceId !== plan.destinationScope.workspaceId
      || !['native_committed', 'published'].includes(receipt.publicationStatus) || !/^[a-f0-9]{64}$/u.test(receipt.requestFingerprint)
      || receipt.documents.length !== plan.cloneRequirements.length) throw new NativeCopyLinkBindingError();
    let budget = 64 * 1024 * 1024;
    const births = Array.from({ length: input.births.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(input.births, String(index));
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new NativeCopyLinkBindingError();
      const birth = decodeNativeCopyMarkdownBirthV1(field.value); budget -= Buffer.byteLength(JSON.stringify(birth));
      if (budget < 0) throw new NativeCopyLinkBindingError(); return birth;
    });
    const targets = new Map<string, string>();
    const ids = new Set(plan.compilation.finalNamespace.flatMap(entity => entity.binding.kind === 'existing'
      && entity.binding.namespaceEvidence.documentId ? [entity.binding.namespaceEvidence.documentId] : []));
    const lineages = new Set([plan.sourceEvidence, plan.destinationEvidence].flatMap(evidence => evidence.nativeComponent.nativeBindings.map(binding => binding.expected.lineageId)));
    for (const entity of plan.compilation.finalNamespace) if (entity.binding.kind === 'existing') targets.set(entity.entityKey, entity.binding.namespaceEvidence.identity);
    for (const requirement of plan.cloneRequirements) {
      const entity = plan.compilation.finalNamespace.find(entity => entity.entityKey === requirement.entityKey);
      const source = plan.sourceEvidence.namespace.find(entry => entry.path === requirement.sourcePath);
      const document = receipt.documents.find(document => document.clone.path === entity?.path);
      const inventory = plan.compilation.documentEvidence.find(value => value.inventory.document.documentId === source?.documentId)?.inventory;
      if (!entity || entity.binding.kind !== 'unbound-copy' || !source?.documentId || !document || !inventory
        || document.version !== 1 || document.source.documentId !== source.documentId
        || document.source.lifecycleGeneration !== source.lifecycleGeneration || document.source.stateProof !== inventory.version.stateProof
        || document.source.documentSequence !== inventory.version.documentSequence || document.clone.lifecycleGeneration !== 1
        || document.clone.initialSequence !== 0 || !document.clone.documentId || !document.clone.lineageId
        || ids.has(document.clone.documentId) || lineages.has(document.clone.lineageId)) throw new NativeCopyLinkBindingError();
      ids.add(document.clone.documentId); lineages.add(document.clone.lineageId);
      targets.set(entity.entityKey, `registry:${document.clone.documentId}:1`);
    }
    for (const [index, birth] of births.entries()) {
      const requirement = plan.rawImportRequirements[index], target = birth.binding.receipt.target;
      const idsForImport = nativeCopyMarkdownImportIds(parent.operationId, parent.stageDigest, index);
      if (birth.parent.operationId !== parent.operationId || birth.parent.stageDigest !== parent.stageDigest
        || birth.parent.requestHash !== parent.requestHash || birth.parent.planId !== plan.planId
        || birth.parent.requirementIndex !== index || birth.parent.entityKey !== requirement.entityKey
        || birth.parent.requirementProof !== proof(requirement) || birth.binding.receipt.operationId !== idsForImport.operationId
        || !equal(birth.origin.sourceScope, plan.sourceScope) || !equal(birth.origin.destinationScope, plan.destinationScope)
        || !equal(birth.origin, births[0].origin) || birth.b1TransactionId !== births[0].b1TransactionId
        || birth.binding.source.workspaceId !== requirement.sourceWorkspaceId || birth.binding.source.path !== requirement.sourcePath
        || birth.binding.source.physicalSourceProof !== requirement.physicalSourceProof
        || birth.binding.source.sourceHash !== requirement.physical.byteHash || birth.binding.source.sourceBytes !== requirement.physical.byteLength
        || birth.binding.source.filesystemIdentity !== requirement.physical.filesystemIdentity
        || target.workspaceId !== requirement.destinationWorkspaceId || target.path !== requirement.destinationPath
        || target.representation !== requirement.preparation.representation || target.newlineStyle !== requirement.preparation.newlineStyle
        || target.hasBom !== requirement.preparation.hasBom || ids.has(target.documentId) || lineages.has(target.lineageId)
        || birth.binding.links.length !== requirement.linkBindings.length || requirement.linkBindings.some(link =>
          birth.binding.links.filter(binding => binding.physicalLinkId === link.physicalLinkId).length !== 1)) throw new NativeCopyLinkBindingError();
      ids.add(target.documentId); lineages.add(target.lineageId); targets.set(requirement.entityKey, `registry:${target.documentId}:1`);
    }
    // Non-native copied assets/Scenes are still logical targets until the fixed
    // owner proves their real FD/provider births. Never synthesize a native ID.
    for (const entity of plan.compilation.finalNamespace) if (!targets.has(entity.entityKey)) targets.set(entity.entityKey, entity.entityKey);
    const used = new Set<string>();
    const result = births.map((birth, index): NativeRawHtmlCopyLinkUpdates => {
      const requirement = plan.rawImportRequirements[index], initial = birth.binding.nativeInventory;
      const recipes = plan.nativePathPlan.physicalLinkIntents.filter(intent => intent.entityKey === requirement.entityKey).map(intent => {
        const binding = birth.binding.links.find(binding => binding.physicalLinkId === intent.physicalLinkId);
        const link = initial.links.find(link => link.id === binding?.nativeLinkId);
        const target = plan.compilation.finalNamespace.find(entity => entity.entityKey === intent.targetEntityKeyAfter);
        const key = proof({ entityKey: requirement.entityKey, physicalLinkId: intent.physicalLinkId });
        if (!binding || !link || !target || used.has(key) || intent.virtualLinkKey !== key
          || intent.physicalSourceProof !== requirement.ordinaryRequirement.physicalSourceProof || intent.action !== 'rewrite'
          || intent.expectedSourceLiteral !== link.literal || intent.expectedTargetPathText !== link.targetPathText
          || target.workspaceId !== initial.document.workspaceId || target.path !== intent.targetPathAfter
          || intent.fragment !== link.fragment || intent.alias !== link.alias || intent.embed !== link.embed) throw new NativeCopyLinkBindingError();
        used.add(key);
        const nextValue = formatNativeLinkTargetForPathChange(link, target.path, initial.document.path);
        if (nextValue === null) throw new NativeCopyLinkBindingError();
        return { linkId: link.id, source: initial.document, sourceVersion: initial.version, reference: link.ref,
          destinationWorkspaceId: initial.document.workspaceId, sourcePathAfter: initial.document.path,
          cloneSelection: null, action: 'rewrite' as const, nextValue, expectedTargetIdentity: targets.get(target.entityKey)! };
      }).filter(recipe => (recipe.reference.kind === 'link-mark' ? recipe.reference.expected.href : recipe.reference.expected) !== recipe.nextValue);
      return { requirementIndex: index, entityKey: requirement.entityKey, documentId: initial.document.documentId,
        mutationId: nativeRawCopyLinkMutationId({ operationId: parent.operationId, stageDigest: parent.stageDigest, entityKey: requirement.entityKey }),
        linkBindings: birth.binding.links.map(link => ({ physicalLinkId: link.physicalLinkId, nativeLinkId: link.nativeLinkId })), recipes };
    });
    if (used.size !== plan.nativePathPlan.physicalLinkIntents.length) throw new NativeCopyLinkBindingError();
    return result;
  } catch (error) { if (error instanceof NativeCopyLinkBindingError) throw error; throw new NativeCopyLinkBindingError(); }
}

/** Fresh B1 preparation only. All births already exist on the same actual B1.
 * Recovery must use immutable original receipts, never call this on seq1/D2. */
export function prepareNativeRawHtmlCopyLinkUpdates(input: NativeRawHtmlCopyLinkUpdatesInput & Readonly<{
  initialRecords: readonly NativeRecoveryRecord[];
}>): readonly (NativeRawHtmlCopyLinkUpdates & Readonly<{ prepared: PreparedNativeLinkUpdateV4 | null }>)[] {
  try {
    const targets = nativeRawHtmlCopyLinkTargets(input);
    if (!Array.isArray(input.initialRecords) || types.isProxy(input.initialRecords) || input.initialRecords.length !== targets.length) throw new NativeCopyLinkBindingError();
    return targets.map((target, index) => {
      const record = input.initialRecords[index], birth = decodeNativeCopyMarkdownBirthV1(input.births[index]), state = record.state;
      const receipt = birth.binding.receipt.target;
      if (record.lineageId !== receipt.lineageId || !equal(inspectPersistedDocumentLinksV4(state), captureRawHtmlCopyNativeBindingV2(birth, state).inventory4)
        || state.newlineStyle !== receipt.newlineStyle || state.hasBom !== receipt.hasBom
        || createHash('sha256').update(state.yjsState).digest('hex') !== birth.binding.nativeBinaryHash
        || createHash('sha256').update(state.stateVector).digest('hex') !== birth.binding.nativeVectorHash) throw new NativeCopyLinkBindingError();
      captureRawHtmlCopyNativeBindingV2(birth, state);
      if (!target.recipes.length) return { ...target, prepared: null };
      const prepared = prepareNativeLinkMutationsV4({ state, recipes: target.recipes, operationId: target.mutationId });
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, state.yjsState); Y.applyUpdate(scratch, prepared.update);
        const after = { ...state, yjsState: Y.encodeStateAsUpdate(scratch), stateVector: Y.encodeStateVector(scratch) };
        const inverse = prepareNativeLinkInverseV4({ state: after, operationId: `${target.mutationId}:inverse`, inverseRecipes: prepared.inverseRecipes });
        Y.applyUpdate(scratch, inverse.update);
        const undone = { ...state, yjsState: Y.encodeStateAsUpdate(scratch), stateVector: Y.encodeStateVector(scratch) };
        if (!equal(authoritativeNativeCollaborationSnapshot(undone).content, authoritativeNativeCollaborationSnapshot(state).content)) throw new NativeCopyLinkBindingError();
      } finally { scratch.destroy(); }
      return { ...target, prepared };
    });
  } catch (error) { if (error instanceof NativeCopyLinkBindingError) throw error; throw new NativeCopyLinkBindingError(); }
}
