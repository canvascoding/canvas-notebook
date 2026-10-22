import 'server-only';
import { isDeepStrictEqual as equal } from 'node:util';
import { parseObsidianWikiTarget } from '../markdown/obsidian-flavored-markdown';
import { buildWorkspaceMixedHtmlLinkGraphV5 } from '../markdown/workspace-native-link-graph';
import type { MixedReadResolvedLinkV3 } from '../markdown/workspace-link-contract-v3';
import type { PhysicalNativeImportBindingV1 } from '../markdown/physical-native-import-binding';
import { nativeLinkJsonProof as proof } from '../markdown/workspace-native-link-inventory';
import { workspaceOperationMixedSourceSnapshotV5, type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';
import type { WorkspacePathHtmlImportPreparationPlanV4 } from './workspace-path-html-import-preparation';
import { WorkspacePathImportPreparationPhaseError } from './workspace-path-import-preparation-phase';
function fail(_code?: string): never { throw new WorkspacePathImportPreparationPhaseError('PATH_IMPORT_PREPARATION_PHASE_CHANGED'); }
function edgeResolution(edge: MixedReadResolvedLinkV3, identityMap: ReadonlyMap<string, string>, anchorIdentity?: string) {
  if (anchorIdentity && edge.kind === 'wiki' && edge.classification === 'anchor-only'
    && parseObsidianWikiTarget(edge.literal)?.path === '') {
    return { status: 'resolved', target: anchorIdentity, candidates: [anchorIdentity] };
  }
  return { status: edge.resolution.status, target: edge.resolution.target
    ? identityMap.get(edge.resolution.target.identity) ?? edge.resolution.target.identity : null,
  candidates: edge.resolution.candidates.map(item => identityMap.get(item.identity) ?? item.identity).sort() };
}
/** Genuine import receipts bridge original physical identities/occurrences to
 * actual fresh native ones. The namespace has not moved in B0. No import may
 * silently change a surviving link's original resolution before execution. */
export function assertWorkspacePathHtmlImportsCurrentGraphV4(plan: WorkspacePathHtmlImportPreparationPlanV4, bindings: readonly PhysicalNativeImportBindingV1[],
  current: WorkspaceOperationMixedSourceEvidenceV5): void {
  if (!equal(plan.sourceEvidence.scope, current.scope) || !equal(plan.sourceEvidence.coverage, current.coverage)) return fail();
  const normalizeHtml = (value: WorkspaceOperationMixedSourceEvidenceV5['physicalHtmlSources4'][number]) => {
    const { htmlSourceProof: _proof, authority, ...body } = value; const { catalogueProof: _catalogue, ...boundAuthority } = authority;
    return { ...body, authority: boundAuthority };
  };
  if (!equal(plan.sourceEvidence.physicalHtmlSources4.map(normalizeHtml), current.physicalHtmlSources4.map(normalizeHtml))) return fail();
  // B0 adds exactly the genuine imported documents to the native catalogue.
  // Their source grammar rejects HTML, so every new location row must be empty;
  // every pre-existing document's ordered locations must remain byte exact.
  const importedIds = new Set(bindings.map(binding => binding.receipt.target.documentId));
  if (importedIds.size !== bindings.length
    || plan.sourceEvidence.nativeHtmlSourceLocations.some(row => importedIds.has(row.documentId))
    || !equal(plan.sourceEvidence.nativeHtmlSourceLocations,
      current.nativeHtmlSourceLocations.filter(row => !importedIds.has(row.documentId)))) return fail();
  for (const binding of bindings) {
    const locations = current.nativeHtmlSourceLocations.filter(row => row.documentId === binding.receipt.target.documentId);
    if (locations.length !== 1 || locations[0].path !== binding.receipt.target.path || locations[0].locations.length !== 0) return fail();
  }
  for (const original of plan.sourceEvidence.nativeOrdinarySources4) if (!equal(original,
    current.nativeOrdinarySources4.find(value => value.documentId === original.documentId))) return fail();
  const before = buildWorkspaceMixedHtmlLinkGraphV5(workspaceOperationMixedSourceSnapshotV5(plan.sourceEvidence));
  const after = buildWorkspaceMixedHtmlLinkGraphV5(workspaceOperationMixedSourceSnapshotV5(current));
  const byPath = new Map(bindings.map(binding => [binding.source.path, binding]));
  const identities = new Map<string, string>(), used = new Set<MixedReadResolvedLinkV3>();
  const unchangedPhysicalIds = new Map<string, Map<string, string>>();
  for (const original of plan.sourceEvidence.physicalSources4) {
    if (byPath.has(original.path)) continue;
    const matches = current.physicalSources4.filter(source => source.path === original.path);
    if (matches.length !== 1) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const actual = matches[0];
    // Every immutable source/profile/FD/hash fact stays exact. A genuine
    // import changes the catalogue proof, hence the derived source/link IDs,
    // even for a completely untouched Raw reader. Never discard that reader.
    const { physicalSourceProof: _originalProof, authority: originalAuthority, links: originalLinks, ...originalFacts } = original;
    const { physicalSourceProof: _actualProof, authority: actualAuthority, links: actualLinks, ...actualFacts } = actual;
    const { catalogueProof: _originalCatalogue, ...originalAuthorityFacts } = originalAuthority;
    const { catalogueProof: _actualCatalogue, ...actualAuthorityFacts } = actualAuthority;
    if (!equal(originalFacts, actualFacts) || !equal(originalAuthorityFacts, actualAuthorityFacts)
      || originalLinks.length !== actualLinks.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const actualByOccurrence = new Map(actualLinks.map(link => {
      const { physicalLinkId, ...facts } = link;
      return [proof(facts), { physicalLinkId, facts }] as const;
    }));
    if (actualByOccurrence.size !== actualLinks.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const ids = new Map<string, string>(), occurrences = new Set<string>();
    for (const link of originalLinks) {
      // This includes raw text, both UTF-16/UTF-8 ranges, syntax, target,
      // source path, fragment, alias and embed; equal spelling alone is not
      // enough to select an occurrence. Fresh Evidence3 reparses actual bytes.
      const { physicalLinkId, ...facts } = link, key = proof(facts), found = actualByOccurrence.get(key);
      if (!found || occurrences.has(key) || !equal(facts, found.facts)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
      occurrences.add(key); ids.set(physicalLinkId, found.physicalLinkId);
    }
    if (ids.size !== originalLinks.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    unchangedPhysicalIds.set(original.path, ids);
  }
  if (before.namespace.length !== after.namespace.length) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  for (const original of before.namespace) {
    const actual = after.namespace.find(entry => entry.path === original.path), binding = byPath.get(original.path);
    if (!actual || actual.kind !== original.kind || actual.filesystemIdentity !== original.filesystemIdentity
      || actual.workspaceId !== original.workspaceId) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    if (binding) {
      if (actual.documentId !== binding.receipt.target.documentId || actual.lifecycleGeneration !== binding.receipt.target.lifecycleGeneration
        || original.documentId !== null) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    } else if (!equal(actual, original)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    identities.set(original.identity, actual.identity);
  }
  for (const previous of plan.sourceEvidence.nativeComponent.nativeBindings) {
    const actual = current.nativeComponent.nativeBindings.find(item => item.expected.documentId === previous.expected.documentId);
    if (!actual || !equal(actual.expected, previous.expected)) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  }
  for (const original of before.edges) {
    const binding = byPath.get(original.source.path);
    const occurrence = binding?.links.find(link => link.physicalLinkId === original.id);
    const candidates = after.edges.filter(edge => edge.source.path === original.source.path && (binding
      ? edge.sourceKind === 'native' && edge.source.documentId === binding.receipt.target.documentId
        && occurrence && equal(edge.ref, occurrence.reference)
      : edge.sourceKind === original.sourceKind && edge.id === (original.sourceKind === 'physical-read'
        ? unchangedPhysicalIds.get(original.source.path)?.get(original.id) : original.id)));
    if (candidates.length !== 1) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
    const actual = candidates[0]; used.add(actual);
    const anchor = binding ? after.namespace.find(entry => entry.path === original.source.path)!.identity : undefined;
    if (!equal(edgeResolution(original, identities), edgeResolution(actual, new Map(), anchor))) return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  }
  for (const edge of after.edges) if (!used.has(edge)) {
    // The physical inventory deliberately omits external/non-file anchors.
    // Such actual imported native edges are retained, never chosen as targets.
    if (!byPath.has(edge.source.path) || edge.classification === 'local'
      || edge.classification === 'anchor-only' && edge.kind === 'wiki') return fail('PATH_IMPORT_PREPARATION_PHASE_CHANGED');
  }
}
