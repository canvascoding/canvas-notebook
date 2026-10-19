import 'server-only';

import type { NativeWorkspaceLinkSnapshot } from '../markdown/workspace-link-contract-v2';
import type { WorkspaceMixedReadLinkSnapshotV3 } from '../markdown/workspace-link-contract-v3';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation } from '../markdown/workspace-source-authority-stage';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationNativePlanData, workspaceOperationNativePlanSnapshot } from './workspace-operation-native-plan-data';
import { assertWorkspaceOperationNativeSourceEvidenceCurrent, decodeWorkspaceOperationNativeSourceEvidence,
  WorkspaceOperationNativeSourceEvidenceError, type WorkspaceOperationNativeSourceEvidence } from './workspace-operation-native-source-evidence';
import { assertWorkspaceOperationNativeSourceEvidenceV3Current, decodeWorkspaceOperationNativeSourceEvidenceV3,
  type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';

/** Explicit data union. It does not broaden the historical V1/V2 decoder. */
export type WorkspaceOperationMixedSourceEvidence = WorkspaceOperationNativeSourceEvidence | WorkspaceOperationNativeSourceEvidenceV3;

export function decodeWorkspaceOperationMixedSourceEvidence(input: unknown): WorkspaceOperationMixedSourceEvidence {
  const captured = captureWorkspaceOperationNativePlanData(input, reason => {
    throw new WorkspaceOperationNativeSourceEvidenceError(reason === 'too-large'
      ? 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE' : 'NATIVE_SOURCE_EVIDENCE_INVALID');
  }, 8 * 1024 * 1024);
  return captured && typeof captured === 'object' && !Array.isArray(captured)
    && Reflect.get(captured, 'evidenceVersion') === 3 ? decodeWorkspaceOperationNativeSourceEvidenceV3(captured)
      : decodeWorkspaceOperationNativeSourceEvidence(captured);
}

/** Accessors for already decoded facts. The component is only the native
 * provider inventory; full namespace and visible scope use separate accessors. */
export function workspaceOperationSourceNativeEvidence(evidence: WorkspaceOperationMixedSourceEvidence): WorkspaceOperationNativeSourceEvidence {
  return evidence.evidenceVersion === 3 ? evidence.nativeComponent : evidence;
}
export function workspaceOperationSourceNamespace(evidence: WorkspaceOperationMixedSourceEvidence) {
  return evidence.evidenceVersion === 3 ? evidence.namespace : evidence.stage.namespace;
}
export function workspaceOperationSourceScope(evidence: WorkspaceOperationMixedSourceEvidence) {
  return evidence.evidenceVersion === 3 ? evidence.scope : evidence.stage.scope;
}

export function workspaceOperationMixedSourceSnapshot(evidence: WorkspaceOperationNativeSourceEvidenceV3): WorkspaceMixedReadLinkSnapshotV3;
export function workspaceOperationMixedSourceSnapshot(evidence: WorkspaceOperationNativeSourceEvidence): NativeWorkspaceLinkSnapshot;
export function workspaceOperationMixedSourceSnapshot(evidence: WorkspaceOperationMixedSourceEvidence): NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3;
export function workspaceOperationMixedSourceSnapshot(evidence: WorkspaceOperationMixedSourceEvidence): NativeWorkspaceLinkSnapshot | WorkspaceMixedReadLinkSnapshotV3 {
  if (evidence.evidenceVersion !== 3) return workspaceOperationNativePlanSnapshot(evidence, () => {
    throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_IMPORT_REQUIRED');
  });
  const body = { contractVersion: 3 as const, workspaceId: evidence.workspaceScope.workspaceId,
    namespace: structuredClone(evidence.namespace),
    documents: structuredClone(evidence.nativeComponent.stage.sources.map(source => source.inventory)),
    physicalSources: structuredClone([...evidence.physicalSources]),
    coverage: structuredClone(evidence.coverage) };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}

/** A current comparison always needs fresh actual facts collected under the
 * caller's existing authority and fences. Decoding never supplies either. */
export function assertWorkspaceOperationMixedSourceCurrent(expected: WorkspaceOperationMixedSourceEvidence,
  observation: WorkspaceLinkSourceAuthorityObservation, scope: WorkspaceOperationJobScope): void {
  if (expected.evidenceVersion === 3) assertWorkspaceOperationNativeSourceEvidenceV3Current(expected, observation, scope);
  else assertWorkspaceOperationNativeSourceEvidenceCurrent(expected, observation, scope);
}
