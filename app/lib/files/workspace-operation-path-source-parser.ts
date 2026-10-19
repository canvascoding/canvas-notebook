import 'server-only';

import { types } from 'node:util';
import type { WorkspaceOperationMixedSourceEvidence } from './workspace-operation-mixed-source-evidence';
import { WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';

/** Select only the physical parser bound by an already decoded stored plan.
 * Evidence 3 is not itself a parser upgrade. Historical absent markers and an
 * empty physical set retain parser 2; mixed markers cannot be reinterpreted by
 * a single fresh collector. This supplies neither evidence nor authority. */
export function deriveWorkspacePathPhysicalParserVersion(evidence: WorkspaceOperationMixedSourceEvidence): 2 | 3 {
  if (!evidence || typeof evidence !== 'object' || types.isProxy(evidence)
    || Object.getPrototypeOf(evidence) !== Object.prototype) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const version = Object.getOwnPropertyDescriptor(evidence, 'evidenceVersion');
  if (!version?.enumerable || !Object.hasOwn(version, 'value') || ![1, 2, 3].includes(version.value)) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  if (version.value !== 3) return 2;
  const descriptor = Object.getOwnPropertyDescriptor(evidence, 'physicalSources');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  const physical: unknown = descriptor.value;
  if (!physical || typeof physical !== 'object' || types.isProxy(physical) || !Array.isArray(physical)
    || Object.getPrototypeOf(physical) !== Array.prototype || physical.length > 10_000
    || Reflect.ownKeys(physical).length !== physical.length + 1) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
  let parserVersion: 2 | 3 | undefined;
  for (let index = 0; index < physical.length; index++) {
    const item = Object.getOwnPropertyDescriptor(physical, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    const source: unknown = item.value;
    if (!source || typeof source !== 'object' || types.isProxy(source)
      || Object.getPrototypeOf(source) !== Object.prototype) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    const marker = Object.getOwnPropertyDescriptor(source, 'parserVersion');
    if (marker && (!marker.enumerable || !Object.hasOwn(marker, 'value'))) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    const current = marker === undefined ? 2 : marker.value;
    if (current !== 2 && current !== 3 || parserVersion !== undefined && current !== parserVersion) throw new WorkspaceOperationNativeSourceEvidenceError('NATIVE_SOURCE_EVIDENCE_INVALID');
    parserVersion = current;
  }
  return parserVersion ?? 2;
}
