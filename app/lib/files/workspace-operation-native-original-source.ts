import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { decodeWorkspaceOperationNativeSourceEvidence,
  WorkspaceOperationNativeSourceEvidenceError,
  type WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';

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
