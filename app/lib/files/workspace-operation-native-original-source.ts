import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { decodeWorkspaceOperationNativeSourceEvidence,
  WorkspaceOperationNativeSourceEvidenceError,
  type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { decodeWorkspaceOperationNativeSourceEvidenceV3,
  type WorkspaceOperationNativeSourceEvidenceV3 } from './workspace-operation-native-source-evidence-v3';
import { decodeWorkspaceOperationMixedSourceEvidence } from './workspace-operation-mixed-source-evidence';
import { decodeWorkspaceOperationMixedSourceEvidenceV5,
  type WorkspaceOperationMixedSourceEvidenceV5 } from './workspace-operation-mixed-source-evidence-v5';

/** Historical data validation only. The fixed owner must capture this evidence
 * from actual native bytes and the complete catalogue on its own connection.
 * A decoded witness never grants current access or authorizes a filesystem move. */
export function decodeWorkspaceOperationNativeOriginalSourceWitness(
  expected: WorkspaceOperationNativeSourceEvidenceV2,
  input: unknown,
): WorkspaceOperationNativeSourceEvidenceV2 {
  const original = decodeWorkspaceOperationNativeSourceEvidence(expected);
  const witness = decodeWorkspaceOperationNativeSourceEvidence(input);
  if (original.evidenceVersion !== 2 || witness.evidenceVersion !== 2
    || !isDeepStrictEqual(witness.workspaceScope, original.workspaceScope)
    || witness.semanticProof !== original.semanticProof) {
    throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  return witness;
}

/** Version-bound historical witness facts only. Fresh V3 catalogue/bytes must
 * still be captured by the actual owner; this decoder creates no authority. */
export function decodeWorkspaceOperationMixedOriginalSourceWitness(expected: WorkspaceOperationNativeSourceEvidenceV2,
  input: unknown): WorkspaceOperationNativeSourceEvidenceV2;
export function decodeWorkspaceOperationMixedOriginalSourceWitness(expected: WorkspaceOperationNativeSourceEvidenceV3,
  input: unknown): WorkspaceOperationNativeSourceEvidenceV3;
export function decodeWorkspaceOperationMixedOriginalSourceWitness(expected: WorkspaceOperationMixedSourceEvidenceV5,
  input: unknown): WorkspaceOperationMixedSourceEvidenceV5;
export function decodeWorkspaceOperationMixedOriginalSourceWitness(expected: WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5,
  input: unknown): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5;
export function decodeWorkspaceOperationMixedOriginalSourceWitness(expected: WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5,
  input: unknown): WorkspaceOperationNativeSourceEvidenceV2 | WorkspaceOperationNativeSourceEvidenceV3 | WorkspaceOperationMixedSourceEvidenceV5 {
  if (expected?.evidenceVersion === 5) {
    const original = decodeWorkspaceOperationMixedSourceEvidenceV5(expected);
    const witness = decodeWorkspaceOperationMixedSourceEvidenceV5(input);
    if (!isDeepStrictEqual(witness.workspaceScope, original.workspaceScope) || witness.semanticProof !== original.semanticProof) {
      throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
    }
    return witness;
  }
  const original = decodeWorkspaceOperationMixedSourceEvidence(expected);
  if (original.evidenceVersion === 2) return decodeWorkspaceOperationNativeOriginalSourceWitness(original, input);
  if (original.evidenceVersion !== 3) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const witness = decodeWorkspaceOperationNativeSourceEvidenceV3(input);
  if (!isDeepStrictEqual(witness.workspaceScope, original.workspaceScope) || witness.semanticProof !== original.semanticProof) {
    throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_CHANGED');
  }
  return witness;
}
